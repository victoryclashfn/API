/**
 * Gamescan — Dev Bypass Edition (Quick, insecure dev mode)
 *
 * NOTES:
 *  - This version REMOVES the security middleware from the /analyze route.
 *  - Do NOT use this on a public server long-term.
 *  - Re-enable security by restoring `securityCheck` into the route middleware list.
 */

import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import crypto from "crypto";
import OpenAI from "openai";

import "dotenv/config"; // load .env in local dev (optional)

const app = express();
const upload = multer({ dest: "uploads/" });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- CONFIG ----------
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "3", 10);
const PORT = parseInt(process.env.PORT || "3000", 10);

// ---------- BASIC MIDDLEWARE ----------
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cors()); // permissive for dev

// ---------- SIMPLE IN-MEMORY CACHE ----------
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

// ---------- RATE LIMIT (simple, per-ip) ----------
const rateBuckets = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 20; // allow more in dev

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

// ---------- QUEUE ----------
const queue = [];
let running = 0;

async function enqueue(jobFn, res) {
  return new Promise((resolve, reject) => {
    const job = { jobFn, res, resolve, reject, id: crypto.randomUUID() };
    queue.push(job);
    const position = queue.length;
    if (running >= MAX_CONCURRENT) {
      // Immediately inform caller they're queued (developer UX)
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

// ---------- UTILITIES ----------
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

// ---------- (DEV) SECURITY BYPASS — removed from route ----------
// NOTE: The production security middleware exists in your prior version.
// For this DEV BYPASS release, we intentionally do not call it on /analyze.
// Make sure to restore it later.

// ---------- CORE ANALYSIS FUNCTION ----------
async function handleAnalysis(req) {
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
    userTier = "free"
  } = req.body;

  if (!req.file || !game || !responseType) {
    return { success: false, error: "Missing required fields: game, responseType, video file" };
  }

  // focusAreas can be JSON-string or array
  let focusAreas = req.body.focusAreas;
  try { if (typeof focusAreas === "string") focusAreas = JSON.parse(focusAreas); } catch {}
  const focusList = Array.isArray(focusAreas) ? focusAreas.map(s => (typeof s === "string" ? s.trim() : String(s))) : ["overall"];

  // check cache
  const videoHash = hashFile(req.file.path);
  if (analysisCache.has(videoHash)) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return { ...analysisCache.get(videoHash), cached: true };
  }

  // detect key moments and extract frames
  const keyTimes = await detectKeyMoments(req.file.path);
  const keyMoments = keyTimes.map(t => `${Math.round(t)}s`);

  const frameDir = path.join("uploads", `frames-${Date.now()}`);
  fs.mkdirSync(frameDir, { recursive: true });

  // tier-based settings
  const scale = userTier === "master" ? "1280:-1" : userTier === "pro" ? "720:-1" : "640:-1";
  const frameCount = userTier === "master" ? 8 : userTier === "pro" ? 5 : 3;

  const frames = await extractFrames(req.file.path, frameDir, frameCount, scale);

  // remove original upload to save space
  try { fs.unlinkSync(req.file.path); } catch {}

  // model selection
  const model =
    userTier === "master" ? "gpt-4.1" :
    userTier === "pro" ? "gpt-4o" :
    "gpt-4o-mini";

  // prompt building
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

  // prepare images for the model (file:// works for many setups; swap to signed HTTP URLs if needed)
  const imageInputs = frames.map((filePath, idx) => ({
    type: "image_url",
    image_url: `file://${path.resolve(filePath)}`,
  }));

  // call OpenAI
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

  const aiText = applyDynamicSpacing(completion.choices?.[0]?.message?.content || "No analysis returned.");

  // mock stats & charts
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
  } catch (e) {}

  // cache & persist
  analysisCache.set(videoHash, responseData);
  saveCache();

  return responseData;
}

// ---------- ROUTES ----------

app.get("/", (_req, res) =>
  res.send("🎮 Gamescan — Dev Bypass API (no auth on /analyze)"));

/**
 * IMPORTANT: This route intentionally omits the securityCheck middleware so devs
 * can test without the shared API key or nonce.
 *
 * Reintroduce the security middleware before going to production.
 */
app.post("/analyze", rateLimit, upload.single("video"), async (req, res) => {
  await enqueue(() => handleAnalysis(req), res);
});

// ---------- START SERVER ----------
app.listen(PORT, () => {
  console.log(`✅ Dev Gamescan API running on port ${PORT} — max ${MAX_CONCURRENT} concurrent jobs`);
});

// graceful shutdown
process.on("SIGINT", () => {
  console.log("\n💾 Saving cache before exit...");
  saveCache();
  process.exit(0);
});
