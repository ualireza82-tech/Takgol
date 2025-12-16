// server.js — FINALIZED - PostgreSQL (Neon) + SSE + persistent messages + self-ping + group + soft delete + image support + TOKEN USER AUTH
import express from "express";
import cors from "cors";
import { Pool } from "pg";
import http from "http";
import https from "https";
import crypto from 'crypto';

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(cors());

/* --------------- CONFIG --------------- */
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error("ERROR: DATABASE_URL not set"); process.exit(1); }

const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 180); 
const ENABLE_SELF_PING = String(process.env.ENABLE_SELF_PING || "true").toLowerCase() === "true";
const SELF_PING_URL = process.env.SELF_PING_URL || "";
const SELF_PING_BASE_MINUTES = Number(process.env.SELF_PING_BASE_MINUTES || 14);
const SELF_PING_JITTER_MS = Number(process.env.SELF_PING_JITTER_MS || (30 * 1000));
const SELF_PING_TIMEOUT_MS = Number(process.env.SELF_PING_TIMEOUT_MS || (10 * 1000));
const SSE_KEEPALIVE_INTERVAL_MS = Number(process.env.SSE_KEEPALIVE_INTERVAL_MS || 20 * 1000);

const DUMMY_SECRET_KEY = process.env.DUMMY_SECRET_KEY || "SuperSafeAndSecretKey";

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.PG_MAX_CLIENTS || 6),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

/* --------------- SCHEMA --------------- */
const ensureSchema = async () => {
  const create = `
    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL,
      text TEXT NOT NULL,
      "group" TEXT,
      image TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      deleted BOOLEAN DEFAULT false,
      deleted_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_group ON messages("group");
  `;
  await pool.query(create);
};

/* --------------- SSE CLIENTS --------------- */
let clients = [];
function cleanupDeadClients() {
    const beforeCount = clients.length;
    clients = clients.filter(c => {
        if (c.res.finished) return false;
        if (Date.now() - c.lastActive > 30 * 60 * 1000) { try { c.res.end(); } catch{}; return false; }
        return true;
    });
    if (beforeCount !== clients.length && beforeCount>0) console.log(`SSE Cleanup: ${beforeCount - clients.length} dead clients removed`);
}
setInterval(cleanupDeadClients, 5*60*1000);

function broadcastEvent(obj){
  const payload = `data: ${JSON.stringify(obj)}\n\n`;
  clients.forEach(c => { try { c.res.write(payload); c.lastActive=Date.now(); } catch{} });
}

/* --------------- AUTH HELPERS --------------- */
function generateAuthToken(user_id){
    const ts = Date.now();
    const sig = crypto.createHmac('sha256', DUMMY_SECRET_KEY).update(`${user_id}:${ts}`).digest('hex');
    return `${user_id}.${ts}.${sig}`;
}
function verifyAuthToken(token){
    if(!token) return null;
    const parts = token.split('.');
    if(parts.length!==3) return null;
    const [user_id, ts, sig]=parts;
    const expected = crypto.createHmac('sha256', DUMMY_SECRET_KEY).update(`${user_id}:${ts}`).digest('hex');
    try{ if(!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null; } catch{return null;}
    if(Date.now()-Number(ts) > 30*24*60*60*1000) return null;
    return user_id;
}

/* --------------- HELPERS --------------- */
function getClientIp(req){
  const fwd=req.headers['x-forwarded-for']||req.headers['x-forwarded-for'.toLowerCase()];
  if(fwd) return fwd.split(',')[0].trim();
  return req.ip||null;
}
function httpGetWithTimeout(urlStr, timeoutMs=SELF_PING_TIMEOUT_MS){
  return new Promise((resolve,reject)=>{
    let url;
    try{url=new URL(urlStr);}catch(e){return reject(new Error("Invalid URL"));}
    const lib = url.protocol==="https:"?https:http;
    const req = lib.request(url,{method:"GET",timeout:timeoutMs,headers:{"Cache-Control":"no-store","User-Agent":"self-pinger/1.0"}},res=>{
      res.on("data",()=>{}); res.on("end",()=>resolve({statusCode:res.statusCode}));
    });
    req.on("timeout",()=>req.destroy(new Error("timeout")));
    req.on("error",err=>reject(err));
    req.end();
  });
}
async function doSelfPingOnce(){
  if(!ENABLE_SELF_PING||!SELF_PING_URL) return;
  try{ const r=await httpGetWithTimeout(SELF_PING_URL, SELF_PING_TIMEOUT_MS); console.log(`self-ping -> ${SELF_PING_URL} status=${r.statusCode}`); }catch(e){console.warn("self-ping error:", e?.message||e);}
}
function scheduleNextSelfPing(){
  if(!ENABLE_SELF_PING||!SELF_PING_URL) return;
  const baseMs=SELF_PING_BASE_MINUTES*60*1000;
  const jitter=Math.floor((Math.random()*2-1)*SELF_PING_JITTER_MS);
  const nextMs=Math.max(60*1000,baseMs+jitter);
  setTimeout(async()=>{await doSelfPingOnce(); scheduleNextSelfPing();},nextMs);
}

/* --------------- ENDPOINTS --------------- */
app.get("/ping",(req,res)=>{res.setHeader("Cache-Control","no-store,no-cache,must-revalidate"); res.status(200).send("pong ✅ server alive");});

app.get("/messages",async(req,res)=>{
  try{
    const group=req.query.group||null;
    const limit=Math.min(5000,Math.max(50,Number(req.query.limit||1000)));
    let q="SELECT id,user_id as sender_id,text,image,\"group\",created_at FROM messages WHERE deleted=false";
    let params=[];
    if(group){ q+=" AND \"group\"=$1 ORDER BY created_at ASC LIMIT $2"; params=[group,limit]; } 
    else { q+=" ORDER BY created_at ASC LIMIT $1"; params=[limit]; }
    const r=await pool.query(q,params);
    res.json({ok:true,rows:r.rows});
  }catch(e){console.error(e); res.status(500).json({ok:false,error:"server error"});}
});

app.get("/events",(req,res)=>{
  res.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache",Connection:"keep-alive"});
  res.write(":\n\n");
  const client={res,id:crypto.randomUUID(),lastActive:Date.now()};
  clients.push(client);
  req.on("close",()=>{clients=clients.filter(c=>c!==client);});
});

app.post("/send",async(req,res)=>{
  try{
    const token=req.headers['authorization']?.split(' ')[1]||req.body.token;
    const user_id=verifyAuthToken(token);
    if(!user_id) return res.status(401).json({ok:false,error:"invalid or expired token"});

    const text=String(req.body.text||"").trim();
    const group=req.body.group?String(req.body.group):null;
    let img=req.body.image?String(req.body.image):null;
    if(!text&&!img) return res.status(400).json({ok:false,error:"empty message"});
    if(img && img.length>5*1024*1024*(4/3)) img="TooLarge";

    const id=crypto.randomUUID();
    const insert="INSERT INTO messages(id,user_id,text,\"group\",image) VALUES($1,$2,$3,$4,$5) RETURNING created_at";
    const r=await pool.query(insert,[id,user_id,text,group,img]);

    const msg={id,user_id: user_id, text, image: img, group, created_at:r.rows[0].created_at};
    broadcastEvent({type:"message",payload:msg});
    res.json({ok:true,id,message:"message sent & broadcast"});
  }catch(e){console.error(e); res.status(500).json({ok:false,error:"server error on send"});}
});

app.delete("/messages/:id",async(req,res)=>{
  try{
    const token=req.headers['authorization']?.split(' ')[1]||req.body.token;
    const user_id=verifyAuthToken(token);
    if(!user_id) return res.status(401).json({ok:false,error:"invalid or expired token"});
    const id=req.params.id;
    const q="UPDATE messages SET deleted=true,deleted_at=now() WHERE id=$1 AND user_id=$2 RETURNING id";
    const r=await pool.query(q,[id,user_id]);
    if(r.rowCount){broadcastEvent({type:"delete",id}); res.json({ok:true,message:"soft deleted"});}
    else res.status(403).json({ok:false,error:"message not found or no permission"});
  }catch(e){console.error(e); res.status(500).json({ok:false,error:"server error"});}
});

/* --------------- CLEANUP --------------- */
async function cleanupOldMessages(){
  try{
    const r1=await pool.query("DELETE FROM messages WHERE deleted=false AND created_at < now()-($1||' days')::interval",[RETENTION_DAYS]);
    if(r1.rowCount) console.log(`cleanup: deleted ${r1.rowCount} UN-deleted messages older than ${RETENTION_DAYS} days`);
    const r2=await pool.query("DELETE FROM messages WHERE deleted=true AND deleted_at < now()-('60 days')::interval");
    if(r2.rowCount) console.log(`cleanup: permanently deleted ${r2.rowCount} SOFT-deleted messages older than 60 days`);
  }catch(e){console.error("cleanup error",e);}
}
const DAY_MS=24*60*60*1000;
setTimeout(()=>{setInterval(cleanupOldMessages,DAY_MS);},5000);
cleanupOldMessages().catch(()=>{});

/* --------------- SSE KEEPALIVE --------------- */
setInterval(()=>{if(clients.length>0) clients.forEach(c=>{try{c.res.write(":\n\n");c.lastActive=Date.now();}catch{}});},SSE_KEEPALIVE_INTERVAL_MS);

/* --------------- START --------------- */
const PORT=process.env.PORT||10000;
(async()=>{
  try{
    await ensureSchema();
    if(ENABLE_SELF_PING && SELF_PING_URL){await doSelfPingOnce(); scheduleNextSelfPing();}
    else console.log("Self-ping disabled or no SELF_PING_URL set.");
    app.listen(PORT,()=>console.log(`✅ Chat server running on port ${PORT}`));
  }catch(e){console.error("Failed to start:",e); process.exit(1);}
})();