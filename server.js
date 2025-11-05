// server.js — نسخهٔ مقاوم با self-ping کم‌تهاجمی
import express from "express";
import cors from "cors";
import { URL } from "url";
import http from "http";
import https from "https";

const app = express();
app.use(cors());
app.use(express.json());

let clients = [];

// --------- CONFIG ----------
const PORT = process.env.PORT || 10000;

// Self-ping configuration (برای اطمینان: در کنار UptimeRobot استفاده شود)
const ENABLE_SELF_PING = String(process.env.ENABLE_SELF_PING || "true").toLowerCase() === "true";
// آدرس کاملِ ping خودت، مثال: https://chatroom-dfjp.onrender.com/ping
const SELF_PING_URL = process.env.SELF_PING_URL || "https://chatroom-dfjp.onrender.com/ping";
// پایهٔ اینتروال: 14 دقیقه
const SELF_PING_BASE_MINUTES = 14;
// جیتِر (±30 ثانیه) برای جلوگیری از الگوی صددرصد منظم
const SELF_PING_JITTER_MS = 30 * 1000;
// تایم‌اوت درخواست self-ping
const SELF_PING_TIMEOUT_MS = 10 * 1000;
// SSE keep-alive (comment) interval
const SSE_KEEPALIVE_INTERVAL_MS = 20 * 1000;
// ---------------------------

// ساده و سبک: endpoint مخصوص مانیتور/پینگ
app.get("/ping", (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.status(200).send("pong ✅ server is alive");
});

// SSE endpoint
app.get("/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // ارسال یک comment اولیه برای نگه داشتن کانکشن
  res.write(":\n\n");

  clients.push(res);
  req.on("close", () => {
    clients = clients.filter(c => c !== res);
  });
});

// ارسال پیام
app.post("/send", (req, res) => {
  const msg = {
    text: req.body.text,
    sender: req.body.sender || "کاربر",
    time: Date.now(),
  };
  for (const client of clients) {
    try {
      client.write(`data: ${JSON.stringify(msg)}\n\n`);
    } catch (e) {
      // نادیده بگیر؛ cleanup در close handler انجام می‌شود
    }
  }
  res.json({ ok: true });
});

// SSE keep-alive (ارسال comment هر 20s برای جلوگیری از بسته شدن توسط پروکسی‌ها)
setInterval(() => {
  if (clients.length === 0) return;
  clients.forEach((c) => {
    try {
      c.write(":\n\n");
    } catch (e) {
      clients = clients.filter(x => x !== c);
    }
  });
}, SSE_KEEPALIVE_INTERVAL_MS);

// ---------- Self-ping implementation (native http/https, مقاوم) ----------
function httpGetWithTimeout(urlStr, timeoutMs = SELF_PING_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (err) {
      return reject(new Error("Invalid URL"));
    }

    const lib = url.protocol === "https:" ? https : http;
    const options = {
      method: "GET",
      timeout: timeoutMs,
      headers: {
        "Cache-Control": "no-store, no-cache",
        "User-Agent": "self-pinger/1.0 (+https://chatroom)",
      },
    };

    const req = lib.request(url, options, (res) => {
      // consume and ignore body to free socket
      res.on("data", () => {});
      res.on("end", () => resolve({ statusCode: res.statusCode }));
    });

    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });

    req.on("error", (err) => {
      reject(err);
    });

    req.end();
  });
}

async function doSelfPingOnce() {
  if (!ENABLE_SELF_PING) return;
  if (!SELF_PING_URL) {
    console.warn("SELF_PING_URL is empty; skipping self-ping.");
    return;
  }
  try {
    const r = await httpGetWithTimeout(SELF_PING_URL, SELF_PING_TIMEOUT_MS);
    console.log(`self-ping -> ${SELF_PING_URL} status=${r.statusCode}`);
  } catch (err) {
    console.warn("self-ping error:", (err && err.message) ? err.message : err);
  }
}

function scheduleNextSelfPing() {
  if (!ENABLE_SELF_PING || !SELF_PING_URL) return;
  // base interval in ms
  const baseMs = SELF_PING_BASE_MINUTES * 60 * 1000;
  // random jitter in range [-JITTER, +JITTER]
  const jitter = Math.floor((Math.random() * 2 - 1) * SELF_PING_JITTER_MS);
  const nextMs = Math.max(60 * 1000, baseMs + jitter); // حداقل 1 دقیقه محافظه‌کارانه
  setTimeout(async () => {
    await doSelfPingOnce();
    scheduleNextSelfPing();
  }, nextMs);
}

// start self-ping loop (اجرای فوری یک بار، سپس زمان‌بندی)
if (ENABLE_SELF_PING && SELF_PING_URL) {
  // اجرای فوری برای اطمینان
  (async () => {
    await doSelfPingOnce();
    scheduleNextSelfPing();
  })();
} else {
  console.log("Self-ping is disabled. To enable set ENABLE_SELF_PING=true and SELF_PING_URL.");
}

// ---------- Start server ----------
app.listen(PORT, () => console.log(`✅ Chat server running on port ${PORT}`));