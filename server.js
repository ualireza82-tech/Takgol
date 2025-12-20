// server.js — PostgreSQL (Neon) + SSE + persistent messages + self-ping + group + soft delete + image support + USER AUTH (Email Refactor)
import express from "express";
import cors from "cors";
import { Pool } from "pg";
import http from "http";
import https from "https";

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); 

/* --------------- CONFIG --------------- */
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL environment variable not set. Set it to your Neon connection string.");
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

/* --------------- SCHEMA (Email Refactor applied + Reply System) --------------- */
const ensureSchema = async () => {
  const create = `
    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY,
      text TEXT NOT NULL,
      sender TEXT,
      phone TEXT,
      email TEXT,
      "group" TEXT,
      reply_text TEXT, /* 💡 جدید: ذخیره متن ریپلای */
      created_at TIMESTAMPTZ DEFAULT now(),
      ip TEXT,
      user_agent TEXT,
      deleted BOOLEAN DEFAULT false,
      deleted_at TIMESTAMPTZ,
      image TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_group ON messages("group");
    
    CREATE TABLE IF NOT EXISTS users (
      phone TEXT,
      email TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      first_name TEXT NOT NULL,
      last_name TEXT,
      avatar_base64 TEXT,
      registered_at TIMESTAMPTZ DEFAULT now()
    );

    /* Safe Migrations for existing columns */
    DO $$ BEGIN ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT false; EXCEPTION WHEN others THEN END $$;
    DO $$ BEGIN ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ; EXCEPTION WHEN others THEN END $$;
    DO $$ BEGIN ALTER TABLE messages ADD COLUMN IF NOT EXISTS image TEXT; EXCEPTION WHEN others THEN END $$;
    DO $$ BEGIN ALTER TABLE messages ADD COLUMN IF NOT EXISTS email TEXT; EXCEPTION WHEN others THEN END $$;
    DO $$ BEGIN ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_text TEXT; EXCEPTION WHEN others THEN END $$; /* 💡 جدید: اطمینان از وجود ستون ریپلای */
    
    DO $$ 
    BEGIN 
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='email') THEN
            ALTER TABLE users RENAME phone TO phone_old;
            ALTER TABLE users ADD COLUMN email TEXT PRIMARY KEY;
            ALTER TABLE users ADD COLUMN phone TEXT;
        ELSE
            ALTER TABLE users DROP CONSTRAINT IF EXISTS users_pkey; 
            ALTER TABLE users ADD PRIMARY KEY (email);
        END IF;
    EXCEPTION WHEN others THEN END $$;
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
app.get("/ping", (req, res) => {
  res.setHeader("Cache-Control","no-store, no-cache, must-revalidate");
  res.status(200).send("pong ✅ server alive");
});

app.get("/messages", async (req, res) => {
  try {
    const group = req.query.group || null;
    const limit = Math.min(5000, Math.max(50, Number(req.query.limit || 1000)));

    const baseQuery = `
        SELECT 
            m.id, 
            m.text, 
            m.image AS image_data,
            m.reply_text, /* 💡 جدید: بازگرداندن متن ریپلای */
            COALESCE(
              NULLIF(TRIM(u.first_name || ' ' || COALESCE(u.last_name,'')), ''),
              NULLIF(TRIM(m.sender), ''), 
              m.email, 
              m.phone,
              'کاربر'
            ) AS sender_name,
            COALESCE(m.email, m.phone) AS sender_identity_id,
            u.avatar_base64 AS avatar,
            m.created_at
        FROM messages m
        LEFT JOIN users u 
          ON (m.email IS NOT NULL AND m.email = u.email)
          OR (m.email IS NULL AND m.phone IS NOT NULL AND m.phone = u.phone)
        WHERE m.deleted = false AND m.created_at >= now() - ($1 || ' days')::interval
    `;
    
    let q, params;
    if (group) {
      q = baseQuery + ` AND m."group" = $2 ORDER BY m.created_at ASC LIMIT $3`;
      params = [RETENTION_DAYS, group, limit];
    } else {
      q = baseQuery + ` ORDER BY m.created_at ASC LIMIT $2`;
      params = [RETENTION_DAYS, limit];
    }

    const r = await pool.query(q, params);
    
    const rows = r.rows.map(row => ({
        id: row.id,
        text: row.text,
        sender: (row.sender_name || "کاربر").trim(),
        sender_identity_id: row.sender_identity_id || null,
        avatar: row.avatar || null,
        image: row.image_data || null,
        reply_text: row.reply_text || null, /* 💡 جدید */
        created_at: row.created_at,
    }));
    
    res.json({ ok: true, rows: rows });
  } catch (err) {
    console.error("GET /messages error:", err);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

app.get("/events", (req, res) => {
  res.writeHead(200, { "Content-Type":"text/event-stream", "Cache-Control":"no-cache", Connection:"keep-alive" });
  res.write(":\n\n");
  clients.push(res);
  req.on("close", () => { clients = clients.filter(c => c !== res); });
});

app.post("/auth/login-or-register", async (req, res) => {
  try {
    const { email, password, firstName, lastName, avatarBase64 } = req.body;
    if (!email || !password) return res.status(400).json({ ok: false, error: "ایمیل و رمز عبور الزامی است." });

    const existingUserQuery = 'SELECT email, password, first_name, last_name, avatar_base64 FROM users WHERE email = $1';
    const existingUser = await pool.query(existingUserQuery, [email]);

    if (existingUser.rowCount > 0) {
      const user = existingUser.rows[0];
      if (user.password !== password) return res.status(401).json({ ok: false, error: "رمز عبور اشتباه است." });
      const token = `AUTH_TOKEN_${user.email}_${Date.now()}`; 
      return res.json({ 
        ok: true, 
        action: "login",
        message: "ورود موفق",
        user: { 
          identity: user.email, 
          name: `${user.first_name || ''} ${user.last_name || ''}`.trim() || user.email, 
          avatarBase64: user.avatar_base64 
        },
        token: token
      });
    } else {
      if (!firstName || !avatarBase64) return res.status(400).json({ ok: false, error: "برای ثبت نام، نام و عکس پروفایل الزامی است." });
      const insertQuery = `INSERT INTO users (email, password, first_name, last_name, avatar_base64) VALUES ($1, $2, $3, $4, $5)`;
      await pool.query(insertQuery, [email, password, firstName, lastName || null, avatarBase64]);
      const token = `AUTH_TOKEN_${email}_${Date.now()}`; 
      return res.json({ 
        ok: true, 
        action: "register",
        message: "ثبت نام موفق و ورود",
        user: { identity: email, name: `${firstName} ${lastName || ''}`.trim(), avatarBase64: avatarBase64 },
        token: token
      });
    }
  } catch (err) {
    console.error("POST /auth/login-or-register error:", err);
    res.status(500).json({ ok: false, error: "خطای سرور" });
  }
});

app.post("/send", async (req, res) => {
  try {
    const text = String(req.body.text || "").trim();
    const email = req.body.email ? String(req.body.email) : null; 
    const group = req.body.group ? String(req.body.group) : null;
    const reply_text = req.body.reply_text ? String(req.body.reply_text) : null; /* 💡 جدید */
    let messageImageBase64 = req.body.image ? String(req.body.image) : null;
    
    let senderName = null; 
    let userAvatarBase64 = null;

    if (email) {
      const userResult = await pool.query('SELECT first_name, last_name, avatar_base64 FROM users WHERE email = $1', [email]);
      if (userResult.rowCount > 0) {
        const user = userResult.rows[0];
        const fullName = `${user.first_name || ''} ${user.last_name || ''}`.trim();
        senderName = fullName || email; 
        userAvatarBase64 = user.avatar_base64 || null;
      } else {
        senderName = email; 
      }
    }
    if (!senderName) senderName = "کاربر";

    if (!text && !messageImageBase64) return res.status(400).json({ ok:false, error:"empty text and image" });

    const id = (typeof globalThis?.crypto?.randomUUID === "function") ? globalThis.crypto.randomUUID() : require('crypto').randomUUID();
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] || null;

    const insert = `
      INSERT INTO messages (id, text, sender, phone, email, "group", ip, user_agent, image, reply_text)
      VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9) RETURNING created_at
    `;
    const result = await pool.query(insert, [id, text || "", senderName, email, group, ip, ua, messageImageBase64, reply_text]);

    const msg = { 
      id, 
      text, 
      sender: senderName, 
      sender_identity_id: email, 
      avatar: userAvatarBase64 || null,
      image: messageImageBase64 || null,
      reply_text: reply_text, /* 💡 جدید */
      created_at: result.rows[0].created_at
    };

    broadcastEvent({ type: "message", payload: msg });
    res.json({ ok: true, id });
  } catch (err) {
    console.error("POST /send error:", err);
    res.status(500).json({ ok:false, error:"server error" });
  }
});

/* 💡 تغییر آدرس حذف برای هماهنگی با فرانت‌اند شما */
app.delete("/delete/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const q = `UPDATE messages SET deleted = true, deleted_at = now() WHERE id = $1`;
    const r = await pool.query(q, [id]);
    if (r.rowCount > 0) {
      broadcastEvent({ type: "delete", id }); 
      res.json({ ok: true });
    } else {
      res.status(404).json({ ok: false, error: "not found" });
    }
  } catch (err) {
    console.error("DELETE error:", err);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

/* برای سازگاری با کدهای قدیمی، آدرس قبلی را هم نگه می‌داریم */
app.delete("/messages/:id", async (req, res) => {
  res.redirect(307, `/delete/${req.params.id}`);
});

async function cleanupOldMessages() {
  try {
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

setInterval(() => { if (clients.length === 0) return; clients.forEach(c=>{ try{ c.write(":\n\n"); }catch{} }); }, SSE_KEEPALIVE_INTERVAL_MS);

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
