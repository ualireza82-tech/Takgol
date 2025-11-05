// server.js — PostgreSQL (Neon) + SSE + persistent messages
import express from "express";
import cors from "cors";
import { Pool } from "pg";
import http from "http";

const app = express();
app.use(cors());
app.use(express.json());

/* ------------------ Configuration ------------------ */
// DATABASE_URL must be provided in environment (Neon connection pooling string)
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERROR: Please set DATABASE_URL environment variable (Neon connection string).");
  process.exit(1);
}

// Retention in days (default 180 days = ~6 months)
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 180);

// Pool configuration — conservative limits to be safe on free plans
const pool = new Pool({
  connectionString: DATABASE_URL,
  // optional tuned params (can be adjusted)
  max: 6,            // max DB connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

/* ------------------ Ensure table exists ------------------ */
const ensureSchema = async () => {
  const create = `
    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY,
      text TEXT NOT NULL,
      sender TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      ip TEXT,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
  `;
  await pool.query(create);
};

/* ------------------ SSE clients ------------------ */
let clients = [];

/* ------------------ Helpers ------------------ */
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  if (req.ip) return req.ip;
  return null;
}

/* ------------------ Endpoints ------------------ */

// simple health/ping (for UptimeRobot)
app.get("/ping", (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.status(200).send("pong ✅ server alive");
});

// fetch recent messages (within retention window). optional ?limit=N
app.get("/messages", async (req, res) => {
  try {
    const limit = Math.min(2000, Math.max(50, Number(req.query.limit || 1000))); // safe boundaries
    const q = `
      SELECT id, text, sender, created_at, ip, user_agent
      FROM messages
      WHERE created_at >= now() - ($1 || ' days')::interval
      ORDER BY created_at ASC
      LIMIT $2
    `;
    const r = await pool.query(q, [RETENTION_DAYS, limit]);
    res.json({ ok: true, rows: r.rows });
  } catch (err) {
    console.error("GET /messages error:", err);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

// SSE endpoint
app.get("/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  // send an initial comment to keep proxies happy
  res.write(":\n\n");

  clients.push(res);
  req.on("close", () => {
    clients = clients.filter(c => c !== res);
  });
});

// receive a new message: save to DB, then broadcast to SSE clients
app.post("/send", async (req, res) => {
  try {
    const payloadText = String(req.body.text || "").trim();
    if (!payloadText) return res.status(400).json({ ok: false, error: "empty text" });

    const sender = req.body.sender ? String(req.body.sender) : "کاربر";
    // generate uuid using crypto if available
    const id = (typeof globalThis?.crypto?.randomUUID === "function")
      ? globalThis.crypto.randomUUID()
      : require('crypto').randomUUID();

    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] || null;

    const insertQuery = `
      INSERT INTO messages (id, text, sender, ip, user_agent)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, created_at
    `;
    const result = await pool.query(insertQuery, [id, payloadText, sender, ip, ua]);

    const msg = {
      id,
      text: payloadText,
      sender,
      created_at: result.rows[0].created_at,
      ip,
      user_agent: ua
    };

    // broadcast to SSE clients (non-blocking)
    for (const client of clients) {
      try {
        client.write(`data: ${JSON.stringify(msg)}\n\n`);
      } catch (e) {
        // ignore write errors; cleanup happens on close
      }
    }

    res.json({ ok: true, id });
  } catch (err) {
    console.error("POST /send error:", err);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

/* ------------------ Background cleanup job ------------------ */
// run once a day to delete messages older than retention window
async function cleanupOldMessages() {
  try {
    const q = `DELETE FROM messages WHERE created_at < now() - ($1 || ' days')::interval`;
    const r = await pool.query(q, [RETENTION_DAYS]);
    if (r && r.rowCount) {
      console.log(`cleanup: deleted ${r.rowCount} old messages older than ${RETENTION_DAYS} days`);
    }
  } catch (err) {
    console.error("cleanupOldMessages error:", err);
  }
}

// schedule daily cleanup at approx every 24h (also run once at startup)
const DAY_MS = 24 * 60 * 60 * 1000;
setTimeout(() => {
  // run daily (avoid exact timer drift)
  setInterval(cleanupOldMessages, DAY_MS);
}, 5 * 1000);
cleanupOldMessages().catch(()=>{});

/* ------------------ SSE keep-alive ------------------ */
const SSE_KEEPALIVE_INTERVAL_MS = 20 * 1000;
setInterval(() => {
  if (clients.length === 0) return;
  clients.forEach((c) => {
    try { c.write(":\n\n"); } catch { /* cleanup on close */ }
  });
}, SSE_KEEPALIVE_INTERVAL_MS);

/* ------------------ Start server & ensure DB ready ------------------ */
const PORT = process.env.PORT || 10000;
(async () => {
  try {
    await ensureSchema();
    app.listen(PORT, () => console.log(`✅ Chat server running on port ${PORT}`));
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
})();