import express from "express";
import OpenAI from "openai";
import multer from "multer";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import cors from "cors";
import { spawn } from "child_process";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

// --- Config ---
const UPLOAD_DIR = path.resolve("./uploads");
const FRAME_SAMPLE_COUNT = 8; // increased frame samples for better analysis
const DB_PATH = path.join(UPLOAD_DIR, "fortnite.db");

// --- Initialize OpenAI ---
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Express setup ---
const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// --- Initialize SQLite DB ---
let db;
async function initDB() {
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.run(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, bio TEXT)`);
  await db.run(`CREATE TABLE IF NOT EXISTS matches (id INTEGER PRIMARY KEY AUTOINCREMENT, userId TEXT, timestamp INTEGER, analysis TEXT)`);
}

// --- Merge Bio Function ---
function mergeBioText(oldBio = "", newBio = "", maxLen = 4000) {
  if (!oldBio) return newBio || "";
  if (!newBio) return oldBio || "";
  const splitSentences = (text) => text.split(/(?<=[.?!])\s+/).map(s => s.trim()).filter(Boolean);
  const sentences = [...splitSentences(oldBio), ...splitSentences(newBio)];
  const seen = new Set();
  const merged = [];
  for (const s of sentences) {
    const key = s.toLowerCase();
    if (!seen.has(key)) {
      merged.push(s);
      seen.add(key);
    }
  }
  let result = merged.join(" ");
  if (result.length > maxLen) {
    const reversed = merged.reverse();
    let truncated = "";
    for (const s of reversed) {
      if ((truncated + " " + s).length > maxLen) break;
      truncated = (truncated + " " + s).trim();
    }
    result = truncated;
  }
  return result;
}

// --- Multer for video uploads ---
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("video/")) return cb(new Error("Only video uploads allowed"));
    cb(null, true);
  }
});

// --- FFmpeg frame extraction ---
async function extractFrames(videoPath, outputDir, count = FRAME_SAMPLE_COUNT) {
  await fsp.mkdir(outputDir, { recursive: true });
  return new Promise((resolve, reject) => {
    const outPattern = path.join(outputDir, "frame-%02d.png");
    const args = ["-y", "-i", videoPath, "-vf", "thumbnail,scale=640:360", "-frames:v", String(count), outPattern, "-hide_banner", "-loglevel", "error"];
    const ff = spawn("ffmpeg", args);
    let stderr = "";
    ff.stderr.on("data", (d) => (stderr += d.toString()));
    ff.on("error", reject);
    ff.on("close", async (code) => {
      if (code !== 0) return reject(new Error("ffmpeg failed: " + stderr));
      try {
        const files = await fsp.readdir(outputDir);
        const frames = files.filter(f => f.startsWith("frame-") && f.endsWith(".png")).map(f => path.join(outputDir, f));
        resolve(frames);
      } catch (e) { reject(e); }
    });
  });
}

// --- Build system prompt ---
function buildSystemPrompt(responseType) {
  return (`You are an expert Fortnite analyst. Response type: ${responseType}. Produce a single JSON object with fields: type, summary, mistakes[], improvements[], stats{accuracy, buildingEfficiency, editingSpeed}, framesAnalyzedCount. If a field is not applicable, return null or empty array/object.`);
}

function tryParseJsonFromText(text) {
  if (!text || typeof text !== "string") return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const jsonText = text.slice(start, end + 1);
  try { return JSON.parse(jsonText); } catch (e) { return null; }
}

// --- Analyze endpoint ---
app.post("/analyze", upload.single("video"), async (req, res) => {
  const videoFile = req.file;
  const { userId, bio: newBio, responseType = "analytics", length = "medium" } = req.body;
  const allowed = ["couch","stats","summary","hype","analytics"];
  if (!allowed.includes(responseType)) return res.status(400).json({ error: `responseType must be one of ${allowed.join(", ")}` });

  try {
    let mergedBio = newBio || "";
    if (userId) {
      const userRow = await db.get("SELECT bio FROM users WHERE id = ?", userId);
      const existingBio = userRow?.bio || "";
      mergedBio = mergeBioText(existingBio, newBio || "");
      await db.run("INSERT INTO users (id, bio) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET bio=excluded.bio", userId, mergedBio);
    }

    const messages = [{ role: "system", content: buildSystemPrompt(responseType) }];
    let framePaths = [];
    if (videoFile) {
      const framesDir = path.join(UPLOAD_DIR, `frames-${Date.now()}`);
      try {
        framePaths = await extractFrames(videoFile.path, framesDir, FRAME_SAMPLE_COUNT);
        for (let i = 0; i < framePaths.length; i++) {
          const b64 = await fsp.readFile(framePaths[i], { encoding: "base64" });
          messages.push({ role: "user", content: [ { type: "text", text: `Frame ${i+1}` }, { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } } ] });
        }
      } catch (e) { console.error("Frame extraction failed:", e); }
    }

    if (mergedBio) messages.push({ role: "user", content: `Player bio/context: ${mergedBio}` });
    const maxTokens = length === "short" ? 400 : length === "long" ? 2000 : 1200;

    messages.push({ role: "user", content: `Please analyze using the "${responseType}" style and return JSON.` });
    const analysisResp = await client.chat.completions.create({ model: "gpt-4o", messages, max_tokens: maxTokens, temperature: 0.2 });
    let analysisJson = tryParseJsonFromText(analysisResp.choices?.[0]?.message?.content || "") || { raw: analysisResp.choices?.[0]?.message?.content || "" };

    // Save match history
    if (userId) {
      await db.run("INSERT INTO matches (userId, timestamp, analysis) VALUES (?, ?, ?)", userId, Date.now(), JSON.stringify(analysisJson));
    }

    // Bio summary
    let bioSummary = null;
    if (mergedBio) {
      const bioSystem = `You are a Fortnite analyst. Produce a 'stats' style JSON object summarizing this player's bio/context.`;
      const bioResp = await client.chat.completions.create({ model: "gpt-4o", messages: [{ role: "system", content: bioSystem }, { role: "user", content: `Player bio: ${mergedBio}` }], max_tokens: 400, temperature: 0.1 });
      bioSummary = tryParseJsonFromText(bioResp.choices?.[0]?.message?.content || "") || { raw: bioResp.choices?.[0]?.message?.content || "" };
    }

    res.json({ ok: true, userId: userId || null, mergedBio: mergedBio || null, framesAnalyzed: framePaths.length, analysis: analysisJson, bioSummary });
  } catch (err) {
    console.error("/analyze error:", err);
    res.status(500).json({ error: "Failed to analyze", details: err?.message || String(err) });
  } finally {
    (async () => { try { if (req.file?.path) await fsp.unlink(req.file.path).catch(()=>{}); } catch{} })();
  }
});

// --- Chatbot endpoint ---
app.post("/chatbot", async (req, res) => {
  const { userId, bio: newBio, message } = req.body;
  if (!message) return res.status(400).json({ error: "Message required" });
  try {
    let mergedBio = newBio || "";
    if (userId) {
      const userRow = await db.get("SELECT bio FROM users WHERE id=?", userId);
      const existingBio = userRow?.bio || "";
      mergedBio = mergeBioText(existingBio, newBio || "");
      await db.run("INSERT INTO users (id, bio) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET bio=excluded.bio", userId, mergedBio);
    }

    const systemContent = `You are a friendly Fortnite chatbot using player's bio to inform responses.`;
    const messages = [{ role: "system", content: systemContent }];
    if (mergedBio) messages.push({ role: "user", content: `Player bio/context: ${mergedBio}` });
    messages.push({ role: "user", content: message });

    const resp = await client.chat.completions.create({ model: "gpt-4o-mini", messages, max_tokens: 400, temperature: 0.6 });
    const reply = resp.choices?.[0]?.message?.content || "";
    res.json({ ok: true, reply, mergedBio });
  } catch (err) {
    console.error("/chatbot error:", err);
    res.status(500).json({ error: "Chatbot failed", details: err?.message || String(err) });
  }
});

// --- Healthcheck ---
app.get("/", (req, res) => res.send("Fortnite AI API running - use /analyze and /chatbot"));

// --- Start server ---
const port = process.env.PORT || 3000;
initDB().then(() => { app.listen(port, () => console.log(`Server listening on port ${port}`)); });
