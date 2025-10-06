// server.js
import express from "express";
import fs from "fs";
import { exec } from "child_process";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Optional helper if you later want to extract frames from the video URL ---
function extractFramesFromUrl(videoUrl, outputDir, count = 3) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -i "${videoUrl}" -vf "thumbnail,scale=640:360" -frames:v ${count} ${outputDir}/frame-%02d.png -hide_banner -loglevel error`;
    exec(cmd, (err) => {
      if (err) return reject(err);
      const frames = fs
        .readdirSync(outputDir)
        .filter(f => f.startsWith("frame-") && f.endsWith(".png"))
        .map(f => `${outputDir}/${f}`);
      resolve(frames);
    });
  });
}

// --- Analyze Endpoint (JSON-based) ---
app.post("/analyze", async (req, res) => {
  const { bio, responseType, videoUrl } = req.body;

  console.log("📩 Incoming /analyze request");
  console.log("Body:", req.body);

  if (!bio || !responseType) {
    return res.status(400).json({
      success: false,
      error: "Missing required fields: bio or responseType",
    });
  }

  try {
    let analysisText = `Detailed ${responseType} analysis based on bio: "${bio}".`;

    // Optional: handle video URL
    if (videoUrl) {
      analysisText += `\nVideo provided: ${videoUrl}`;
      try {
        const frameDir = `uploads/frames-${Date.now()}`;
        fs.mkdirSync(frameDir);
        const frames = await extractFramesFromUrl(videoUrl, frameDir, 3);
        analysisText += `\nExtracted ${frames.length} frames for analysis.`;
        frames.forEach(frame => fs.unlinkSync(frame));
        fs.rmdirSync(frameDir);
      } catch (err) {
        console.error("FFmpeg error:", err);
        analysisText += "\nCould not process video frames (ffmpeg error).";
      }
    }

    const bioSummary = `Quick summary of player: ${bio}`;

    return res.json({
      success: true,
      bioSummary,
      analysis: analysisText,
    });

  } catch (error) {
    console.error("Analysis error:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error while processing analysis.",
    });
  }
});

// --- Chatbot Endpoint ---
app.post("/chatbot", async (req, res) => {
  const { bio, message } = req.body;

  if (!bio || !message) {
    return res.status(400).json({
      success: false,
      error: "Missing required fields: bio or message",
    });
  }

  try {
    const reply = `Chatbot reply considering bio: "${bio}" and message: "${message}".`;
    return res.json({ success: true, reply });
  } catch (err) {
    console.error("Chatbot error:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error while generating chatbot reply.",
    });
  }
});

// --- Root Endpoint ---
app.get("/", (req, res) => {
  res.send("🎮 Fortnite AI API running with JSON + videoUrl support!");
});

// --- Start Server ---
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});
