import express from "express";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import multer from "multer";

const app = express();
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Connect to Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 1️⃣ Upload video endpoint
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    const filename = `gameplays/${Date.now()}_${file.originalname}`;

    const { error } = await supabase.storage
      .from("gameplay-files")
      .upload(filename, file.buffer);

    if (error) throw error;

    const publicUrl = supabase.storage.from("gameplay-files")
      .getPublicUrl(filename).data.publicUrl;

    res.json({ url: publicUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// 2️⃣ Analyze gameplay endpoint
app.post("/analyze", async (req, res) => {
  try {
    const { description, length } = req.body;

    let maxTokens = 200;
    if (length === "short") maxTokens = 100;
    if (length === "long") maxTokens = 400;

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a Fortnite coach analyzing gameplay." },
        { role: "user", content: `Analyze this match: ${description}` }
      ],
      max_tokens: maxTokens
    });

    res.json({ feedback: response.choices[0].message.content });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Analysis failed" });
  }
});

// Run server
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
