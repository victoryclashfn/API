// server.js
import express from "express";
import multer from "multer";
import fs from "fs";
import { exec } from "child_process";

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Helper: Extract frames from video ---
function extractFrames(videoPath, outputDir, count = 3) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -i ${videoPath} -vf "thumbnail,scale=640:360" -frames:v ${count} ${outputDir}/frame-%02d.png -hide_banner -loglevel error`;
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

// --- Analyze Endpoint ---
app.post("/analyze", upload.single("video"), async (req, res) => {
  const { bio, responseType } = req.body;
  const videoFile = req.file;

  if (!bio || !responseType) {
    return res.status(400).json({
      success: false,
      error: "Missing required fields: bio or responseType",
    });
  }

  try {
    let analysisText = `Detailed ${responseType} analysis based on bio: "${bio}".`;

    // Optional video processing
    if (videoFile) {
      const frameDir = `uploads/frames-${Date.now()}`;
      fs.mkdirSync(frameDir);
      try {
        const frames = await extractFrames(videoFile.path, frameDir, 3);
        analysisText += `\nProcessed ${frames.length} video frames for additional analysis.`;
        frames.forEach(frame => fs.unlinkSync(frame));
      } catch (err) {
        console.error("FFmpeg error:", err);
        analysisText += "\nVideo processing failed, skipping frame analysis.";
      } finally {
        fs.unlinkSync(videoFile.path); // Clean up uploaded video
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
  res.send("🎮 Fortnite AI API running!");
});

// --- Start Server ---
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});
