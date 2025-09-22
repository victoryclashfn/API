// server.js
import express from "express";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// ✅ Setup OpenAI client with your API key
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---------- ROUTES ----------

// 1. Gameplay Analysis
app.post("/analyze", async (req, res) => {
  try {
    const { request } = req.body;

    if (!request) {
      return res.status(400).json({ error: "Missing request field" });
    }

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a Fortnite coach giving gameplay feedback." },
        { role: "user", content: request },
      ],
    });

    const feedback = response.choices[0].message.content;
    res.json({ feedback });
  } catch (error) {
    console.error("Error in /analyze:", error);
    res.status(500).json({ error: error.message });
  }
});

// 2. Chatbot
app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Missing message field" });
    }

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a friendly Fortnite chatbot." },
        { role: "user", content: message },
      ],
    });

    const reply = response.choices[0].message.content;
    res.json({ reply });
  } catch (error) {
    console.error("Error in /chat:", error);
    res.status(500).json({ error: error.message });
  }
});

// ---------- START SERVER ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
