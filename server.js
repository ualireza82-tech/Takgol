// server.js
// Robust SSE + Neon (Postgres) + soft-delete + edit + group support + self-ping (conservative)
import express from "express";
import cors from "cors";
import { Pool } from "pg";
import http from "http";
import https from "https";

process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection', err);
});

const app = express();
app.use(cors());
app.use(express.json());

/* --------------- CONFIG --------------- */
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL environment variable not set.");
  process.exit(1);
}
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 180);
const ENABLE_SELF_PING = String(process.env.ENABLE_SELF_PING || "true").toLowerCase() === "true";
const SELF_PING_URL = process.env.SELF_PING_URL || "";
const SELF_PING_BASE_MINUTES = Number(process.env.SELF_PING_BASE_MINUTES || 14);
const SELF_PING_JITTER_MS = Number(process.env.SELF_PING_JITTER_MS || (30 * 1000));
const SELF_PING_TIMEOUT_MS = Number(process.env.SELF_PING_TIMEOUT_MS || (10 * 1000));
const SSE_KEEPALIVE_INTERVAL_MS = Number(process.env.SSE_KEEPALIVE_INTERVAL_MS || 20 * 1000);

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.PG_MAX_CLIENTS || 6),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

/* --------------- SCHEMA ENSURE --------------- */
async function ensureSchema() {
  const create = `
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      sender TEXT,
      phone TEXT,
      "group" TEXT,
      reply JSONB,
      edited BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now(),
      ip TEXT,
      user_agent TEXT,
      deleted BOOLEAN DEFAULT false,
      deleted_at TIMESTAMPTZ,
      deleted_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_group ON messages("group");
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      action TEXT NOT NULL,
      actor TEXT,
      meta JSONB,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_audit_message_id ON audit_logs(message_id);
  `;
  await pool.query(create);
}

/* --------------- SSE clients & broadcast --------------- */
let clients = [];
function broadcast(obj) {
  const payload = `data: ${JSON.stringify(obj)}\n\n`;
  clients.forEach((res) => {
    try { res.write(payload); } catch (e) { /* ignore */ }
  });
}

/* --------------- Helpers --------------- */
function getClientIp(req){
  const forwarded = req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  if (req.ip) return req.ip;
  return null;
}
function uuidv4(){
  if (typeof globalThis?.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return require('crypto').randomUUID();
}
function httpGetWithTimeout(urlStr, timeoutMs = SELF_PING_TIMEOUT_MS){
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch (err) { return reject(new Error("Invalid URL")); }
    const lib = url.protocol === "https:" ? https : http;
    const options = { method: "GET", timeout: timeoutMs, headers: { "Cache-Control":"no-store", "User-Agent":"self-pinger/1.0" } };
    const req = lib.request(url, options, (res) => {
      res.on("data", ()=>{}); res.on("end", ()=> resolve({ statusCode: res.statusCode }));
    });
    req.on("timeout", ()=> req.destroy(new Error("timeout")));
    req.on("error", (err)=> reject(err));
    req.end();
  });
}

/* --------------- Self-ping (safe) --------------- */
async function doSelfPingOnce(){
  if (!ENABLE_SELF_PING) return;
  if (!SELF_PING_URL) { console.warn("SELF_PING_URL empty; skipping self-ping."); return; }
  try {
    const r = await httpGetWithTimeout(SELF_PING_URL, SELF_PING_TIMEOUT_MS);
    console.log(`self-ping -> ${SELF_PING_URL} status=${r.statusCode}`);
  } catch (err) {
    console.warn("self-ping error:", err && err.message ? err.message : err);
  }
}
function scheduleNextSelfPing(){
  if (!ENABLE_SELF_PING || !SELF_PING_URL) return;
  const baseMs = SELF_PING_BASE_MINUTES * 60 * 1000;
  const jitter = Math.floor((Math.random()*2 - 1) * SELF_PING_JITTER_MS);
  const nextMs = Math.max(60*1000, baseMs + jitter);
  setTimeout(async () => { await doSelfPingOnce(); scheduleNextSelfPing(); }, nextMs);
}

/* --------------- Endpoints --------------- */

// health/ping used by external monitors (UptimeRobot)
app.get("/ping", (req, res) => {
  res.setHeader("Cache-Control","no-store, no-cache, must-revalidate");
  res.status(200).send("pong ✅ server alive");
});

// GET messages (filter by group if provided). default excludes deleted
app.get("/messages", async (req, res) => {
  try {
    const group = req.query.group || null;
    const includeDeleted = String(req.query.include_deleted || "false").toLowerCase() === "true";
    const limit = Math.min(5000, Math.max(50, Number(req.query.limit || 1000)));
    let q, params;
    if (group) {
      if (includeDeleted) {
        q = `SELECT id,text,sender,phone,"group",reply,edited,created_at,ip,user_agent,deleted,deleted_at,deleted_by FROM messages WHERE "group" = $1 AND created_at >= now() - ($2 || ' days')::interval ORDER BY created_at ASC LIMIT $3`;
        params = [group, RETENTION_DAYS, limit];
      } else {
        q = `SELECT id,text,sender,phone,"group",reply,edited,created_at,ip,user_agent FROM messages WHERE "group" = $1 AND deleted = false AND created_at >= now() - ($2 || ' days')::interval ORDER BY created_at ASC LIMIT $3`;
        params = [group, RETENTION_DAYS, limit];
      }
    } else {
      if (includeDeleted) {
        q = `SELECT id,text,sender,phone,"group",reply,edited,created_at,ip,user_agent,deleted,deleted_at,deleted_by FROM messages WHERE created_at >= now() - ($1 || ' days')::interval ORDER BY created_at ASC LIMIT $2`;
        params = [RETENTION_DAYS, limit];
      } else {
        q = `SELECT id,text,sender,phone,"group",reply,edited,created_at,ip,user_agent FROM messages WHERE deleted = false AND created_at >= now() - ($1 || ' days')::interval ORDER BY created_at ASC LIMIT $2`;
        params = [RETENTION_DAYS, limit];
      }
    }
    const r = await pool.query(q, params);
    res.json({ ok: true, rows: r.rows });
  } catch (err) {
    console.error("GET /messages error:", err);
    res.status(500).json({ ok:false, error:"server error" });
  }
});

// SSE endpoint
app.get("/events", (req, res) => {
  res.writeHead(200, { "Content-Type":"text/event-stream", "Cache-Control":"no-cache", Connection:"keep-alive" });
  res.write(":\n\n"); // initial comment
  clients.push(res);
  req.on("close", () => { clients = clients.filter(c => c !== res); });
});

// POST /send : store message and broadcast (expects group in body)
app.post("/send", async (req, res) => {
  try {
    const text = String(req.body.text || "").trim();
    if (!text) return res.status(400).json({ ok:false, error:"empty text" });
    const sender = req.body.sender ? String(req.body.sender) : "کاربر";
    const group = req.body.group ? String(req.body.group) : null;
    const phone = req.body.phone ? String(req.body.phone) : null;
    const reply = req.body.reply ? req.body.reply : null;
    const id = uuidv4();
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] || null;

    const insertQ = `INSERT INTO messages (id,text,sender,phone,"group",reply,ip,user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING created_at`;
    const result = await pool.query(insertQ, [id, text, sender, phone, group, reply ? JSON.stringify(reply) : null, ip, ua]);

    // audit log: create
    const auditId = uuidv4();
    try {
      await pool.query(`INSERT INTO audit_logs (id,message_id,action,actor,meta) VALUES ($1,$2,'create',$3,$4)`, [auditId, id, sender, JSON.stringify({ group, ip })]);
    } catch(e){ /* non-fatal */ }

    const msg = { id, text, sender, phone, group, reply, created_at: result.rows[0].created_at, ip, user_agent: ua };
    // broadcast wrapper: type = "message", payload = msg
    broadcast({ type: "message", payload: msg });

    res.json({ ok:true, id });
  } catch (err) {
    console.error("POST /send error:", err);
    res.status(500).json({ ok:false, error:"server error" });
  }
});

// PUT edit
app.put("/messages/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const newText = String(req.body.text || "").trim();
    if (!newText) return res.status(400).json({ ok:false, error:"empty text" });
    const editor = req.body.editor ? String(req.body.editor) : (req.headers['x-actor'] || 'unknown');
    const q = `UPDATE messages SET text=$2, edited=true WHERE id=$1 RETURNING id, text, sender, phone, "group", reply, edited, created_at`;
    const r = await pool.query(q, [id, newText]);
    if (!r.rowCount) return res.status(404).json({ ok:false, error:"not found" });

    const auditId = uuidv4();
    try { await pool.query(`INSERT INTO audit_logs (id,message_id,action,actor,meta) VALUES ($1,$2,'edit',$3,$4)`, [auditId, id, editor, JSON.stringify({ newText })]); } catch(e){}

    const updated = r.rows[0];
    broadcast({ type: "edit", payload: updated });
    res.json({ ok:true, id });
  } catch (err) {
    console.error("PUT /messages/:id error:", err);
    res.status(500).json({ ok:false, error:"server error" });
  }
});

// DELETE (soft-delete)
app.delete("/messages/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const actor = req.headers['x-actor'] || req.body.actor || 'unknown';
    const updateQ = `UPDATE messages SET deleted=true, deleted_at = now(), deleted_by = $2 WHERE id = $1 RETURNING id`;
    const r = await pool.query(updateQ, [id, actor]);
    if (!r.rowCount) return res.status(404).json({ ok:false, error:"not found" });

    const auditId = uuidv4();
    try { await pool.query(`INSERT INTO audit_logs (id,message_id,action,actor,meta) VALUES ($1,$2,'delete',$3,$4)`, [auditId, id, actor, JSON.stringify({ reason: req.body.reason || null })]); } catch(e){}

    broadcast({ type: "delete", id });
    res.json({ ok:true, id });
  } catch (err) {
    console.error("DELETE /messages/:id error:", err);
    res.status(500).json({ ok:false, error:"server error" });
  }
});

/* --------------- Cleanup (hard-delete old soft-deleted messages) --------------- */
async function cleanupOldMessages(){
  try {
    const q = `DELETE FROM messages WHERE deleted = true AND created_at < now() - ($1 || ' days')::interval`;
    const r = await pool.query(q, [RETENTION_DAYS]);
    if (r && r.rowCount) console.log(`cleanup: hard-deleted ${r.rowCount} old messages`);
  } catch (err) {
    console.error("cleanupOldMessages error:", err);
  }
}
const DAY_MS = 24 * 60 * 60 * 1000;
setTimeout(()=> { setInterval(cleanupOldMessages, DAY_MS); }, 5*1000);
cleanupOldMessages().catch(()=>{});

/* --------------- SSE keep-alive --------------- */
setInterval(() => {
  if (clients.length === 0) return;
  clients.forEach(c => {
    try { c.write(":\n\n"); } catch (e) { /* ignore */ }
  });
}, SSE_KEEPALIVE_INTERVAL_MS);

/* --------------- Start server --------------- */
const PORT = process.env.PORT || 10000;
(async () => {
  try {
    await ensureSchema();
    if (ENABLE_SELF_PING && SELF_PING_URL) { await doSelfPingOnce(); scheduleNextSelfPing(); } else { console.log("Self-ping disabled or no SELF_PING_URL set."); }
    app.listen(PORT, () => console.log(`✅ Chat server running on port ${PORT}`));
  } catch (err) {
    console.error("Failed to start:", err);
    process.exit(1);
  }
})();