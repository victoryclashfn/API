import express from "express";
import OpenAI from "openai";
import multer from "multer";
import fs from "fs";
import cors from "cors";
import { exec } from "child_process";
import admin from "firebase-admin";

// --- Firebase Setup (Option 1: fs.readFileSync) ---
const serviceAccount = JSON.parse(
  fs.readFileSync("./serviceAccountKey.json", "utf8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// --- Express App ---
const app = express();
app.use(cors());
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const upload = multer({ dest: "uploads/" });

// --- Helper: Extract frames ---
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

// --- Helper: Merge bio in Firestore ---
async function mergeBio(userId, newBio) {
  const ref = db.collection("bios").doc(userId);
  const doc = await ref.get();
  let combined = newBio;
  if (doc.exists) {
    combined = doc.data().bio + " " + newBio;
  }
  await ref.set({ bio: combined }, { merge: true });
  return combined;
}

// --- Generate prompt style based on type ---
function buildPrompt(responseType) {
  switch (responseType?.toLowerCase()) {
    case "coach":
      return "Act like a Fortnite coach. Give constructive, step-by-step advice.";
    case "stats":
      return "Provide raw gameplay statistics and performance breakdowns.";
    case "summary":
      return "Give a short, neutral match summary.";
    case "hype":
      return "Respond like a hype caster. Make it energetic and fun.";
    case "analytics":
      return "Provide a detailed, analytical breakdown of the gameplay.";
    default:
      return "Be a helpful Fortnite assistant.";
  }
}

// --- Analyze Endpoint ---
app.post("/analyze", upload.single("video"), async (req, res) => {
  console.log("Analysis request:", req.body, req.file?.originalname);

  const { userId, bio, responseType } = req.body;
  const videoFile = req.file;

  if (!userId) return res.status(400).json({ error: "userId is required" });
  if (!bio && !videoFile)
    return res.status(400).json({ error: "Bio or video required" });

  let framePaths = [];
  try {
    // Merge bio into Firestore
    const combinedBio = bio ? await mergeBio(userId, bio) : "";

    // Build request text
    const promptIntro = buildPrompt(responseType);
    let requestText = `${promptIntro}\nPlayer Bio: ${combinedBio}\nAnalyze this Fortnite gameplay.`;

    let messages = [{ role: "system", content: requestText }];

    // Process video frames
    if (videoFile) {
      try {
        const frameDir = `uploads/frames-${Date.now()}`;
        fs.mkdirSync(frameDir);
        framePaths = await extractFrames(videoFile.path, frameDir, 3);

        for (const frame of framePaths) {
          const b64 = fs.readFileSync(frame, { encoding: "base64" });
          messages.push({
            role: "user",
            content: [
              { type: "text", text: "Frame from gameplay video" },
              { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } }
            ]
          });
        }
      } catch (ffmpegErr) {
        console.error("FFmpeg error:", ffmpegErr);
      }
    }

    // Request to OpenAI
    const response = await client.chat.completions.create({
      model: "gpt-4o",
      messages,
      max_tokens: 600
    });

    let analysis = response.choices[0].message.content || "";
    analysis = analysis.replace(/\*/g, "").replace(/\n{2,}/g, "\n\n");

    res.json({ analysis });
  } catch (err) {
    console.error("Analysis error:", err);
    res.status(500).json({ error: "Failed to analyze" });
  } finally {
    try {
      if (videoFile) fs.unlinkSync(videoFile.path);
      for (const frame of framePaths) fs.unlinkSync(frame);
    } catch (cleanupErr) {
      console.error("Cleanup error:", cleanupErr);
    }
  }
});

// --- Chatbot Endpoint ---
app.post("/chatbot", async (req, res) => {
  try {
    const { userId, bio, message } = req.body;
    if (!userId || !message)
      return res.status(400).json({ error: "userId and message required" });

    const combinedBio = bio
      ? await mergeBio(userId, bio)
      : (await db.collection("bios").doc(userId).get()).data()?.bio || "";

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `You are a Fortnite chatbot. Player Bio: ${combinedBio}` },
        { role: "user", content: message }
      ],
      max_tokens: 300
    });

    let reply = response.choices[0].message.content || "";
    reply = reply.replace(/\*/g, "").replace(/\n{2,}/g, "\n\n");

    res.json({ reply });
  } catch (err) {
    console.error("Chatbot error:", err);
    res.status(500).json({ error: "Failed to get chatbot response" });
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
