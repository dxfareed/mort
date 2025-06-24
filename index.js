import { GoogleGenAI } from "@google/genai";
import express from "express";
import axios from "axios";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, addDoc, doc, setDoc, updateDoc, getDoc, query, where, orderBy, limit, getDocs, serverTimestamp } from "firebase/firestore";
import bcrypt from "bcrypt";
import dotenv from "dotenv";
import { PrivyClient } from '@privy-io/server-auth';
import { createViemAccount } from '@privy-io/server-auth/viem';
import { createPublicClient, createWalletClient, http, parseEther, formatEther } from 'viem';
import { avalancheFuji } from 'viem/chains';
dotenv.config();

const WEBHOOK_VERIFY_TOKEN = process.env.Whatsapp_hook_token;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PRIVY_APP_ID = process.env.PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;

// Firebase Configuration
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
const CONVERSATION_TTL = 30 * 60 * 1000;
const SALT_ROUNDS = 12;

// Registration states
const REGISTRATION_STEPS = {
    AWAITING_USERNAME: 'awaiting_username',
    AWAITING_EMAIL: 'awaiting_email',
    AWAITING_PIN: 'awaiting_pin',
    CONFIRMING_PIN: 'confirming_pin'
};

// Initialize Gemini AI
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// ========== Database Helper Functions ==========
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

        // Also create username mapping
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
        return true; // Return true to be safe
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

        // Create Avax wallet using Privy
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

// ========== WhatsApp Webhook Setup ==========
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

// ========== WhatsApp Incoming Message Handler ==========
app.post("/webhook", async (req, res) => {
    try {
        const { entry } = req.body;
        if (!entry?.[0]?.changes?.[0]?.value?.messages) return res.sendStatus(400);

        const message = entry[0].changes[0].value.messages[0];
        const userPhoneNumber = message.from;

        // Handle button responses first
        if (message.interactive?.button_reply?.id) {
            const buttonId = message.interactive.button_reply.id;

            if (buttonId === "create_account") {
                // Start registration process
                registrationStates.set(userPhoneNumber, {
                    step: REGISTRATION_STEPS.AWAITING_USERNAME
                });
                await sendMessage(userPhoneNumber, "🔐 Let's create your account!\n\nFirst, choose a unique username (3-20 characters, letters, numbers, and underscores only):");
                return res.sendStatus(200);
            }

            if (buttonId === "games_option") {
                const user = await getUserFromDatabase(userPhoneNumber);
                await handleUserSelection(userPhoneNumber, "/games", user);
                return res.sendStatus(200);
            }

            if (buttonId === "wallet_option") {
                const user = await getUserFromDatabase(userPhoneNumber);
                await handleUserSelection(userPhoneNumber, "/wallet", user);
                return res.sendStatus(200);
            }

            if (buttonId === "send_crypto") {
                const user = await getUserFromDatabase(userPhoneNumber);
                await handleSendCrypto(userPhoneNumber, user);
                return res.sendStatus(200);
            }

            if (buttonId === "receive_crypto") {
                const user = await getUserFromDatabase(userPhoneNumber);
                await handleReceiveCrypto(userPhoneNumber, user);
                return res.sendStatus(200);
            }

            if (buttonId === "view_balance") {
                const user = await getUserFromDatabase(userPhoneNumber);
                await handleViewBalance(userPhoneNumber, user);
                return res.sendStatus(200);
            }
        }

        // Handle text messages
        const userText = message.text?.body;
        if (userText) {
            console.log("📩 User said:", userText);

            // Check if user exists in database
            const existingUser = await getUserFromDatabase(userPhoneNumber);

            if (!existingUser) {
                // Handle new user registration flow
                await handleNewUserFlow(userPhoneNumber, userText);
            } else {
                // Handle existing user
                await updateUserLastSeen(userPhoneNumber);

                // Check for special commands first
                if (userText === "/games" || userText === "/wallet") {
                    await handleUserSelection(userPhoneNumber, userText, existingUser);
                } else if (userText.toLowerCase().startsWith("send ") && userText.includes(" to ")) {
                    // Handle send crypto transaction
                    await handleTransactionInput(userPhoneNumber, userText, existingUser);
                } else {
                    // Check if user is in transaction state
                    const userState = userStates.get(userPhoneNumber);
                    if (userState && userState.type === 'awaiting_transaction') {
                        await handleTransactionInput(userPhoneNumber, userText, existingUser);
                    } else if (userState && userState.type === 'awaiting_pin_for_transaction') {
                        await handlePinForTransaction(userPhoneNumber, userText, userState);
                    } else {
                        // Send welcome back message for first interaction
                        if (!userStates.has(userPhoneNumber)) {
                            await sendWelcomeBackMessage(userPhoneNumber, existingUser);
                        } else {
                            // Normal AI conversation
                            const reply = await generateAIResponse(userPhoneNumber, userText);
                            await sendMessage(userPhoneNumber, reply);
                        }
                    }
                }
            }
        }

        res.sendStatus(200);
    } catch (error) {
        console.error("❌ Error handling message:", error);
        res.sendStatus(500);
    }
});

// ========== New User Registration Flow ==========
async function handleNewUserFlow(userPhoneNumber, userText) {
    const registrationState = registrationStates.get(userPhoneNumber);

    if (!registrationState) {
        // First time user - send welcome message with create account button
        await sendNewUserWelcomeMessage(userPhoneNumber);
        return;
    }

    // Handle registration steps
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
            await sendNewUserWelcomeMessage(userPhoneNumber);
    }
}

// ========== New User Welcome Message ==========
async function sendNewUserWelcomeMessage(to) {
    try {
        await axios({
            url: `https://graph.facebook.com/v22.0/696395350222810/messages`,
            method: "POST",
            headers: {
                Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                "Content-Type": "application/json",
            },
            data: {
                messaging_product: "whatsapp",
                to,
                type: "interactive",
                interactive: {
                    type: "button",
                    header: {
                        type: "text",
                        text: "🚀 Welcome to Mort by Hot Coffee"
                    },
                    body: {
                        text: "Hello! I'm Morty, your Wallet Agent that enables you to:\n\n💰 Send & receive crypto\n🎮 Play games and earn crypto\n📱 Manage your digital wallet\n\nTo get started, you'll need to create your account. This will only take a minute!"
                    },
                    footer: {
                        text: "Secure • Fast • Easy"
                    },
                    action: {
                        buttons: [
                            {
                                type: "reply",
                                reply: {
                                    id: "create_account",
                                    title: "🔐 Create Account"
                                }
                            }
                        ]
                    }
                }
            },
        });
        console.log("✅ New user welcome message sent to:", to);
    } catch (error) {
        console.error("❌ Error sending new user welcome message:", error);
        await sendMessage(to, "🚀 Welcome to Web3 ChatBot!\n\nTo get started, please reply with 'create account' to set up your profile.");
    }
}

// ========== Welcome Back Message ==========
async function sendWelcomeBackMessage(to, user) {
    try {
        await axios({
            url: `https://graph.facebook.com/v22.0/696395350222810/messages`,
            method: "POST",
            headers: {
                Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                "Content-Type": "application/json",
            },
            data: {
                messaging_product: "whatsapp",
                to,
                type: "interactive",
                interactive: {
                    type: "button",
                    header: {
                        type: "text",
                        text: `👋 Welcome back, ${user.username}!`
                    },
                    body: {
                        text: "Great to see you again! What would you like to do today?\n\n🎮 Play games and earn crypto\n💰 Manage your wallet and transactions"
                    },
                    footer: {
                        text: "Choose an option to continue"
                    },
                    action: {
                        buttons: [
                            {
                                type: "reply",
                                reply: {
                                    id: "games_option",
                                    title: "🎮 Games"
                                }
                            },
                            {
                                type: "reply",
                                reply: {
                                    id: "wallet_option",
                                    title: "💰 Wallet"
                                }
                            }
                        ]
                    }
                }
            },
        });
        console.log("✅ Welcome back message sent to:", to);
    } catch (error) {
        console.error("❌ Error sending welcome back message:", error);
        await sendMessage(to, `👋 Welcome back, ${user.username}!\n\nType:\n/games - for games\n/wallet - for wallet features`);
    }
}

// ========== Registration Step Handlers ==========
async function handleUsernameInput(userPhoneNumber, username) {
    // Validate username
    if (username.length < 3 || username.length > 20) {
        await sendMessage(userPhoneNumber, "❌ Username must be between 3-20 characters. Please try again:");
        return;
    }

    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
        await sendMessage(userPhoneNumber, "❌ Username can only contain letters, numbers, and underscores. Please try again:");
        return;
    }

    // Check if username exists
    const usernameExists = await checkUsernameExists(username);
    if (usernameExists) {
        await sendMessage(userPhoneNumber, "❌ This username is already taken. Please choose another one:");
        return;
    }

    // Save username and move to email step
    const state = registrationStates.get(userPhoneNumber);
    state.username = username;
    state.step = REGISTRATION_STEPS.AWAITING_EMAIL;
    registrationStates.set(userPhoneNumber, state);

    await sendMessage(userPhoneNumber, `✅ Great! Username "${username}" is available.\n\nNow, please enter your email address:`);
}

async function handleEmailInput(userPhoneNumber, email) {
    // Validate email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        await sendMessage(userPhoneNumber, "❌ Please enter a valid email address:");
        return;
    }

    // Save email and move to pin step
    const state = registrationStates.get(userPhoneNumber);
    state.email = email;
    state.step = REGISTRATION_STEPS.AWAITING_PIN;
    registrationStates.set(userPhoneNumber, state);

    await sendMessage(userPhoneNumber, `✅ Email saved: ${email}\n\n🔐 Now, create a secure 4-6 digit transaction PIN.\n\n⚠️ This PIN will be used to authorize transactions and sensitive operations. Keep it secure!\n\nEnter your PIN:`);
}

async function handlePinInput(userPhoneNumber, pin) {
    // Validate PIN
    if (!/^\d{4,6}$/.test(pin)) {
        await sendMessage(userPhoneNumber, "❌ PIN must be 4-6 digits only. Please try again:");
        return;
    }

    // Save PIN and ask for confirmation
    const state = registrationStates.get(userPhoneNumber);
    state.pin = pin;
    state.step = REGISTRATION_STEPS.CONFIRMING_PIN;
    registrationStates.set(userPhoneNumber, state);

    await sendMessage(userPhoneNumber, "🔒 Please confirm your PIN by entering it again:");
}

async function handlePinConfirmation(userPhoneNumber, confirmPin) {
    const state = registrationStates.get(userPhoneNumber);

    if (state.pin !== confirmPin) {
        // Reset to PIN creation step
        state.step = REGISTRATION_STEPS.AWAITING_PIN;
        registrationStates.set(userPhoneNumber, state);
        await sendMessage(userPhoneNumber, "❌ PINs don't match. Please enter your 4-6 digit PIN again:");
        return;
    }

    // Create user account
    try {
        const hashedPin = await hashPin(state.pin);
        const now = new Date().toISOString();

        // Create wallet using Privy
        await sendMessage(userPhoneNumber, "🔗 Creating your secure wallet...");
        const walletData = await createWalletForUser(state.username);

        const userData = {
            whatsappId: userPhoneNumber,
            username: state.username,
            email: state.email,
            security: {
                hashedPin: hashedPin,
                pinSetAt: now
            },
            wallet: {
                primaryAddress: walletData.address,
                walletId: walletData.walletId,
                chainType: walletData.chainType,
                balance: {
                    AVAX: "0"
                },
                lastBalanceUpdate: now
            },
            stats: {
                gamesPlayed: 0,
                totalEarned: "0",
                transactionCount: 0
            },
            createdAt: now,
            lastSeen: now
        };

        const success = await createUserInDatabase(userData);

        if (success) {
            // Clear registration state
            registrationStates.delete(userPhoneNumber);

            await sendMessage(userPhoneNumber, `🎉 Account created successfully!\n\n✅ Username: ${state.username}\n✅ Email: ${state.email}\n✅ Security PIN: Set\n💰 Wallet Address: ${walletData.address}\n\nWelcome to Mort! Your secure Avax wallet has been created and you can now start playing games and managing your crypto.`);

            // Send welcome options
            setTimeout(async () => {
                const user = await getUserFromDatabase(userPhoneNumber);
                await sendWelcomeBackMessage(userPhoneNumber, user);
            }, 2000);

        } else {
            await sendMessage(userPhoneNumber, "❌ Sorry, there was an error creating your account. Please try again later.");
            registrationStates.delete(userPhoneNumber);
        }

    } catch (error) {
        console.error("❌ Error creating account:", error);
        await sendMessage(userPhoneNumber, "❌ Sorry, there was an error creating your account. Please try again later.");
        registrationStates.delete(userPhoneNumber);
    }
}

// ========== Wallet Menu ==========
async function sendWalletMenu(to, user) {
    try {
        await axios({
            url: `https://graph.facebook.com/v22.0/696395350222810/messages`,
            method: "POST",
            headers: {
                Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                "Content-Type": "application/json",
            },
            data: {
                messaging_product: "whatsapp",
                to,
                type: "interactive",
                interactive: {
                    type: "button",
                    header: {
                        type: "text",
                        text: `💰 ${user.username}'s Wallet`
                    },
                    body: {
                        text: `Your Wallet Address:\n${user.wallet.primaryAddress}\n\nWhat would you like to do?`
                    },
                    footer: {
                        text: "Avalanche Fuji Network"
                    },
                    action: {
                        buttons: [
                            {
                                type: "reply",
                                reply: {
                                    id: "send_crypto",
                                    title: "💸 Send Crypto"
                                }
                            },
                            {
                                type: "reply",
                                reply: {
                                    id: "receive_crypto",
                                    title: "📥 Receive Crypto"
                                }
                            },
                            {
                                type: "reply",
                                reply: {
                                    id: "view_balance",
                                    title: "📊 View Balance"
                                }
                            }
                        ]
                    }
                }
            },
        });
        console.log("✅ Wallet menu sent to:", to);
    } catch (error) {
        console.error("❌ Error sending wallet menu:", error);
        await sendMessage(to, `💰 Welcome to Wallet, ${user.username}!\n\nType:\n/send - Send crypto\n/receive - Receive crypto\n/balance - View balance`);
    }
}

// ========== Handle User Selection ==========
async function handleUserSelection(userPhoneNumber, selection, user) {
    if (selection === "/games") {
        const response = `🎮 Welcome to Games, ${user.username}!\n\nHere you can:\n• Play interactive games\n• Check game statistics\n• Compete with friends\n• Earn crypto rewards\n\nGames Played: ${user.stats.gamesPlayed}\nTotal Earned: ${user.stats.totalEarned} tokens\n\nWhat would you like to do? Just ask me anything about games!`;
        await sendMessage(userPhoneNumber, response);

        // Initialize AI conversation for this user after selection
        initializeUserChat(userPhoneNumber, selection, user);
    } else if (selection === "/wallet") {
        // Send wallet menu with interactive buttons
        await sendWalletMenu(userPhoneNumber, user);
    }
}

// ========== Wallet Functions ==========
async function handleReceiveCrypto(userPhoneNumber, user) {
    // First send just the wallet address
    await sendMessage(userPhoneNumber, user.wallet.primaryAddress);

    // Then send the instructions
    await sendMessage(userPhoneNumber, `📥 Receive Crypto\n\nSend 🔺 AVAX to this address on the Avalanche Fuji network.\n\n🔺 Only send AVAX on Avalanche Fuji network to this address!`);
}

async function handleViewBalance(userPhoneNumber, user) {
    try {
        await sendMessage(userPhoneNumber, "📊 Checking your balance...");

        // Get balance using Privy API
        const balance = await getWalletBalance(user.wallet.primaryAddress);

        if (balance && balance.balances && balance.balances.length > 0) {
            const avaxBalance = balance.balances.find(b => b.asset === 'eth' && b.chain === 'avalanche-fuji');

            if (avaxBalance) {
                const balanceMessage = `💰 Your Wallet Balance\n\n🔺 AVAX: ${avaxBalance.display_values.eth} AVAX\n💲 USD Value: $${avaxBalance.display_values.usd}\n\nNetwork: Avalanche Fuji`;
                await sendMessage(userPhoneNumber, balanceMessage);
            } else {
                await sendMessage(userPhoneNumber, `💰 Your Wallet Balance\n\n🔺 AVAX: 0 AVAX\n💲 USD Value: $0.00\n\nNetwork: Avalanche Fuji`);
            }
        } else {
            await sendMessage(userPhoneNumber, `💰 Your Wallet Balance\n\n🔺 AVAX: 0 AVAX\n💲 USD Value: $0.00\n\nNetwork: Avalanche Fuji`);
        }
    } catch (error) {
        console.error("❌ Error fetching balance:", error);
        await sendMessage(userPhoneNumber, "❌ Sorry, I couldn't fetch your balance right now. Please try again later.");
    }
}

async function handleSendCrypto(userPhoneNumber, user) {
    await sendMessage(userPhoneNumber, "💸 Send Crypto\n\nPlease provide the following information:\n\n1️⃣ Recipient address\n2️⃣ Amount in AVAX\n\nExample: Send 0.01 AVAX to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e\n\nPlease enter in this format: 'send [amount] to [address]'");

    // Set user state for transaction
    userStates.set(userPhoneNumber, { type: 'awaiting_transaction', user: user });
}

async function getWalletBalance(w) {
    try {
        const publicClient = createPublicClient({
            chain: avalancheFuji,
            transport: http()
        });

        const balance = await publicClient.getBalance({
            address: w,
        });

        return {
            balances: [{
                asset: 'eth',
                chain: 'avalanche-fuji',
                display_values: {
                    eth: formatEther(balance),
                    usd:"ftch later from gecko / chainlink",
                }
            }]
        };
    } catch (error) {
        console.error("❌ Error fetching wallet balance:", error);
        throw error;
    }}

async function sendTransaction(user, toAddress, amount) {
    try {
        // Create a viem account instance for the wallet
        const account = await createViemAccount({
            walletId: user.wallet.walletId,
            address: user.wallet.primaryAddress,
            privy
        });

        // Create wallet client
        const client = createWalletClient({
            account,
            chain: avalancheFuji,
            transport: http()
        });

        // Send transaction
        const hash = await client.sendTransaction({
            to: toAddress,
            value: parseEther(amount)
        });

        return hash;
    } catch (error) {
        console.error("❌ Error sending transaction:", error);
        throw error;
    }
}

async function handleTransactionInput(userPhoneNumber, userText, user) {
    try {
        // Parse the transaction input
        // Expected format: "send [amount] to [address]"
        const regex = /send\s+([\d.]+)\s+to\s+(0x[a-fA-F0-9]{40})/i;
        const match = userText.match(regex);

        if (!match) {
            await sendMessage(userPhoneNumber, "❌ Invalid format. Please use: 'send [amount] to [address]'\n\nExample: send 0.01 to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e");
            return;
        }

        const amount = match[1];
        const toAddress = match[2];

        // Validate amount
        if (isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
            await sendMessage(userPhoneNumber, "❌ Invalid amount. Please enter a valid number greater than 0.");
            return;
        }

        // Validate address format
        if (!/^0x[a-fA-F0-9]{40}$/.test(toAddress)) {
            await sendMessage(userPhoneNumber, "❌ Invalid address format. Please enter a valid Ethereum address starting with 0x.");
            return;
        }

        // Ask for PIN confirmation
        await sendMessage(userPhoneNumber, `🔐 Transaction Confirmation\n\n💸 Amount: ${amount} AVAX\n📧 To: ${toAddress}\n⛓️ Network: Avalanche Fuji\n\nPlease enter your 4-6 digit PIN to confirm this transaction:`);

        // Set user state for PIN confirmation
        userStates.set(userPhoneNumber, {
            type: 'awaiting_pin_for_transaction',
            user: user,
            transaction: {
                amount: amount,
                toAddress: toAddress
            }
        });

    } catch (error) {
        console.error("❌ Error handling transaction input:", error);
        await sendMessage(userPhoneNumber, "❌ Sorry, there was an error processing your transaction. Please try again.");
        userStates.delete(userPhoneNumber);
    }
}

async function handlePinForTransaction(userPhoneNumber, enteredPin, userState) {
    try {
        const { user, transaction } = userState;

        // Validate PIN format
        if (!/^\d{4,6}$/.test(enteredPin)) {
            await sendMessage(userPhoneNumber, "❌ PIN must be 4-6 digits only. Please try again:");
            return;
        }

        // Verify PIN against stored hash
        const isValidPin = await bcrypt.compare(enteredPin, user.security.hashedPin);

        if (!isValidPin) {
            await sendMessage(userPhoneNumber, "❌ Incorrect PIN. Transaction cancelled for security.");
            userStates.delete(userPhoneNumber);
            return;
        }

        // PIN is correct, process the transaction
        await sendMessage(userPhoneNumber, "✅ PIN verified. Processing transaction...");

        try {
            const txHash = await sendTransaction(user, transaction.toAddress, transaction.amount);

            await sendMessage(userPhoneNumber, `🎉 Transaction Successful!\n\n💸 Sent: ${transaction.amount} AVAX\n📧 To: ${transaction.toAddress}\n🔗 Transaction Hash: ${txHash}\n⛓️ Network: Avalanche Fuji\n\nYour transaction is being processed on the blockchain.`);

            // Update user transaction count
            const userRef = doc(db, 'users', userPhoneNumber);
            await updateDoc(userRef, {
                'stats.transactionCount': user.stats.transactionCount + 1,
                lastSeen: serverTimestamp()
            });

        } catch (txError) {
            console.error("❌ Transaction failed:", txError);
            await sendMessage(userPhoneNumber, "❌ Transaction failed. This could be due to insufficient balance, network issues, or invalid recipient address. Please check your balance and try again.");
        }

        // Clear user state
        userStates.delete(userPhoneNumber);

    } catch (error) {
        console.error("❌ Error handling PIN for transaction:", error);
        await sendMessage(userPhoneNumber, "❌ Sorry, there was an error processing your PIN. Please try again later.");
        userStates.delete(userPhoneNumber);
    }
}

// ========== Initialize User Chat Session ==========
function initializeUserChat(userPhoneNumber, selectedOption, user) {
    const contextInstruction = selectedOption === "/games"
        ? `You are a helpful gaming assistant for ${user.username}. Help users with game-related queries, provide gaming tips, and make the experience fun and engaging. The user has played ${user.stats.gamesPlayed} games and earned ${user.stats.totalEarned} tokens so far.`
        : `You are a helpful wallet and financial assistant for ${user.username}. Help users with wallet operations, transaction queries, and provide financial guidance while being secure and professional. 🔺 Avax ${user.wallet.balance.AVAX}.`;

    const userChat = ai.chats.create({
        model: "gemini-2.0-flash",
        history: [],
        config: {
            systemInstruction: contextInstruction
        }
    });

    // Set TTL for conversation
    setTimeout(() => {
        userStates.delete(userPhoneNumber);
    }, CONVERSATION_TTL);

    userStates.set(userPhoneNumber, userChat);
}

// ========== AI Response Generator ==========
async function generateAIResponse(userPhoneNumber, userPrompt) {
    try {
        // Get or create user chat history
        let userChat = userStates.get(userPhoneNumber);

        if (!userChat) {
            // If no chat exists, create a general one
            userChat = ai.chats.create({
                model: "gemini-2.0-flash",
                history: [],
                config: {
                    systemInstruction: "You are a friendly and helpful Web3 AI assistant. Provide useful and engaging responses about crypto, gaming, and digital wallets."
                }
            });

            // Set TTL for conversation
            setTimeout(() => {
                userStates.delete(userPhoneNumber);
            }, CONVERSATION_TTL);

            userStates.set(userPhoneNumber, userChat);
        }

        // Generate response
        const response = await userChat.sendMessage({
            message: userPrompt
        });

        return response.text;

    } catch (err) {
        console.error("❌ AI error:", err);

        // Handle specific error types
        if (err.message?.includes('rate limit')) {
            return "I'm receiving too many messages right now. Please try again in a moment.";
        } else if (err.message?.includes('safety')) {
            return "I apologize, but I cannot provide a response to that type of content. Please remember that I'm here to help in a safe and constructive way.";
        }

        return "I'm having trouble responding at the moment. Please try again later.";
    }
}

// ========== WhatsApp Send Message ==========
async function sendMessage(to, body) {
    try {
        await axios({
            url: "https://graph.facebook.com/v22.0/696395350222810/messages",
            method: "POST",
            headers: {
                Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                "Content-Type": "application/json",
            },
            data: {
                messaging_product: "whatsapp",
                to,
                type: "text",
                text: { body },
            },
        });
    } catch (error) {
        console.error("❌ Error sending message:", error.response?.data || error);
    }
}

app.listen(8000, () => {
    console.log("🚀 Web3 ChatBot Server running on port 8000");
    console.log("🔐 Security: bcrypt pin hashing enabled");
    console.log("💾 Database: Firestore integration active");
    console.log("🤖 AI: Gemini 2.0 Flash ready");
});
