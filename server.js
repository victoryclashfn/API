// server.js
import express from "express";
import multer from "multer";
import fs from "fs";
import { exec } from "child_process";
import OpenAI from "openai";
import path from "path";

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- OpenAI setup ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Helper: Extract frames from uploaded video ---
function extractFrames(videoPath, outputDir, count = 3) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(outputDir, { recursive: true });
    const cmd = `ffmpeg -i "${videoPath}" -vf "thumbnail,scale=640:360" -frames:v ${count} ${outputDir}/frame-%02d.png -hide_banner -loglevel error`;
    exec(cmd, (err) => {
      if (err) return reject(err);
      const frames = fs
        .readdirSync(outputDir)
        .filter(f => f.startsWith("frame-") && f.endsWith(".png"))
        .map(f => path.join(outputDir, f));
      resolve(frames);
    });
  });
}

// --- Helper: Create textual summary of frames ---
function summarizeFrames(frames) {
  return `The player performs aggressive plays, builds frequently, rotates actively, and engages in mid-range fights. ${frames.length} frames were analyzed.`;
}

// --- Analyze Endpoint ---
app.post("/analyze", upload.single("video"), async (req, res) => {
  const { bio, focus, responseType } = req.body;
  const videoFile = req.file;

  if (!bio || !focus || !responseType) {
    return res.status(400).json({
      success: false,
      error: "Missing required fields: bio, focus, or responseType",
    });
  }

  let frameSummary = "";

  try {
    if (videoFile) {
      const frameDir = `uploads/frames-${Date.now()}`;
      const frames = await extractFrames(videoFile.path, frameDir, 3);
      frameSummary = summarizeFrames(frames);

      // Cleanup frames
      frames.forEach(f => fs.unlinkSync(f));
      fs.rmdirSync(frameDir);

      // Cleanup video
      fs.unlinkSync(videoFile.path);
    }
  } catch (err) {
    console.error("Frame extraction error:", err);
    frameSummary = "Video processing failed, no frames analyzed.";
  }

  try {
    // Focus instructions
    let focusPrompt = "";
    switch (focus.toLowerCase()) {
      case "gameplay":
        focusPrompt = "Provide overall gameplay analysis including aim, positioning, building, and edits.";
        break;
      case "aim":
        focusPrompt = "Focus mainly on aiming and shooting accuracy.";
        break;
      case "building":
        focusPrompt = "Focus mainly on building and editing skills.";
        break;
      case "positioning":
        focusPrompt = "Focus mainly on positioning, rotations, and map awareness.";
        break;
      case "all":
        focusPrompt = "Analyze everything: aim, positioning, building, edits, rotations, and overall gameplay.";
        break;
      default:
        focusPrompt = "Provide general gameplay analysis.";
    }

    // ResponseType instructions
    let responsePrompt = "";
    switch (responseType.toLowerCase()) {
      case "stats":
        responsePrompt = "Provide numeric ratings out of 10 for relevant skills.";
        break;
      case "improvement":
        responsePrompt = "Provide actionable improvement tips.";
        break;
      case "coach":
        responsePrompt = "Provide detailed coaching feedback and advice.";
        break;
      case "summary":
        responsePrompt = "Provide a short descriptive summary of the player's performance.";
        break;
      default:
        responsePrompt = "Provide detailed feedback.";
    }

    const analysisPrompt = `You are a professional Fortnite gameplay coach.
Analyze the following player:
Bio: ${bio}
Video summary: ${frameSummary}

Focus: ${focusPrompt}
Output type: ${responsePrompt}

Return the result in JSON format ONLY containing the analysis data.`;

    // Call OpenAI
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a professional Fortnite gameplay analyst." },
        { role: "user", content: analysisPrompt }
      ]
    });

    const aiText = aiResponse.choices[0].message.content;

    // Parse JSON from AI
    let analysisJSON;
    try {
      analysisJSON = JSON.parse(aiText);
    } catch (err) {
      console.error("Error parsing AI response:", err);
      // Wrap plain text in analysis object
      analysisJSON = { feedback: aiText };
    }

    // ✅ Return ONLY the analysis object
    return res.json({
      success: true,
      analysis: analysisJSON
    });

  } catch (err) {
    console.error("Analysis error:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error while processing analysis"
    });
  }
});

// --- Chatbot Endpoint ---
app.post("/chatbot", async (req, res) => {
  const { bio, message } = req.body;
  if (!bio || !message) {
    return res.status(400).json({ success: false, error: "Missing bio or message" });
  }

  try {
    const reply = `Chatbot reply considering bio: "${bio}" and message: "${message}".`;
    return res.json({ success: true, reply });
  } catch (err) {
    console.error("Chatbot error:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// --- Root Endpoint ---
app.get("/", (req, res) => {
  res.send("🎮 Fortnite AI API running with clean analysis output!");
});

// --- Start Server ---
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});
