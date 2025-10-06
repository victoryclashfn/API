// server.js
import express from "express";
import fs from "fs";
import { exec } from "child_process";
import OpenAI from "openai";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- OpenAI setup ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Optional helper: extract frames if needed later ---
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

// --- Analyze Endpoint with focus + responseType ---
app.post("/analyze", async (req, res) => {
  const { bio, focus, responseType, videoUrl } = req.body;

  if (!bio || !focus || !responseType) {
    return res.status(400).json({
      success: false,
      error: "Missing required fields: bio, focus, or responseType",
    });
  }

  try {
    // Base prompt
    let basePrompt = `You are a professional Fortnite gameplay coach.
Analyze this player's profile and video URL:
Bio: ${bio}
Video URL: ${videoUrl || "No video provided"}.
`;

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

    // Full prompt
    const analysisPrompt = `${basePrompt}
Focus: ${focusPrompt}
Output type: ${responsePrompt}
Return the result in JSON format if possible.`;

    // Call OpenAI
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a professional Fortnite gameplay analyst." },
        { role: "user", content: analysisPrompt }
      ]
    });

    const aiText = response.choices[0].message.content;

    // Parse JSON from AI if possible
    let analysisJSON;
    try {
      analysisJSON = JSON.parse(aiText);
    } catch (err) {
      console.error("Error parsing AI response:", err);
      analysisJSON = { feedback: aiText };
    }

    return res.json({
      success: true,
      bioSummary: `Quick summary of player: ${bio}`,
      analysis: analysisJSON
    });

  } catch (error) {
    console.error("Analysis error:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error while processing analysis"
    });
  }
});

// --- Chatbot Endpoint (unchanged) ---
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
  res.send("🎮 Fortnite AI API running with dynamic focus + responseType analysis (including 'all')!");
});

// --- Start Server ---
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});
