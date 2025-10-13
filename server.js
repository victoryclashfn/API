// server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import OpenAI from "openai";
import crypto from "crypto";

const app = express();

// Ensure uploads folder exists
const UPLOADS_DIR = "uploads";
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// Multer setup
const upload = multer({ dest: UPLOADS_DIR });

// OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// In-memory token store
const tokenStore = new Map();
const TOKEN_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Helpers ---
function generateToken() {
  return crypto.randomBytes(24).toString("hex");
}

function scheduleTokenCleanup(token) {
  setTimeout(() => {
    const entry = tokenStore.get(token);
    if (entry) {
      try { if (fs.existsSync(entry.filePath)) fs.unlinkSync(entry.filePath); } catch(e){}
      try { if (entry.frameDir && fs.existsSync(entry.frameDir)) fs.rmSync(entry.frameDir, { recursive: true, force: true }); } catch(e){}
      tokenStore.delete(token);
    }
  }, TOKEN_EXPIRY_MS + 1000);
}

function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    const cmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`;
    exec(cmd, (err, stdout) => {
      if (err) return reject(err);
      resolve(parseFloat(stdout.trim()));
    });
  });
}

function extractFrames(videoPath, outputDir, count = 5) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -y -i "${videoPath}" -vf "thumbnail,scale=640:360" -frames:v ${count} "${outputDir}/frame-%02d.png" -hide_banner -loglevel error`;
    exec(cmd, (err) => {
      if (err) return reject(err);
      try {
        const frames = fs.readdirSync(outputDir)
          .filter(f => f.startsWith("frame-") && f.endsWith(".png"))
          .map(f => path.join(outputDir, f));
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
      if (err) return resolve("No key moments detected");
      const matches = stderr.match(/pts_time:(\d+\.?\d*)/g) || [];
      const times = matches.map(m => m.replace("pts_time:", ""));
      resolve(times.length > 0 ? times.slice(0, 10).map(t => `${Math.round(t)}s`).join(", ") : "No key moments detected");
    });
  });
}

function applyDynamicSpacing(text) {
  let spaced = text.replace(/\n\s*\n/g, "\n\n");
  spaced = spaced.replace(/([^\n])\n([^\n])/g, "$1\n\n$2");
  spaced = spaced.replace(/\n{3,}/g, "\n\n");
  return spaced.trim();
}

function calculateCost(durationSeconds = 0, detailLevel = "normal", responseType = "balanced", focusArea = "overall") {
  const base = durationSeconds * 20;
  const detailMap = { low: 0.8, normal: 1, high: 2 };
  const detailMultiplier = detailMap[detailLevel.toLowerCase()] || 1;

  let responseSurcharge = 0;
  if (responseType.toLowerCase() === "detailed") responseSurcharge = Math.ceil(durationSeconds * 2);
  if (responseType.toLowerCase() === "coach") responseSurcharge = Math.ceil(durationSeconds * 5);

  let focusSurcharge = focusArea.toLowerCase() === "overall" ? Math.ceil(base * 0.10) : 0;

  return {
    base: Math.ceil(base),
    detailMultiplier,
    responseSurcharge,
    focusSurcharge,
    total: Math.ceil(base * detailMultiplier + responseSurcharge + focusSurcharge)
  };
}

// -------------------
// Routes
// -------------------

// Root
app.get("/", (req, res) => res.send("🎮 GPT-4o Game AI API running!"));

// INIT
app.post("/analyze/init", upload.single("video"), async (req, res) => {
  try {
    const { game, responseType, focusArea, detailLevel, bio } = req.body;
    const videoFile = req.file;

    if (!game || !responseType || !focusArea || !detailLevel || !videoFile) {
      return res.status(400).json({ success: false, error: "Missing required fields." });
    }

    let videoLength = 0;
    try { videoLength = await getVideoDuration(videoFile.path); } catch(e) { videoLength = 0; }

    const costInfo = calculateCost(videoLength, detailLevel, responseType, focusArea);
    const token = generateToken();
    const frameDir = path.join(UPLOADS_DIR, `frames-pending-${Date.now()}-${token}`);

    tokenStore.set(token, {
      filePath: videoFile.path,
      originalName: videoFile.originalname,
      body: { game, responseType, focusArea, detailLevel, bio },
      createdAt: Date.now(),
      expiresAt: Date.now() + TOKEN_EXPIRY_MS,
      frameDir
    });

    scheduleTokenCleanup(token);

    return res.json({
      success: true,
      message: "Cost calculated. Use token to confirm after deducting credits.",
      cost: costInfo.total,
      breakdown: costInfo,
      token,
      videoLength: Math.round(videoLength)
    });

  } catch (error) {
    console.error("Init error:", error);
    return res.status(500).json({ success: false, error: "Server error during init." });
  }
});

// CONFIRM
app.post("/analyze/confirm", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ success: false, error: "Missing token." });

    const entry = tokenStore.get(token);
    if (!entry || Date.now() > entry.expiresAt) {
      if (entry) {
        try { if (fs.existsSync(entry.filePath)) fs.unlinkSync(entry.filePath); } catch(e){}
        try { if (entry.frameDir && fs.existsSync(entry.frameDir)) fs.rmSync(entry.frameDir, { recursive: true, force: true }); } catch(e){}
        tokenStore.delete(token);
      }
      return res.status(400).json({ success: false, error: "Invalid or expired token." });
    }

    const { filePath, body, frameDir } = entry;
    const { game, responseType, focusArea, detailLevel, bio } = body;

    let videoLength = 0, frameCount = 5, frameSummary = "No frames extracted.", keyMoments = "No key moments detected.";

    try {
      videoLength = await getVideoDuration(filePath);
      frameCount = videoLength > 120 ? 15 : (videoLength >= 30 ? 10 : 5);

      fs.mkdirSync(frameDir, { recursive: true });
      const frames = await extractFrames(filePath, frameDir, frameCount);
      frameSummary = `Extracted ${frames.length} frames from the ${Math.round(videoLength)}s gameplay video.`;
      keyMoments = await detectKeyMomentsFFmpeg(filePath);

      // Cleanup
      frames.forEach(f => { try { fs.unlinkSync(f); } catch(e){} });
      try { fs.rmdirSync(frameDir); } catch(e){}
      try { fs.unlinkSync(filePath); } catch(e){}
    } catch (err) {
      console.error("Video processing error:", err);
    }

    // AI Prompt
    const focusPromptMap = {
      aim: "Focus on aiming, shooting accuracy, and tracking.",
      building: "Focus on building speed, edits, and structure control.",
      positioning: "Focus on positioning, rotations, and awareness.",
      movement: "Focus on movement and positioning decisions.",
      overall: "Analyze all aspects: aiming, building, positioning, and movement."
    };
    const responsePromptMap = {
      short: "Provide a short 2–3 sentence summary.",
      balanced: "Provide a balanced analysis with brief scores and suggestions.",
      detailed: "Provide detailed step-by-step advice with examples.",
      coach: "Respond like a professional coach with tips and encouragement."
    };

    const analysisPrompt = `
You are a professional ${game} gameplay analyst.
Player Bio: ${bio || "No bio provided"}
Video Summary: ${frameSummary}
Key Moments: ${keyMoments}
Focus: ${focusPromptMap[focusArea.toLowerCase()] || "General analysis"}
Detail Level: ${detailLevel}
Response Type: ${responsePromptMap[responseType.toLowerCase()] || "General feedback"}
Provide a clean, readable, plain text analysis. Add spacing between sections.
`;

    let cleanText = "";
    try {
      const aiTextResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: `You are a professional ${game} coach. Return plain text only.` },
          { role: "user", content: analysisPrompt }
        ]
      });
      cleanText = applyDynamicSpacing(aiTextResp.choices?.[0]?.message?.content || "");
    } catch(err) {
      console.error("OpenAI error:", err);
      cleanText = "AI analysis failed or returned no content.";
    }

    const baseStats = { accuracy: 80, positioning: 75, editing: 70, building: 65 };
    const generateTimeline = (base) => Array.from({ length: frameCount }, (_, i) => Math.min(100, Math.max(0, base + Math.round(Math.random()*10-5))));
    const charts = (focusArea.toLowerCase() === "overall" ? ["accuracy","positioning","editing","building"] : [focusArea.toLowerCase()]).map(type => ({
      label: type.charAt(0).toUpperCase() + type.slice(1),
      labels: Array.from({ length: frameCount }, (_, i) => `Frame ${i+1}`),
      data: generateTimeline(baseStats[type] || 70)
    }));

    const costInfo = calculateCost(videoLength, detailLevel, responseType, focusArea);
    tokenStore.delete(token);

    return res.json({
      success: true,
      analysis: cleanText,
      keyMoments,
      videoLength: Math.round(videoLength),
      frameCount,
      stats: baseStats,
      charts,
      headline: "Gameplay Analysis",
      cost: costInfo.total,
      breakdown: costInfo
    });

  } catch (error) {
    console.error("AI Analysis error:", error);
    return res.status(500).json({ success: false, error: "Internal server error during analysis." });
  }
});

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
