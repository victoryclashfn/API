/**
 * Gameplay Analysis API — Vision + Security Edition (WordPress-compatible)
 * - API key auth (x-gamescan-key) + nonce (x-analysis-nonce)
 * - Optional nonce verification via WordPress REST
 * - Allowed origin check
 * - Per-IP rate limiting
 * - In-memory queue + persistent cache
 * - Tier-based model & frame scaling
 */

import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import crypto from "crypto";
import fetch from "node-fetch";
import OpenAI from "openai";

const app = express();
const upload = multer({ dest: "uploads/" });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ====== ENV / CONFIG ======
const API_KEY = process.env.GAMESCAN_API_KEY || "";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const VERIFY_NONCE_URL = process.env.VERIFY_NONCE_URL || ""; // e.g. https://yourdomain.com/wp-json/gamescan/v1/verify_nonce?nonce=
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "3", 10);
const PORT = process.env.PORT || 3000;

// ====== BASE MIDDLEWARE ======
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: (origin, cb) => cb(null, true) })); // fine; we still hard-check origin below

// ====== CACHE ======
const CACHE_FILE = path.resolve("analysisCache.json");
let analysisCache = new Map();
if (fs.existsSync(CACHE_FILE)) {
  try {
    analysisCache = new Map(Object.entries(JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"))));
    console.log(`✅ Loaded ${analysisCache.size} cached analyses`);
  } catch (e) {
    console.error("⚠️ Cache load failed:", e);
  }
}
function saveCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(analysisCache), null, 2));
}

// ====== SIMPLE RATE LIMIT (per-IP) ======
const rateBuckets = new Map(); // ip -> timestamps[]
const RATE_WINDOW_MS = 60_000; // 1 min
const RATE_MAX = 10;           // 10 req/min

function rateLimit(req, res, next) {
  const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() || req.ip || "unknown";
  const now = Date.now();
  const arr = (rateBuckets.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) {
    return res.status(429).json({ success: false, error: "Too many requests, slow down." });
  }
  arr.push(now);
  rateBuckets.set(ip, arr);
  next();
}

// ====== QUEUE ======
const queue = [];
let running = 0;

async function enqueue(jobFn, res) {
  return new Promise((resolve, reject) => {
    const job = { jobFn, res, resolve, reject, id: crypto.randomUUID() };
    queue.push(job);
    const position = queue.length;
    if (running >= MAX_CONCURRENT) {
      res.json({
        queued: true,
        position,
        message: `⏳ Your clip is in queue — position #${position}.`,
      });
    }
    processNext();
  });
}

async function processNext() {
  if (running >= MAX_CONCURRENT || queue.length === 0) return;
  const job = queue.shift();
  running++;
  job
    .jobFn()
    .then(result => {
      if (!job.res.headersSent) job.res.json({ queued: false, ...result });
      job.resolve(result);
    })
    .catch(err => {
      console.error("❌ Job error:", err);
      if (!job.res.headersSent)
        job.res.status(500).json({ success: false, error: "Internal error", details: err.message });
      job.reject(err);
    })
    .finally(() => {
      running--;
      processNext();
    });
}

// ====== UTILS ======
function hashFile(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}
function applyDynamicSpacing(t) {
  return (t || "")
    .replace(/\n\s*\n/g, "\n\n")
    .replace(/([^\n])\n([^\n])/g, "$1\n\n$2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function detectKeyMoments(videoPath) {
  return new Promise(resolve => {
    const cmd = `ffmpeg -i "${videoPath}" -vf "select=gt(scene\\,0.3),showinfo" -f null -`;
    exec(cmd, (err, _out, stderr) => {
      if (err) return resolve([]);
      const times =
        stderr.match(/pts_time:(\d+\.?\d*)/g)?.map((m) => parseFloat(m.replace("pts_time:", ""))) ||
        [];
      resolve(times.slice(0, 10));
    });
  });
}
function extractFrames(videoPath, outputDir, count = 5, scale = "640:-1") {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -y -i "${videoPath}" -vf "thumbnail,scale=${scale}" -frames:v ${count} "${outputDir}/frame-%02d.jpg" -q:v 8 -hide_banner -loglevel error`;
    exec(cmd, (err) => {
      if (err) return reject(err);
      const frames = fs
        .readdirSync(outputDir)
        .filter((f) => f.startsWith("frame-"))
        .map((f) => `${outputDir}/${f}`);
      resolve(frames);
    });
  });
}

// ====== SECURITY MIDDLEWARE (Origin + Key + Nonce) ======
async function securityCheck(req, res, next) {
  // Origin allowlist (best-effort—server-to-server calls may not set Origin; we accept if API key ok)
  const originHeader = (req.headers.origin || req.headers.referer || req.headers.origin_url || "").toString();
  if (ALLOWED_ORIGINS.length > 0 && originHeader) {
    const ok = ALLOWED_ORIGINS.some(o => originHeader.startsWith(o));
    if (!ok) {
      return res.status(403).json({ success: false, error: "Origin not allowed" });
    }
  }

  // API Key (required)
  const providedKey = req.headers["x-gamescan-key"];
  if (!API_KEY || !providedKey || providedKey !== API_KEY) {
    return res.status(401).json({ success: false, error: "Invalid or missing API key" });
  }

  // Nonce (required)
  const nonce = req.headers["x-analysis-nonce"];
  if (!nonce || String(nonce).length < 8) {
    return res.status(400).json({ success: false, error: "Missing or invalid nonce" });
  }

  // Optional: verify nonce via WordPress REST
  if (VERIFY_NONCE_URL) {
    try {
      const url = `${VERIFY_NONCE_URL}${encodeURIComponent(String(nonce))}`;
      const r = await fetch(url, { timeout: 8000 });
      const data = await r.json();
      if (!data || data.valid !== true) {
        return res.status(401).json({ success: false, error: "Nonce verification failed" });
      }
    } catch (e) {
      return res.status(502).json({ success: false, error: "Nonce verification error" });
    }
  }

  next();
}

// ====== CORE ANALYSIS ======
async function handleAnalysis(req) {
  // Expect fields from WP PHP:
  // file field name: "video"
  // responseType, focusAreas (JSON string or array), game, clipType, language, feedbackStyle
  const {
    responseType,
    game,
    clipType,
    language,
    feedbackStyle,
    detailLevel = "normal",
    skillLevel = "Unknown",
    audioInClip = "false",
    playerBio = "",
    extraNotes = "",
    userTier = "free" // optional; can be passed via extra body/header later
  } = req.body;

  if (!req.file || !game || !responseType) {
    return { success: false, error: "Missing required fields: game, responseType, and video file" };
  }

  // focusAreas can arrive as JSON string from WP bridge
  let focusAreas = req.body.focusAreas;
  try {
    if (typeof focusAreas === "string") focusAreas = JSON.parse(focusAreas);
  } catch {
    /* ignore */ 
  }
  const focusList = Array.isArray(focusAreas)
    ? focusAreas.map(s => (typeof s === "string" ? s.trim() : String(s)))
    : ["overall"];

  // cache
  const videoHash = hashFile(req.file.path);
  if (analysisCache.has(videoHash)) {
    fs.unlinkSync(req.file.path);
    return { ...analysisCache.get(videoHash), cached: true };
  }

  // key moments + frames
  const keyTimes = await detectKeyMoments(req.file.path);
  const keyMoments = keyTimes.map((t) => `${Math.round(t)}s`);

  const frameDir = path.join("uploads", `frames-${Date.now()}`);
  fs.mkdirSync(frameDir, { recursive: true });

  // Tier-based scaling (feel free to adjust)
  const scale = userTier === "master" ? "1280:-1" : userTier === "pro" ? "720:-1" : "640:-1";
  const frameCount = userTier === "master" ? 8 : userTier === "pro" ? 5 : 3;

  const frames = await extractFrames(req.file.path, frameDir, frameCount, scale);

  // remove original upload to save space
  try { fs.unlinkSync(req.file.path); } catch {}

  // Model choice
  const model =
    userTier === "master" ? "gpt-4.1"
    : userTier === "pro" ? "gpt-4o"
    : "gpt-4o-mini";

  const weightedFocus = focusList
    .map((f, i) => {
      const weights = [40, 30, 20, 15, 10];
      return `- ${f} (${weights[i] || 10}% importance)`;
    })
    .join("\n");

  const prompt = `
You are an expert ${game} gameplay coach. Analyze the provided frames.
Focus on:
- Aiming/tracking/recoil control
- Building/edit timing (if applicable)
- Positioning & cover usage
- Decision-making & game sense
- Specific, actionable tips

Reference frames as "Frame 1..N" where helpful.

Context:
Skill Level: ${skillLevel}
Feedback Style: ${feedbackStyle}
Language: ${language}
Audio Included: ${audioInClip}
Detail Level: ${detailLevel}
Focus Areas (weighted):
${weightedFocus}
Key Moments: ${keyMoments.join(", ") || "None"}
Extra Notes: ${extraNotes || "None"}
Player Bio: ${playerBio || "N/A"}

Output format (use exactly these sections):
[STRENGTHS]
[WEAKNESSES]
[TIPS]
`;

  // Build image inputs (note: many setups work fine with file://; switch to signed HTTP URLs if needed)
  const imageInputs = frames.map((filePath, idx) => ({
    type: "image_url",
    image_url: `file://${path.resolve(filePath)}`,
    // Optionally add a caption "Frame N"
    // caption: `Frame ${idx + 1}`
  }));

  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: "You are a professional gameplay analyst." },
      {
        role: "user",
        content: [{ type: "text", text: prompt }, ...imageInputs],
      },
    ],
    max_tokens: detailLevel === "high" ? 1500 : 1000,
    temperature: 0.4,
  });

  const aiText = applyDynamicSpacing(
    completion.choices?.[0]?.message?.content || "No analysis returned."
  );

  // Example stats/charts (placeholder logic)
  const baseStats = { aim: 80, positioning: 82, movement: 78, editing: 75 };
  const randomStats = (base) =>
    Array.from({ length: frameCount }, () =>
      Math.min(100, Math.max(0, base + Math.round(Math.random() * 8 - 4)))
    );
  const charts = focusList.map((area) => ({
    label: area.charAt(0).toUpperCase() + area.slice(1),
    labels: Array.from({ length: frameCount }, (_, i) => `Frame ${i + 1}`),
    data: randomStats(baseStats[area.toLowerCase()] || 70),
  }));

  const responseData = {
    success: true,
    game,
    responseType,
    detailLevel,
    focusAreas: focusList,
    skillLevel,
    feedbackStyle,
    clipType,
    language,
    analysis: aiText,
    keyMoments,
    stats: baseStats,
    charts,
    modelUsed: model,
    framesUsed: frameCount,
    frameScale: scale,
    usage: completion.usage,
    cached: false,
  };

  // cleanup frames
  try {
    frames.forEach((f) => fs.unlinkSync(f));
    fs.rmSync(frameDir, { recursive: true, force: true });
  } catch {}

  // cache & save
  analysisCache.set(videoHash, responseData);
  saveCache();

  return responseData;
}

// ====== ROUTES ======
app.get("/", (_req, res) =>
  res.send("🎮 Gamescan — Secure Vision Gameplay Analysis API (WP-ready)")
);

// Analyze endpoint — protected
app.post("/analyze", rateLimit, securityCheck, upload.single("video"), async (req, res) => {
  await enqueue(() => handleAnalysis(req), res);
});

// ====== START ======
app.listen(PORT, () => {
  console.log(`✅ API running on port ${PORT} — max ${MAX_CONCURRENT} concurrent jobs`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n💾 Saving cache before exit...");
  saveCache();
  process.exit(0);
});
