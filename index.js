import { GoogleGenAI } from "@google/genai";
import express from "express";
import axios from "axios";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, addDoc, doc, setDoc, updateDoc, getDoc, query, where, orderBy, limit, getDocs, serverTimestamp } from "firebase/firestore";
import dotenv from "dotenv";

dotenv.config();

const WEBHOOK_VERIFY_TOKEN = process.env.Whatsapp_hook_token;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const app = express();
app.use(express.json());

const userStates = new Map();
const firstTimeUsers = new Set();
const CONVERSATION_TTL = 30 * 60 * 1000;

// Initialize Gemini AI
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

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
        const userText = message.text?.body;

        if (userText) {
            console.log("📩 User said:", userText);

            // Check if this is a first-time user
            if (!firstTimeUsers.has(userPhoneNumber)) {
                firstTimeUsers.add(userPhoneNumber);
                await sendWelcomeMessage(userPhoneNumber);
                return res.sendStatus(200);
            }

            // Handle button selections
            if (userText === "/games" || userText === "/wallet") {
                await handleUserSelection(userPhoneNumber, userText);
                return res.sendStatus(200);
            }

            // Normal AI conversation
            const reply = await generateAIResponse(userPhoneNumber, userText);
            await sendMessage(userPhoneNumber, reply);
        }

        res.sendStatus(200);
    } catch (error) {
        console.error("❌ Error handling message:", error);
        res.sendStatus(500);
    }
});

// ========== Welcome Message with Interactive Buttons ==========
async function sendWelcomeMessage(to) {
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
                        text: "🤖 Welcome to AI Assistant!"
                    },
                    body: {
                        text: "Hello! I'm your AI assistant powered by advanced technology. I'm here to help you with various tasks and answer your questions.\n\nPlease choose what you'd like to explore:"
                    },
                    footer: {
                        text: "Select an option to get started"
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
        console.log("✅ Welcome message sent to:", to);
    } catch (error) {
        console.error("❌ Error sending welcome message:", error.response?.data || error);
        // Fallback to simple text message if interactive message fails
        await sendMessage(to, "🤖 Welcome to AI Assistant!\n\nPlease type:\n/games - for games\n/wallet - for wallet features");
    }
}

// ========== Handle User Selection ==========
async function handleUserSelection(userPhoneNumber, selection) {
    let response = "";

    if (selection === "/games") {
        response = "🎮 Welcome to Games!\n\nHere you can:\n• Play interactive games\n• Check game statistics\n• Compete with friends\n• Earn rewards\n\nWhat would you like to do? Just ask me anything about games!";
    } else if (selection === "/wallet") {
        response = "💰 Welcome to Wallet!\n\nHere you can:\n• Check your balance\n• View transaction history\n• Send/receive payments\n• Manage your account\n\nWhat would you like to do with your wallet? Just ask me!";
    }

    await sendMessage(userPhoneNumber, response);

    // Initialize AI conversation for this user after selection
    initializeUserChat(userPhoneNumber, selection);
}

// ========== Initialize User Chat Session ==========
function initializeUserChat(userPhoneNumber, selectedOption) {
    const contextInstruction = selectedOption === "/games"
        ? "You are a helpful gaming assistant. Help users with game-related queries, provide gaming tips, and make the experience fun and engaging."
        : "You are a helpful wallet and financial assistant. Help users with wallet operations, transaction queries, and provide financial guidance while being secure and professional.";

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
                    systemInstruction: "You are a friendly and helpful AI assistant. Provide useful and engaging responses."
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
    console.log("🚀 Server running on port 8000");
});
