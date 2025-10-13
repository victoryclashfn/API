// server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import OpenAI from "openai";

const app = express();
const upload = multer({ dest: "uploads/" });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Enable CORS
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Helpers ---
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
      if (err) return resolve("No key moments detected");
      const matches = stderr.match(/pts_time:(\d+\.?\d*)/g) || [];
      const times = matches.map((m) => m.replace("pts_time:", ""));
      if (times.length === 0) return resolve("No key moments detected");
      resolve(times.slice(0, 10).map((t) => `${Math.round(t)}s`).join(", "));
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

function calculateCost({ videoLength, detailLevel, responseType }) {
  const basePerSecond = 0.20; // $0.02 per second
  const detailMultiplierMap = { low: 0.8, normal: 1, high: 3 };
  const responseMultiplierMap = { short: 0.8, balanced: 1, detailed: 1.5, coach: 2 };

  const detailMultiplier = detailMultiplierMap[detailLevel?.toLowerCase()] || 1;
  const responseMultiplier = responseMultiplierMap[responseType?.toLowerCase()] || 1;

  return +(videoLength * basePerSecond * detailMultiplier * responseMultiplier).toFixed(2);
}

// --- /calculate-cost endpoint ---
app.post("/calculate-cost", upload.single("video"), async (req, res) => {
  try {
    const { detailLevel, responseType } = req.body;
    const videoFile = req.file;

    if (!videoFile) return res.status(400).json({ success: false, error: "No video uploaded" });

    const videoLength = await getVideoDuration(videoFile.path);
    const cost = calculateCost({ videoLength, detailLevel, responseType });

    // Cleanup uploaded video
    try { fs.unlinkSync(videoFile.path); } catch (e) {}

    return res.json({ success: true, videoLength: Math.round(videoLength), cost });
  } catch (error) {
    console.error("Cost calculation error:", error);
    return res.status(500).json({ success: false, error: "Error calculating cost" });
  }
});

// --- /analyze endpoint ---
app.post("/analyze", upload.single("video"), async (req, res) => {
  try {
    const { game, responseType, focusArea, detailLevel, bio } = req.body;
    const videoFile = req.file;

    if (!game || !responseType || !focusArea || !detailLevel || !videoFile) {
      return res.status(400).json({ success: false, error: "Missing required fields." });
    }

    let frameSummary = "No frames extracted.";
    let keyMoments = "No key moments detected.";
    let videoLength = 0;
    let frameCount = 5;

    try {
      videoLength = await getVideoDuration(videoFile.path);
      if (videoLength >= 30 && videoLength <= 120) frameCount = 10;
      else if (videoLength > 120) frameCount = 15;

      const frameDir = path.join("uploads", `frames-${Date.now()}`);
      fs.mkdirSync(frameDir, { recursive: true });

      const frames = await extractFrames(videoFile.path, frameDir, frameCount);
      frameSummary = `Extracted ${frames.length} frames from the ${Math.round(videoLength)}s gameplay video.`;

      keyMoments = await detectKeyMomentsFFmpeg(videoFile.path);

      // Cleanup frames and video
      frames.forEach((f) => { try { fs.unlinkSync(f); } catch(e){} });
      try { fs.rmdirSync(frameDir); } catch(e){}
      try { fs.unlinkSync(videoFile.path); } catch(e){}
    } catch (err) {
      console.error("Video processing error:", err);
      frameSummary = "Video processing failed or no frames extracted.";
    }

    // --- Build Prompts ---
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
    const detailMultiplierMap = { low: 0.8, normal: 1, high: 3 };
    const detailMultiplier = detailMultiplierMap[detailLevel.toLowerCase()] || 1;

    // --- Plain Text Analysis ---
    const analysisPrompt = `
You are a professional ${game} gameplay analyst.
Player Bio: ${bio || "No bio provided"}
Video Summary: ${frameSummary}
Key Moments: ${keyMoments}
Focus: ${focusPrompt}
Detail Level: ${detailLevel} (${detailMultiplier}x)
Response Type: ${responsePrompt}
Provide a clean, readable, plain text analysis. Add spacing between sections. Never use symbols like *, {}, [], #, or \`\`\`.
`;

    const aiTextResp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `You are a professional ${game} coach. Return plain formatted text only.` },
        { role: "user", content: analysisPrompt }
      ]
    });

    let cleanText = (aiTextResp.choices?.[0]?.message?.content || "").trim();
    cleanText = cleanText.replace(/[{}[\]*#"]/g, "").replace(/\n{3,}/g, "\n\n").trim();
    cleanText = applyDynamicSpacing(cleanText);

    // --- Structured JSON for Charts ---
    const baseStats = { accuracy: 80, positioning: 75, editing: 70, building: 65 };
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

    return res.json({
      success: true,
      analysis: cleanText,
      keyMoments,
      videoLength: Math.round(videoLength),
      frameCount,
      stats: baseStats,
      charts,
      headline: "Gameplay Analysis"
    });

  } catch (error) {
    console.error("AI Analysis error:", error);
    return res.status(500).json({ success: false, error: "Internal server error during analysis." });
  }
});

// Root
app.get("/", (req, res) => res.send("🎮 GPT-4o Game AI API with multi-chart carousel support!"));

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
