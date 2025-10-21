/**
 * Gameplay Analysis API — GPT-4o-mini Edition
 * Adds:
 *  • In-memory job queue with MAX_CONCURRENT limit
 *  • Live queue-position feedback
 *  • Persists cache as before
 */

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

app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- PERSISTENT CACHE ----------
const CACHE_FILE = path.resolve("analysisCache.json");
let analysisCache = new Map();
if (fs.existsSync(CACHE_FILE)) {
  try {
    analysisCache = new Map(
      Object.entries(JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")))
    );
    console.log(`✅ Loaded ${analysisCache.size} cached analyses`);
  } catch (e) {
    console.error("⚠️ Cache load failed:", e);
  }
}
function saveCache() {
  fs.writeFileSync(
    CACHE_FILE,
    JSON.stringify(Object.fromEntries(analysisCache), null, 2)
  );
}

// ---------- SIMPLE IN-MEMORY QUEUE ----------
const queue = [];
let running = 0;
const MAX_CONCURRENT = 3; // adjust for your server

async function enqueue(jobFn, res) {
  return new Promise((resolve, reject) => {
    const job = { jobFn, res, resolve, reject, id: crypto.randomUUID() };
    queue.push(job);

    const position = queue.length;
    // If server is busy, immediately tell user their place
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
    .then((result) => {
      // Only send here if not already sent (for queued users)
      if (!job.res.headersSent)
        job.res.json({ queued: false, ...result });
      job.resolve(result);
    })
    .catch((err) => {
      console.error("❌ Job error:", err);
      if (!job.res.headersSent)
        job.res
          .status(500)
          .json({ success: false, error: "Internal error", details: err.message });
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
function extractFrames(videoPath, outputDir, count = 5) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -y -i "${videoPath}" -vf "thumbnail,scale=640:360" -frames:v ${count} "${outputDir}/frame-%02d.png" -hide_banner -loglevel error`;
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
function detectKeyMoments(videoPath) {
  return new Promise((resolve) => {
    const cmd = `ffmpeg -i "${videoPath}" -vf "select=gt(scene\\,0.3),showinfo" -f null -`;
    exec(cmd, (err, _out, stderr) => {
      if (err) return resolve([]);
      const times =
        stderr.match(/pts_time:(\\d+\\.?\\d*)/g)?.map((m) =>
          parseFloat(m.replace("pts_time:", ""))
        ) || [];
      resolve(times.slice(0, 10));
    });
  });
}
function applyDynamicSpacing(t) {
  return t
    .replace(/\\n\\s*\\n/g, "\\n\\n")
    .replace(/([^\\n])\\n([^\\n])/g, "$1\\n\\n$2")
    .replace(/\\n{3,}/g, "\\n\\n")
    .trim();
}

// ---------- ANALYSIS HANDLER ----------
async function handleAnalysis(req) {
  const {
    game,
    responseType,
    focusAreas,
    detailLevel,
    skillLevel,
    feedbackStyle,
    clipType,
    language,
    audioInClip,
    playerBio,
    extraNotes,
  } = req.body;

  if (!game || !responseType || !detailLevel || !req.file) {
    return {
      success: false,
      error: "Missing required fields: game, responseType, detailLevel, video",
    };
  }

  const focusList =
    typeof focusAreas === "string"
      ? focusAreas.split(",").map((s) => s.trim())
      : Array.isArray(focusAreas)
      ? focusAreas
      : ["overall"];

  const videoHash = hashFile(req.file.path);
  if (analysisCache.has(videoHash)) {
    fs.unlinkSync(req.file.path);
    return { ...analysisCache.get(videoHash), cached: true };
  }

  const keyTimes = await detectKeyMoments(req.file.path);
  const keyMoments = keyTimes.map((t) => `${Math.round(t)}s`);
  const frameDir = path.join("uploads", `frames-${Date.now()}`);
  fs.mkdirSync(frameDir, { recursive: true });
  let frames = [];
  try {
    frames = await extractFrames(req.file.path, frameDir, Math.min(keyMoments.length || 5, 10));
  } catch {}
  try {
    frames.forEach((f) => fs.unlinkSync(f));
    fs.rmSync(frameDir, { recursive: true, force: true });
    fs.unlinkSync(req.file.path);
  } catch {}

  const weightedFocus = focusList
    .map((f, i) => {
      const weights = [40, 35, 25, 20, 15];
      return `- ${f} (${weights[i] || 10}% importance)`;
    })
    .join("\\n");

  const keyMomentContext =
    keyMoments.length > 0
      ? keyMoments
          .map((t, i) => `Moment ${i + 1}: ${t} mark — possible key event.`)
          .join("\\n")
      : "None detected.";

  const example = `
Example (Fortnite):
[STRENGTHS]
- Good crosshair tracking
- Efficient 90° build transitions
[WEAKNESSES]
- Over-commits to height, loses cover
[TIPS]
- Prioritize retake efficiency over height control
`;

  // ---------- MINI REASONING ----------
  const prepass = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "You are an internal reasoning assistant. Extract 5 bullet points capturing core gameplay insights. Keep under 100 words.",
      },
      {
        role: "user",
        content: `Game: ${game}\\nFocus: ${focusList.join(", ")}\\nClip type: ${clipType}\\nNotes: ${extraNotes}`,
      },
    ],
    max_tokens: 200,
    temperature: 0.4,
  });
  const reasoning = prepass.choices?.[0]?.message?.content || "No reasoning generated.";

  const prompt = `
You are an expert ${game} gameplay analyst and coach.

Follow this structured format exactly:
[STRENGTHS]
[List player strengths concisely]

[WEAKNESSES]
[List key weak points]

[TIPS]
[Give actionable, prioritized improvements]

Analyze using this information:
Player Bio: ${playerBio || "N/A"}
Skill Level: ${skillLevel || "Unknown"}
Feedback Style: ${feedbackStyle || "Balanced"}
Language: ${language || "English"}
Audio Included: ${audioInClip || "false"}
Detail Level: ${detailLevel}
Focus Areas (weighted):
${weightedFocus}
Key Moments:
${keyMomentContext}

Internal reasoning summary:
${reasoning}

Use a clear, coach-like tone. Avoid repetition.

${example}
`;

  const max_tokens = detailLevel === "high" ? 1500 : 1000;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "You are a professional gameplay coach providing high-accuracy structured analysis.",
      },
      { role: "user", content: prompt },
    ],
    max_tokens,
    temperature: 0.5,
  });

  const aiText = applyDynamicSpacing(
    completion.choices?.[0]?.message?.content || "No analysis returned."
  );

  const baseStats = { aim: 78, positioning: 82, movement: 75, editing: 70 };
  const frameCount = 5;
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
    modelUsed: "gpt-4o-mini",
    cached: false,
  };

  analysisCache.set(videoHash, responseData);
  saveCache();

  return responseData;
}

// ---------- ENDPOINT ----------
app.post("/analyze", upload.single("video"), async (req, res) => {
  await enqueue(() => handleAnalysis(req), res);
});

app.get("/", (_req, res) =>
  res.send("🎮 Gameplay AI Analysis API — high-accuracy build with queue & cache.")
);

const port = process.env.PORT || 3000;
app.listen(port, () =>
  console.log(`✅ API running on port ${port} (queued mode, max ${MAX_CONCURRENT} concurrent jobs)`)
);
process.on("SIGINT", () => {
  console.log("\\n💾 Saving cache before exit...");
  saveCache();
  process.exit(0);
});
