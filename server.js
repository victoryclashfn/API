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

    if (!description && !videoFile) {
      return res.status(400).json({ error: "No description or video provided" });
    }

    // Build messages
    let input = [
      {
        role: "system",
        content: "You are an assistant that analyzes Fortnite gameplay and provides insights and feedback."
      }
    ];

    if (description) {
      input.push({
        role: "user",
        content: `Analyze this Fortnite match: ${description}`
      });
    }

    if (videoFile) {
      // Send video as input_media instead of trying to push into messages
      input.push({
        role: "user",
        content: [
          { type: "input_text", text: "Analyze this gameplay video" },
          {
            type: "input_media",
            media_type: "video/mp4", // assume mp4, adjust if needed
            data: fs.readFileSync(videoFile.path).toString("base64")
          }
        ]
      });
    }

    const response = await client.responses.create({
      model: "gpt-4.1",
      input
    });

    if (videoFile) fs.unlinkSync(videoFile.path); // cleanup temp upload

    res.json({ analysis: response.output_text });
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
