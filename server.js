import express from "express";
import OpenAI from "openai";
import multer from "multer";
import fs from "fs";
import cors from "cors";
import { exec } from "child_process";

// --- Express App ---
const app = express();
app.use(cors());
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const upload = multer({ dest: "uploads/" });

// --- In-memory bio storage ---
const bioDatabase = {}; // Stores combined bio per userId

// --- Helper: Extract frames from video ---
function extractFrames(videoPath, outputDir, count = 3) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -i ${videoPath} -vf "thumbnail,scale=640:360" -frames:v ${count} ${outputDir}/frame-%02d.png -hide_banner -loglevel error`;
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

// --- Helper: Build prompt based on response type ---
function buildPrompt(responseType) {
  switch (responseType?.toLowerCase()) {
    case "coach": return "Act like a Fortnite coach. Give constructive, step-by-step advice.";
    case "stats": return "Provide raw gameplay statistics and performance breakdowns.";
    case "summary": return "Give a short, neutral match summary.";
    case "hype": return "Respond like a hype caster. Make it energetic and fun.";
    case "analytics": return "Provide a detailed, analytical breakdown of the gameplay.";
    default: return "Be a helpful Fortnite assistant.";
  }
}

// --- Analyze Endpoint ---
app.post("/analyze", upload.single("video"), async (req, res) => {
  try {
    const { userId, bio: newBio, responseType } = req.body;
    const videoFile = req.file;

    if (!userId) return res.status(400).json({ error: "userId is required" });
    if (!newBio && !videoFile) return res.status(400).json({ error: "Bio or video required" });

    // --- Combine bio with existing ---
    let combinedBio = bioDatabase[userId] || "";
    if (newBio) combinedBio = (combinedBio + " " + newBio).trim();
    bioDatabase[userId] = combinedBio;

    // --- Bio summary ---
    const bioSummaryPrompt = `Provide a stats-style summary of this player bio:\n${combinedBio}`;
    const bioSummaryResp = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "system", content: buildPrompt("stats") }, { role: "user", content: bioSummaryPrompt }],
      max_tokens: 200
    });
    const bioSummary = bioSummaryResp.choices[0].message.content || "";

    // --- Build video analysis prompt ---
    const promptIntro = buildPrompt(responseType);
    let requestText = `${promptIntro}\nPlayer Bio: ${combinedBio}\nAnalyze this Fortnite gameplay.`;

    let messages = [{ role: "system", content: requestText }];

    let framePaths = [];
    if (videoFile) {
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
    }

    const analysisResp = await client.chat.completions.create({
      model: "gpt-4o",
      messages,
      max_tokens: 600
    });
    const analysis = analysisResp.choices[0].message.content || "";

    // --- Clean up files ---
    if (videoFile) fs.unlinkSync(videoFile.path);
    framePaths.forEach(f => fs.unlinkSync(f));

    res.json({ bio: combinedBio, bioSummary, analysis });

  } catch (err) {
    console.error("Analyze error:", err);
    res.status(500).json({ error: "Failed to analyze" });
  }
});

// --- Chatbot Endpoint ---
app.post("/chatbot", async (req, res) => {
  try {
    const { userId, bio, message } = req.body;
    if (!userId || !message) return res.status(400).json({ error: "userId and message required" });

    // Combine bio
    let combinedBio = bioDatabase[userId] || "";
    if (bio) combinedBio = (combinedBio + " " + bio).trim();
    bioDatabase[userId] = combinedBio;

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `You are a Fortnite chatbot. Player Bio: ${combinedBio}` },
        { role: "user", content: message }
      ],
      max_tokens: 300
    });

    const reply = response.choices[0].message.content || "";
    res.json({ reply, bio: combinedBio });

  } catch (err) {
    console.error("Chatbot error:", err);
    res.status(500).json({ error: "Failed to get chatbot response" });
  }
});

// --- Root Endpoint ---
app.get("/", (req, res) => {
  res.send("🎮 Fortnite AI API running!");
});

// --- Start Server ---
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server running on port ${port}`));
