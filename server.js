import express from "express";
import OpenAI from "openai";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// Multer middleware for file uploads
const upload = multer({ storage: multer.memoryStorage() });

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// OpenAI client
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===== Upload + Generate Signed URL + GPT Analysis =====
app.post("/upload-analyze", upload.single("video"), async (req, res) => {
  try {
    const file = req.file;
    const { description, length } = req.body;

    if (!file || !description) {
      return res.status(400).json({ error: "Video and description are required" });
    }

    const filename = `videos/${Date.now()}-${file.originalname}`;

    // 1️⃣ Upload video to Supabase
    const { error: uploadError } = await supabase.storage
      .from("gameplay")
      .upload(filename, file.buffer, { contentType: file.mimetype });

    if (uploadError) throw uploadError;

    // 2️⃣ Generate signed URL (valid 1 hour)
    const { data: signedData, error: signedError } = await supabase.storage
      .from("gameplay")
      .createSignedUrl(filename, 3600); // 3600s = 1 hour

    if (signedError) throw signedError;

    const signedUrl = signedData.signedUrl;

    // 3️⃣ Analyze gameplay with GPT
    let maxTokens = 200;
    if (length === "short") maxTokens = 100;
    if (length === "long") maxTokens = 400;

    const aiResponse = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a Fortnite coach that analyzes gameplay." },
        { role: "user", content: `Analyze this Fortnite match: ${description}` }
      ],
      max_tokens: maxTokens
    });

    const feedback = aiResponse.choices[0].message.content;

    // 4️⃣ Schedule deletion after 1 hour
    setTimeout(async () => {
      await supabase.storage.from("gameplay").remove([filename]);
      console.log(`Deleted ${filename} from storage after 1 hour`);
    }, 3600 * 1000); // 1 hour in milliseconds

    // 5️⃣ Return response to frontend
    res.json({
      message: "Upload and analysis successful!",
      videoUrl: signedUrl,
      feedback
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload or analysis failed" });
  }
});

// Basic health check
app.get("/", (req, res) => {
  res.send("Fortnite AI API is running 🚀");
});

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
