// server.js
import express from "express";
import multer from "multer";
import fs from "fs";
import { exec } from "child_process";
import OpenAI from "openai";
import cv from "opencv4nodejs"; // npm install opencv4nodejs

const app = express();
const upload = multer({ dest: "uploads/" });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Helper: Extract frames from video ---
function extractFrames(videoPath, outputDir, count = 5) {
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

// --- Helper: Analyze key moments using OpenCV ---
async function detectKeyMoments(frames) {
  const keyMoments = [];
  for (let i = 0; i < frames.length; i++) {
    const img = cv.imread(frames[i]);
    const gray = img.bgrToGray();
    const edges = gray.canny(50, 150);
    const nonZero = edges.countNonZero();

    // Heuristic: high activity frames may indicate kills/explosions
    if (nonZero > 5000) keyMoments.push(`Frame ${i + 1}`);
  }
  return keyMoments.length > 0 ? keyMoments.join(", ") : "No key moments detected";
}

// --- Helper: Apply strict dynamic spacing ---
function applyDynamicSpacing(text) {
  let spaced = text.replace(/\n\s*\n/g, "\n\n");
  spaced = spaced.replace(/([^\n])\n([^\n])/g, "$1\n\n$2");
  spaced = spaced.replace(/\n{3,}/g, "\n\n");
  return spaced.trim();
}

// --- /analyze endpoint ---
app.post("/analyze", upload.single("video"), async (req, res) => {
  const { game, responseType, focusArea, detailLevel, bio } = req.body;
  const videoFile = req.file;

  if (!game || !responseType || !focusArea || !detailLevel || !bio) {
    return res.status(400).json({
      success: false,
      error: "Missing required fields: game, responseType, focusArea, detailLevel, or bio",
    });
  }

  let frameSummary = "";
  let keyMoments = "";

  try {
    if (videoFile) {
      const frameDir = `uploads/frames-${Date.now()}`;
      fs.mkdirSync(frameDir);
      const frames = await extractFrames(videoFile.path, frameDir, 5);
      frameSummary = `Extracted ${frames.length} frames from the gameplay video.`;

      keyMoments = await detectKeyMoments(frames);

      // Clean up frames & video
      frames.forEach((f) => fs.unlinkSync(f));
      fs.rmdirSync(frameDir);
      fs.unlinkSync(videoFile.path);
    }
  } catch (err) {
    console.error("Video processing error:", err);
    frameSummary = "Video processing failed or no frames extracted.";
    keyMoments = "No key moments detected.";
  }

  try {
    // --- Focus Prompt ---
    let focusPrompt = "";
    switch (focusArea.toLowerCase()) {
      case "aim": focusPrompt = "Focus on aiming, shooting accuracy, and tracking."; break;
      case "building": focusPrompt = "Focus on building speed, edits, and structure control."; break;
      case "positioning": focusPrompt = "Focus on positioning, rotations, and awareness."; break;
      case "overall": focusPrompt = "Analyze everything comprehensively."; break;
      default: focusPrompt = "Provide general gameplay analysis."; 
    }

    // --- Response Type Prompt ---
    let responsePrompt = "";
    switch (responseType.toLowerCase()) {
      case "short": responsePrompt = "Provide a short 2–3 sentence summary."; break;
      case "balanced": responsePrompt = "Provide a balanced analysis with brief scores and suggestions."; break;
      case "detailed": responsePrompt = "Provide detailed step-by-step advice with examples."; break;
      case "coach": responsePrompt = "Respond like a professional coach with tips and encouragement."; break;
      default: responsePrompt = "Provide general feedback."; 
    }

    // --- Detail Multiplier ---
    let detailMultiplier = 1;
    if (detailLevel.toLowerCase() === "low") detailMultiplier = 0.8;
    else if (detailLevel.toLowerCase() === "normal") detailMultiplier = 1;
    else if (detailLevel.toLowerCase() === "high") detailMultiplier = 3;

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
        {
          role: "system",
          content: `You are a professional ${game} coach. Return plain formatted text only.`,
        },
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
    });

  } catch (error) {
    console.error("AI Analysis error:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error during analysis.",
    });
  }
});

// --- Root Route ---
app.get("/", (req, res) => {
  res.send("🎮 GPT-4o Game AI API running with key moment detection!");
});

// --- Start Server ---
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server running on port ${port}`));
