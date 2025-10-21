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

// ---------- BASIC MIDDLEWARE ----------
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- SIMPLE IN-MEMORY CACHE ----------
const analysisCache = new Map();

// ---------- HELPERS ----------
function hashFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function extractFrames(videoPath, outputDir, count = 5) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -y -i "${videoPath}" -vf "thumbnail,scale=640:360" -frames:v ${count} "${outputDir}/frame-%02d.png" -hide_banner -loglevel error`;
    exec(cmd, (err) => {
      if (err) return reject(err);
      try {
        const frames = fs
          .readdirSync(outputDir)
          .filter((f) => f.startsWith("frame-"))
          .map((f) => `${outputDir}/${f}`);
        resolve(frames);
      } catch (e) {
        reject(e);
      }
    });
  });
}

function detectKeyMoments(videoPath) {
  return new Promise((resolve) => {
    const cmd = `ffmpeg -i "${videoPath}" -vf "select=gt(scene\\,0.3),showinfo" -f null -`;
    exec(cmd, (err, stdout, stderr) => {
      if (err) return resolve([]);
      const matches = stderr.match(/pts_time:(\d+\.?\d*)/g) || [];
      const times = matches.map((m) => parseFloat(m.replace("pts_time:", "")));
      resolve(times.slice(0, 10)); // limit to 10 key moments
    });
  });
}

function applyDynamicSpacing(text) {
  return text
    .replace(/\n\s*\n/g, "\n\n")
    .replace(/([^\n])\n([^\n])/g, "$1\n\n$2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------- COST-EFFICIENT MODEL SELECTOR ----------
function chooseModel(responseType, detailLevel) {
  const type = responseType?.toLowerCase() || "";
  const detail = detailLevel?.toLowerCase() || "normal";

  // gpt-4o-mini for pro / detailed users, gpt-3.5-turbo otherwise
  if (["coaching", "detailed", "pro-coaching", "advanced"].includes(type)) {
    return { model: "gpt-4o-mini", tokens: detail === "high" ? 1500 : 1000 };
  }
  return { model: "gpt-3.5-turbo", tokens: detail === "low" ? 400 : 700 };
}

// ---------- /analyze ENDPOINT ----------
app.post("/analyze", upload.single("video"), async (req, res) => {
  try {
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
      return res.status(400).json({
        success: false,
        error: "Missing required fields: game, responseType, detailLevel, video",
      });
    }

    const focusList =
      typeof focusAreas === "string"
        ? focusAreas.split(",").map((s) => s.trim())
        : Array.isArray(focusAreas)
        ? focusAreas
        : ["overall"];

    // ---------- CACHE ----------
    const videoHash = hashFile(req.file.path);
    if (analysisCache.has(videoHash)) {
      fs.unlinkSync(req.file.path);
      return res.json({ ...analysisCache.get(videoHash), cached: true });
    }

    // ---------- VIDEO ANALYSIS PREP ----------
    const keyTimes = await detectKeyMoments(req.file.path);
    const keyMoments = keyTimes.slice(0, 10).map((t) => `${Math.round(t)}s`);
    const frameDir = path.join("uploads", `frames-${Date.now()}`);
    fs.mkdirSync(frameDir, { recursive: true });

    let frames = [];
    try {
      frames = await extractFrames(req.file.path, frameDir, Math.min(keyMoments.length || 5, 10));
    } catch (e) {
      console.error("Frame extraction failed:", e);
    }

    // Cleanup temporary files early
    try {
      frames.forEach((f) => fs.unlinkSync(f));
      fs.rmSync(frameDir, { recursive: true, force: true });
      fs.unlinkSync(req.file.path);
    } catch (e) {}

    // ---------- COST CONTROL ----------
    const { model, tokens: max_tokens } = chooseModel(responseType, detailLevel);

    // ---------- GPT PROMPT ----------
    const prompt = `
You are an expert ${game} gameplay analyst.
Provide feedback in clear sections with short paragraphs.
Only return readable text (no JSON).

Game: ${game}
Player Bio: ${playerBio || "N/A"}
Skill Level: ${skillLevel || "Unknown"}
Focus Areas: ${focusList.join(", ")}
Clip Type: ${clipType || "N/A"}
Feedback Style: ${feedbackStyle || "Balanced"}
Language: ${language || "English"}
Audio Included: ${audioInClip || "false"}
Detail Level: ${detailLevel}
Extra Notes: ${extraNotes || "None"}
Detected Key Moments: ${keyMoments.length ? keyMoments.join(", ") : "None"}

Now produce a ${responseType}-style analysis focusing on improvement tips, strengths, and weak points.
`;

    const completion = await openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "You are a professional gameplay coach providing concise, helpful analyses." },
        { role: "user", content: prompt },
      ],
      max_tokens,
      temperature: 0.7,
    });

    const aiText = applyDynamicSpacing(
      completion.choices?.[0]?.message?.content || "No analysis returned."
    );

    // ---------- MOCK STATS + CHARTS ----------
    const baseStats = { aim: 78, positioning: 82, movement: 75, editing: 70 };
    const frameCount = 5;
    const randomStats = (base) =>
      Array.from({ length: frameCount }, (_, i) =>
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
      cached: false,
    };

    analysisCache.set(videoHash, responseData);
    res.json(responseData);
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({
      success: false,
      error: "Internal error during analysis",
      details: err.message,
    });
  }
});

// ---------- ROOT ----------
app.get("/", (req, res) =>
  res.send("🎮 Gameplay AI Analysis API — Optimized for cost & integrated fields.")
);

// ---------- START SERVER ----------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ API running on port ${port}`));
