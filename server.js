// server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import crypto from "crypto";
import OpenAI from "openai";

const app = express();
const upload = multer({ dest: "uploads/" });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Simple in-memory cache (replace with DB for production) ---
const analysisCache = new Map();

// --- Helpers ---
function hashFile(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

function extractFrames(videoPath, outputDir, count = 5) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -y -i "${videoPath}" -vf "thumbnail,scale=640:360" -frames:v ${count} "${outputDir}/frame-%02d.png" -hide_banner -loglevel error`;
    exec(cmd, (err) => {
      if (err) return reject(err);
      try {
        const frames = fs
          .readdirSync(outputDir)
          .filter((f) => f.startsWith("frame-") && f.endsWith(".png"))
          .map((f) => `${outputDir}/${f}`);
        resolve(frames);
      } catch (e) {
        reject(e);
      }
    });
  });
}

function detectKeyMomentsFFmpeg(videoPath) {
  return new Promise((resolve) => {
    const cmd = `ffmpeg -i "${videoPath}" -vf "select=gt(scene\\,0.3),showinfo" -f null -`;
    exec(cmd, (err, stdout, stderr) => {
      if (err) return resolve([]);
      const matches = stderr.match(/pts_time:(\d+\.?\d*)/g) || [];
      const times = matches.map((m) => parseFloat(m.replace("pts_time:", "")));
      resolve(times.slice(0, 10)); // Limit to 10 key moments
    });
  });
}

function applyDynamicSpacing(text) {
  let spaced = text.replace(/\n\s*\n/g, "\n\n");
  spaced = spaced.replace(/([^\n])\n([^\n])/g, "$1\n\n$2");
  spaced = spaced.replace(/\n{3,}/g, "\n\n");
  return spaced.trim();
}

// --- /analyze endpoint ---
app.post("/analyze", upload.single("video"), async (req, res) => {
  try {
    const {
      game, responseType, focusArea, detailLevel, bio,
      focusAreas, skillLevel, feedbackStyle, clipType, language, audioInClip, advancedOptions
    } = req.body;

    const videoFile = req.file;

    if (!game || !responseType || !focusArea || !detailLevel || !videoFile) {
      return res.status(400).json({ success: false, error: "Missing required fields." });
    }

    // Parse JSON fields
    const parsedFocusAreas = focusAreas ? JSON.parse(focusAreas) : [focusArea];
    const parsedAdvancedOptions = advancedOptions ? JSON.parse(advancedOptions) : {};

    // --- Step 0: Check cache ---
    const videoHash = hashFile(videoFile.path);
    if (analysisCache.has(videoHash)) {
      try { fs.unlinkSync(videoFile.path); } catch(e){}
      return res.json({ ...analysisCache.get(videoHash), cached: true });
    }

    // --- Step 1: Detect key moments ---
    const keyTimes = await detectKeyMomentsFFmpeg(videoFile.path);
    const keyMoments = keyTimes.length ? keyTimes.slice(0, 10).map(t => `${Math.round(t)}s`) : [];

    // --- Step 2: Extract frames ---
    const frameDir = path.join("uploads", `frames-${Date.now()}`);
    fs.mkdirSync(frameDir, { recursive: true });
    let frames = [];
    try { frames = await extractFrames(videoFile.path, frameDir, Math.min(keyMoments.length || 5, 10)); } catch(e){ console.error("Frame extraction failed:", e); }

    // --- Step 3: Cleanup ---
    try { frames.forEach(f=>fs.unlinkSync(f)); fs.rmdirSync(frameDir); fs.unlinkSync(videoFile.path); } catch(e){}

    // --- Step 4: Build GPT prompt including all settings ---
    const analysisPrompt = `
You are a professional ${game} gameplay analyst.
Player Bio: ${bio || "No bio provided"}
Focus Areas: ${parsedFocusAreas.join(", ")}
Skill Level: ${skillLevel || "N/A"}
Feedback Style: ${feedbackStyle || "N/A"}
Clip Type: ${clipType || "N/A"}
Language: ${language || "English"}
Audio Included: ${audioInClip || "false"}
Advanced Options: ${JSON.stringify(parsedAdvancedOptions)}
Key Moments: ${keyMoments.length ? keyMoments.join(", ") : "No key moments detected"}
Response Type: ${responseType}
Detail Level: ${detailLevel}
Provide a clean, readable analysis with spacing between sections.
`;

    const model = ["detailed","coach"].includes(responseType.toLowerCase()) ? "gpt-4o-mini" : "gpt-3.5-turbo";
    const maxTokensMap = { short: 300, balanced: 600, detailed: 1200, coach: 1500 };
    const max_tokens = maxTokensMap[responseType.toLowerCase()] || 600;

    const aiResp = await openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: `You are a professional ${game} coach. Return plain formatted text only.` },
        { role: "user", content: analysisPrompt }
      ],
      max_tokens
    });

    let cleanText = applyDynamicSpacing(aiResp.choices?.[0]?.message?.content || "No analysis returned");

    // --- Step 5: Generate charts ---
    const baseStats = { accuracy: 80, positioning: 75, editing: 70, building: 65 };
    const frameCount = frames.length || Math.min(keyMoments.length || 5, 10);
    const generateTimeline = (base) => Array.from({ length: frameCount }, (_, i) => Math.min(100, Math.max(0, base + Math.round(Math.random()*10-5))));

    let charts = [];
    const focusTypes = parsedFocusAreas.length ? parsedFocusAreas.map(f => f.toLowerCase()) : ["overall"];
    focusTypes.forEach((type) => {
      charts.push({
        label: type.charAt(0).toUpperCase() + type.slice(1),
        labels: Array.from({ length: frameCount }, (_, i) => `Frame ${i+1}`),
        data: generateTimeline(baseStats[type] || 70)
      });
    });

    const responseData = {
      success: true,
      analysis: cleanText,
      keyMoments: keyMoments.join(", "),
      frameCount,
      stats: baseStats,
      charts,
      headline: "Gameplay Analysis",
      cached: false
    };
    analysisCache.set(videoHash, responseData);
    return res.json(responseData);

  } catch (error) {
    console.error("AI Analysis error:", error);
    return res.status(500).json({ success: false, error: "Internal server error during analysis." });
  }
});

// Root
app.get("/", (req, res) => res.send("🎮 GPT-4o Game AI API with caching and cost optimization!"));

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
