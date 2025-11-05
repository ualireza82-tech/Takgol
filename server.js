// server.js — PostgreSQL (Neon) + SSE + persistent messages + self-ping + group + soft delete (Text Preserved)
import express from "express";
import cors from "cors";
import { Pool } from "pg";
import http from "http";
import https from "https";

const app = express();
app.use(cors());
app.use(express.json());

/* --------------- CONFIG --------------- */
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL environment variable not set. Set it to your Neon connection string.");
  process.exit(1);
}
// پیام‌های حذف‌نشده پس از این تعداد روز حذف فیزیکی می‌شوند.
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 180); 
// پیام‌های حذف شده (soft deleted) همیشه باقی می‌مانند.

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

/* --------------- SCHEMA (include group and soft delete) --------------- */
const ensureSchema = async () => {
  const create = `
    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY,
      text TEXT NOT NULL,
      sender TEXT,
      phone TEXT,
      "group" TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      ip TEXT,
      user_agent TEXT,
      -- ستون‌های حذف منطقی (Soft Delete)
      deleted BOOLEAN DEFAULT false,
      deleted_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_group ON messages("group");
    -- اطمینان از وجود ستون‌های soft delete در صورت وجود نداشتن (برای به‌روزرسانی‌های بعدی)
    DO $$ BEGIN ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT false; EXCEPTION WHEN others THEN END $$;
    DO $$ BEGIN ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ; EXCEPTION WHEN others THEN END $$;
  `;
  await pool.query(create);
};

/* --------------- SSE --------------- */
let clients = [];

function broadcastEvent(obj) {
  const payload = `data: ${JSON.stringify(obj)}\n\n`;
  clients.forEach(c => {
    try { c.write(payload); } catch (e) { /* ignore */ }
  });
}

/* --------------- Helpers --------------- */
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'] || req.headers['x-forwarded-for'.toLowerCase()];
  if (forwarded) return forwarded.split(',')[0].trim();
  if (req.ip) return req.ip;
  return null;
}

function httpGetWithTimeout(urlStr, timeoutMs = SELF_PING_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch (err) { return reject(new Error("Invalid URL")); }
    const lib = url.protocol === "https:" ? https : http;
    const options = { method: "GET", timeout: timeoutMs, headers: { "Cache-Control":"no-store", "User-Agent":"self-pinger/1.0" } };
    const req = lib.request(url, options, (res) => {
      res.on("data", () => {});
      res.on("end", () => resolve({ statusCode: res.statusCode }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => reject(err));
    req.end();
  });
}

async function doSelfPingOnce() {
  if (!ENABLE_SELF_PING) return;
  if (!SELF_PING_URL) { console.warn("SELF_PING_URL empty; skipping self-ping."); return; }
  try {
    const r = await httpGetWithTimeout(SELF_PING_URL, SELF_PING_TIMEOUT_MS);
    console.log(`self-ping -> ${SELF_PING_URL} status=${r.statusCode}`);
  } catch (err) {
    console.warn("self-ping error:", err && err.message ? err.message : err);
  }
}
function scheduleNextSelfPing() {
  if (!ENABLE_SELF_PING || !SELF_PING_URL) return;
  const baseMs = SELF_PING_BASE_MINUTES * 60 * 1000;
  const jitter = Math.floor((Math.random() * 2 - 1) * SELF_PING_JITTER_MS);
  const nextMs = Math.max(60 * 1000, baseMs + jitter);
  setTimeout(async () => { await doSelfPingOnce(); scheduleNextSelfPing(); }, nextMs);
}

/* --------------- Endpoints --------------- */
// health/ping
app.get("/ping", (req, res) => {
  res.setHeader("Cache-Control","no-store, no-cache, must-revalidate");
  res.status(200).send("pong ✅ server alive");
});

// fetch messages filtered by group: GET /messages?group=...&limit=1000
app.get("/messages", async (req, res) => {
  try {
    const group = req.query.group || null;
    const limit = Math.min(5000, Math.max(50, Number(req.query.limit || 1000)));
    let q, params;
    
    // 💡 مهم: این بخش پیام‌های حذف شده (deleted = false) را فیلتر می‌کند تا برای کاربران عادی نمایش داده نشوند.
    const baseQuery = `
      SELECT id, text, sender, phone, "group", created_at, ip, user_agent
      FROM messages
      WHERE deleted = false AND created_at >= now() - ($1 || ' days')::interval
      ORDER BY created_at ASC
      LIMIT $2
    `;

    if (group) {
      // برای گروه خاص
      q = `
        SELECT id, text, sender, phone, "group", created_at, ip, user_agent
        FROM messages
        WHERE "group" = $1 AND deleted = false AND created_at >= now() - ($2 || ' days')::interval
        ORDER BY created_at ASC
        LIMIT $3
      `;
      params = [group, RETENTION_DAYS, limit];
    } else {
      // برای همه گروه‌ها (بدون گروه)
      q = `
        SELECT id, text, sender, phone, "group", created_at, ip, user_agent
        FROM messages
        WHERE deleted = false AND created_at >= now() - ($1 || ' days')::interval
        ORDER BY created_at ASC
        LIMIT $2
      `;
      params = [RETENTION_DAYS, limit];
    }
    const r = await pool.query(q, params);
    res.json({ ok: true, rows: r.rows });
  } catch (err) {
    console.error("GET /messages error:", err);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

// SSE endpoint
app.get("/events", (req, res) => {
  res.writeHead(200, { "Content-Type":"text/event-stream", "Cache-Control":"no-cache", Connection:"keep-alive" });
  res.write(":\n\n");
  clients.push(res);
  req.on("close", () => { clients = clients.filter(c => c !== res); });
});

// send message (accepts group)
app.post("/send", async (req, res) => {
  try {
    const text = String(req.body.text || "").trim();
    if (!text) return res.status(400).json({ ok:false, error:"empty text" });
    const sender = req.body.sender ? String(req.body.sender) : "کاربر";
    const group = req.body.group ? String(req.body.group) : null;
    const phone = req.body.phone ? String(req.body.phone) : null;
    const id = (typeof globalThis?.crypto?.randomUUID === "function") ? globalThis.crypto.randomUUID() : require('crypto').randomUUID();
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] || null;

    const insert = `INSERT INTO messages (id, text, sender, phone, "group", ip, user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING created_at`;
    const result = await pool.query(insert, [id, text, sender, phone, group, ip, ua]);

    const msg = { id, text, sender, phone, group, created_at: result.rows[0].created_at, ip, user_agent: ua };

    // broadcast message object (type 'message')
    broadcastEvent({ type: "message", payload: msg });

    res.json({ ok: true, id });
  } catch (err) {
    console.error("POST /send error:", err);
    res.status(500).json({ ok:false, error:"server error" });
  }
});

// delete message by id (soft delete)
app.delete("/messages/:id", async (req, res) => {
  try {
    const id = req.params.id;
    // ⭐️ اصلاح نهایی: فقط فلگ deleted را می‌زنیم. ستون text برای حفظ متن اصلی دست‌نخورده باقی می‌ماند.
    const q = `UPDATE messages SET deleted = true, deleted_at = now() WHERE id = $1`;
    const r = await pool.query(q, [id]);
    if (r.rowCount) {
      // اطلاع‌رسانی به کلاینت‌ها: پیام با این id باید از صفحه چت حذف شود.
      broadcastEvent({ type: "delete", id }); 
      res.json({ ok: true });
    } else {
      res.status(404).json({ ok: false, error: "not found" });
    }
  } catch (err) {
    console.error("DELETE /messages/:id error:", err);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

/* --------------- Background cleanup --------------- */
async function cleanupOldMessages() {
  try {
    // 💡 مهم: فقط پیام‌های "حذف‌نشده" قدیمی‌تر از RETENTION_DAYS حذف فیزیکی می‌شوند. پیام‌های deleted=true باقی می‌مانند.
    const q = `DELETE FROM messages WHERE deleted = false AND created_at < now() - ($1 || ' days')::interval`;
    const r = await pool.query(q, [RETENTION_DAYS]);
    if (r && r.rowCount) console.log(`cleanup: deleted ${r.rowCount} UN-deleted messages older than ${RETENTION_DAYS} days`);
  } catch (err) {
    console.error("cleanupOldMessages error:", err);
  }
}
const DAY_MS = 24 * 60 * 60 * 1000;
setTimeout(() => { setInterval(cleanupOldMessages, DAY_MS); }, 5 * 1000);
cleanupOldMessages().catch(()=>{});

/* --------------- SSE keep-alive --------------- */
setInterval(() => { if (clients.length === 0) return; clients.forEach(c=>{ try{ c.write(":\n\n"); }catch{} }); }, SSE_KEEPALIVE_INTERVAL_MS);

/* --------------- Start --------------- */
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
