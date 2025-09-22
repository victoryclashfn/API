import express from "express";
import OpenAI from "openai";
import multer from "multer";
import fs from "fs";
import cors from "cors";

const app = express();
app.use(cors()); // allow web requests
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Setup multer for file uploads
const upload = multer({ dest: "uploads/" });

// --- Chatbot endpoint (separate) ---
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
        { role: "system", content: "You are a helpful and friendly fortnite chatbot." },
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

// --- Combined text + video analysis endpoint ---
app.post("/analyze", upload.single("video"), async (req, res) => {
  console.log("Analysis request received:", req.body, req.file?.originalname);

  try {
    const { description } = req.body; // optional extra text
    const videoFile = req.file;

    let messages = [
      { role: "system", content: "You are an assistant that analyzes Fortnite/gameplay and provides insights and feedback on how to improve." }
    ];

    // Add text description if present
    if (description) {
      messages.push({ role: "user", content: `Analyze this Fortnite match: ${description}` });
    }

    // Add video if uploaded
    if (videoFile) {
      const videoStream = fs.createReadStream(videoFile.path);
      messages.push({
        role: "user",
        content: [
          { type: "input_text", text: "Analyze this gameplay video" },
          { type: "input_video", video: videoStream }
        ]
      });
    }

    if (!description && !videoFile) {
      return res.status(400).json({ error: "No description or video provided" });
    }

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      max_tokens: 500
    });

    // Delete uploaded video if present
    if (videoFile) fs.unlinkSync(videoFile.path);

    res.json({ analysis: response.choices[0].message.content });
  } catch (err) {
    console.error("Analysis error:", err);
    res.status(500).json({ error: "Failed to analyze" });
  }
});

app.get("/", (req, res) => {
  res.send("Fortnite AI API is running 🚀");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
