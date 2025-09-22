import express from "express";
import OpenAI from "openai";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

// --- OpenAI client ---
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// --- Supabase client ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // ⚠️ use "service_role" key, not anon
);

// --- Multer setup (buffer storage) ---
const storage = multer.memoryStorage();
const upload = multer({ storage });

// ==============================
// Chatbot endpoint
// ==============================
app.post("/chatbot", async (req, res) => {
  try {
    const { message, length } = req.body;

    let maxTokens = 200;
    if (length === "short") maxTokens = 100;
    if (length === "long") maxTokens = 400;

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a helpful and friendly chatbot." },
        { role: "user", content: message }
      ],
      max_tokens: maxTokens
    });

    res.json({
      reply: response.choices[0].message.content
    });
  } catch (err) {
    console.error("Chatbot error:", err);
    res.status(500).json({ error: "Failed to get chatbot response" });
  }
});

// ==============================
// Text-only Fortnite analyze
// ==============================
app.post("/analyze", async (req, res) => {
  try {
    const { description } = req.body;

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a Fortnite coach that analyzes gameplay and gives practical tips." },
        { role: "user", content: `Analyze this Fortnite match: ${description}` }
      ],
      max_tokens: 300
    });

    res.json({
      feedback: response.choices[0].message.content
    });
  } catch (err) {
    console.error("Analyze error:", err);
    res.status(500).json({ error: "Failed to analyze gameplay" });
  }
});

// ==============================
// Video upload + analysis
// ==============================
app.post("/upload-analyze", upload.single("video"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No video uploaded" });
    }

    // 1. Upload to Supabase bucket "videos"
    const filePath = `uploads/${Date.now()}-${req.file.originalname}`;
    const { data, error } = await supabase.storage
      .from("videos")
      .upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true
      });

    if (error) {
      console.error("Supabase upload error:", error);
      return res.status(500).json({ error: error.message });
    }

    console.log("Uploaded file:", data);

    // 2. Create signed URL (1h expiry)
    const { data: signedUrlData, error: urlError } = await supabase.storage
      .from("videos")
      .createSignedUrl(filePath, 3600);

    if (urlError || !signedUrlData?.signedUrl) {
      console.error("Signed URL error:", urlError);
      return res.status(500).json({ error: "Failed to create signed URL" });
    }

    // 3. Ask OpenAI for feedback (with video URL)
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a Fortnite coach analyzing gameplay videos." },
        { role: "user", content: `Here is a video URL: ${signedUrlData.signedUrl}. Please provide feedback.` }
      ],
      max_tokens: 250
    });

    res.json({
      videoUrl: signedUrlData.signedUrl,
      feedback: response.choices[0].message.content
    });
  } catch (err) {
    console.error("Upload-analyze error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ==============================
app.get("/", (req, res) => {
  res.send("Fortnite AI API is running 🚀");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
