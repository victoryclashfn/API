=import express from "express";
import OpenAI from "openai";
import multer from "multer";
import fs from "fs";
import cors from "cors";
import { exec } from "child_process";

const app = express();
app.use(cors());
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const upload = multer({ dest: "uploads/" });

// --- Helper: extract frames with ffmpeg ---
function extractFrames(videoPath, outputDir, count = 3) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -i ${videoPath} -vf "fps=1/${Math.floor(
      count
    )}" ${outputDir}/frame-%02d.png -hide_banner -loglevel error`;
    exec(cmd, (err) => {
      if (err) return reject(err);
      const frames = fs
        .readdirSync(outputDir)
        .filter((f) => f.startsWith("frame-") && f.endsWith(".png"))
        .map((f) => `${outputDir}/${f}`);
      resolve(frames);
    });
  });
}

// --- Chatbot endpoint ---
app.post("/chatbot", async (req, res) => {
  try {
    const { message, length } = req.body;
    if (!message) return res.status(400).json({ error: "Message missing" });

    let maxTokens = 200;
    if (length === "short") maxTokens = 100;
    if (length === "long") maxTokens = 400;

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a helpful and friendly Fortnite chatbot." },
        { role: "user", content: message }
      ],
      max_tokens: maxTokens
    });

    let reply = response.choices[0].message.content || "";
    reply = reply.replace(/\*/g, "").replace(/\n{2,}/g, "\n\n"); // clean formatting

    res.json({ reply });
  } catch (err) {
    console.error("Chatbot error:", err);
    res.status(500).json({ error: "Failed to get chatbot response" });
  }
});

// --- Analyze endpoint ---
app.post("/analyze", upload.single("video"), async (req, res) => {
  console.log("Analysis request:", req.body, req.file?.originalname);

  const { description, improvementTips, mistakeOverview, statistics } = req.body;
  const videoFile = req.file;

  if (!description && !videoFile) {
    return res.status(400).json({ error: "No description or video provided" });
  }

  try {
    let messages = [
      {
        role: "system",
        content:
          "You are an assistant that analyzes Fortnite gameplay and provides detailed, constructive feedback."
      }
    ];

    // Build user instruction based on checkboxes
    let checklist = [];
    if (improvementTips === "true" || improvementTips === true)
      checklist.push("Give specific improvement tips.");
    if (mistakeOverview === "true" || mistakeOverview === true)
      checklist.push("List mistakes and how to avoid them.");
    if (statistics === "true" || statistics === true)
      checklist.push("Provide gameplay statistics like accuracy, building efficiency, and editing speed.");

    let requestText = "Analyze this Fortnite match.";
    if (description) requestText += ` Description: ${description}`;
    if (checklist.length > 0) requestText += ` Focus on: ${checklist.join(" ")}`;

    messages.push({ role: "user", content: requestText });

    // If video uploaded → extract frames and add them
    let framePaths = [];
    if (videoFile) {
      try {
        const frameDir = `uploads/frames-${Date.now()}`;
        fs.mkdirSync(frameDir);
        framePaths = await extractFrames(videoFile.path, frameDir, 3);

        for (const frame of framePaths) {
          const b64 = fs.readFileSync(frame, { encoding: "base64" });
          messages.push({
            role: "user",
            content: [
              { type: "text", text: "Frame from gameplay video" },
              { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } }
            ]
          });
        }
      } catch (ffmpegErr) {
        console.error("FFmpeg error:", ffmpegErr);
        return res.status(500).json({ error: "Failed to process video frames" });
      }
    }

    let response;
    try {
      response = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages,
        max_tokens: 600
      });
    } catch (openaiErr) {
      console.error("OpenAI API error:", openaiErr);
      return res.status(500).json({ error: "Failed to generate analysis" });
    }

    // Cleanup files
    try {
      if (videoFile) fs.unlinkSync(videoFile.path);
      for (const frame of framePaths) fs.unlinkSync(frame);
    } catch (cleanupErr) {
      console.error("Cleanup error:", cleanupErr);
    }

    let analysis = response.choices[0].message.content || "";
    analysis = analysis.replace(/\*/g, "").replace(/\n{2,}/g, "\n\n"); // clean formatting

    res.json({ analysis });
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
