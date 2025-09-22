import express from "express";
import OpenAI from "openai";
import multer from "multer";
import fs from "fs";
import cors from "cors"; // <-- added cors
import path from "path";

const app = express();

// --- CORS setup ---
// For testing, allow all origins. For production, replace '*' with your web URL
app.use(cors({ origin: "*" }));
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Setup multer for file uploads
const upload = multer({ dest: "uploads/" });

// --- Chatbot endpoint ---
app.post("/chatbot", async (req, res) => {
  console.log("Chatbot request body:", req.body);
  try {
    const { message, length } = req.body;

    if (!message) return res.status(400).json({ error: "Message missing" });

    let maxTokens = 200;
    if (length === "short") maxTokens = 100;
    if (length === "long") maxTokens = 400;

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a helpful and friendly chatbot." },
        { role: "user", content: message }
      ],
      max_tokens: maxTokens
    });

    res.json({ reply: response.choices[0].message.content });
  } catch (err) {
    console.error("Chatbot error:", err);
    res.status(500).json({ error: "Failed to get chatbot response" });
  }
});

// --- Fortnite analyze endpoint ---
app.post("/analyze", async (req, res) => {
  console.log("Analyze request body:", req.body);
  try {
    const { description } = req.body;
    if (!description) return res.status(400).json({ error: "Description missing" });

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a Fortnite coach that analyzes gameplay and gives practical tips." },
        { role: "user", content: `Analyze this Fortnite match: ${description}` }
      ],
      max_tokens: 300
    });

    res.json({ feedback: response.choices[0].message.content });
  } catch (err) {
    console.error("Analyze error:", err);
    res.status(500).json({ error: "Failed to analyze gameplay" });
  }
});

// --- Video analysis endpoint ---
app.post("/analyze-video", upload.single("video"), async (req, res) => {
  console.log("Video upload request:", req.file?.originalname);
  try {
    if (!req.file) return res.status(400).json({ error: "No video uploaded" });

    const videoPath = req.file.path;
    const videoStream = fs.createReadStream(videoPath);

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are an assistant that analyzes video gameplay and provides insights." },
        {
          role: "user",
          content: [
            { type: "input_text", text: "Analyze this gameplay video" },
            { type: "input_video", video: videoStream }
          ]
        }
      ],
      max_tokens: 500
    });

    fs.unlinkSync(videoPath);

    res.json({ analysis: response.choices[0].message.content });
  } catch (err) {
    console.error("Video analysis error:", err);
    res.status(500).json({ error: "Failed to analyze video" });
  }
});

// --- Root endpoint ---
app.get("/", (req, res) => {
  res.send("Fortnite AI API is running 🚀");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
