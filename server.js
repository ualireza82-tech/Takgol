// server.js — FINALIZED - PostgreSQL (Neon) + SSE + persistent messages + self-ping + group + soft delete + image support + TOKEN USER AUTH
import express from "express";
import cors from "cors";
import { Pool } from "pg";
import http from "http";
import https from "https";
import crypto from 'crypto';

const app = express();
// افزایش لیمیت برای قبول کردن تصاویر Base64
app.use(express.json({ limit: '20mb' })); 
app.use(cors()); 

/* --------------- CONFIG & DATABASE --------------- */
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

// 🔒 توکن امنیتی بسیار ساده (برای محیط‌های آزمایشی/ساده)
// در محیط واقعی، باید از JWT استفاده شود.
const DUMMY_SECRET_KEY = process.env.DUMMY_SECRET_KEY || "SuperSafeAndSecretKey";


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
      sender TEXT, -- نام نمایش
      phone TEXT, -- ID اصلی کاربر (برای JOIN با users)
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
    
    CREATE TABLE IF NOT EXISTS users (
      phone TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      first_name TEXT NOT NULL,
      last_name TEXT,
      avatar_base64 TEXT,
      registered_at TIMESTAMPTZ DEFAULT now()
    );

    -- اطمینان از وجود ستون‌ها
    DO $$ BEGIN ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT false; EXCEPTION WHEN others THEN END $$;
    DO $$ BEGIN ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ; EXCEPTION WHEN others THEN END $$;
    DO $$ BEGIN ALTER TABLE messages ADD COLUMN IF NOT EXISTS image TEXT; EXCEPTION WHEN others THEN END $$;
  `;
  await pool.query(create);
};

/* --------------- SSE CLIENT MANAGEMENT --------------- */
/** * @typedef {Object} SSEClient
 * @property {import('express').Response} res
 * @property {string} id - ID منحصر به فرد کلاینت
 * @property {number} lastActive - Timestamp آخرین فعالیت
 */

/** @type {SSEClient[]} */
let clients = [];

/**
 * پاکسازی دوره‌ای کلاینت‌های غیرفعال (برای جلوگیری از نشت حافظه)
 */
function cleanupDeadClients() {
    const beforeCount = clients.length;
    clients = clients.filter(c => {
        // اگر response بسته شده باشد، آن را حذف می‌کنیم
        if (c.res.finished) {
            return false;
        }
        // اگر بیشتر از 30 دقیقه غیرفعال بوده، آن را حذف می‌کنیم (احتیاطی)
        if (Date.now() - c.lastActive > 30 * 60 * 1000) {
            try { c.res.end(); } catch {}
            return false;
        }
        return true;
    });
    // اگر تغییر بزرگی در تعداد بود، لاگ می‌گیریم
    if (beforeCount !== clients.length && beforeCount > 0) {
        console.log(`SSE Cleanup: ${beforeCount - clients.length} dead clients removed. Remaining: ${clients.length}`);
    }
}
// هر ۵ دقیقه یک بار پاکسازی
setInterval(cleanupDeadClients, 5 * 60 * 1000);


function broadcastEvent(obj) {
  const payload = `data: ${JSON.stringify(obj)}\n\n`;
  clients.forEach(c => {
    try { 
        c.res.write(payload); 
        c.lastActive = Date.now(); // به‌روزرسانی زمان فعالیت
    } catch (e) { 
        // در صورت خطا (مثلاً قطع شدن اتصال)، کلاینت در دور بعدی cleanup حذف می‌شود 
        // یا در هنگام `req.on("close")` بلافاصله حذف می‌شود.
    }
  });
}

/* --------------- AUTH/TOKEN Helpers (Simple HMAC-like for this demo) --------------- */
/**
 * @param {string} phone
 * @returns {string} token
 */
function generateAuthToken(phone) {
    const timestamp = Date.now();
    // 🔒 استفاده از HMAC ساده برای تولید توکن قابل تأیید
    const signature = crypto.createHmac('sha256', DUMMY_SECRET_KEY)
                            .update(`${phone}:${timestamp}`)
                            .digest('hex');
    return `${phone}.${timestamp}.${signature}`;
}

/**
 * @param {string} token
 * @returns {string | null} phone
 */
function verifyAuthToken(token) {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [phone, timestamp, signature] = parts;
    
    // تأیید امضا
    const expectedSignature = crypto.createHmac('sha256', DUMMY_SECRET_KEY)
                                    .update(`${phone}:${timestamp}`)
                                    .digest('hex');
    
    // جلوگیری از حمله زمانی با استفاده از `timingSafeEqual`
    const isSignatureValid = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
    
    if (!isSignatureValid) return null;

    // تأیید انقضا (مثلاً توکن بعد از 1 ماه منقضی شود - 30 روز)
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - Number(timestamp) > thirtyDaysMs) return null;

    return phone;
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

// fetch messages filtered by group
app.get("/messages", async (req, res) => {
  try {
    const group = req.query.group || null;
    const limit = Math.min(5000, Math.max(50, Number(req.query.limit || 1000)));

    const baseQuery = `
        SELECT 
            m.id, 
            m.text, 
            m.image AS image_data,
            COALESCE(u.first_name || ' ' || u.last_name, m.sender, 'کاربر') AS sender_name, 
            m.phone AS sender_phone_id, -- 🚨 اصلاح: فیلد phone پیام را مستقیماً بگیرید 
            u.avatar_base64 AS avatar,
            m.created_at
        FROM messages m
        LEFT JOIN users u ON m.phone = u.phone
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
        // 🚨 حیاتی برای فرانت‌اند: ID فرستنده (شماره موبایل) برای مقایسه پیام خودی
        sender_phone_id: row.sender_phone_id || null, 
        avatar: row.avatar || null,
        image: row.image_data || null,
        created_at: row.created_at,
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
  
  const client = { res, id: crypto.randomUUID(), lastActive: Date.now() };
  clients.push(client);
  
  req.on("close", () => { 
    clients = clients.filter(c => c !== client); 
    // console.log(`Client disconnected. Total: ${clients.length}`); 
  });
});

app.post("/auth/login-or-register", async (req, res) => {
  try {
    const { phone, password, firstName, lastName, avatarBase64 } = req.body;
    if (!phone || !password) return res.status(400).json({ ok: false, error: "شماره موبایل و رمز عبور الزامی است." });

    const existingUserQuery = 'SELECT phone, password, first_name, last_name, avatar_base64 FROM users WHERE phone = $1';
    const existingUser = await pool.query(existingUserQuery, [phone]);

    if (existingUser.rowCount > 0) {
      const user = existingUser.rows[0];
      if (user.password !== password) return res.status(401).json({ ok: false, error: "رمز عبور اشتباه است." });

      // 🔑 تولید توکن امن‌تر
      const token = generateAuthToken(user.phone); 
      return res.json({ 
        ok: true, 
        action: "login",
        message: "ورود موفق",
        user: { 
          phone: user.phone, 
          name: `${user.first_name || ''} ${user.last_name || ''}`.trim() || user.phone, 
          avatarBase64: user.avatar_base64 
        },
        token: token
      });

    } else {
      if (!firstName || !avatarBase64) return res.status(400).json({ ok: false, error: "برای ثبت نام، نام و عکس پروفایل الزامی است." });

      const insertQuery = `
        INSERT INTO users (phone, password, first_name, last_name, avatar_base64)
        VALUES ($1, $2, $3, $4, $5)
      `;
      await pool.query(insertQuery, [phone, password, firstName, lastName || null, avatarBase64]);

      // 🔑 تولید توکن امن‌تر
      const token = generateAuthToken(phone); 
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


app.post("/send", async (req, res) => {
  try {
    // 🚨 مرحله ۱: احراز هویت با توکن
    const token = req.headers['authorization']?.split(' ')[1] || req.body.token; // توکن را از هدر یا بادی می‌خواند
    const senderPhoneId = verifyAuthToken(token);

    if (!senderPhoneId) {
        return res.status(401).json({ ok: false, error: "توکن احراز هویت نامعتبر یا منقضی شده است." });
    }
    
    // 🚨 مرحله ۲: دریافت داده‌های پیام
    const text = String(req.body.text || "").trim();
    const group = req.body.group ? String(req.body.group) : null;
    let messageImageBase64 = req.body.image ? String(req.body.image) : null;
    
    // 🚨 مرحله ۳: بررسی محتوا و اندازه (کنترل تصویر)
    if (!text && !messageImageBase64) return res.status(400).json({ ok:false, error:"متن و تصویر خالی است." });
    
    // اگر تصویر بود، مطمئن می‌شویم از یک حجم معقول بزرگتر نیست (مثلاً < 5MB)
    if (messageImageBase64 && messageImageBase64.length > 5 * 1024 * 1024 * (4/3)) {
        // base64 حدود 33% بزرگتر از داده اصلی است
        console.warn("Received large image: ", messageImageBase64.length);
        messageImageBase64 = "TooLarge"; // یا آن را null کنید و پیام خطا دهید
    }

    // 🚨 مرحله ۴: واکشی مشخصات کامل کاربر از دیتابیس
    let senderName = "کاربر";
    let userAvatarBase64 = null;
    const userResult = await pool.query('SELECT first_name, last_name, avatar_base64 FROM users WHERE phone = $1', [senderPhoneId]);
    if (userResult.rowCount > 0) {
        const user = userResult.rows[0];
        senderName = `${user.first_name || ''} ${user.last_name || ''}`.trim() || senderPhoneId;
        userAvatarBase64 = user.avatar_base64 || null;
    } else {
        // این حالت نباید رخ دهد اگر توکن معتبر باشد، اما به عنوان یک مورد اضطراری
        console.warn(`User with phone ${senderPhoneId} verified by token but not found in DB.`);
    }


    // 🚨 مرحله ۵: ثبت پیام در دیتابیس
    const id = (typeof globalThis?.crypto?.randomUUID === "function") ? globalThis.crypto.randomUUID() : crypto.randomUUID();
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] || null;

    const insert = `
      INSERT INTO messages (id, text, sender, phone, "group", ip, user_agent, image)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING created_at
    `;
    const result = await pool.query(insert, [id, text || "", senderName, senderPhoneId, group, ip, ua, messageImageBase64]);

    // 🚨 مرحله ۶: Broadcast به کلاینت‌ها
    const msg = { 
      id, 
      text, 
      sender: senderName, 
      sender_phone_id: senderPhoneId, // 🚨 حیاتی برای فرانت‌اند: ID فرستنده
      avatar: userAvatarBase64 || null,
      image: messageImageBase64 || null,
      created_at: result.rows[0].created_at
    };

    broadcastEvent({ type: "message", payload: msg });

    res.json({ ok: true, id, message: "پیام ارسال و Broadcast شد." });
  } catch (err) {
    console.error("POST /send error:", err);
    res.status(500).json({ ok:false, error:"خطای سرور هنگام ارسال پیام" });
  }
});

app.delete("/messages/:id", async (req, res) => {
    try {
        // 🚨 مرحله ۱: احراز هویت ادمین/مالک پیام (فعلاً فقط احراز هویت توکن)
        const token = req.headers['authorization']?.split(' ')[1] || req.body.token; 
        const senderPhoneId = verifyAuthToken(token);

        if (!senderPhoneId) {
            return res.status(401).json({ ok: false, error: "توکن احراز هویت نامعتبر یا منقضی شده است." });
        }
        
        const id = req.params.id;
        
        // 🚨 افزودن شرط: پیام فقط توسط مالک آن یا ادمین (در این مثال مالک) قابل حذف است
        // برای افزودن منطق ادمین، نیاز به جدول یا فیلد نقش کاربری (role) است.
        const q = `UPDATE messages SET deleted = true, deleted_at = now() WHERE id = $1 AND phone = $2 RETURNING id`;
        const r = await pool.query(q, [id, senderPhoneId]);
        
        if (r.rowCount) {
            broadcastEvent({ type: "delete", id }); 
            res.json({ ok: true, message: "پیام با موفقیت حذف (Soft Delete) شد." });
        } else {
            res.status(403).json({ ok: false, error: "پیام یافت نشد یا شما اجازه حذف آن را ندارید." });
        }
    } catch (err) {
        console.error("DELETE /messages/:id error:", err);
        res.status(500).json({ ok: false, error: "خطای سرور" });
    }
});

/* --------------- Background cleanup --------------- */
async function cleanupOldMessages() {
  try {
    // پاک کردن پیام‌های غیرحذف شده‌ای که تاریخ انقضایشان گذشته است
    const q = `DELETE FROM messages WHERE deleted = false AND created_at < now() - ($1 || ' days')::interval`;
    const r = await pool.query(q, [RETENTION_DAYS]);
    if (r && r.rowCount) console.log(`cleanup: deleted ${r.rowCount} UN-deleted messages older than ${RETENTION_DAYS} days`);
    
    // حذف پیام‌های حذف شده (Soft Delete) پس از ۶۰ روز (یا هر دوره دلخواه)
    const qDeleted = `DELETE FROM messages WHERE deleted = true AND deleted_at < now() - ('60 days')::interval`;
    const rDeleted = await pool.query(qDeleted);
    if (rDeleted && rDeleted.rowCount) console.log(`cleanup: permanently deleted ${rDeleted.rowCount} SOFT-deleted messages older than 60 days`);

  } catch (err) {
    console.error("cleanupOldMessages error:", err);
  }
}
const DAY_MS = 24 * 60 * 60 * 1000;
setTimeout(() => { setInterval(cleanupOldMessages, DAY_MS); }, 5 * 1000);
cleanupOldMessages().catch(()=>{});

/* --------------- SSE keep-alive --------------- */
setInterval(() => { 
    if (clients.length === 0) return; 
    // ارسال کامنت خالی (:) برای جلوگیری از بسته شدن اتصال توسط پروکسی/لودبالانسر
    clients.forEach(c=>{ 
        try{ c.res.write(":\n\n"); c.lastActive = Date.now(); }catch{ /* ignore closed connections */ } 
    }); 
}, SSE_KEEPALIVE_INTERVAL_MS);


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
