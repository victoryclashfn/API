/**
 * 🎮 Gamescan API — vSecure + Cost Tracker (Render Ready)
 * ------------------------------------------------------------
 *  ✅ Secure (Auth, Rate Limit, CORS, Helmet)
 *  ✅ Cost-efficient model logic (Gamer = Free)
 *  ✅ Logs estimated OpenAI cost per analysis
 *  ✅ Tracks daily + monthly totals in memory
 * ------------------------------------------------------------
 */

import express from "express";
import cors from "cors";
import helmet from "helmet";
import multer from "multer";
import fs from "fs/promises";
import fssync from "fs";
import path from "path";
import { exec } from "child_process";
import crypto from "crypto";
import OpenAI from "openai";
import { fileTypeFromFile } from "file-type";
import { fileURLToPath } from "url";
import { dirname } from "path";
import "dotenv/config";

// ---------- INIT ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();

// ---------- CONFIG ----------
const DEV_MODE = (process.env.DEV_MODE || "false") === "true";
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "3", 10);
const MAX_QUEUE = parseInt(process.env.MAX_QUEUE || "50", 10);
const PORT = parseInt(process.env.PORT || "3000", 10);
const CACHE_FILE = path.resolve("analysisCache.json");
const CACHE_TTL_DAYS = parseInt(process.env.CACHE_TTL_DAYS || "7", 10);
const UPLOAD_DIR = process.env.UPLOAD_DIR || "/tmp/uploads";
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || "200", 10);
const FFMPEG_TIMEOUT_MS = parseInt(process.env.FFMPEG_TIMEOUT_MS || "60000", 10);
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim())
  : ["*"];

// ---------- COST TRACKER ----------
let dailyCost = 0, monthlyCost = 0;
function logCost(amount){ dailyCost+=amount; monthlyCost+=amount; }
function resetDaily(){
  console.log(`📊 Daily total: $${dailyCost.toFixed(4)} | Monthly: $${monthlyCost.toFixed(4)}`);
  dailyCost=0;
}
function resetMonthly(){
  console.log(`💰 Monthly total reset. Prev month: $${monthlyCost.toFixed(4)}`);
  monthlyCost=0;
}
setInterval(resetDaily, 24*60*60*1000);
setInterval(resetMonthly, 30*24*60*60*1000);

// ---------- BOOT ----------
console.log("\n🎮 Gamescan API starting...");
console.log(`Mode: ${DEV_MODE ? "DEV" : "PROD"} | Port: ${PORT}`);
console.log("==============================");

// ---------- MIDDLEWARE ----------
await fs.mkdir(UPLOAD_DIR,{recursive:true}).catch(()=>{});
const upload=multer({
  dest:UPLOAD_DIR,
  limits:{fileSize:MAX_UPLOAD_MB*1024*1024},
  fileFilter:(_r,f,cb)=>{
    if((f.mimetype||"").startsWith("video/")) return cb(null,true);
    cb(new Error("Only video files allowed"));
  }
});
app.use(helmet());
app.use(cors({
  origin:(o,cb)=>{
    if(!o||ALLOWED_ORIGINS.includes("*")||ALLOWED_ORIGINS.includes(o))
      return cb(null,true);
    console.log(`🚫 CORS blocked: ${o}`); cb(new Error("Not allowed"));
  }
}));
app.use(express.json({limit:"2mb"}));
app.use(express.urlencoded({extended:true}));

// ---------- AUTH ----------
function authMiddleware(req,res,next){
  if(DEV_MODE) return next();
  const key=req.headers["x-api-key"];
  if(!key||key!==process.env.API_KEY)
    return res.status(401).json({success:false,error:"Unauthorized"});
  next();
}

// ---------- CACHE ----------
let analysisCache=new Map();
async function atomicWrite(file,data){
  const tmp=`${file}.tmp-${Date.now()}`;
  await fs.writeFile(tmp,data); await fs.rename(tmp,file);
}
async function loadCache(){
  try{
    if(fssync.existsSync(CACHE_FILE)){
      const data=JSON.parse(await fs.readFile(CACHE_FILE,"utf8"));
      analysisCache=new Map(Object.entries(data));
      console.log(`✅ Cache loaded (${analysisCache.size} entries)`);
    }
  }catch(e){ console.error("⚠️ Cache load failed:",e.message); }
}
await loadCache();
async function saveCache(){
  try{ await atomicWrite(CACHE_FILE,JSON.stringify(Object.fromEntries(analysisCache),null,2)); }
  catch(e){ console.error("⚠️ Cache save failed:",e.message); }
}
setInterval(async()=>{
  const now=Date.now(), ttl=CACHE_TTL_DAYS*86400000;
  let removed=0;
  analysisCache.forEach((v,k)=>{
    if(v.timestamp&&now-v.timestamp>ttl){ analysisCache.delete(k); removed++; }
  });
  if(removed){ await saveCache(); console.log(`🧹 Cache cleanup: ${removed}`); }
},3600000);

// ---------- RATE LIMIT ----------
const rateBuckets=new Map();
const RATE_WINDOW_MS=60000,RATE_MAX=20;
function rateLimit(req,res,next){
  const ip=req.headers["x-forwarded-for"]?.split(",")[0].trim()||req.ip||"unk";
  const now=Date.now();
  const arr=(rateBuckets.get(ip)||[]).filter(t=>now-t<RATE_WINDOW_MS);
  if(arr.length>=RATE_MAX)
    return res.status(429).json({success:false,error:"Too many requests"});
  arr.push(now); rateBuckets.set(ip,arr); next();
}

// ---------- QUEUE ----------
const queue=[]; let running=0;
async function enqueue(jobFn,res){
  return new Promise((resolve,reject)=>{
    const job={jobFn,res,resolve,reject,id:crypto.randomUUID()};
    queue.push(job);
    if(running>=MAX_CONCURRENT){
      const pos=queue.length;
      console.log(`📥 Queued job #${pos}`);
      res.json({queued:true,position:pos,message:`⏳ Queue #${pos}`});
    }
    processNext();
  });
}
async function processNext(){
  if(running>=MAX_CONCURRENT||!queue.length)return;
  const job=queue.shift(); running++;
  console.log(`🚀 Processing job (${running})`);
  job.jobFn()
    .then(r=>{ if(!job.res.headersSent)job.res.json({queued:false,...r}); job.resolve(r); })
    .catch(e=>{
      console.error("❌ Job error:",e.message);
      if(!job.res.headersSent)job.res.status(500).json({success:false,error:"Internal"});
      job.reject(e);
    })
    .finally(()=>{ running--; processNext(); });
}

// ---------- UTIL ----------
async function sha256(f){ const b=await fs.readFile(f); return crypto.createHash("sha256").update(b).digest("hex"); }
function applyDynamicSpacing(t){
  return (t||"").replace(/\n\s*\n/g,"\n\n").replace(/([^\n])\n([^\n])/g,"$1\n\n$2").replace(/\n{3,}/g,"\n\n").trim();
}
function execWithTimeout(cmd,timeout){
  return new Promise((res,rej)=>{
    exec(cmd,{timeout},(err,out,errout)=>{ if(err) return rej(err); res({out,errout}); });
  });
}
const openai=new OpenAI({apiKey:process.env.OPENAI_API_KEY});
async function openaiRetry(payload,tries=3){
  let delay=800;
  for(let i=0;i<tries;i++){
    try{return await openai.chat.completions.create(payload);}catch(e){
      if(i===tries-1)throw e;
      await new Promise(r=>setTimeout(r,delay)); delay*=2;
    }
  }
}

// ---------- ANALYSIS ----------
async function handleAnalysis(req){
  const {
    responseType,game,clipType,language,feedbackStyle,
    detailLevel="normal",skillLevel="Unknown",audioInClip="false",
    playerBio="",extraNotes="",userTier="free",
  }=req.body;
  if(!req.file||!game||!responseType)
    return {success:false,error:"Missing required fields"};

  try{
    const type=await fileTypeFromFile(req.file.path);
    if(!type||!type.mime.startsWith("video/")){
      await fs.unlink(req.file.path);
      return {success:false,error:"Invalid video"};
    }
  }catch{}

  let focusAreas=req.body.focusAreas;
  try{ if(typeof focusAreas==="string")focusAreas=JSON.parse(focusAreas);}catch{}
  const focusList=Array.isArray(focusAreas)?focusAreas.slice(0,5):["overall"];

  const videoHash=await sha256(req.file.path);
  const cacheKey=`${videoHash}|${game}|${userTier}|${detailLevel}`;
  if(analysisCache.has(cacheKey)){
    console.log("💾 Cache hit"); await fs.unlink(req.file.path).catch(()=>{});
    return {...analysisCache.get(cacheKey),cached:true};
  }

  console.log("🔍 Detecting key moments...");
  const keyTimes=[];
  try{
    const {errout}=await execWithTimeout(
      `ffmpeg -i "${req.file.path}" -vf "select=gt(scene\\,0.3),showinfo" -f null -`,
      FFMPEG_TIMEOUT_MS
    );
    const times=errout?.match(/pts_time:(\\d+\\.?\\d*)/g)?.map(m=>parseFloat(m.replace("pts_time:","")) )||[];
    keyTimes.push(...times.slice(0,10));
  }catch{}
  const keyMoments=keyTimes.map(t=>`${Math.round(t)}s`);

  const frameDir=path.join(UPLOAD_DIR,`frames-${Date.now()}`);
  await fs.mkdir(frameDir,{recursive:true});

  // ---------- FRAME SCALING ----------
  let frameCount=3, scale="720:-1";
  if(detailLevel==="high") frameCount=4;
  if(userTier==="master"){ frameCount=6; scale="960:-1"; }

  try{
    await execWithTimeout(
      `ffmpeg -y -i "${req.file.path}" -vf "thumbnail,scale=${scale}" -frames:v ${frameCount} "${frameDir}/frame-%02d.jpg" -q:v 8`,
      FFMPEG_TIMEOUT_MS
    );
  }catch(e){ console.log("⚠️ Frame extraction:",e.message); }
  await fs.unlink(req.file.path).catch(()=>{});

  const frames=fssync.readdirSync(frameDir)
    .filter(f=>f.startsWith("frame-")).map(f=>`${frameDir}/${f}`);

  // ---------- MODEL SELECTION ----------
  const TOKEN_LIMITS={free:800,gamer:900,pro:1200,master:1500};
  const MODEL_RATES={"gpt-4o-mini":0.00015,"gpt-4o":0.005,"gpt-4.1":0.01};
  function estimateCost(u,m){const t=u?.total_tokens||0;return (t/1000)*(MODEL_RATES[m]||0.005);}

  let model="gpt-4o-mini";
  if(userTier==="pro"){ if(detailLevel==="high") model="gpt-4o"; }
  else if(userTier==="master"){ model=detailLevel==="high"?"gpt-4.1":"gpt-4o"; }
  console.log(`🎯 Using model: ${model} (tier=${userTier}, detail=${detailLevel})`);

  const weightedFocus=focusList
    .map((f,i)=>`- ${f} (${[40,30,20,15,10][i]||10}% importance)`).join("\n");

  const prompt=`
You are an expert ${game} gameplay coach. Analyze the provided frames.

Focus Areas:
${weightedFocus}

Context:
Skill Level: ${skillLevel}
Feedback Style: ${feedbackStyle}
Language: ${language}
Audio Included: ${audioInClip}
Detail Level: ${detailLevel}
Key Moments: ${keyMoments.join(", ")||"None"}
Extra Notes: ${extraNotes||"None"}
Player Bio: ${playerBio||"N/A"}

Output format:
[STRENGTHS]
[WEAKNESSES]
[TIPS]
`.trim();

  const imageInputs=frames.map(f=>({type:"image_url",image_url:`file://${path.resolve(f)}`}));

  console.log("🤖 Sending to OpenAI...");
  const completion=await openaiRetry({
    model,
    messages:[
      {role:"system",content:"You are a professional gameplay analyst."},
      {role:"user",content:[{type:"text",text:prompt},...imageInputs]}
    ],
    max_tokens:TOKEN_LIMITS[userTier]||900,
    temperature:0.4
  });

  const aiText=applyDynamicSpacing(completion?.choices?.[0]?.message?.content||"No analysis.");

  const cost=estimateCost(completion?.usage,model);
  logCost(cost);
  console.log(`💰 Cost: $${cost.toFixed(4)} | Tokens: ${completion?.usage?.total_tokens||0}`);

  const baseStats={aim:80,positioning:82,movement:78,editing:75};
  const randomStats=b=>Array.from({length:frames.length},()=>Math.min(100,Math.max(0,b+Math.round(Math.random()*8-4))));
  const charts=focusList.map(a=>({
    label:a.charAt(0).toUpperCase()+a.slice(1),
    labels:Array.from({length:frames.length},(_,i)=>`Frame ${i+1}`),
    data:randomStats(baseStats[a.toLowerCase()]||70)
  }));

  const responseData={
    success:true,game,responseType,detailLevel,focusAreas:focusList,
    analysis:aiText,keyMoments,charts,modelUsed:model,framesUsed:frames.length,
    frameScale:scale,usage:completion?.usage,cached:false,timestamp:Date.now()
  };

  for(const f of frames) await fs.unlink(f).catch(()=>{});
  await fs.rm(frameDir,{recursive:true,force:true}).catch(()=>{});
  analysisCache.set(cacheKey,responseData); saveCache();
  console.log("✅ Analysis complete");
  return responseData;
}

// ---------- ROUTES ----------
app.get("/",(_req,res)=>res.send("🎮 Gamescan API running"));
app.get("/health",(_req,res)=>res.json({
  ok:true,uptime:process.uptime(),running,queued:queue.length,
  cacheSize:analysisCache.size,dailyCost,monthlyCost
}));
app.post("/analyze",rateLimit,authMiddleware,upload.single("video"),
  async(req,res)=>{ await enqueue(()=>handleAnalysis(req),res); });

// ---------- START ----------
app.listen(PORT,()=>console.log(`✅ Gamescan API live on port ${PORT} (${DEV_MODE?"DEV":"PROD"})`));
process.on("SIGINT",async()=>{
  console.log("\n💾 Saving cache..."); await saveCache(); process.exit(0);
});
