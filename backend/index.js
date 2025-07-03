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
dotenv.config();

const flipGameAbi = require('./abi/flipAbi.json');
const rpsGameAbi = require('./abi/rpsAbi.json');
const luckyNumberAbi = require('./abi/luckyNumberAbi.json');

const WEBHOOK_VERIFY_TOKEN = process.env.WHATSAPP_HOOK_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PORT = process.env.PORT;

const PRIVY_APP_ID = process.env.PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;

const FLIP_GAME_CONTRACT_ADDRESS = process.env.FLIP_GAME_CONTRACT_ADDRESS;
const RPS_GAME_CONTRACT_ADDRESS = process.env.RPS_GAME_CONTRACT_ADDRESS;
const LUCKY_NUMBER_GAME_CONTRACT_ADDRESS = process.env.LUCKY_NUMBER_GAME_CONTRACT_ADDRESS;

const WSS_RPC_URL = process.env.AVAX_RPC_WSS_URL;
const SENDER_WALLET_ID = process.env.SENDER_WALLET_ID;
const SENDER_WALLET_ADDRESS = process.env.SENDER_WALLET_ADDRESS;
const FUNDING_AMOUNT_AVAX = '0.1';

const firebaseConfig = {
    apiKey: "AIzaSyAg4wuPWMxgDxGYUpxDT-2vAI34AjwvcQg",
    authDomain: "mypiggybanksave.firebaseapp.com",
    projectId: "mypiggybanksave",
    storageBucket: "mypiggybanksave.firebasestorage.app",
    messagingSenderId: "1081850835040",
    appId: "1:1081850835040:web:80eef2a1451af90b3b9305",
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

async function sendTransactionSuccessMessage(to, txHash, messageHeader) {
    try {
        const explorerUrl = `https://testnet.snowtrace.io/tx/${txHash}`;
        await sendMessage(to, `${messageHeader}\n\n*Transaction Hash:*\n${txHash}`);
        
        const data = {
            messaging_product: "whatsapp", to, type: "interactive",
            interactive: {
                type: "cta_url",
                body: { text: "Click the button below to see your transaction on the explorer." },
                action: { name: "cta_url", parameters: { display_text: "View on Explorer", url: explorerUrl } }
            }
        };

        await axios({
            url: `https://graph.facebook.com/v22.0/696395350222810/messages`,
            method: "POST", headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
            data,
        });
    } catch (error) {
        console.error("❌ Error sending cta_url message:", error.response?.data || error.message);
        await sendMessage(to, `${messageHeader}\n\nView your transaction here:\nhttps://testnet.snowtrace.io/tx/${txHash}`);
    }
}

async function getUserFromDatabase(whatsappId) {
    try {
        const userRef = doc(db, 'users', whatsappId);
        const userSnap = await getDoc(userRef);
        return userSnap.exists() ? { id: userSnap.id, ...userSnap.data() } : null;
    } catch (error) {
        console.error("❌ Error fetching user:", error);
        return null;
    }
}

async function createUserInDatabase(userData) {
    try {
        const userRef = doc(db, 'users', userData.whatsappId);
        await setDoc(userRef, userData);
        const usernameRef = doc(db, 'usernames', userData.username.toLowerCase());
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

async function getUserByUsername(username) {
    try {
        const usernameRef = doc(db, 'usernames', username.toLowerCase());
        const usernameSnap = await getDoc(usernameRef);
        if (!usernameSnap.exists()) return null;
        const { whatsappId } = usernameSnap.data();
        return await getUserFromDatabase(whatsappId);
    } catch (error) {
        console.error("❌ Error fetching user by username:", error);
        return null;
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
        await updateDoc(doc(db, 'users', whatsappId), { lastSeen: serverTimestamp() });
    } catch (error) {
        console.error("❌ Error updating last seen:", error);
    }
}

async function createWalletForUser(username) {
    try {
        console.log("🔗 Creating wallet for user:", username);
        const { id, address, chainType } = await privy.walletApi.create({ chainType: 'ethereum' });
        console.log("✅ Wallet created successfully:", "ID:", id, "Address:", address);
        return { walletId: id, address: address, chainType: chainType };
    } catch (error) {
        console.error("❌ Error creating wallet:", error);
        throw error;
    }
}

async function fundNewUser(recipientAddress, recipientPhoneNumber) {
    try {
        console.log(`ℹ️ Funding new user: ${recipientAddress} with ${FUNDING_AMOUNT_AVAX} AVAX.`);
        const account = await createViemAccount({
            walletId: SENDER_WALLET_ID,
            address: SENDER_WALLET_ADDRESS,
            privy: privy
        });
        const client = createWalletClient({ account, chain: avalancheFuji, transport: http() });
        const txHash = await client.sendTransaction({
            to: recipientAddress,
            value: parseEther(FUNDING_AMOUNT_AVAX),
            gas: 21000n
        });
        console.log(`✅ Successfully sent ${FUNDING_AMOUNT_AVAX} AVAX to ${recipientAddress}. Tx hash: ${txHash}`);
        await sendMessage(recipientPhoneNumber, `🎁 We've sent you *${FUNDING_AMOUNT_AVAX} AVAX* on the Fuji testnet to get you started! You can use it to play games.`);
        const fundingRef = doc(collection(db, 'fundingTransactions'));
        await setDoc(fundingRef, {
            to: recipientAddress,
            from: SENDER_WALLET_ADDRESS,
            amount: FUNDING_AMOUNT_AVAX,
            txHash: txHash,
            timestamp: serverTimestamp(),
            recipientPhoneNumber: recipientPhoneNumber
        });
    } catch (error) {
        console.error(`❌ Error funding new user ${recipientAddress}:`, error);
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
        if (!entry?.[0]?.changes?.[0]?.value?.messages) return res.sendStatus(200);
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
            } else { await sendNewUserWelcomeMessage(userPhoneNumber); }
            return res.sendStatus(200);
        }
        await updateUserLastSeen(userPhoneNumber);
        if (buttonId) {
            await handleButtonSelection(userPhoneNumber, buttonId, user);
        } else if (userText) {
            const lowerCaseText = userText.toLowerCase();
            if (lowerCaseText === "/games" || lowerCaseText === "games") await sendGamesMenu(userPhoneNumber, user);
            else if (lowerCaseText === "/wallet" || lowerCaseText === "wallet") await sendWalletMenu(userPhoneNumber, user);
            else await sendWelcomeBackMessage(userPhoneNumber, user);
        }
        res.sendStatus(200);
    } catch (error) { console.error("❌ Error handling webhook:", error); res.sendStatus(500); }
});

async function handleStatefulInput(userPhoneNumber, userText, buttonId, userState) {
    if (buttonId === 'cancel_operation') {
        userStates.delete(userPhoneNumber);
        await sendMessage(userPhoneNumber, "Action cancelled.");
        const user = await getUserFromDatabase(userPhoneNumber);
        if (user) setTimeout(() => sendMainMenu(userPhoneNumber, user), 1000);
        return;
    }
    const getAmountFromButton = (id) => id ? id.split('_')[id.split('_').length - 1] : null;

    if (userState.type === 'awaiting_transaction' && userText) await handleTransactionInput(userPhoneNumber, userText, userState.user);
    else if (userState.type === 'awaiting_pin_for_transaction' && userText) await handlePinForTransaction(userPhoneNumber, userText, userState);
    else if (userState.type === 'awaiting_flip_amount' && buttonId?.startsWith('flip_amount_')) await handleFlipAmountSelection(userPhoneNumber, getAmountFromButton(buttonId), userState);
    else if (userState.type === 'awaiting_pin_for_flip' && userText) await handlePinForFlip(userPhoneNumber, userText, userState);
    else if (userState.type === 'awaiting_rps_amount' && buttonId?.startsWith('rps_amount_')) await handleRpsAmountSelection(userPhoneNumber, getAmountFromButton(buttonId), userState);
    else if (userState.type === 'awaiting_pin_for_rps' && userText) await handlePinForRps(userPhoneNumber, userText, userState);
    else if (userState.type === 'awaiting_lucky_number_amount' && buttonId?.startsWith('lucky_amount_')) await handleLuckyNumberAmountSelection(userPhoneNumber, getAmountFromButton(buttonId), userState);
    else if (userState.type === 'awaiting_pin_for_lucky_play' && userText) await handlePinForLuckyPlay(userPhoneNumber, userText, userState);
    else if (userState.type === 'awaiting_lucky_number_guess' && userText) await handleLuckyNumberGuessInput(userPhoneNumber, userText, userState);
    else if (userState.type === 'awaiting_pin_for_lucky_guess' && userText) await handlePinForLuckyGuess(userPhoneNumber, userText, userState);
    else await sendMessage(userPhoneNumber, "Please complete the current action first.");
}

async function handleButtonSelection(userPhoneNumber, buttonId, user) {
    switch (buttonId) {
        case "games_option": await sendGamesMenu(userPhoneNumber, user); break;
        case "wallet_option": await sendWalletMenu(userPhoneNumber, user); break;
        case "send_crypto": await handleSendCrypto(userPhoneNumber, user); break;
        case "receive_crypto": await handleReceiveCrypto(userPhoneNumber, user); break;
        case "view_balance": await handleViewBalance(userPhoneNumber, user); break;
        case "flip_it": await handleStartFlipGame(userPhoneNumber, user); break;
        case "flip_choice_heads": await handleFlipChoice(userPhoneNumber, user, 0); break;
        case "flip_choice_tails": await handleFlipChoice(userPhoneNumber, user, 1); break;
        case "rock_paper_scissors": await handleStartRpsGame(userPhoneNumber, user); break;
        case "rps_choice_rock": await handleRpsChoice(userPhoneNumber, user, 0); break;
        case "rps_choice_paper": await handleRpsChoice(userPhoneNumber, user, 1); break;
        case "rps_choice_scissor": await handleRpsChoice(userPhoneNumber, user, 2); break;
        case "guess_number": await handleStartLuckyNumberGame(userPhoneNumber, user); break;
    }
}

async function startBlockchainListener() {
    let reconnectDelay = 5000; // 5 second delay to start up server
    let unwatchFlip, unwatchRps, unwatchLuckyReady, unwatchLuckyResult;

    const connectAndWatch = () => {
        console.log("👂 Attempting to connect to blockchain with WebSocket...");
        try {
            const publicClient = createPublicClient({
                chain: avalancheFuji,
                transport: webSocket(WSS_RPC_URL, {
                    retryCount: 5,
                    retryDelay: 2000,
                })
            });

            const handleListenerError = (error, gameName) => {
                console.error(`🔥 ${gameName} listener error:`, error.shortMessage || error.message);
                reconnect();
            };

            // Clean up any previous watchers before starting new ones
            if (unwatchFlip) unwatchFlip();
            if (unwatchRps) unwatchRps();
            if (unwatchLuckyReady) unwatchLuckyReady();
            if (unwatchLuckyResult) unwatchLuckyResult();

            unwatchFlip = publicClient.watchContractEvent({
                address: FLIP_GAME_CONTRACT_ADDRESS, abi: flipGameAbi, eventName: 'FlipResolved',
                onLogs: async (logs) => {
                    for (const log of logs) {
                        try {
                            const { requestId, won, payout = 0n } = log.args;
                            const flipDocRef = doc(db, 'flips', requestId.toString());
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
                            const messageBody = won ? `The coin landed on *${resultStr}*!\n\nYou chose *${userChoiceStr}* and WON! 🎉\n\nYou've received ${payoutFormatted} AVAX.` : `The coin landed on *${resultStr}*.\n\nYou chose *${userChoiceStr}* and lost.\nBetter luck next time!`;
                            await sendMessage(flipData.whatsappId, messageBody);
                            await updateDoc(flipDocRef, { status: 'resolved', result: won ? 'won' : 'lost', payoutAmount: payoutFormatted, resolvedTimestamp: serverTimestamp() });
                            const userStatsUpdate = { 'stats.gamesPlayed': (userData.stats.gamesPlayed || 0) + 1 };
                            if (won) userStatsUpdate['stats.totalEarned'] = (parseFloat(userData.stats.totalEarned || "0") + parseFloat(payoutFormatted)).toString();
                            await updateDoc(userDocRef, userStatsUpdate);
                            setTimeout(() => sendPostGameMenu(flipData.whatsappId), 2000);
                        } catch (e) { console.error("Error processing a resolved flip log:", e); }
                    }
                },
                onError: (error) => handleListenerError(error, "Flip Game")
            });

            unwatchRps = publicClient.watchContractEvent({
                address: RPS_GAME_CONTRACT_ADDRESS, abi: rpsGameAbi, eventName: 'GameResult',
                onLogs: async (logs) => {
                    for (const log of logs) {
                        try {
                            const { requestId, outcome, playerChoice, computerChoice, prizeAmount = 0n } = log.args;
                            const rpsDocRef = doc(db, 'rps_games', requestId.toString());
                            const rpsDocSnap = await getDoc(rpsDocRef);
                            if (!rpsDocSnap.exists() || rpsDocSnap.data().status !== 'pending') continue;
                            const rpsData = rpsDocSnap.data();
                            const userDocRef = doc(db, 'users', rpsData.whatsappId);
                            const userDocSnap = await getDoc(userDocRef);
                            if (!userDocSnap.exists()) continue;
                            const userData = userDocSnap.data();
                            const prizeFormatted = formatEther(prizeAmount);
                            const choiceMap = ['✊ Rock', '✋ Paper', '✌️ Scissor'];
                            let messageBody;
                            if (outcome === 0) messageBody = `*You Win! 🎉*\n\nYou chose ${choiceMap[playerChoice]}\nComputer chose ${choiceMap[computerChoice]}\n\nYou won ${prizeFormatted} AVAX!`;
                            else if (outcome === 2) messageBody = `*It's a Draw! 🤝*\n\nYou chose ${choiceMap[playerChoice]}\nComputer chose ${choiceMap[computerChoice]}\n\nYour bet of ${rpsData.betAmount} AVAX was returned.`;
                            else messageBody = `*You Lose 😔*\n\nYou chose ${choiceMap[playerChoice]}\nComputer chose ${choiceMap[computerChoice]}\n\nBetter luck next time!`;
                            await sendMessage(rpsData.whatsappId, messageBody);
                            await updateDoc(rpsDocRef, { status: 'resolved', result: ['Win', 'Loss', 'Draw'][outcome], prizeAmount: prizeFormatted, resolvedTimestamp: serverTimestamp() });
                            const userStatsUpdate = { 'stats.gamesPlayed': (userData.stats.gamesPlayed || 0) + 1 };
                            if (outcome === 0) userStatsUpdate['stats.totalEarned'] = (parseFloat(userData.stats.totalEarned || "0") + parseFloat(prizeFormatted)).toString();
                            await updateDoc(userDocRef, userStatsUpdate);
                            setTimeout(() => sendPostGameMenu(rpsData.whatsappId), 2000);
                        } catch (e) { console.error("Error processing a resolved RPS log:", e); }
                    }
                },
                onError: (error) => handleListenerError(error, "RPS Game")
            });

            unwatchLuckyReady = publicClient.watchContractEvent({
                address: LUCKY_NUMBER_GAME_CONTRACT_ADDRESS, abi: luckyNumberAbi, eventName: 'GameReady',
                onLogs: async (logs) => {
                    for (const log of logs) {
                        try {
                            const { id, numbers } = log.args;
                            const gameDocRef = doc(db, 'lucky_games', id.toString());
                            const gameDocSnap = await getDoc(gameDocRef);
                            if (!gameDocSnap.exists() || gameDocSnap.data().status !== 'pending') continue;
                            const gameData = gameDocSnap.data();
                            const user = await getUserFromDatabase(gameData.whatsappId);
                            if (!user) continue;
                            await updateDoc(gameDocRef, { status: 'ready', drawnNumbers: numbers });
                            await sendLuckyNumberGuessMenu(gameData.whatsappId, id, numbers);
                        } catch (e) { console.error("Error processing a ready Lucky Number game:", e); }
                    }
                },
                onError: (error) => handleListenerError(error, "Lucky Number (Ready)")
            });

            unwatchLuckyResult = publicClient.watchContractEvent({
                address: LUCKY_NUMBER_GAME_CONTRACT_ADDRESS, abi: luckyNumberAbi, eventName: 'GameResult',
                onLogs: async (logs) => {
                    for (const log of logs) {
                        try {
                            const { id, outcome, winningIndex, prize = 0n } = log.args;
                            const gameDocRef = doc(db, 'lucky_games', id.toString());
                            const gameDocSnap = await getDoc(gameDocRef);
                            if (!gameDocSnap.exists() || gameDocSnap.data().status === 'resolved') continue;
                            const gameData = gameDocSnap.data();
                            const userDocRef = doc(db, 'users', gameData.whatsappId);
                            const userDocSnap = await getDoc(userDocRef);
                            if (!userDocSnap.exists()) continue;
                            const userData = userDocSnap.data();
                            const prizeFormatted = formatEther(prize);
                            const outcomeMap = ['You Win! 🎉', 'You Lose 😔'];
                            const guessedNumber = gameData.drawnNumbers[gameData.guessIndex];
                            const winningNumber = gameData.drawnNumbers[winningIndex];
                            const messageBody = `*${outcomeMap[outcome]}*\n\nYou guessed *${guessedNumber}*.\nThe winning number was *${winningNumber}*.\n\n${outcome === 0 ? `You won ${prizeFormatted} AVAX!` : 'Better luck next time!'}`;
                            await sendMessage(gameData.whatsappId, messageBody);
                            await updateDoc(gameDocRef, { status: 'resolved', result: outcome === 0 ? 'Win' : 'Loss', prizeAmount: prizeFormatted, winningIndex, resolvedTimestamp: serverTimestamp() });
                            const userStatsUpdate = { 'stats.gamesPlayed': (userData.stats.gamesPlayed || 0) + 1 };
                            if (outcome === 0) userStatsUpdate['stats.totalEarned'] = (parseFloat(userData.stats.totalEarned || "0") + parseFloat(prizeFormatted)).toString();
                            await updateDoc(userDocRef, userStatsUpdate);
                            setTimeout(() => sendPostGameMenu(gameData.whatsappId), 2000);
                        } catch (e) { console.error("Error processing a resolved Lucky Number log:", e); }
                    }
                },
                onError: (error) => handleListenerError(error, "Lucky Number (Result)")
            });
            
            console.log("✅ Blockchain listeners are active.");
            reconnectDelay = 5000; // Reset delay on successful connection
        } catch (error) {
            console.error("🔥 Failed to create public client or initial watch:", error.shortMessage || error.message);
            reconnect();
        }
    };
    
    const reconnect = () => {
        console.warn(`🔌 Socket disconnected. Attempting to reconnect in ${reconnectDelay / 1000} seconds...`);
        if (unwatchFlip) unwatchFlip();
        if (unwatchRps) unwatchRps();
        if (unwatchLuckyReady) unwatchLuckyReady();
        if (unwatchLuckyResult) unwatchLuckyResult();
        setTimeout(connectAndWatch, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 60000); 
    };

    connectAndWatch();
} 

async function fetchAvaxPrice() {
  const url = `${process.env.COINGECKO_API}/simple/price?ids=avalanche-2&vs_currencies=usd`;
  const headers = { 'Accept': 'application/json', 'x-cg-demo-api-key': process.env.COINGECKO_API_KEY };
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`CoinGecko API error: ${response.status} ${response.statusText}`);
    const data = await response.json();
    const price = data['avalanche-2']?.usd;
    if (price == null) throw new Error('Unexpected API response structure');
    return price;
  } catch (error) { console.error(error.message); return 0; }
}

async function handleNewUserFlow(userPhoneNumber, userText, registrationState) {
    if (!userText) {
        await sendMessage(userPhoneNumber, "Please provide the requested information to continue.");
        return;
    }
    switch (registrationState.step) {
        case REGISTRATION_STEPS.AWAITING_USERNAME: await handleUsernameInput(userPhoneNumber, userText); break;
        case REGISTRATION_STEPS.AWAITING_EMAIL: await handleEmailInput(userPhoneNumber, userText); break;
        case REGISTRATION_STEPS.AWAITING_PIN: await handlePinInput(userPhoneNumber, userText); break;
        case REGISTRATION_STEPS.CONFIRMING_PIN: await handlePinConfirmation(userPhoneNumber, userText); break;
        default: registrationStates.delete(userPhoneNumber); await sendNewUserWelcomeMessage(userPhoneNumber);
    }
}

async function sendNewUserWelcomeMessage(to) {
    try {
        await axios({
            url: `https://graph.facebook.com/v22.0/696395350222810/messages`,
            method: "POST", headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
            data: { messaging_product: "whatsapp", to, type: "interactive", interactive: { type: "button", header: { type: "text", text: "🚀 Welcome to Mort by Hot Coffee" }, body: { text: "Hello! I'm Morty, your Wallet Agent that enables you to:\n\n💰 Send & receive crypto\n🎮 Play games and earn crypto\n📱 Manage your digital wallet\n\nTo get started, you'll need to create your account. This will only take a minute!" }, footer: { text: "Secure • Fast • Easy" }, action: { buttons: [{ type: "reply", reply: { id: "create_account", title: "🔐 Create Account" } }] } } },
        });
        console.log("✅ New user welcome message sent to:", to);
    } catch (error) { console.error("❌ Error sending new user welcome message:", error.response?.data || error.message); }
}

async function sendWelcomeBackMessage(to, user) {
    try {
        await axios({
            url: `https://graph.facebook.com/v22.0/696395350222810/messages`,
            method: "POST", headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
            data: { messaging_product: "whatsapp", to, type: "interactive", interactive: { type: "button", header: { type: "text", text: `👋 Welcome back, ${user.username}!` }, body: { text: "Great to see you again! What would you like to do today?\n\n🎮 Play games and earn crypto\n💰 Manage your wallet and transactions" }, footer: { text: "Choose an option to continue" }, action: { buttons: [{ type: "reply", reply: { id: "games_option", title: "🎮 Games" } }, { type: "reply", reply: { id: "wallet_option", title: "💰 Wallet" } }] } } },
        });
        console.log("✅ Welcome back message sent to:", to);
    } catch (error) { console.error("❌ Error sending welcome back message:", error.response?.data || error.message); }
}

async function handleUsernameInput(userPhoneNumber, username) {
    if (username.length < 3 || username.length > 20 || !/^[a-zA-Z0-9_]+$/.test(username)) {
        await sendMessage(userPhoneNumber, "❌ Invalid username (3-20 chars, letters, numbers, underscores).");
        return;
    }
    const usernameExists = await checkUsernameExists(username.toLowerCase());
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
        const userData = { whatsappId: userPhoneNumber, username: state.username, email: state.email, security: { hashedPin: await hashPin(state.pin), pinSetAt: now }, wallet: { primaryAddress: walletData.address, walletId: walletData.walletId, chainType: walletData.chainType, balance: { AVAX: "0" }, lastBalanceUpdate: now }, stats: { gamesPlayed: 0, totalEarned: "0", transactionCount: 0 }, createdAt: now, lastSeen: now };
        if (await createUserInDatabase(userData)) {
            registrationStates.delete(userPhoneNumber);
            await sendMessage(userPhoneNumber, `🎉 Account created successfully!\n\n✅ Username: ${state.username}\n💰 Wallet Address: ${walletData.address}\n\nWelcome to Mort!`);
            await fundNewUser(walletData.address, userPhoneNumber);
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
            data: { messaging_product: "whatsapp", to, type: "interactive", interactive: { type: "button", header: { type: "text", text: `💰 ${user.username}'s Wallet` }, body: { text: `Your Wallet Address:\n${user.wallet.primaryAddress}\n\nWhat would you like to do?` }, footer: { text: "Avalanche Fuji Network" }, action: { buttons: [{ type: "reply", reply: { id: "send_crypto", title: "💸 Send Crypto" } }, { type: "reply", reply: { id: "receive_crypto", title: "📥 Receive Crypto" } }, { type: "reply", reply: { id: "view_balance", title: "📊 View Balance" } }] } } },
        });
        console.log("✅ Wallet menu sent to:", to);
    } catch (error) { console.error("❌ Error sending wallet menu:", error.response?.data || error.message); }
}

async function sendGamesMenu(to, user) {
    try {
        await axios({
            url: `https://graph.facebook.com/v22.0/696395350222810/messages`,
            method: "POST", headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
            data: { messaging_product: "whatsapp", to, type: "interactive", interactive: { type: "button", header: { type: "text", text: `🎮 ${user.username}'s Games` }, body: { text: `Games Played: ${user.stats.gamesPlayed}\nChoose a game to play:` }, footer: { text: "Play • Earn • Have Fun" }, action: { buttons: [{ type: "reply", reply: { id: "flip_it", title: "🎲 Flip It" } }, { type: "reply", reply: { id: "rock_paper_scissors", title: "✂️ Rock Paper" } }, { type: "reply", reply: { id: "guess_number", title: "🔢 Pick the Number" } }] } } },
        });
        console.log("✅ Games menu sent to:", to);
    } catch (error) { console.error("❌ Error sending games menu:", error.response?.data || error.message); }
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
            method: "POST", headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
            data: { messaging_product: "whatsapp", to, type: "interactive", interactive: { type: "button", header: { type: "text", text: "What's Next?" }, body: { text: `Your current balance is\n🔺AVAX: ${user_bal}\n💲${usdValue.toFixed(2)}\n\nChoose an option to continue.` }, footer: { text: "Mort by Hot Coffee" }, action: { buttons: [{ type: "reply", reply: { id: "games_option", title: "🎮 Games" } }, { type: "reply", reply: { id: "wallet_option", title: "💰 Wallet" } }] } } },
        });
        console.log("✅ Main menu sent to:", to);
    } catch (error) { console.error("❌ Error sending main menu:", error.response?.data || error.message); }
}

async function sendPostGameMenu(to) {
    try {
        const publicClient = createPublicClient({ chain: avalancheFuji, transport: http() });
        const user = await getUserFromDatabase(to);
        if (!user) return;
        const balance = await publicClient.getBalance({ address: user.wallet.primaryAddress });
        const balanceFormatted = Number(formatEther(balance)).toFixed(3);
        const data = { messaging_product: "whatsapp", to, type: "interactive", interactive: { type: "button", header: { type: "text", text: "Round Complete!" }, body: { text: `Your current balance is 🔺 *${balanceFormatted} AVAX*.\n\nWhat would you like to do next?` }, footer: { text: "Choose an option to continue" }, action: { buttons: [{ type: "reply", reply: { id: "games_option", title: "🎮 Play Again" } }, { type: "reply", reply: { id: "wallet_option", title: "💰 Go to Wallet" } }] } } };
        await axios({
            url: `https://graph.facebook.com/v22.0/696395350222810/messages`,
            method: "POST", headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
            data: data,
        });
        console.log("✅ Post-game menu sent to:", to);
    } catch (error) { console.error("❌ Error sending post-game menu:", error.response?.data || error.message); }
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
        const account = await createViemAccount({ walletId: user.wallet.walletId, address: user.wallet.primaryAddress, privy });
        const client = createWalletClient({ account, chain: avalancheFuji, transport: http() });
        const txHash = await client.sendTransaction({ to: transaction.toAddress, value: parseEther(transaction.amount) });
        await sendTransactionSuccessMessage(userPhoneNumber, txHash, "🎉 Transaction Successful!");
        await updateDoc(doc(db, 'users', userPhoneNumber), { 'stats.transactionCount': (user.stats.transactionCount || 0) + 1 });
    } catch (txError) {
        console.error("TX Error:", txError.message);
        await sendMessage(userPhoneNumber, "❌ Transaction failed. Please check your balance and try again.");
    }
    userStates.delete(userPhoneNumber);
    setTimeout(() => sendMainMenu(userPhoneNumber, user), 2000);
}

async function handleSendCrypto(userPhoneNumber, user) {
    userStates.set(userPhoneNumber, { type: 'awaiting_transaction', user: user });
    try {
        await axios({
            url: `https://graph.facebook.com/v22.0/696395350222810/messages`,
            method: "POST", headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
            data: { messaging_product: "whatsapp", to: userPhoneNumber, type: "interactive", interactive: { type: "button", body: { text: "💸 *Send Crypto*\nPlease enter the transaction details in one of these formats:\n\n`send [amount] to [address]`\n`send [amount] to [username]`" }, action: { buttons: [{ type: "reply", reply: { id: "cancel_operation", title: "❌ Cancel" } }] } } }
        });
    } catch (error) {
        console.error("❌ Error sending send crypto prompt:", error.response?.data || error.message);
        await sendMessage(userPhoneNumber, "💸 Send Crypto\nPlease enter in this format: 'send [amount] to [address]'\n\n(Reply with 'cancel' to exit)");
    }
}

async function handleTransactionInput(userPhoneNumber, userText, user) {
    const regex = /send\s+([\d.]+)\s+to\s+(0x[a-fA-F0-9]{40}|[a-zA-Z0-9_]{3,20})/i;
    const match = userText.match(regex);
    if (!match) {
        await sendMessage(userPhoneNumber, "❌ Invalid format. Please use:\n`send [amount] to [address]` or\n`send [amount] to [username]`");
        return;
    }
    const [_, amount, recipient] = match;
    let toAddress;
    let recipientIdentifier = recipient;
    if (/^0x[a-fA-F0-9]{40}$/i.test(recipient)) {
        toAddress = recipient;
        if (toAddress.toLowerCase() === user.wallet.primaryAddress.toLowerCase()) {
            await sendMessage(userPhoneNumber, "❌ You cannot send crypto to yourself.");
            return;
        }
    } else {
        const recipientUser = await getUserByUsername(recipient);
        if (!recipientUser) {
            await sendMessage(userPhoneNumber, `❌ User "${recipient}" not found. Please check the username and try again.`);
            return;
        }
        if (recipientUser.whatsappId === userPhoneNumber) {
            await sendMessage(userPhoneNumber, "❌ You cannot send crypto to yourself.");
            return;
        }
        toAddress = recipientUser.wallet.primaryAddress;
        recipientIdentifier = `${recipientUser.username} (${toAddress.substring(0, 6)}...${toAddress.substring(38)})`;
    }
    userStates.set(userPhoneNumber, { type: 'awaiting_pin_for_transaction', user: user, transaction: { amount, toAddress } });
    try {
        const bodyText = `🔐 *Confirm Transaction*\n\n*Amount:* ${amount} AVAX\n*To:* ${recipientIdentifier}\n\nPlease enter your PIN to confirm.`
        await axios({
            url: `https://graph.facebook.com/v22.0/696395350222810/messages`,
            method: "POST", headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
            data: { messaging_product: "whatsapp", to: userPhoneNumber, type: "interactive", interactive: { type: "button", body: { text: bodyText }, action: { buttons: [{ type: "reply", reply: { id: "cancel_operation", title: "❌ Cancel" } }] } } }
        });
    } catch (error) {
        console.error("❌ Error sending PIN prompt:", error.response?.data || error.message);
        await sendMessage(userPhoneNumber, `🔐 Confirm Transaction\n💸 Amount: ${amount} AVAX\nTo: ${recipientIdentifier}\n\nEnter your PIN:`);
    }
}

async function sendGameAmountMenu(to, choiceText, gamePrefix) {
    try {
        await axios({
            url: `https://graph.facebook.com/v22.0/696395350222810/messages`,
            method: "POST", headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
            data: { messaging_product: "whatsapp", to, type: "interactive", interactive: { type: "button", header: { type: "text", text: `You Chose ${choiceText}` }, body: { text: "How much AVAX would you like to bet? 🔺" }, footer: { text: "Select a bet amount" }, action: { buttons: [{ type: "reply", reply: { id: `${gamePrefix}_amount_0.001`, title: "0.001 AVAX" } }, { type: "reply", reply: { id: `${gamePrefix}_amount_0.01`, title: "0.01 AVAX" } }, { type: "reply", reply: { id: `${gamePrefix}_amount_0.1`, title: "0.1 AVAX" } }] } } }
        });
    } catch (error) {
        console.error(`❌ Error sending ${gamePrefix} amount menu:`, error.response?.data || error.message);
        await sendMessage(to, "Sorry, there was an error. Please try starting the game again.");
        userStates.delete(to);
    }
}

async function handleStartFlipGame(to, user) {
    try {
        await axios({
            url: `https://graph.facebook.com/v22.0/696395350222810/messages`,
            method: "POST", headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
            data: { messaging_product: "whatsapp", to, type: "interactive", interactive: { type: "button", header: { type: "text", text: "🎲 Flip It Game" }, body: { text: "Heads or Tails? Make your choice." }, footer: { text: "Provably fair on-chain coin flip." }, action: { buttons: [{ type: "reply", reply: { id: "flip_choice_heads", title: "🗿 Heads" } }, { type: "reply", reply: { id: "flip_choice_tails", title: "🪙 Tails" } }] } } }
        });
    } catch (error) { console.error("❌ Error sending flip game start message:", error.response?.data || error.message); }
}

async function handleFlipChoice(phone, user, choice) {
    userStates.set(phone, { type: 'awaiting_flip_amount', user, choice });
    const choiceText = choice === 0 ? "Heads" : "Tails";
    await sendGameAmountMenu(phone, choiceText, 'flip');
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
        if (result.success) {
            await sendTransactionSuccessMessage(phone, result.hash, "🎉 Bet Placed!");
        } else {
            await sendMessage(phone, `❌ Bet failed. ${result.error || "Check balance and try again."}`);
        }
    } catch (e) {
        await sendMessage(phone, "❌ Bet failed due to a network or balance issue.");
    } finally {
        userStates.delete(phone);
    }
}

async function executeFlipTransaction(user, choice, amount) {
    try {
        const account = await createViemAccount({ walletId: user.wallet.walletId, address: user.wallet.primaryAddress, privy });
        const walletClient = createWalletClient({ account, chain: avalancheFuji, transport: http() });
        const publicClient = createPublicClient({ chain: avalancheFuji, transport: http() });
        const hash = await walletClient.writeContract({ address: FLIP_GAME_CONTRACT_ADDRESS, abi: flipGameAbi, functionName: 'flip', args: [choice], value: parseEther(amount.toString()) });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== FLIP_GAME_CONTRACT_ADDRESS.toLowerCase()) continue;
            try {
                const decodedEvent = decodeEventLog({ abi: flipGameAbi, data: log.data, topics: log.topics });
                if (decodedEvent.eventName === 'FlipRequested') {
                    await setDoc(doc(db, 'flips', decodedEvent.args.requestId.toString()), { whatsappId: user.whatsappId, username: user.username, betAmount: amount, choice, status: 'pending', requestTimestamp: serverTimestamp(), txHash: hash });
                    return { success: true, hash };
                }
            } catch (e) { console.warn("Could not decode a log from the game contract:", e.message); }
        }
        return { success: false, error: 'Could not confirm request ID on-chain.' };
    } catch (e) {
        console.error("Flip TX Error:", e);
        throw e;
    }
}

async function handleStartRpsGame(to, user) {
    try {
        await axios({
            url: `https://graph.facebook.com/v22.0/696395350222810/messages`,
            method: "POST", headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
            data: { messaging_product: "whatsapp", to, type: "interactive", interactive: { type: "button", header: { type: "text", text: "✊ Rock Paper Scissor" }, body: { text: "Make your choice to begin!" }, action: { buttons: [ { type: "reply", reply: { id: "rps_choice_rock", title: "✊ Rock" } }, { type: "reply", reply: { id: "rps_choice_paper", title: "✋ Paper" } }, { type: "reply", reply: { id: "rps_choice_scissor", title: "✌️ Scissor" } } ] } } }
        });
    } catch (error) { console.error("❌ Error sending RPS start message:", error.response?.data || error.message); }
}

async function handleRpsChoice(phone, user, choice) {
    userStates.set(phone, { type: 'awaiting_rps_amount', user, choice });
    const choiceMap = ['✊ Rock', '✋ Paper', '✌️ Scissor'];
    await sendGameAmountMenu(phone, choiceMap[choice], 'rps');
}

async function handleRpsAmountSelection(phone, amount, state) {
    const { user, choice } = state;
    const choiceMap = ['Rock', 'Paper', 'Scissor'];
    await sendMessage(phone, `🔐 Confirm Game\n\n🎲 Choice: ${choiceMap[choice]}\n💸 Bet: ${amount} AVAX\n\nEnter your PIN:`);
    userStates.set(phone, { type: 'awaiting_pin_for_rps', user, rps: { amount, choice } });
}

async function handlePinForRps(phone, pin, state) {
    const { user, rps } = state;
    try {
        if (!(await bcrypt.compare(pin, user.security.hashedPin))) {
            userStates.delete(phone);
            await sendMessage(phone, "❌ Incorrect PIN. Game cancelled.");
            setTimeout(() => sendGamesMenu(phone, user), 1500);
            return;
        }
        await sendMessage(phone, "✅ PIN verified. Placing your bet...");
        const result = await executeRpsTransaction(user, rps.choice, rps.amount);
        if (result.success) {
            await sendTransactionSuccessMessage(phone, result.hash, "🎉 Bet Placed!");
        } else {
            await sendMessage(phone, `❌ Bet failed. ${result.error || "Check balance and try again."}`);
        }
    } catch (e) {
        await sendMessage(phone, "❌ Bet failed due to a network or balance issue.");
    } finally {
        userStates.delete(phone);
    }
}

async function executeRpsTransaction(user, choice, amount) {
    try {
        const account = await createViemAccount({ walletId: user.wallet.walletId, address: user.wallet.primaryAddress, privy });
        const walletClient = createWalletClient({ account, chain: avalancheFuji, transport: http() });
        const publicClient = createPublicClient({ chain: avalancheFuji, transport: http() });
        const hash = await walletClient.writeContract({ address: RPS_GAME_CONTRACT_ADDRESS, abi: rpsGameAbi, functionName: 'play', args: [choice], value: parseEther(amount.toString()) });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== RPS_GAME_CONTRACT_ADDRESS.toLowerCase()) continue;
            try {
                const decodedEvent = decodeEventLog({ abi: rpsGameAbi, data: log.data, topics: log.topics });
                if (decodedEvent.eventName === 'GamePlayed') {
                    await setDoc(doc(db, 'rps_games', decodedEvent.args.requestId.toString()), {
                        whatsappId: user.whatsappId, username: user.username, betAmount: amount, choice, status: 'pending', requestTimestamp: serverTimestamp(), txHash: hash
                    });
                    return { success: true, hash };
                }
            } catch (e) { console.warn("Could not decode a log from the RPS contract:", e.message); }
        }
        return { success: false, error: 'Could not confirm RPS request ID on-chain.' };
    } catch (e) {
        console.error("RPS TX Error:", e);
        throw e;
    }
}


async function handleStartLuckyNumberGame(to, user) {
    try {
        const bodyText = "🔢 *Welcome to Pick the Lucky Number!* \n\nI'll show you 5 numbers. Just pick the one you think is lucky to win!\n\nFirst, how much would you like to bet?";
        await axios({
            url: `https://graph.facebook.com/v22.0/696395350222810/messages`,
            method: "POST", headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
            data: { 
                messaging_product: "whatsapp", 
                to, 
                type: "interactive", 
                interactive: { 
                    type: "button", 
                    header: { type: "text", text: "💰 Choose Your Bet" },
                    body: { text: bodyText },
                    footer: { text: "Select a bet amount below" },
                    action: { buttons: [
                        { type: "reply", reply: { id: "lucky_amount_0.001", title: "0.001 AVAX" } },
                        { type: "reply", reply: { id: "lucky_amount_0.01", title: "0.01 AVAX" } }, 
                        { type: "reply", reply: { id: "lucky_amount_0.1", title: "0.1 AVAX" } }
                    ] } 
                } 
            },
        });
        userStates.set(to, { type: 'awaiting_lucky_number_amount', user });
    } catch (error) {
        console.error("❌ Error sending Lucky Number start menu:", error.response?.data || error.message);
        await sendMessage(to, "Sorry, there was an error starting the game. Please try again.");
    }
}

async function handleLuckyNumberAmountSelection(phone, amount, state) {
    const { user } = state;
    await sendMessage(phone, `🔐 *Confirm Bet*\n\n💸 Bet: ${amount} AVAX\n\nTo start the game and see your numbers, please enter your PIN:`);
    userStates.set(phone, { type: 'awaiting_pin_for_lucky_play', user, betAmount: amount });
}

async function handlePinForLuckyPlay(phone, pin, state) {
    const { user, betAmount } = state;
    try {
        if (!(await bcrypt.compare(pin, user.security.hashedPin))) {
            userStates.delete(phone);
            await sendMessage(phone, "❌ Incorrect PIN. Game cancelled.");
            setTimeout(() => sendGamesMenu(phone, user), 1500);
            return;
        }
        await sendMessage(phone, "✅ PIN verified. Drawing your lucky numbers now...");
        const result = await executeLuckyNumberPlay(user, betAmount);
        if (result.success) {
            await sendMessage(phone, `🎉 Game started! We'll send your 5 numbers in just a moment.`);
        } else {
            await sendMessage(phone, `❌ Game could not be started. ${result.error || "Please try again."}`);
        }
    } catch (e) {
        await sendMessage(phone, "❌ Game failed due to a network or balance issue.");
    } finally {
        userStates.delete(phone);
    }
}

async function executeLuckyNumberPlay(user, amount) {
    try {
        const account = await createViemAccount({ walletId: user.wallet.walletId, address: user.wallet.primaryAddress, privy });
        const walletClient = createWalletClient({ account, chain: avalancheFuji, transport: http() });
        const publicClient = createPublicClient({ chain: avalancheFuji, transport: http() });
        const hash = await walletClient.writeContract({ address: LUCKY_NUMBER_GAME_CONTRACT_ADDRESS, abi: luckyNumberAbi, functionName: 'play', args: [], value: parseEther(amount.toString()) });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== LUCKY_NUMBER_GAME_CONTRACT_ADDRESS.toLowerCase()) continue;
            try {
                const decodedEvent = decodeEventLog({ abi: luckyNumberAbi, data: log.data, topics: log.topics });
                if (decodedEvent.eventName === 'GameStarted') {
                    await setDoc(doc(db, 'lucky_games', decodedEvent.args.id.toString()), {
                        whatsappId: user.whatsappId, username: user.username, betAmount: amount, status: 'pending', requestTimestamp: serverTimestamp(), txHash: hash
                    });
                    return { success: true };
                }
            } catch (e) { console.warn("Could not decode Lucky Number log:", e.message); }
        }
        return { success: false, error: 'Could not confirm game start ID on-chain.' };
    } catch (e) {
        console.error("Lucky Number Play TX Error:", e);
        throw e;
    }
}

async function sendLuckyNumberGuessMenu(to, id, numbers) {
    const numbersText = numbers.map(n => `*${n.toString()}*`).join('   ');
    const message = `Here are your numbers! 🎲\n\n${numbersText}\n\nWhich one do you think is the lucky one? Just *type the number* you want to guess.`;
    
    await sendMessage(to, message);
    userStates.set(to, { type: 'awaiting_lucky_number_guess', id: id.toString(), drawnNumbers: numbers });
}

async function handleLuckyNumberGuessInput(phone, text, state) {
    const user = await getUserFromDatabase(phone);
    if (!user) {
        userStates.delete(phone);
        return;
    }

    const { id, drawnNumbers } = state;
    const guessedNumber = text.trim();

    const drawnNumbersAsStrings = drawnNumbers.map(n => n.toString());

    if (!drawnNumbersAsStrings.includes(guessedNumber)) {
        await sendMessage(phone, `❌ That's not one of your numbers. Please pick one of these:\n\n${drawnNumbersAsStrings.join(', ')}`);
        return;
    }
    
    const guessIndex = drawnNumbersAsStrings.indexOf(guessedNumber);

    await sendMessage(phone, `🔐 *Confirm Guess*\n\n🔢 You picked the number: *${guessedNumber}*\n\nEnter your PIN to lock in your guess.`);
    userStates.set(phone, { type: 'awaiting_pin_for_lucky_guess', user, id, guessIndex });
}

async function handlePinForLuckyGuess(phone, pin, state) {
    const { user, id, guessIndex } = state;
    try {
        if (!(await bcrypt.compare(pin, user.security.hashedPin))) {
            userStates.delete(phone);
            await sendMessage(phone, "❌ Incorrect PIN. Your guess was not submitted.");
            
            const gameDoc = await getDoc(doc(db, 'lucky_games', id));
            if (gameDoc.exists()) {
                const gameData = gameDoc.data();
                setTimeout(() => sendLuckyNumberGuessMenu(phone, id, gameData.drawnNumbers), 1500);
            }
            return;
        }
        await sendMessage(phone, "✅ PIN verified. Submitting your final guess...");
        const result = await executeLuckyNumberGuess(user, id, guessIndex);
        if (result.success) {
            await sendMessage(phone, `✅ Your guess has been submitted! We'll notify you of the result shortly.`);
        } else {
            await sendMessage(phone, `❌ Could not submit your guess. ${result.error || "Please try again."}`);
        }
    } catch (e) {
        await sendMessage(phone, "❌ Guess submission failed due to a network or balance issue.");
    } finally {
        userStates.delete(phone);
    }
}

async function executeLuckyNumberGuess(user, id, guessIndex) {
    try {
        const account = await createViemAccount({ walletId: user.wallet.walletId, address: user.wallet.primaryAddress, privy });
        const walletClient = createWalletClient({ account, chain: avalancheFuji, transport: http() });
        const hash = await walletClient.writeContract({ address: LUCKY_NUMBER_GAME_CONTRACT_ADDRESS, abi: luckyNumberAbi, functionName: 'makeGuess', args: [BigInt(id), Number(guessIndex)] });
        
        await updateDoc(doc(db, 'lucky_games', id.toString()), { guessTxHash: hash, status: 'guessed', guessIndex });
        return { success: true };
    } catch (e) {
        console.error("Lucky Number Guess TX Error:", e);
        throw e;
    }
}

async function sendMessage(to, body) {
    try {
        await axios({
            url: "https://graph.facebook.com/v22.0/696395350222810/messages",
            method: "POST", headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
            data: { messaging_product: "whatsapp", to, type: "text", text: { body, "preview_url": false } }
        });
    } catch (error) { console.error("❌ Error sending message:", error.response?.data || error.message); }
}

app.listen(PORT, () => {
    console.log("🚀 Web3 ChatBot Server running on port", PORT);
    startBlockchainListener().catch(error => {
        console.error("🔥 Fatal error starting the blockchain listener:", error);
    });
});