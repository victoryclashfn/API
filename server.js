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
const upload = multer({ dest: "uploads/" });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// In-memory token store for two-step flow
// Structure: token -> { filePath, originalName, body, createdAt, expiresAt, frameDir }
const tokenStore = new Map();
// Token expiry ms
const TOKEN_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true) }));

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

function generateToken() {
  return crypto.randomBytes(24).toString("hex");
}

function scheduleTokenCleanup(token, timeoutMs = TOKEN_EXPIRY_MS) {
  setTimeout(() => {
    const entry = tokenStore.get(token);
    if (entry) {
      // cleanup files
      try { if (fs.existsSync(entry.filePath)) fs.unlinkSync(entry.filePath); } catch(e){}
      try { if (entry.frameDir && fs.existsSync(entry.frameDir)) fs.rmSync(entry.frameDir, { recursive: true, force: true }); } catch(e){}
      tokenStore.delete(token);
      // console.log(`Token ${token} expired and cleaned up.`);
    }
  }, timeoutMs + 1000); // small buffer
}

/**
 * Cost calculation logic (base 20 credits per second + modifiers)
 * - base = durationSeconds * 20
 * - detailMultiplier: low=0.8, normal=1, high=2
 * - responseType surcharge:
 *    short: 0
 *    balanced: 0
 *    detailed: ceil(duration * 2)
 *    coach: ceil(duration * 5)
 * - focus: overall -> +10% of base (rounded)
 */
function calculateCost(durationSeconds = 0, detailLevel = "normal", responseType = "balanced", focusArea = "overall") {
  const base = durationSeconds * 20;

  const detailMap = { low: 0.8, normal: 1, high: 2 };
  const detailMultiplier = detailMap[(detailLevel || "normal").toLowerCase()] ?? 1;

  const rt = (responseType || "balanced").toLowerCase();
  let responseSurcharge = 0;
  if (rt === "detailed") responseSurcharge = Math.ceil(durationSeconds * 2);
  else if (rt === "coach") responseSurcharge = Math.ceil(durationSeconds * 5);
  // short & balanced -> 0

  const focus = (focusArea || "overall").toLowerCase();
  let focusSurcharge = 0;
  if (focus === "overall") focusSurcharge = Math.ceil(base * 0.10); // 10% of base
  // else single-focus -> 0

  const final = Math.ceil(base * detailMultiplier + responseSurcharge + focusSurcharge);
  return {
    base: Math.ceil(base),
    detailMultiplier,
    responseSurcharge,
    focusSurcharge,
    total: final
  };
}

// -----------------------
// Two-step API workflow
// 1) POST /analyze/init   (multipart with "video" file)
//    => server calculates cost, stores file and metadata under a token, returns { token, cost }
// 2) POST /analyze/confirm
//    => body: { token }
//    => server verifies token, performs processing & OpenAI call, returns analysis results
// -----------------------

/**
 * INIT: receive upload + options, compute duration & cost, store file temporarily, return token
 * Example request form-data fields:
 * - video (file)
 * - game, responseType, focusArea, detailLevel, bio (strings)
 */
app.post("/analyze/init", upload.single("video"), async (req, res) => {
  try {
    const { game, responseType, focusArea, detailLevel, bio } = req.body;
    const videoFile = req.file;

    if (!game || !responseType || !focusArea || !detailLevel || !videoFile) {
      // still allow init if user intentionally didn't pass some fields? keep strict:
      return res.status(400).json({ success: false, error: "Missing required fields (game, responseType, focusArea, detailLevel, video)." });
    }

    // get duration
    let videoLength = 0;
    try {
      videoLength = await getVideoDuration(videoFile.path);
      if (isNaN(videoLength) || !isFinite(videoLength)) videoLength = 0;
    } catch (err) {
      console.warn("Could not read video duration:", err);
      videoLength = 0;
    }

    // cost calculation
    const costInfo = calculateCost(videoLength, detailLevel, responseType, focusArea);

    // create token and store metadata
    const token = generateToken();
    const frameDir = path.join("uploads", `frames-pending-${Date.now()}-${token}`);
    // keep file & frameDir references for later processing
    tokenStore.set(token, {
      filePath: videoFile.path,
      originalName: videoFile.originalname,
      body: { game, responseType, focusArea, detailLevel, bio },
      createdAt: Date.now(),
      expiresAt: Date.now() + TOKEN_EXPIRY_MS,
      frameDir
    });
    scheduleTokenCleanup(token);

    // return cost and token to caller (WordPress should deduct credits then call /analyze/confirm)
    return res.json({
      success: true,
      message: "Cost calculated. Use the returned token to confirm and run analysis after deducting credits.",
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

/**
 * CONFIRM: body { token }
 * - Verifies token exists and not expired
 * - Runs actual processing & AI analysis
 * - Cleans up and returns results
 */
app.post("/analyze/confirm", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ success: false, error: "Missing token." });

    const entry = tokenStore.get(token);
    if (!entry) return res.status(400).json({ success: false, error: "Invalid or expired token." });

    // check expiry
    if (Date.now() > entry.expiresAt) {
      // cleanup here just in case
      try { if (fs.existsSync(entry.filePath)) fs.unlinkSync(entry.filePath); } catch(e){}
      try { if (entry.frameDir && fs.existsSync(entry.frameDir)) fs.rmSync(entry.frameDir, { recursive: true, force: true }); } catch(e){}
      tokenStore.delete(token);
      return res.status(400).json({ success: false, error: "Token expired." });
    }

    // Now we run the full processing & AI analysis
    const { filePath, originalName, body, frameDir } = entry;
    const { game, responseType, focusArea, detailLevel, bio } = body;

    // Determine frameCount by duration
    let frameSummary = "No frames extracted.";
    let keyMoments = "No key moments detected.";
    let videoLength = 0;
    let frameCount = 5;

    try {
      videoLength = await getVideoDuration(filePath);
      if (videoLength >= 30 && videoLength <= 120) frameCount = 10;
      else if (videoLength > 120) frameCount = 15;

      fs.mkdirSync(frameDir, { recursive: true });

      const frames = await extractFrames(filePath, frameDir, frameCount);
      frameSummary = `Extracted ${frames.length} frames from the ${Math.round(videoLength)}s gameplay video.`;

      keyMoments = await detectKeyMomentsFFmpeg(filePath);

      // cleanup frames and video after we read them
      frames.forEach((f) => { try { fs.unlinkSync(f); } catch(e){} });

      try { fs.rmdirSync(frameDir); } catch(e){}
      try { fs.unlinkSync(filePath); } catch(e){}
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
    const detailMultiplierMap = { low: 0.8, normal: 1, high: 2 };
    const detailMultiplier = detailMultiplierMap[detailLevel.toLowerCase()] || 1;

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

    // --- Call OpenAI (chat completion) ---
    let cleanText = "";
    try {
      const aiTextResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: `You are a professional ${game} coach. Return plain formatted text only.` },
          { role: "user", content: analysisPrompt }
        ]
      });

      cleanText = (aiTextResp.choices?.[0]?.message?.content || "").trim();
      cleanText = cleanText.replace(/[{}[\]*#"]/g, "").replace(/\n{3,}/g, "\n\n").trim();
      cleanText = applyDynamicSpacing(cleanText);
    } catch (aiErr) {
      console.error("OpenAI error:", aiErr);
      // Allow processing to continue: provide partial results
      cleanText = "AI analysis failed or returned no content.";
    }

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

    // Cost re-calculation to include with results (definitive server-side)
    const costInfo = calculateCost(videoLength, detailLevel, responseType, focusArea);

    // Done: remove token from store
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

// Root
app.get("/", (req, res) => res.send("🎮 GPT-4o Game AI API with secure cost calc & two-step confirm flow!"));

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
