import { GoogleGenAI } from "@google/genai";
import express from "express";
import axios from "axios";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, addDoc, doc, setDoc, updateDoc, getDoc, query, where, orderBy, limit, getDocs, serverTimestamp } from "firebase/firestore";
import bcrypt from "bcrypt";
import dotenv from "dotenv";
import { PrivyClient } from '@privy-io/server-auth';
import { createViemAccount } from '@privy-io/server-auth/viem';
import { createPublicClient, createWalletClient, http, webSocket, parseEther, formatEther, decodeEventLog } from 'viem';
import { avalancheFuji } from 'viem/chains';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const flipGameAbi = require('./abi/flip.json');
dotenv.config();

const WEBHOOK_VERIFY_TOKEN = process.env.Whatsapp_hook_token;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PRIVY_APP_ID = process.env.PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;
const PORT = process.env.PORT;
const FLIP_GAME_CONTRACT_ADDRESS = '0x06262a1934E1a8fDD5d4bc1D9EcF5D141b1Cb36F';
const WSS_RPC_URL=process.env.AVAX_RPC_WSS_URL

const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
    measurementId: process.env.FIREBASE_MEASUREMENT_ID
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
const privy = new PrivyClient(PRIVY_APP_ID, PRIVY_APP_SECRET);

const app = express();
app.use(express.json());

const userStates = new Map();
const registrationStates = new Map();
const SALT_ROUNDS = 12;

const REGISTRATION_STEPS = {
    AWAITING_USERNAME: 'awaiting_username',
    AWAITING_EMAIL: 'awaiting_email',
    AWAITING_PIN: 'awaiting_pin',
    CONFIRMING_PIN: 'confirming_pin'
};

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

async function getUserFromDatabase(whatsappId) {
    try {
        const userRef = doc(db, 'users', whatsappId);
        const userSnap = await getDoc(userRef);
        if (userSnap.exists()) {
            return { id: userSnap.id, ...userSnap.data() };
        }
        return null;
    } catch (error) {
        console.error("❌ Error fetching user:", error);
        return null;
    }
}

async function createUserInDatabase(userData) {
    try {
        const userRef = doc(db, 'users', userData.whatsappId);
        await setDoc(userRef, userData);
        const usernameRef = doc(db, 'usernames', userData.username);
        await setDoc(usernameRef, { whatsappId: userData.whatsappId });
        console.log("✅ User created successfully:", userData.whatsappId);
        return true;
    } catch (error) {
        console.error("❌ Error creating user:", error);
        return false;
    }
}

async function checkUsernameExists(username) {
    try {
        const usernameRef = doc(db, 'usernames', username);
        const usernameSnap = await getDoc(usernameRef);
        return usernameSnap.exists();
    } catch (error) {
        console.error("❌ Error checking username:", error);
        return true;
    }
}

async function hashPin(pin) {
    try {
        return await bcrypt.hash(pin, SALT_ROUNDS);
    } catch (error) {
        console.error("❌ Error hashing pin:", error);
        throw error;
    }
}

async function updateUserLastSeen(whatsappId) {
    try {
        const userRef = doc(db, 'users', whatsappId);
        await updateDoc(userRef, {
            lastSeen: serverTimestamp()
        });
    } catch (error) {
        console.error("❌ Error updating last seen:", error);
    }
}

async function createWalletForUser(username) {
    try {
        console.log("🔗 Creating wallet for user:", username);
        const { id, address, chainType } = await privy.walletApi.create({
            chainType: 'ethereum'
        });
        console.log("✅ Wallet created successfully:");
        console.log("   - Wallet ID:", id);
        console.log("   - Address:", address);
        console.log("   - Chain Type:", chainType);
        return {
            walletId: id,
            address: address,
            chainType: chainType
        };
    } catch (error) {
        console.error("❌ Error creating wallet:", error);
        throw error;
    }
}

app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const challenge = req.query["hub.challenge"];
    const token = req.query["hub.verify_token"];
    if (mode && token === WEBHOOK_VERIFY_TOKEN) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

app.post("/webhook", async (req, res) => {
    try {
        const { entry } = req.body;
        if (!entry?.[0]?.changes?.[0]?.value?.messages) {
            return res.sendStatus(200);
        }

        const message = entry[0].changes[0].value.messages[0];
        const userPhoneNumber = message.from;
        const userText = message.text?.body;
        const buttonId = message.interactive?.button_reply?.id;

        const registrationState = registrationStates.get(userPhoneNumber);
        if (registrationState) {
            await handleNewUserFlow(userPhoneNumber, userText, registrationState);
            return res.sendStatus(200);
        }

        const userState = userStates.get(userPhoneNumber);
        if (userState) {
            await handleStatefulInput(userPhoneNumber, userText, buttonId, userState);
            return res.sendStatus(200);
        }

        const user = await getUserFromDatabase(userPhoneNumber);

        if (!user) {
            if (buttonId === 'create_account') {
                registrationStates.set(userPhoneNumber, { step: REGISTRATION_STEPS.AWAITING_USERNAME });
                await sendMessage(userPhoneNumber, "🔐 Let's create your account!\n\nFirst, choose a unique username (3-20 characters, letters, numbers, and underscores only):");
            } else {
                await sendNewUserWelcomeMessage(userPhoneNumber);
            }
            return res.sendStatus(200);
        }

        await updateUserLastSeen(userPhoneNumber);

        if (buttonId) {
            await handleButtonSelection(userPhoneNumber, buttonId, user);
        } else if (userText) {
            const lowerCaseText = userText.toLowerCase();
            if (lowerCaseText === "/games" || lowerCaseText === "games") {
                await sendGamesMenu(userPhoneNumber, user);
            } else if (lowerCaseText === "/wallet" || lowerCaseText === "wallet") {
                await sendWalletMenu(userPhoneNumber, user);
            } else {
                await sendWelcomeBackMessage(userPhoneNumber, user);
            }
        }
        res.sendStatus(200);
    } catch (error) {
        console.error("❌ Error handling webhook:", error);
        res.sendStatus(500);
    }
});

async function handleStatefulInput(userPhoneNumber, userText, buttonId, userState) {
    if (buttonId === 'cancel_operation') {
        userStates.delete(userPhoneNumber);
        await sendMessage(userPhoneNumber, "Action cancelled.");
        const user = await getUserFromDatabase(userPhoneNumber);
        if(user) {
            setTimeout(() => sendMainMenu(userPhoneNumber, user), 1000);
        }
        return;
    }

    if (userState.type === 'awaiting_transaction' && userText) {
        await handleTransactionInput(userPhoneNumber, userText, userState.user);
    } else if (userState.type === 'awaiting_pin_for_transaction' && userText) {
        await handlePinForTransaction(userPhoneNumber, userText, userState);
    } else if (userState.type === 'awaiting_flip_amount' && buttonId?.startsWith('flip_amount_')) {
        const amount = buttonId.split('_')[2];
        await handleFlipAmountSelection(userPhoneNumber, amount, userState);
    } else if (userState.type === 'awaiting_pin_for_flip' && userText) {
        await handlePinForFlip(userPhoneNumber, userText, userState);
    } else {
        await sendMessage(userPhoneNumber, "Please complete the current action or press Cancel.");
    }
}

async function handleButtonSelection(userPhoneNumber, buttonId, user) {
    switch (buttonId) {
        case "games_option":
            await sendGamesMenu(userPhoneNumber, user);
            break;
        case "wallet_option":
            await sendWalletMenu(userPhoneNumber, user);
            break;
        case "send_crypto":
            await handleSendCrypto(userPhoneNumber, user);
            break;
        case "receive_crypto":
            await handleReceiveCrypto(userPhoneNumber, user);
            break;
        case "view_balance":
            await handleViewBalance(userPhoneNumber, user);
            break;
        case "flip_it":
            await handleStartFlipGame(userPhoneNumber, user);
            break;
        case "flip_choice_heads":
            await handleFlipChoice(userPhoneNumber, user, 0);
            break;
        case "flip_choice_tails":
            await handleFlipChoice(userPhoneNumber, user, 1);
            break;
        case "rock_paper_scissors":
        case "guess_number":
            await sendMessage(userPhoneNumber, "This feature is coming soon!");
            break;
    }
}

async function fetchAvaxPrice() {
  const url = `${process.env.COINGECKO_API}/simple/price?ids=avalanche-2&vs_currencies=usd`;
  const headers = {
    'Accept': 'application/json',
    'x-cg-demo-api-key': process.env.COINGECKO_API_KEY
  };
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`CoinGecko API error: ${response.status} ${response.statusText}`);
    const data = await response.json();
    const price = data['avalanche-2']?.usd;
    if (price == null) throw new Error('Unexpected API response structure');
    return price;
  } catch (error) {
    console.error(error.message);
    return 0;
  }
}

async function handleNewUserFlow(userPhoneNumber, userText, registrationState) {
    if (!userText) {
        await sendMessage(userPhoneNumber, "Please provide the requested information to continue.");
        return;
    }

    switch (registrationState.step) {
        case REGISTRATION_STEPS.AWAITING_USERNAME:
            await handleUsernameInput(userPhoneNumber, userText);
            break;
        case REGISTRATION_STEPS.AWAITING_EMAIL:
            await handleEmailInput(userPhoneNumber, userText);
            break;
        case REGISTRATION_STEPS.AWAITING_PIN:
            await handlePinInput(userPhoneNumber, userText);
            break;
        case REGISTRATION_STEPS.CONFIRMING_PIN:
            await handlePinConfirmation(userPhoneNumber, userText);
            break;
        default:
            registrationStates.delete(userPhoneNumber);
            await sendNewUserWelcomeMessage(userPhoneNumber);
    }
}

async function sendNewUserWelcomeMessage(to) {
    try {
        await axios({
            url: `https://graph.facebook.com/v22.0/696395350222810/messages`,
            method: "POST",
            headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
            data: {
                messaging_product: "whatsapp", to, type: "interactive",
                interactive: {
                    type: "button", header: { type: "text", text: "🚀 Welcome to Mort by Hot Coffee" },
                    body: { text: "Hello! I'm Morty, your Wallet Agent that enables you to:\n\n💰 Send & receive crypto\n🎮 Play games and earn crypto\n📱 Manage your digital wallet\n\nTo get started, you'll need to create your account. This will only take a minute!" },
                    footer: { text: "Secure • Fast • Easy" },
                    action: { buttons: [{ type: "reply", reply: { id: "create_account", title: "🔐 Create Account" } }] }
                }
            },
        });
        console.log("✅ New user welcome message sent to:", to);
    } catch (error) {
        console.error("❌ Error sending new user welcome message:", error.response?.data || error.message);
    }
}

async function sendWelcomeBackMessage(to, user) {
    try {
        await axios({
            url: `https://graph.facebook.com/v22.0/696395350222810/messages`,
            method: "POST",
            headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
            data: {
                messaging_product: "whatsapp", to, type: "interactive",
                interactive: {
                    type: "button", header: { type: "text", text: `👋 Welcome back, ${user.username}!` },
                    body: { text: "Great to see you again! What would you like to do today?\n\n🎮 Play games and earn crypto\n💰 Manage your wallet and transactions" },
                    footer: { text: "Choose an option to continue" },
                    action: { buttons: [{ type: "reply", reply: { id: "games_option", title: "🎮 Games" } }, { type: "reply", reply: { id: "wallet_option", title: "💰 Wallet" } }] }
                }
            },
        });
        console.log("✅ Welcome back message sent to:", to);
    } catch (error) {
        console.error("❌ Error sending welcome back message:", error.response?.data || error.message);
    }
}

async function handleUsernameInput(userPhoneNumber, username) {
    if (username.length < 3 || username.length > 20 || !/^[a-zA-Z0-9_]+$/.test(username)) {
        await sendMessage(userPhoneNumber, "❌ Invalid username (3-20 chars, letters, numbers, underscores).");
        return;
    }
    const usernameExists = await checkUsernameExists(username);
    if (usernameExists) {
        await sendMessage(userPhoneNumber, "❌ This username is already taken. Please choose another one:");
        return;
    }
    const state = registrationStates.get(userPhoneNumber);
    state.username = username;
    state.step = REGISTRATION_STEPS.AWAITING_EMAIL;
    registrationStates.set(userPhoneNumber, state);
    await sendMessage(userPhoneNumber, `✅ Great! Username "${username}" is available.\n\nNow, please enter your email address:`);
}

async function handleEmailInput(userPhoneNumber, email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        await sendMessage(userPhoneNumber, "❌ Please enter a valid email address:");
        return;
    }
    const state = registrationStates.get(userPhoneNumber);
    state.email = email;
    state.step = REGISTRATION_STEPS.AWAITING_PIN;
    registrationStates.set(userPhoneNumber, state);
    await sendMessage(userPhoneNumber, `✅ Email saved: ${email}\n\n🔐 Now, create a secure 4-6 digit transaction PIN.\nEnter your PIN:`);
}

async function handlePinInput(userPhoneNumber, pin) {
    if (!/^\d{4,6}$/.test(pin)) {
        await sendMessage(userPhoneNumber, "❌ PIN must be 4-6 digits only. Please try again:");
        return;
    }
    const state = registrationStates.get(userPhoneNumber);
    state.pin = pin;
    state.step = REGISTRATION_STEPS.CONFIRMING_PIN;
    registrationStates.set(userPhoneNumber, state);
    await sendMessage(userPhoneNumber, "🔒 Please confirm your PIN by entering it again:");
}

async function handlePinConfirmation(userPhoneNumber, confirmPin) {
    const state = registrationStates.get(userPhoneNumber);
    if (state.pin !== confirmPin) {
        state.step = REGISTRATION_STEPS.AWAITING_PIN;
        registrationStates.set(userPhoneNumber, state);
        await sendMessage(userPhoneNumber, "❌ PINs don't match. Please enter your 4-6 digit PIN again:");
        return;
    }
    try {
        await sendMessage(userPhoneNumber, "🔗 Creating your secure wallet...");
        const walletData = await createWalletForUser(state.username);
        const now = new Date().toISOString();
        const userData = {
            whatsappId: userPhoneNumber, username: state.username, email: state.email,
            security: { hashedPin: await hashPin(state.pin), pinSetAt: now },
            wallet: { primaryAddress: walletData.address, walletId: walletData.walletId, chainType: walletData.chainType, balance: { AVAX: "0" }, lastBalanceUpdate: now },
            stats: { gamesPlayed: 0, totalEarned: "0", transactionCount: 0 },
            createdAt: now, lastSeen: now
        };
        if (await createUserInDatabase(userData)) {
            registrationStates.delete(userPhoneNumber);
            await sendMessage(userPhoneNumber, `🎉 Account created successfully!\n\n✅ Username: ${state.username}\n💰 Wallet Address: ${walletData.address}\n\nWelcome to Mort!`);
            setTimeout(async () => {
                const user = await getUserFromDatabase(userPhoneNumber);
                await sendWelcomeBackMessage(userPhoneNumber, user);
            }, 1000);
        } else {
            await sendMessage(userPhoneNumber, "❌ Error creating account.");
            registrationStates.delete(userPhoneNumber);
        }
    } catch (error) {
        console.error("❌ Error creating account:", error);
        await sendMessage(userPhoneNumber, "❌ Error creating your account.");
        registrationStates.delete(userPhoneNumber);
    }
}

async function sendWalletMenu(to, user) {
    try {
        await axios({
            url: `https://graph.facebook.com/v22.0/696395350222810/messages`,
            method: "POST", headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
            data: {
                messaging_product: "whatsapp", to, type: "interactive",
                interactive: {
                    type: "button", header: { type: "text", text: `💰 ${user.username}'s Wallet` },
                    body: { text: `Your Wallet Address:\n${user.wallet.primaryAddress}\n\nWhat would you like to do?` },
                    footer: { text: "Avalanche Fuji Network" },
                    action: { buttons: [{ type: "reply", reply: { id: "send_crypto", title: "💸 Send Crypto" } }, { type: "reply", reply: { id: "receive_crypto", title: "📥 Receive Crypto" } }, { type: "reply", reply: { id: "view_balance", title: "📊 View Balance" } }] }
                }
            },
        });
        console.log("✅ Wallet menu sent to:", to);
    } catch (error) {
        console.error("❌ Error sending wallet menu:", error.response?.data || error.message);
    }
}

async function sendGamesMenu(to, user) {
    try {
        await axios({
            url: `https://graph.facebook.com/v22.0/696395350222810/messages`,
            method: "POST", headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
            data: {
                messaging_product: "whatsapp", to, type: "interactive",
                interactive: {
                    type: "button", header: { type: "text", text: `🎮 ${user.username}'s Games` },
                    body: { text: `Games Played: ${user.stats.gamesPlayed}\nChoose a game to play:` },
                    footer: { text: "Play • Earn • Have Fun" },
                    action: { buttons: [{ type: "reply", reply: { id: "flip_it", title: "🎲 Flip It" } }, { type: "reply", reply: { id: "rock_paper_scissors", title: "✂️ Rock Paper" } }, { type: "reply", reply: { id: "guess_number", title: "🔢 Guess Number" } }] }
                }
            },
        });
        console.log("✅ Games menu sent to:", to);
    } catch (error) {
        console.error("❌ Error sending games menu:", error.response?.data || error.message);
    }
}

async function sendMainMenu(to, user) {
    try {
        const publicClient = createPublicClient({ chain: avalancheFuji, transport: http() });
        const balance = await publicClient.getBalance({ address: user.wallet.primaryAddress });
        const user_bal = Number(formatEther(balance)).toFixed(3);
        const avaxPrice = await fetchAvaxPrice();
        const usdValue = avaxPrice * parseFloat(user_bal);

        await axios({
            url: `https://graph.facebook.com/v22.0/696395350222810/messages`,
            method: "POST",
            headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
            data: {
                messaging_product: "whatsapp", to, type: "interactive",
                interactive: {
                    type: "button", header: { type: "text", text: "What's Next?" },
                    body: { text: `Your current balance is\n🔺AVAX: ${user_bal}\n💲${usdValue.toFixed(2)}\n\nChoose an option to continue.`},
                    footer: { text: "Mort by Hot Coffee" },
                    action: { buttons: [{ type: "reply", reply: { id: "games_option", title: "🎮 Games" } }, { type: "reply", reply: { id: "wallet_option", title: "💰 Wallet" } }] }
                }},
        });
        console.log("✅ Main menu sent to:", to);
    } catch (error) {
        console.error("❌ Error sending main menu:", error.response?.data || error.message);
    }
}

async function sendPostGameMenu(to) {
    try {
        const publicClient = createPublicClient({ chain: avalancheFuji, transport: http() });
        const user = await getUserFromDatabase(to);
        if (!user) return;

        const balance = await publicClient.getBalance({ address: user.wallet.primaryAddress });
        const balanceFormatted = Number(formatEther(balance)).toFixed(3);

        const data = {
            messaging_product: "whatsapp",
            to,
            type: "interactive",
            interactive: {
                type: "button",
                header: { type: "text", text: "Round Complete!" },
                body: { text: `Your current balance is 🔺 *${balanceFormatted} AVAX*.\n\nWhat would you like to do next?` },
                footer: { text: "Choose an option to continue" },
                action: {
                    buttons: [
                        { type: "reply", reply: { id: "games_option", title: "🎮 Play Games" } },
                        { type: "reply", reply: { id: "wallet_option", title: "💰 Go to Wallet" } }
                    ]
                }
            }
        };

        await axios({
            url: `https://graph.facebook.com/v22.0/696395350222810/messages`,
            method: "POST", headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
            data: data,
        });
        console.log("✅ Post-game menu sent to:", to);
    } catch (error) {
        console.error("❌ Error sending post-game menu:", error.response?.data || error.message);
    }
}

async function handleReceiveCrypto(userPhoneNumber, user) {
    await sendMessage(userPhoneNumber, user.wallet.primaryAddress);
    await sendMessage(userPhoneNumber, `📥 Send 🔺AVAX to this address on the Avalanche Fuji network.`);
    setTimeout(() => sendMainMenu(userPhoneNumber, user), 2000);
}

async function handleViewBalance(userPhoneNumber, user) {
    try {
        const price = await fetchAvaxPrice();
        await sendMessage(userPhoneNumber, "📊 Checking your balance...");
        const publicClient = createPublicClient({ chain: avalancheFuji, transport: http() });
        const balance = await publicClient.getBalance({ address: user.wallet.primaryAddress });
        const user_bal = Number(formatEther(balance)).toFixed(3);
        await sendMessage(userPhoneNumber, `💰 Wallet Balance\n🔺AVAX: ${user_bal}\n💲${(parseFloat(user_bal) * price).toFixed(2)}`);
        setTimeout(() => sendMainMenu(userPhoneNumber, user), 2000);
    } catch (error) {
        console.error("❌ Error fetching balance:", error);
        await sendMessage(userPhoneNumber, "❌ Sorry, I couldn't fetch your balance right now.");
    }
}

async function handlePinForTransaction(userPhoneNumber, enteredPin, userState) {
    const { user, transaction } = userState;
    const isValidPin = await bcrypt.compare(enteredPin, user.security.hashedPin);
    if (!isValidPin) {
        await sendMessage(userPhoneNumber, "❌ Incorrect PIN. Transaction cancelled.");
        userStates.delete(userPhoneNumber);
        setTimeout(() => sendMainMenu(userPhoneNumber, user), 1500);
        return;
    }
    await sendMessage(userPhoneNumber, "✅ PIN verified. Processing transaction...");
    try {
        const account = await createViemAccount({
            walletId: user.wallet.walletId,
            address: user.wallet.primaryAddress,
            privy
        });
        const client = createWalletClient({ account, chain: avalancheFuji, transport: http() });
        const txHash = await client.sendTransaction({ to: transaction.toAddress, value: parseEther(transaction.amount) });
        const explorerUrl = `https://testnet.snowtrace.io/tx/${txHash}`;
        await sendMessage(userPhoneNumber, `🎉 Transaction Successful!\n${explorerUrl}`);
        await updateDoc(doc(db, 'users', userPhoneNumber), { 'stats.transactionCount': (user.stats.transactionCount || 0) + 1 });
    } catch (txError) {
        console.error("TX Error:", txError.message);
        await sendMessage(userPhoneNumber, "❌ Transaction failed. Please check your balance and try again.");
    }
    userStates.delete(userPhoneNumber);
    setTimeout(() => sendMainMenu(userPhoneNumber, user), 2000);
}

async function startBlockchainListener() {
    console.log("👂 Starting blockchain event listener with WebSocket...");
    const publicClient = createPublicClient({
        chain: avalancheFuji,
        transport: webSocket(WSS_RPC_URL)
    });

    publicClient.watchContractEvent({
        address: FLIP_GAME_CONTRACT_ADDRESS, abi: flipGameAbi, eventName: 'FlipResolved',
        onLogs: async (logs) => {
            for (const log of logs) {
                try {
                    const { requestId, won, payout = 0n } = log.args;
                    const requestIdStr = requestId.toString();
                    const flipDocRef = doc(db, 'flips', requestIdStr);
                    const flipDocSnap = await getDoc(flipDocRef);

                    if (!flipDocSnap.exists() || flipDocSnap.data().status !== 'pending') continue;

                    const flipData = flipDocSnap.data();
                    const userDocRef = doc(db, 'users', flipData.whatsappId);
                    const userDocSnap = await getDoc(userDocRef);
                    if (!userDocSnap.exists()) continue;

                    const userData = userDocSnap.data();
                    const payoutFormatted = formatEther(payout);
                    
                    const userChoice = flipData.choice;
                    const userChoiceStr = userChoice === 0 ? 'Heads' : 'Tails';
                    
                    const actualResult = won ? userChoice : (1 - userChoice);
                    const resultStr = actualResult === 0 ? '🗿 Heads' : '🪙 Tails';

                    let messageBody;
                    if (won) {
                        messageBody = `The coin landed on *${resultStr}*!\n\nYou chose *${userChoiceStr}* and WON! 🎉\n\nYou've received ${payoutFormatted} AVAX.`;
                    } else {
                        messageBody = `The coin landed on *${resultStr}*.\n\nYou chose *${userChoiceStr}* and lost.\nBetter luck next time!`;
                    }
                    
                    await sendMessage(flipData.whatsappId, messageBody);

                    await updateDoc(flipDocRef, { 
                        status: 'resolved', 
                        result: won ? 'won' : 'lost', 
                        payoutAmount: payoutFormatted, 
                        resolvedTimestamp: serverTimestamp() 
                    });
                    
                    const userStatsUpdate = {
                        'stats.gamesPlayed': (userData.stats.gamesPlayed || 0) + 1
                    };

                    if (won) {
                        const newTotalEarned = (parseFloat(userData.stats.totalEarned || "0") + parseFloat(payoutFormatted)).toString();
                        userStatsUpdate['stats.totalEarned'] = newTotalEarned;
                    }

                    await updateDoc(userDocRef, userStatsUpdate);

                    setTimeout(() => {
                        sendPostGameMenu(flipData.whatsappId);
                    }, 2000);

                } catch(e) { 
                    console.error("Error processing a resolved flip log:", e); 
                }
            }
        },
        onError: (error) => console.error("Blockchain listener error:", error)
    });
}

async function handleSendCrypto(userPhoneNumber, user) {
    userStates.set(userPhoneNumber, { type: 'awaiting_transaction', user: user });
    
    try {
        await axios({
            url: `https://graph.facebook.com/v22.0/696395350222810/messages`,
            method: "POST",
            headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
            data: {
                messaging_product: "whatsapp",
                to: userPhoneNumber,
                type: "interactive",
                interactive: {
                    type: "button",
                    body: { text: "💸 *Send Crypto*\nPlease enter the transaction details in this format:\n\n`send [amount] to [address]`" },
                    action: {
                        buttons: [
                            { type: "reply", reply: { id: "cancel_operation", title: "❌ Cancel" } }
                        ]
                    }
                }
            }
        });
    } catch (error) {
        console.error("❌ Error sending send crypto prompt:", error.response?.data || error.message);
        await sendMessage(userPhoneNumber, "💸 Send Crypto\nPlease enter in this format: 'send [amount] to [address]'\n\n(Reply with 'cancel' to exit)");
    }
}

async function handleTransactionInput(userPhoneNumber, userText, user) {
    const regex = /send\s+([\d.]+)\s+to\s+(0x[a-fA-F0-9]{40})/i;
    const match = userText.match(regex);
    if (!match) {
        await sendMessage(userPhoneNumber, "❌ Invalid format. Please use:\n`send [amount] to [address]`\n\nOr press Cancel below.");
        return;
    }
    const [_, amount, toAddress] = match;
    userStates.set(userPhoneNumber, { type: 'awaiting_pin_for_transaction', user: user, transaction: { amount, toAddress } });

    try {
        const bodyText = `🔐 *Confirm Transaction*\n\n*Amount:* ${amount} AVAX\n*To:* ${toAddress}\n\nPlease enter your PIN to confirm.`
        await axios({
            url: `https://graph.facebook.com/v22.0/696395350222810/messages`,
            method: "POST",
            headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
            data: {
                messaging_product: "whatsapp",
                to: userPhoneNumber,
                type: "interactive",
                interactive: {
                    type: "button",
                    body: { text: bodyText },
                    action: {
                        buttons: [
                            { type: "reply", reply: { id: "cancel_operation", title: "❌ Cancel" } }
                        ]
                    }
                }
            }
        });
    } catch (error) {
        console.error("❌ Error sending PIN prompt:", error.response?.data || error.message);
        await sendMessage(userPhoneNumber, `🔐 Confirm Transaction\n💸 Amount: ${amount} AVAX\nTo: ${toAddress}\n\nEnter your PIN:`);
    }
}

async function handleStartFlipGame(to, user) {
    try {
        await axios({
            url: `https://graph.facebook.com/v22.0/696395350222810/messages`,
            method: "POST", headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
            data: {
                messaging_product: "whatsapp", to, type: "interactive",
                interactive: {
                    type: "button", header: { type: "text", text: "🎲 Flip It Game" },
                    body: { text: "Heads or Tails? Make your choice." }, footer: { text: "Provably fair on-chain coin flip." },
                    action: { buttons: [{ type: "reply", reply: { id: "flip_choice_heads", title: "🗿 Heads" } }, { type: "reply", reply: { id: "flip_choice_tails", title: "🪙 Tails" } }] }
                }
            }
        });
    } catch (error) {
        console.error("❌ Error sending flip game start message:", error.response?.data || error.message);
    }
}

async function sendFlipAmountMenu(to, choice) {
    const choiceText = choice === 0 ? "Heads" : "Tails";
    try {
        await axios({
            url: `https://graph.facebook.com/v22.0/696395350222810/messages`,
            method: "POST",
            headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
            data: {
                messaging_product: "whatsapp",
                to,
                type: "interactive",
                interactive: {
                    type: "button",
                    header: { type: "text", text: `You Chose ${choiceText}` },
                    body: { text: "How much AVAX would you like to bet? 🔺" },
                    footer: { text: "Select a bet amount" },
                    action: {
                        buttons: [
                            { type: "reply", reply: { id: "flip_amount_0.001", title: "0.001 AVAX" } },
                            { type: "reply", reply: { id: "flip_amount_0.01", title: "0.01 AVAX" } },
                            { type: "reply", reply: { id: "flip_amount_0.1", title: "0.1 AVAX" } }
                        ]
                    }
                }
            }
        });
    } catch (error) {
        console.error("❌ Error sending flip amount menu:", error.response?.data || error.message);
        await sendMessage(to, "Sorry, there was an error. Please try starting the game again.");
        userStates.delete(to);
    }
}

async function handleFlipChoice(phone, user, choice) {
    userStates.set(phone, { type: 'awaiting_flip_amount', user, choice });
    await sendFlipAmountMenu(phone, choice);
}

async function handleFlipAmountSelection(phone, amount, state) {
    const { user, choice } = state;
    await sendMessage(phone, `🔐 Confirm Flip\n\n🎲 Choice: ${choice === 0 ? 'Heads' : 'Tails'}\n💸 Bet: ${amount} AVAX\n\nEnter your PIN:`);
    userStates.set(phone, { type: 'awaiting_pin_for_flip', user, flip: { amount, choice } });
}

async function handlePinForFlip(phone, pin, state) {
    const { user, flip } = state;
    try {
        if (!(await bcrypt.compare(pin, user.security.hashedPin))) {
            userStates.delete(phone);
            await sendMessage(phone, "❌ Incorrect PIN. Game cancelled.");
            setTimeout(() => sendGamesMenu(phone, user), 1500);
            return;
        }
        await sendMessage(phone, "✅ PIN verified. Placing your bet...");
        const result = await executeFlipTransaction(user, flip.choice, flip.amount);
        const explorerUrl = `https://testnet.snowtrace.io/tx/${result.hash}`;
        if (result.success) {
            await sendMessage(phone, `🎉 Bet placed! We'll notify you of the result.\n\nTransaction Hash:\n${explorerUrl}`);
        } else {
            await sendMessage(phone, `❌ Bet failed. ${result.error || "Check balance and try again."}`);
        }
    } catch (e) {
        await sendMessage(phone, "❌ Bet failed due to a network or balance issue.");
        console.error("Error during flip transaction execution:", e.message);
    } finally {
        userStates.delete(phone);
    }
}

async function executeFlipTransaction(user, choice, amount) {
    try {
        const account = await createViemAccount({
            walletId: user.wallet.walletId,
            address: user.wallet.primaryAddress,
            privy
        });
        const walletClient = createWalletClient({ account, chain: avalancheFuji, transport: http() });
        const publicClient = createPublicClient({ chain: avalancheFuji, transport: http() });

        const hash = await walletClient.writeContract({ address: FLIP_GAME_CONTRACT_ADDRESS, abi: flipGameAbi, functionName: 'flip', args: [choice], value: parseEther(amount) });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });

        for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== FLIP_GAME_CONTRACT_ADDRESS.toLowerCase()) {
                continue;
            }
            try {
                const decodedEvent = decodeEventLog({ abi: flipGameAbi, data: log.data, topics: log.topics });
                if (decodedEvent.eventName === 'FlipRequested') {
                    await setDoc(doc(db, 'flips', decodedEvent.args.requestId.toString()), {
                        whatsappId: user.whatsappId, username: user.username, betAmount: amount, choice, status: 'pending', requestTimestamp: serverTimestamp(), txHash: hash
                    });
                    return { success: true, hash };
                }
            } catch (e) {
                console.warn("Could not decode a log from the game contract:", e.message);
            }
        }
        return { success: false, error: 'Could not confirm request ID on-chain.' };
    } catch (e) {
        console.error("Flip TX Error:", e);
        throw e;
    }
}

async function sendMessage(to, body) {
    try {
        await axios({
            url: "https://graph.facebook.com/v22.0/696395350222810/messages",
            method: "POST", headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
            data: { messaging_product: "whatsapp", to, type: "text", text: { body } }
        });
    } catch (error) {
        console.error("❌ Error sending message:", error.response?.data || error.message);
    }
}

app.listen(PORT, () => {
    console.log("🚀 Web3 ChatBot Server running on port", PORT);
    startBlockchainListener().catch(error => {
        console.error("🔥 Fatal error starting the blockchain listener:", error);
    });
});