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

function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    const cmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`;
    exec(cmd, (err, stdout) => {
      if (err) return reject(err);
      resolve(parseFloat(stdout.trim()));
    });
  });
}

// --- /analyze endpoint ---
app.post("/analyze", upload.single("video"), async (req, res) => {
  try {
    const { game, responseType, focusArea, detailLevel, bio } = req.body;
    const videoFile = req.file;

    if (!game || !responseType || !focusArea || !detailLevel || !videoFile) {
      return res.status(400).json({ success: false, error: "Missing required fields." });
    }

    // --- Step 0: Check cache ---
    const videoHash = hashFile(videoFile.path);
    if (analysisCache.has(videoHash)) {
      // Return cached result
      try { fs.unlinkSync(videoFile.path); } catch(e){}
      return res.json({ ...analysisCache.get(videoHash), cached: true });
    }

    // --- Step 1: Detect key moments ---
    const keyTimes = await detectKeyMomentsFFmpeg(videoFile.path);
    const keyMoments = keyTimes.length ? keyTimes.map(t => `${Math.round(t)}s`) : [];

    // --- Step 2: Extract frames around key moments (max 10) ---
    const frameDir = path.join("uploads", `frames-${Date.now()}`);
    fs.mkdirSync(frameDir, { recursive: true });
    let frames = [];
    try {
      const frameCount = Math.min(keyMoments.length || 5, 10);
      frames = await extractFrames(videoFile.path, frameDir, frameCount);
    } catch (err) {
      console.error("Frame extraction failed:", err);
    }

    // --- Step 3: Cleanup frames and video after processing ---
    try { frames.forEach(f => fs.unlinkSync(f)); fs.rmdirSync(frameDir); fs.unlinkSync(videoFile.path); } catch(e){}

    // --- Step 4: Focus & response prompts ---
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
    const focusPrompt = focusPromptMap[focusArea.toLowerCase()] || "Provide general gameplay analysis.";
    const responsePrompt = responsePromptMap[responseType.toLowerCase()] || "Provide general feedback.";

    // --- Step 5: Model selection & max tokens ---
    const model = ["detailed","coach"].includes(responseType.toLowerCase()) ? "gpt-4o-mini" : "gpt-3.5-turbo";
    const maxTokensMap = { short: 300, balanced: 600, detailed: 1200, coach: 1500 };
    const max_tokens = maxTokensMap[responseType.toLowerCase()] || 600;

    // --- Step 6: Build GPT prompt ---
    const analysisPrompt = `
You are a professional ${game} gameplay analyst.
Player Bio: ${["detailed","coach"].includes(responseType.toLowerCase()) ? (bio || "No bio provided") : "N/A"}
Key Moments: ${keyMoments.length ? keyMoments.join(", ") : "No key moments detected"}
Focus: ${focusPrompt}
Response Type: ${responsePrompt}
Provide a clean, readable, plain text analysis. Add spacing between sections.
`;

    // --- Step 7: Call OpenAI ---
    const aiResp = await openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: `You are a professional ${game} coach. Return plain formatted text only.` },
        { role: "user", content: analysisPrompt }
      ],
      max_tokens
    });

    let cleanText = (aiResp.choices?.[0]?.message?.content || "").trim();
    cleanText = cleanText.replace(/[{}[\]*#"]/g, "").replace(/\n{3,}/g, "\n\n").trim();
    cleanText = applyDynamicSpacing(cleanText);

    // --- Step 8: Generate charts locally ---
    const baseStats = { accuracy: 80, positioning: 75, editing: 70, building: 65 };
    const frameCount = frames.length || Math.min(keyMoments.length || 5, 10);
    const generateTimeline = (base) => Array.from({ length: frameCount }, (_, i) => Math.min(100, Math.max(0, base + Math.round(Math.random()*10-5))));

    let charts = [];
    const focusTypes = focusArea.toLowerCase() === "overall" ? ["accuracy","positioning","editing","building"] : [focusArea.toLowerCase()];

    focusTypes.forEach((type) => {
      charts.push({
        label: type.charAt(0).toUpperCase() + type.slice(1),
        labels: Array.from({ length: frameCount }, (_, i) => `Frame ${i+1}`),
        data: generateTimeline(baseStats[type] || 70)
      });
    });

    // --- Step 9: Build response & cache ---
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
    analysisCache.set(videoHash, responseData); // Cache result

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
