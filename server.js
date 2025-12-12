// server.js — PostgreSQL (Neon) + SSE + persistent messages + self-ping + group + soft delete + image support + USER AUTH
import express from "express";
import cors from "cors";
import { Pool } from "pg";
import http from "http";
import https from "https";
// اگر از Node 16 یا قدیمی‌تر استفاده می‌کنید، نیاز به import uuid دارید:
// import { randomUUID } from 'crypto'; 

const app = express();
app.use(cors());
// افزایش محدودیت برای عکس Base64 (مویرگی)
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

/* --------------- SCHEMA (include group, soft delete, image, and USERS) --------------- */
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
      deleted BOOLEAN DEFAULT false,
      deleted_at TIMESTAMPTZ,
      image TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_group ON messages("group");
    
    -- نقطه زنی: جدول کاربران برای ثبت نام و ورود
    CREATE TABLE IF NOT EXISTS users (
      phone TEXT PRIMARY KEY,
      password TEXT NOT NULL, -- در برنامه واقعی باید هش شود (hashed)
      first_name TEXT NOT NULL,
      last_name TEXT,
      avatar_base64 TEXT, -- ذخیره عکس پروفایل به صورت Base64
      registered_at TIMESTAMPTZ DEFAULT now()
    );

    DO $$ BEGIN ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT false; EXCEPTION WHEN others THEN END $$;
    DO $$ BEGIN ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ; EXCEPTION WHEN others THEN END $$;
    DO $$ BEGIN ALTER TABLE messages ADD COLUMN IF NOT EXISTS image TEXT; EXCEPTION WHEN others THEN END $$;
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

// fetch messages filtered by group
// 🎯 تغییر مویرگی: استفاده از JOIN برای واکشی نام و آواتار فرستنده از جدول users
app.get("/messages", async (req, res) => {
  try {
    const group = req.query.group || null;
    const limit = Math.min(5000, Math.max(50, Number(req.query.limit || 1000)));
    let q, params;

    const baseQuery = `
        SELECT 
            m.id, 
            m.text, 
            -- ✅ برای نمایش نام فرستنده در فرانت‌اند
            COALESCE(u.first_name || ' ' || u.last_name, m.sender, 'کاربر') AS sender_name, 
            m.phone, 
            m."group", 
            m.created_at, 
            m.ip, 
            m.user_agent, 
            -- ✅ اگر پیام عکس اختصاصی نداشت، از آواتار پروفایل کاربر استفاده کن 
            COALESCE(m.image, u.avatar_base64) AS image_data,
            -- ✅ افزودن phone فرستنده (Sender ID) برای تشخیص پیام ارسالی/دریافتی در فرانت‌اند
            u.phone AS sender_phone_id 
        FROM messages m
        LEFT JOIN users u ON m.phone = u.phone
        WHERE m.deleted = false AND m.created_at >= now() - ($1 || ' days')::interval
        -- شرط group در صورت وجود
    `;
    
    if (group) {
      q = baseQuery.replace('-- شرط group در صورت وجود', 'AND m."group" = $2');
      q += ` ORDER BY m.created_at ASC LIMIT $3`;
      params = [RETENTION_DAYS, group, limit];
    } else {
      q = baseQuery.replace('-- شرط group در صورت وجود', '');
      q += ` ORDER BY m.created_at ASC LIMIT $2`;
      params = [RETENTION_DAYS, limit];
    }
    
    const r = await pool.query(q, params);
    
    // 🎯 تنظیم نام فیلدهای خروجی برای شفافیت در فرانت‌اند:
    const rows = r.rows.map(row => ({
        id: row.id,
        text: row.text,
        sender: row.sender_name.trim() || "کاربر", // نام تمیز شده
        phone: row.phone, // phone ذخیره شده در جدول messages
        group: row.group,
        created_at: row.created_at,
        image: row.image_data, // عکس یا آواتار پروفایل
        sender_phone_id: row.sender_phone_id || row.phone, // کلید برای فرانت‌اند
        // فیلدهای ip و user_agent را برای حفظ امنیت در خروجی حذف کردم اما در دیتابیس باقی می‌مانند
    }));
    
    res.json({ ok: true, rows: rows });
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


// 🎯 نقطه زنی: Endpoint جدید برای ثبت نام یا ورود
app.post("/auth/login-or-register", async (req, res) => {
  try {
    const { phone, password, firstName, lastName, avatarBase64 } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ ok: false, error: "شماره موبایل و رمز عبور الزامی است." });
    }

    const existingUserQuery = 'SELECT phone, password, first_name, avatar_base64 FROM users WHERE phone = $1';
    const existingUser = await pool.query(existingUserQuery, [phone]);

    if (existingUser.rowCount > 0) {
      // --- سناریوی ورود (Login) ---
      const user = existingUser.rows[0];
      if (user.password !== password) {
        return res.status(401).json({ ok: false, error: "رمز عبور اشتباه است." });
      }

      const token = `AUTH_TOKEN_${user.phone}_${Date.now()}`; 
      return res.json({ 
        ok: true, 
        action: "login",
        message: "ورود موفق",
        user: { 
          phone: user.phone, 
          // 🎯 تغییر مویرگی: اطمینان از ارسال نام کامل یا حداقل نام اول
          name: `${user.first_name || ''} ${user.last_name || ''}`.trim() || user.phone, 
          avatarBase64: user.avatar_base64 
        },
        token: token
      });

    } else {
      // --- سناریوی ثبت نام (Register) ---
      // 🎯 تغییر مویرگی: اگر avatarBase64 خالی بود، خطای 400 را برگردان.
      if (!firstName || !avatarBase64) { 
        return res.status(400).json({ ok: false, error: "برای ثبت نام، نام و عکس پروفایل الزامی است." });
      }

      const insertQuery = `
        INSERT INTO users (phone, password, first_name, last_name, avatar_base64)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING registered_at;
      `;
      await pool.query(insertQuery, [
        phone,
        password,
        firstName,
        lastName || null,
        avatarBase64, // اکنون تضمین شده است که مقدار دارد
      ]);

      const token = `AUTH_TOKEN_${phone}_${Date.now()}`; 
      return res.json({ 
        ok: true, 
        action: "register",
        message: "ثبت نام موفق و ورود",
        user: { 
          phone: phone, 
          name: `${firstName} ${lastName || ''}`.trim(), 
          avatarBase64: avatarBase64 
        },
        token: token
      });
    }

  } catch (err) {
    console.error("POST /auth/login-or-register error:", err);
    res.status(500).json({ ok: false, error: "خطای سرور" });
  }
});


// send message (text or/and image)
// 🎯 تغییر مویرگی: اصلاح منطق محاسبه نام فرستنده
app.post("/send", async (req, res) => {
  try {
    const text = String(req.body.text || "").trim();
    const phone = req.body.phone ? String(req.body.phone) : null; 
    const group = req.body.group ? String(req.body.group) : null;
    
    // 1. واکشی اطلاعات فرستنده از دیتابیس
    let senderName = "کاربر";
    let messageImageBase64 = req.body.image ? String(req.body.image) : null; // عکس ارسالی در پیام
    
    let userAvatarBase64 = null; // برای استفاده احتمالی در پیام

    if (phone) {
      const userResult = await pool.query('SELECT first_name, last_name, avatar_base64 FROM users WHERE phone = $1', [phone]);
      if (userResult.rowCount > 0) {
        const user = userResult.rows[0];
        
        // ✅ تغییر مویرگی: ساخت نام کامل و استفاده از "کاربر" تنها در صورت خالی بودن
        const fullName = `${user.first_name || ''} ${user.last_name || ''}`.trim();
        senderName = fullName.length > 0 ? fullName : "کاربر";
        
        userAvatarBase64 = user.avatar_base64;
        
        // ⚠️ اگر در پیام، عکسی ارسال نشده باشد، می‌توان از آواتار پروفایل کاربر به عنوان محتوای image پیام استفاده کرد:
        if (!messageImageBase64 && user.avatar_base64) {
          messageImageBase64 = user.avatar_base64;
        }
      }
    }

    if (!text && !messageImageBase64) return res.status(400).json({ ok:false, error:"empty text and image" });

    const id = (typeof globalThis?.crypto?.randomUUID === "function") ? globalThis.crypto.randomUUID() : require('crypto').randomUUID();
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] || null;

    const insert = `
      INSERT INTO messages (id, text, sender, phone, "group", ip, user_agent, image)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING created_at
    `;
    const result = await pool.query(insert, [id, text || "", senderName, phone, group, ip, ua, messageImageBase64]);

    // 🎯 تضمین ارسال فیلد phone (شناسه فرستنده) برای تشخیص در فرانت‌اند
    const msg = { 
      id, 
      text, 
      sender: senderName, 
      phone: phone, // ✅ شناسه فرستنده برای فرانت‌اند
      group, 
      created_at: result.rows[0].created_at, 
      ip, 
      user_agent: ua, 
      image: messageImageBase64 
    };

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
    const q = `UPDATE messages SET deleted = true, deleted_at = now() WHERE id = $1`;
    const r = await pool.query(q, [id]);
    if (r.rowCount) {
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
