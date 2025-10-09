// server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import { exec } from "child_process";
import OpenAI from "openai";
import path from "path";

const app = express();
const upload = multer({ dest: "uploads/" });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Enable CORS for frontend ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Helper: Extract frames from video ---
function extractFrames(videoPath, outputDir, count = 5) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -y -i "${videoPath}" -vf "thumbnail,scale=640:360" -frames:v ${count} "${outputDir}/frame-%02d.png" -hide_banner -loglevel error`;
    exec(cmd, (err) => {
      if (err) return reject(err);
      try {
        const frames = fs
          .readdirSync(outputDir)
          .filter((f) => f.startsWith("frame-") && f.endsWith(".png"))
          .map((f) => path.join(outputDir, f));
        resolve(frames);
      } catch (e) {
        reject(e);
      }
    });
  });
}

// --- Helper: Detect key moments using FFmpeg scene detection ---
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

// --- Helper: Apply dynamic spacing ---
function applyDynamicSpacing(text) {
  let spaced = text.replace(/\n\s*\n/g, "\n\n");
  spaced = spaced.replace(/([^\n])\n([^\n])/g, "$1\n\n$2");
  spaced = spaced.replace(/\n{3,}/g, "\n\n");
  return spaced.trim();
}

// --- Helper: Get video duration ---
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

    if (!game || !responseType || !focusArea || !detailLevel || !bio || !videoFile) {
      return res.status(400).json({ success: false, error: "Missing required fields or video." });
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

      // Cleanup frames & video
      frames.forEach((f) => fs.unlinkSync(f));
      fs.rmdirSync(frameDir);
      fs.unlinkSync(videoFile.path);

    } catch (err) {
      console.error("Video processing error:", err);
      frameSummary = "Video processing failed or no frames extracted.";
    }

    // --- Focus Prompt ---
    let focusPrompt = {
      aim: "Focus on aiming, shooting accuracy, and tracking.",
      building: "Focus on building speed, edits, and structure control.",
      positioning: "Focus on positioning, rotations, and awareness.",
      overall: "Analyze everything comprehensively."
    }[focusArea.toLowerCase()] || "Provide general gameplay analysis.";

    // --- Response Prompt ---
    let responsePrompt = {
      short: "Provide a short 2–3 sentence summary.",
      balanced: "Provide a balanced analysis with brief scores and suggestions.",
      detailed: "Provide detailed step-by-step advice with examples.",
      coach: "Respond like a professional coach with tips and encouragement."
    }[responseType.toLowerCase()] || "Provide general feedback.";

    // --- Detail Multiplier ---
    let detailMultiplier = { low: 0.8, normal: 1, high: 3 }[detailLevel.toLowerCase()] || 1;

    // --- AI Prompt ---
    const analysisPrompt = `
You are a professional ${game} gameplay analyst.

Player Bio: ${bio}
Video Summary: ${frameSummary}
Key Moments: ${keyMoments}

Focus: ${focusPrompt}
Detail Level: ${detailLevel} (${detailMultiplier}x)
Response Type: ${responsePrompt}

Provide a clean, readable, plain text analysis. Add extra spacing between sections and tips for clarity. Never use symbols like *, {}, [], #, or \`\`\`.
`;

    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `You are a professional ${game} coach. Return plain formatted text only.` },
        { role: "user", content: analysisPrompt },
      ],
    });

    let cleanText = aiResponse.choices[0].message.content.trim();
    cleanText = cleanText.replace(/[{}[\]*#"]/g, "").replace(/\n{3,}/g, "\n\n").trim();
    cleanText = applyDynamicSpacing(cleanText);

    return res.json({
      success: true,
      analysis: cleanText,
      keyMoments,
      videoLength: Math.round(videoLength),
      frameCount,
    });

  } catch (error) {
    console.error("Analysis endpoint error:", error);
    return res.status(500).json({ success: false, error: error.message || "Internal server error." });
  }
});

// --- Root Route ---
app.get("/", (req, res) => {
  res.send("🎮 GPT-4o Game AI API running with dynamic frame count and FFmpeg key moment detection!");
});

// --- Start Server ---
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server running on port ${port}`));
