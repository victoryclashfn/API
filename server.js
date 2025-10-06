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

      frames.forEach((f) => fs.unlinkSync(f));
      fs.rmdirSync(frameDir);
      fs.unlinkSync(videoFile.path);
    }
  } catch (err) {
    console.error("Frame extraction error:", err);
    frameSummary = "Video processing failed or no frames extracted.";
  }

  try {
    // --- Focus type handling ---
    let focusPrompt = "";
    switch (focus.toLowerCase()) {
      case "aim":
        focusPrompt = "Focus mainly on aiming and shooting accuracy.";
        break;
      case "building":
        focusPrompt = "Focus mainly on building, edits, and structural plays.";
        break;
      case "positioning":
        focusPrompt = "Focus mainly on positioning, rotations, and awareness.";
        break;
      case "all":
      case "gameplay":
        focusPrompt =
          "Analyze everything: aim, positioning, building, edits, and overall gameplay.";
        break;
      default:
        focusPrompt = "Provide general gameplay analysis.";
    }

    // --- Response type handling ---
    let responsePrompt = "";
    switch (responseType.toLowerCase()) {
      case "stats":
        responsePrompt = "Provide numeric ratings (out of 10) for each area.";
        break;
      case "improvement":
        responsePrompt = "Give detailed improvement advice.";
        break;
      case "coach":
        responsePrompt = "Respond like a professional Fortnite coach.";
        break;
      case "summary":
        responsePrompt = "Provide a concise gameplay summary.";
        break;
      default:
        responsePrompt = "Provide general gameplay feedback.";
    }

    // --- Full prompt for AI ---
    const analysisPrompt = `
You are a professional Fortnite gameplay analyst.

Analyze this player based on the following:
Bio: ${bio}
Video Summary: ${frameSummary}
Focus: ${focusPrompt}
Response Type: ${responsePrompt}

Rules:
- Respond ONLY in plain text (no JSON, no lists, no *, no quotes, no brackets).
- Do NOT use markdown formatting like \`\`\` or **.
- Write naturally like you're talking to the player.
    `;

    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a Fortnite gameplay coach. Always reply in clean human-readable text. Never use *, {}, or ```.",
        },
        { role: "user", content: analysisPrompt },
      ],
    });

    // --- Cleanup output ---
    let cleanText = aiResponse.choices[0].message.content.trim();

    cleanText = cleanText
      .replace(/```[\s\S]*?```/g, "") // remove code blocks
      .replace(/[{}[\]"*]/g, "") // remove brackets, stars, quotes
      .replace(/feedback:/gi, "")
      .replace(/\s+/g, " ")
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

// --- Root route ---
app.get("/", (req, res) => {
  res.send("🎮 Fortnite AI API running!");
});

// --- Start server ---
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});
