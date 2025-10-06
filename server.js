// server.js
import express from "express";
import multer from "multer";
import fs from "fs";
import { exec } from "child_process";
import OpenAI from "openai";

const app = express();
const upload = multer({ dest: "uploads/" });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
        .filter((f) => f.startsWith("frame-") && f.endsWith(".png"))
        .map((f) => `${outputDir}/${f}`);
      resolve(frames);
    });
  });
}

// --- Helper: Summarize frames ---
function summarizeFrames(frames) {
  return `Extracted ${frames.length} frames from the gameplay video for analysis.`;
}

// --- /analyze endpoint ---
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
      fs.mkdirSync(frameDir);
      const frames = await extractFrames(videoFile.path, frameDir, 3);
      frameSummary = summarizeFrames(frames);

      // Delete frames & uploaded video
      frames.forEach((f) => fs.unlinkSync(f));
      fs.rmdirSync(frameDir);
      fs.unlinkSync(videoFile.path);
    }
  } catch (err) {
    console.error("Frame extraction error:", err);
    frameSummary = "Video processing failed or no frames extracted.";
  }

  try {
    // --- Focus Prompt ---
    let focusPrompt = "";
    switch (focus.toLowerCase()) {
      case "aim":
        focusPrompt = "Focus mainly on aiming, shooting accuracy, and tracking.";
        break;
      case "building":
        focusPrompt = "Focus on building speed, edits, and structure control.";
        break;
      case "positioning":
        focusPrompt = "Focus on positioning, rotations, and awareness.";
        break;
      case "all":
      case "gameplay":
        focusPrompt = "Analyze everything: aim, building, edits, positioning, and overall gameplay.";
        break;
      default:
        focusPrompt = "Provide a general gameplay analysis.";
    }

    // --- Response Type Prompt ---
    let responsePrompt = "";
    switch (responseType.toLowerCase()) {
      case "stats":
        responsePrompt = `
Respond with numeric scores (out of 10) only.
Example:
Aiming: 8/10
Building: 7/10
Positioning: 6/10
Overall: 7/10`;
        break;
      case "improvement":
        responsePrompt = `
Focus only on improvement tips and step-by-step advice.
Example:
1. Improve your crosshair placement.
2. Practice edits daily.
3. Work on early-game positioning.`;
        break;
      case "coach":
        responsePrompt = `
Respond like a professional Fortnite coach.
Use paragraphs and motivational tone.
Example:
“You’ve built solid aim fundamentals, but your mid-fight edits could be smoother...”`;
        break;
      case "summary":
        responsePrompt = `
Provide a short summary (2–3 sentences) of the player's performance.`;
        break;
      default:
        responsePrompt = "Provide clear, general gameplay feedback.";
    }

    // --- AI Prompt ---
    const analysisPrompt = `
You are a professional Fortnite gameplay analyst.

Analyze this player:
Bio: ${bio}
Video Summary: ${frameSummary}
Focus: ${focusPrompt}

Response type: ${responsePrompt}

Format Rules:
- Write clean, readable text only.
- Add newlines between each category or section.
- Never use *, {}, [], #, **, or \`\`\`.
- Keep the formatting natural and easy to read inside a text box.
`;

    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a Fortnite gameplay coach. Always return plain, formatted text only — no JSON, Markdown, or symbols.",
        },
        { role: "user", content: analysisPrompt },
      ],
    });

    // --- Cleanup ---
    let cleanText = aiResponse.choices[0].message.content.trim();

    cleanText = cleanText
      .replace(/```[\s\S]*?```/g, "")
      .replace(/[{}[\]*#"]/g, "")
      .replace(/\s+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return res.json({
      success: true,
      analysis: cleanText,
    });
  } catch (error) {
    console.error("AI Analysis error:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error during analysis.",
    });
  }
});

// --- Root Route ---
app.get("/", (req, res) => {
  res.send("🎮 Fortnite AI API running with dynamic formatting!");
});

// --- Start Server ---
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});
