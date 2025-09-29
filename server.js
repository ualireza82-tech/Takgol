import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 8080;

// لینک اصلی HLS (با توکن فعلی)
const UPSTREAM_URL = "https://beautifulpeople.lovecdn.ru/SkySportsFootballUK/index.fmp4.m3u8?token=77cc516050374957245bde948321361408116b25-cd570984779630e8ebdb9fed59ec93fd-1759192037-1759181237";

// پروکسی playlist (index.m3u8)
app.get("/playlist.m3u8", async (req, res) => {
  try {
    const r = await fetch(UPSTREAM_URL);
    if (!r.ok) throw new Error(`Upstream error: ${r.status}`);
    const body = await r.text();

    // بازنویسی لینک‌ها تا از پراکسی رد بشن
    const proxied = body.replace(/(https?:\/\/[^\s]+)/g, (url) => {
      return `/segment?url=${encodeURIComponent(url)}`;
    });

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.send(proxied);
  } catch (err) {
    console.error(err);
    res.status(500).send("Proxy error");
  }
});

// پروکسی برای segmentها (.ts یا .mp4)
app.get("/segment", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("Missing url");

  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Upstream segment error: ${r.status}`);

    res.setHeader("Content-Type", r.headers.get("content-type") || "video/mp2t");
    r.body.pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).send("Segment proxy error");
  }
});

app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});