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

// --- Enable CORS ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Helpers (ffmpeg/ffprobe helpers) ---
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

// --- /analyze endpoint ---
app.post("/analyze", upload.single("video"), async (req, res) => {
  try {
    const { game, responseType, focusArea, detailLevel, bio } = req.body;
    const videoFile = req.file;

    if (!game || !responseType || !focusArea || !detailLevel || !videoFile) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: game, responseType, focusArea, detailLevel, or video."
      });
    }

    // initialize
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

      // cleanup
      frames.forEach((f) => { try { fs.unlinkSync(f);} catch(e){}} );
      try { fs.rmdirSync(frameDir); } catch(e){}
      try { fs.unlinkSync(videoFile.path); } catch(e){}
    } catch (err) {
      console.error("Video processing error:", err);
      frameSummary = "Video processing failed or no frames extracted.";
    }

    // Build textual prompts
    const focusPromptMap = {
      aim: "Focus on aiming, shooting accuracy, and tracking.",
      building: "Focus on building speed, edits, and structure control.",
      positioning: "Focus on positioning, rotations, and awareness.",
      overall: "Analyze everything comprehensively."
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

    // Primary analysis prompt (plain text)
    const analysisPrompt = `
You are a professional ${game} gameplay analyst.

Player Bio: ${bio || "No bio provided"}
Video Summary: ${frameSummary}
Key Moments: ${keyMoments}

Focus: ${focusPrompt}
Detail Level: ${detailLevel} (${detailMultiplier}x)
Response Type: ${responsePrompt}

Provide a clean, readable, plain text analysis. Add extra spacing between sections and tips for clarity. Never use symbols like *, {}, [], #, or \`\`\`.
`;

    // Ask the model for the human-friendly analysis
    const aiTextResp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `You are a professional ${game} coach. Return plain formatted text only.` },
        { role: "user", content: analysisPrompt }
      ],
    });

    let cleanText = (aiTextResp.choices?.[0]?.message?.content || "").trim();
    cleanText = cleanText.replace(/[{}[\]*#"]/g, "").replace(/\n{3,}/g, "\n\n").trim();
    cleanText = applyDynamicSpacing(cleanText);

    // --- Structured JSON for charts: ask model to return JSON only ---
    // The JSON must look like:
    // { "headline":"...", "analysis":"...", "stats": { "accuracy": int, "positioning": int, "editing": int, "building": int }, "accuracyTimeline":[int,...] }
    const jsonPrompt = `
You are a gameplay analysis assistant. Based on the player bio and video summary, output ONLY a JSON object (no surrounding text) with these fields:
- headline: short title string
- analysis: a one-paragraph summary string
- stats: an object with integer scores 0-100 for keys: accuracy, positioning, editing, building
- accuracyTimeline: an array of integers (0-100) representing accuracy over time (length should be ${frameCount})

Use realistic values consistent with the analysis. Return strictly valid JSON.
Player Bio: ${bio || "No bio provided"}
Video Summary: ${frameSummary}
Key Moments: ${keyMoments}
Focus: ${focusPrompt}
Response Type: ${responsePrompt}
`;

    let chartData = null;

    try {
      const aiJsonResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You will return strictly valid JSON and nothing else." },
          { role: "user", content: jsonPrompt }
        ],
        temperature: 0.2,
        max_tokens: 500
      });

      const jsonText = aiJsonResp.choices?.[0]?.message?.content || "";
      // try to extract JSON substring if the model added backticks or text
      const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(jsonText);
      // basic validation
      if (parsed && parsed.stats && Array.isArray(parsed.accuracyTimeline)) {
        chartData = parsed;
      }
    } catch (err) {
      console.warn("Structured JSON parse failed, falling back to heuristic:", err);
    }

    // fallback: create heuristic random-like (deterministic-ish) chart data if model didn't return JSON
    if (!chartData) {
      // create base numbers from keywords in cleanText (simple heuristic)
      const textLower = cleanText.toLowerCase();
      const base = {
        accuracy: textLower.includes("aim") ? 60 : 75,
        positioning: textLower.includes("position") ? 80 : 70,
        editing: textLower.includes("edit") ? 65 : 72,
        building: textLower.includes("build") ? 78 : 68
      };
      // n points
      const timeline = [];
      for (let i = 0; i < frameCount; i++) {
        const variance = Math.round((Math.sin(i / Math.max(1, frameCount/4)) * 6) + (Math.random() * 6 - 3));
        timeline.push(Math.max(15, Math.min(98, Math.round(base.accuracy + variance))));
      }
      chartData = {
        headline: "Summary & Stats",
        analysis: cleanText.split("\n").slice(0,3).join(" "),
        stats: {
          accuracy: base.accuracy,
          positioning: base.positioning,
          editing: base.editing,
          building: base.building
        },
        accuracyTimeline: timeline
      };
    }

    // final response
    return res.json({
      success: true,
      analysis: cleanText,
      keyMoments,
      videoLength: Math.round(videoLength),
      frameCount,
      stats: chartData.stats,
      accuracyTimeline: chartData.accuracyTimeline,
      headline: chartData.headline
    });

  } catch (error) {
    console.error("AI Analysis error:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error during analysis."
    });
  }
});

// Root
app.get("/", (req, res) => res.send("🎮 GPT-4o Game AI API with chart data!"));

// Start
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on ${port}`));
