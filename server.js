import express from "express";
import OpenAI from "openai";
import multer from "multer";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Setup multer for file uploads
const upload = multer({ dest: "uploads/" });

// --- Chatbot endpoint ---
app.post("/chatbot", async (req, res) => {
  try {
    const { message, length } = req.body; // length = "short" or "long"

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
    console.error(err);
    res.status(500).json({ error: "Failed to get chatbot response" });
  }
});

// --- Fortnite analyze endpoint ---
app.post("/analyze", async (req, res) => {
  try {
    const { description } = req.body;

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
    console.error(err);
    res.status(500).json({ error: "Failed to analyze gameplay" });
  }
});

// --- Video analysis endpoint ---
app.post("/analyze-video", upload.single("video"), async (req, res) => {
  try {
    const videoPath = req.file.path;

    // Convert video to a readable stream for OpenAI (if needed)
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

    // Delete video after processing
    fs.unlinkSync(videoPath);

    res.json({ analysis: response.choices[0].message.content });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to analyze video" });
  }
});

app.get("/", (req, res) => {
  res.send("Fortnite AI API is running 🚀");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
