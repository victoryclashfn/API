import express from "express";
import OpenAI from "openai";
import multer from "multer";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();
app.use(express.json());

// OpenAI client
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Multer storage → save videos locally (./uploads folder)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = "./uploads";
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname);
  },
});
const upload = multer({ storage });

/**
 * ==================================
 *  1. Text-only GPT analysis
 *  (No video upload)
 * ==================================
 */
app.post("/analyze", async (req, res) => {
  try {
    const { description } = req.body;

    if (!description) {
      return res.status(400).json({ error: "Description is required" });
    }

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a Fortnite coach that analyzes gameplay and gives practical tips.",
        },
        { role: "user", content: `Analyze this Fortnite match: ${description}` },
      ],
    });

    res.json({
      feedback: response.choices[0].message.content,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to analyze gameplay" });
  }
});

/**
 * ==================================
 *  2. Upload video + GPT analysis
 *  (Video auto-deletes after 1h)
 * ==================================
 */
app.post("/upload-analyze", upload.single("video"), async (req, res) => {
  try {
    const file = req.file;
    const { description, length } = req.body;

    if (!file || !description) {
      return res
        .status(400)
        .json({ error: "Video and description are required" });
    }

    const filePath = path.resolve(file.path);

    // GPT analysis length handling
    let maxTokens = 200;
    if (length === "short") maxTokens = 100;
    if (length === "long") maxTokens = 400;

    const aiResponse = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are a Fortnite coach that analyzes gameplay.",
        },
        {
          role: "user",
          content: `Analyze this Fortnite match: ${description}`,
        },
      ],
      max_tokens: maxTokens,
    });

    const feedback = aiResponse.choices[0].message.content;

    // Generate video playback URL
    const videoUrl = `${req.protocol}://${req.get("host")}/uploads/${file.filename}`;

    // Auto-delete file after 1 hour
    setTimeout(() => {
      fs.unlink(filePath, (err) => {
        if (!err) {
          console.log(`Deleted ${filePath} after 1 hour ⏳`);
        }
      });
    }, 3600 * 1000);

    res.json({
      videoUrl,
      feedback,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload or analysis failed" });
  }
});

// Serve uploaded videos
app.use("/uploads", express.static("uploads"));

// Health check
app.get("/", (req, res) => {
  res.send("Fortnite AI API is running 🚀");
});

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
