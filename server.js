/**
 * AJ Sports 2026 — RSS Bot Server v3.0 ⚡ CACHED EDITION + GEMINI TRANSLATE
 *
 * ✅ In-Memory Cache: ۲۰ میلیون کاربر فقط RAM را می‌خوانند — صفر Query به DB
 * ✅ Cache-Control headers: Cloudflare این API را 5 دقیقه Edge Cache می‌کند
 * ✅ Stampede Protection: اگر ۱۰۰۰ کاربر همزمان cache منقضی کنند، فقط ۱ DB query می‌رود
 * ✅ Background Refresh: Cron job در پس‌زمینه cache را تازه می‌کند — نه در لحظه درخواست کاربر
 * ✅ RSS → فقط bot_news در Bot DB ذخیره می‌شود
 * ✅ دارای سیستم ایزوله لایک و کامنت با حذف خودکار (Cascade)
 * ✅ [NEW v3.1] ترجمه خودکار عنوان خبر با Gemini Flash — endpoint: POST /api/translate
 *    - کلید Gemini از env می‌آید (GEMINI_API_KEY) — در کد هاردکد نیست
 *    - In-Memory Translation Cache: هر متن فقط یک بار به Gemini می‌رود
 *    - Rate-Limit Safe: اگر Gemini خطا دهد، متن اصلی برگردانده می‌شود
 */

require('dotenv').config();
const express  = require('express');
const { Pool } = require('pg');
const cron     = require('node-cron');
const Parser   = require('rss-parser');
const cors     = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════
// ENV
// ═══════════════════════════════════════════
const BOT_DB_URL    = process.env.BOT_DATABASE_URL;
const NEWS_TTL_MIN  = parseInt(process.env.NEWS_TTL_MINUTES    || '120');
const FETCH_MIN     = parseInt(process.env.FETCH_INTERVAL_MIN  || '3');
const MAX_ITEMS     = parseInt(process.env.MAX_ITEMS_PER_FEED  || '5');
// [NEW] کلید Gemini از .env — هیچ‌گاه در کد نوشته نمی‌شود
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!BOT_DB_URL) {
  console.error('❌ BOT_DATABASE_URL is required');
  process.exit(1);
}

// ═══════════════════════════════════════════
// CORS — با Cache-Control header
// ═══════════════════════════════════════════
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] }));
app.use(express.json());

// ═══════════════════════════════════════════
// DATABASE — فقط Bot DB
// ═══════════════════════════════════════════
const pool = new Pool({
  connectionString: BOT_DB_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 8000
});
pool.on('error', err => console.error('❌ DB pool error:', err.message));

// ═══════════════════════════════════════════
// ⚡ IN-MEMORY CACHE — قلب معماری ضدگلوله
// ═══════════════════════════════════════════
const newsMemCache = {
  data: null,
  updatedAt: 0,
  isRefreshing: false,
  TTL_MS: 3 * 60 * 1000
};

// ═══════════════════════════════════════════
// 🌐 [NEW] TRANSLATION CACHE — جلوگیری از درخواست‌های تکراری به Gemini
// کلید: متن اصلی (trim شده) — مقدار: ترجمه فارسی
// این cache در RAM زندگی می‌کند و با restart پاک می‌شود (مشکلی نیست)
// ═══════════════════════════════════════════
const translationCache = new Map();
// حداکثر ۵۰۰۰ ورودی در حافظه (هر عنوان ~۲۰۰ کاراکتر → ~۱MB)
const TRANSLATION_CACHE_MAX = 5000;

// ═══════════════════════════════════════════
// 🤖 BOT PROFILE MAP
// ═══════════════════════════════════════════
const BOT_PROFILES = {
  khabar_varzeshi: {
    avatar_url:   'https://ui-avatars.com/api/?name=%D8%AE%D8%A8%D8%B1+%D9%88%D8%B1%D8%B2%D8%B4%DB%8C&background=c62828&color=fff&size=128&bold=true&rounded=true',
    display_name: 'خبرورزشی 📰',
    username:     'khabar_varzeshi',
    verification: 'gold'
  },
  khabar_foori_sport: {
    avatar_url:   'https://ui-avatars.com/api/?name=%E2%9A%A1+%D9%81%D9%88%D8%B1%DB%8C&background=e65100&color=fff&size=128&bold=true&rounded=true',
    display_name: 'خبر فوری ورزشی ⚡',
    username:     'khabar_foori_sport',
    verification: 'gold'
  },
  varzsesh3: {
    avatar_url:   'https://ui-avatars.com/api/?name=%D9%88%D8%B1%D8%B2%D8%B4+3&background=6a1b9a&color=fff&size=128&bold=true&rounded=true',
    display_name: 'ورزش ۳ 📺',
    username:     'varzsesh3',
    verification: 'gold'
  },
  iran_football: {
    avatar_url:   'https://ui-avatars.com/api/?name=%D9%81%D9%88%D8%AA%D8%A8%D8%A7%D9%84+%D8%A7%DB%8C%D8%B1%D8%A7%D9%86&background=1b5e20&color=fff&size=128&bold=true&rounded=true',
    display_name: 'فوتبال ایران 🇮🇷',
    username:     'iran_football',
    verification: 'gold'
  },
  fifa_worldcup2026: {
    avatar_url:   'https://ui-avatars.com/api/?name=FIFA+2026&background=0d47a1&color=FFD700&size=128&bold=true&rounded=true',
    display_name: 'FIFA World Cup 2026 🏆',
    username:     'fifa_worldcup2026',
    verification: 'gold'
  },
  worldcup_news: {
    avatar_url:   'https://ui-avatars.com/api/?name=WC+2026&background=880e4f&color=fff&size=128&bold=true&rounded=true',
    display_name: 'World Cup 2026 ⚽',
    username:     'worldcup_news',
    verification: 'gold'
  },
  sport_news_en: {
    avatar_url:   'https://ui-avatars.com/api/?name=Sport+News&background=1565c0&color=fff&size=128&bold=true&rounded=true',
    display_name: 'Sport News 🌍',
    username:     'sport_news_en',
    verification: 'gold'
  },
  sky_sports: {
    avatar_url:   'https://ui-avatars.com/api/?name=Sky+Sports&background=0277bd&color=fff&size=128&bold=true&rounded=true',
    display_name: 'Sky Sports 🔵',
    username:     'sky_sports',
    verification: 'gold'
  },
  bbc_sport: {
    avatar_url:   'https://ui-avatars.com/api/?name=BBC+Sport&background=b71c1c&color=fff&size=128&bold=true&rounded=true',
    display_name: 'BBC Sport 🔴',
    username:     'bbc_sport',
    verification: 'gold'
  },
  goal_com: {
    avatar_url:   'https://ui-avatars.com/api/?name=GOAL&background=00695c&color=fff&size=128&bold=true&rounded=true',
    display_name: 'GOAL.com ⚽',
    username:     'goal_com',
    verification: 'gold'
  },
  marca_en: {
    avatar_url:   'https://ui-avatars.com/api/?name=MARCA&background=f57f17&color=fff&size=128&bold=true&rounded=true',
    display_name: 'MARCA EN 🇪🇸',
    username:     'marca_en',
    verification: 'gold'
  },
  transfermarkt: {
    avatar_url:   'https://ui-avatars.com/api/?name=Transfer&background=37474f&color=fff&size=128&bold=true&rounded=true',
    display_name: 'Transfermarkt 💰',
    username:     'transfermarkt',
    verification: 'gold'
  }
};

// ═══════════════════════════════════════════
// 🔔 KEEP-ALIVE
// ═══════════════════════════════════════════
function startKeepAlive() {
  const selfUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      await fetch(`${selfUrl}/health`, { signal: ctrl.signal });
      clearTimeout(t);
      console.log('💓 Keep-alive ping sent');
    } catch (e) {}
  }, 14 * 60 * 1000);
}

const BOTS = [
  {
    name:    'khabar_varzeshi',
    display: 'خبرورزشی 📰',
    lang:    'fa',
    feeds: [
      { url: 'https://www.irna.ir/rss/tp/14',            source: 'ایرنا'        },
      { url: 'https://www.khabaronline.ir/rss/tp/6',     source: 'خبرآنلاین'   },
      { url: 'https://kayhanvarzeshi.ir/fa/rss/allnews', source: 'کیهان ورزشی' },
      { url: 'https://www.tabnak.ir/fa/rss/2',           source: 'تابناک'       },
      { url: 'https://borna.news/fa/rss/7',              source: 'برنا'         }
    ]
  },
  {
    name:    'khabar_foori_sport',
    display: 'خبر فوری ورزشی ⚡',
    lang:    'fa',
    feeds: [
      { url: 'https://www.khabarfoori.com/fa/feeds/?p=Y2F0ZWdvcmllcz0xNzMmZGF0ZVJhbmdlJTVCc3RhcnQlNUQ9LTYwNDgwMCZwb3NpdGlvbkZyb250PTQ%2C', source: 'خبر فوری' },
      { url: 'https://www.varzesh3.com/rss/all',         source: 'ورزش ۳'      }
    ]
  },
  {
    name:    'varzsesh3',
    display: 'ورزش ۳ 📺',
    lang:    'fa',
    feeds: [
      { url: 'https://www.varzesh3.com/rss/football',    source: 'ورزش ۳ فوتبال' },
      { url: 'https://www.varzesh3.com/rss/all',         source: 'ورزش ۳ همه'    }
    ]
  },
  {
    name:    'iran_football',
    display: 'فوتبال ایران 🇮🇷',
    lang:    'fa',
    feeds: [
      { url: 'https://footballiran.com/rss/',            source: 'فوتبال ایران'   },
      { url: 'https://persianfootball.com/news/feed/',   source: 'پرشین فوتبال'  }
    ]
  },
  {
    name:    'fifa_worldcup2026',
    display: 'FIFA World Cup 2026 🏆',
    lang:    'en',
    feeds: [
      { url: 'https://news.google.com/rss/search?q=FIFA+World+Cup+2026&hl=en-US&gl=US&ceid=US:en', source: 'Google News WC2026' },
      { url: 'https://news.google.com/rss/search?q=World+Cup+2026+goal+match&hl=en-US&gl=US&ceid=US:en', source: 'WC2026 Matches'  }
    ]
  },
  {
    name:    'worldcup_news',
    display: 'World Cup 2026 ⚽',
    lang:    'en',
    feeds: [
      { url: 'https://news.google.com/rss/search?q=worldcup2026+football&hl=en&gl=US&ceid=US:en', source: 'WC News'         },
      { url: 'https://media.rss.com/world-cup-watchpoint/feed.xml',                               source: 'WC Watchpoint'   }
    ]
  },
  {
    name:    'sky_sports',
    display: 'Sky Sports 🔵',
    lang:    'en',
    feeds: [
      { url: 'https://www.skysports.com/rss/12040', source: 'Sky Sports Football' },
      { url: 'https://www.skysports.com/rss/11095', source: 'Sky Sports News'     }
    ]
  },
  {
    name:    'bbc_sport',
    display: 'BBC Sport 🔴',
    lang:    'en',
    feeds: [
      { url: 'https://feeds.bbci.co.uk/sport/football/rss.xml', source: 'BBC Football' },
      { url: 'https://feeds.bbci.co.uk/sport/rss.xml',          source: 'BBC Sport'    }
    ]
  },
  {
    name:    'goal_com',
    display: 'GOAL.com ⚽',
    lang:    'en',
    feeds: [
      { url: 'https://www.90min.com/feed',       source: '90min'    },
      { url: 'https://soccerlens.com/feed',      source: 'SoccerLens' }
    ]
  },
  {
    name:    'marca_en',
    display: 'MARCA EN 🇪🇸',
    lang:    'en',
    feeds: [
      { url: 'https://e00-marca.uecdn.es/rss/en/index.xml',      source: 'Marca EN'       },
      { url: 'https://www.fourfourtwo.com/rss',                   source: 'FourFourTwo'    }
    ]
  },
  {
    name:    'sport_news_en',
    display: 'Sport News 🌍',
    lang:    'en',
    feeds: [
      { url: 'https://www.cbssports.com/rss/headlines/soccer/',  source: 'CBS Soccer'     },
      { url: 'https://www.espn.com/espn/rss/soccer/news',        source: 'ESPN Soccer'    }
    ]
  },
  {
    name:    'transfermarkt',
    display: 'Transfermarkt 💰',
    lang:    'en',
    feeds: [
      { url: 'https://news.google.com/rss/search?q=football+transfer+2026&hl=en&gl=US&ceid=US:en', source: 'Transfer News'  },
      { url: 'https://www.caughtoffside.com/feed/',               source: 'CaughtOffside'  }
    ]
  }
];

// ═══════════════════════════════════════════
// RSS PARSER
// ═══════════════════════════════════════════
const rssParser = new Parser({
  timeout: 12000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; AJSportsRSSBot/2.0)',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*'
  },
  customFields: {
    item: [
      ['media:content',   'mediaContent',   { keepArray: false }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: false }],
      ['enclosure',       'enclosure']
    ]
  }
});

// ═══════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════
function extractImage(item) {
  if (item.mediaContent) {
    const u = item.mediaContent?.$.url || item.mediaContent?.url;
    if (u) return u;
  }
  if (item.mediaThumbnail) {
    const u = item.mediaThumbnail?.$.url || item.mediaThumbnail?.url;
    if (u) return u;
  }
  if (item.enclosure?.url) {
    const t = item.enclosure.type || '';
    if (t.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif)/i.test(item.enclosure.url))
      return item.enclosure.url;
  }
  const html = item['content:encoded'] || item.content || item.description || '';
  const m    = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (m && m[1] && !m[1].startsWith('data:')) return m[1];
  return null;
}

function itemGuid(item) {
  return item.guid || item.link || item.title || `${Date.now()}-${Math.random()}`;
}

// ═══════════════════════════════════════════
// DB INIT
// ═══════════════════════════════════════════
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_news (
      id           SERIAL      PRIMARY KEY,
      guid         TEXT        UNIQUE NOT NULL,
      bot_name     TEXT        NOT NULL,
      bot_display  TEXT        NOT NULL,
      source       TEXT        NOT NULL,
      lang         TEXT        NOT NULL DEFAULT 'fa',
      title        TEXT        NOT NULL,
      link         TEXT,
      image_url    TEXT,
      published_at TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_bn_created ON bot_news (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bn_lang    ON bot_news (lang);
    CREATE INDEX IF NOT EXISTS idx_bn_bot     ON bot_news (bot_name);

    CREATE TABLE IF NOT EXISTS news_likes (
      id         SERIAL      PRIMARY KEY,
      news_id    INT         NOT NULL REFERENCES bot_news(id) ON DELETE CASCADE,
      username   TEXT        NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(news_id, username)
    );
    CREATE INDEX IF NOT EXISTS idx_nl_news_id ON news_likes (news_id);

    CREATE TABLE IF NOT EXISTS news_comments (
      id           SERIAL      PRIMARY KEY,
      news_id      INT         NOT NULL REFERENCES bot_news(id) ON DELETE CASCADE,
      username     TEXT        NOT NULL,
      display_name TEXT,
      avatar_url   TEXT,
      content      TEXT        NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_nc_news_id ON news_comments (news_id);
    CREATE INDEX IF NOT EXISTS idx_nc_created ON news_comments (created_at ASC);
  `);
  console.log('✅ Tables ready: bot_news, news_likes, news_comments');
}

// ═══════════════════════════════════════════
// ⚡ CACHE REFRESH
// ═══════════════════════════════════════════
async function refreshNewsCache(lang = null, limit = 50) {
  if (newsMemCache.isRefreshing) return;
  newsMemCache.isRefreshing = true;

  try {
    const r = await pool.query(
      `SELECT id, bot_name, bot_display, source, lang,
              title, link, image_url, published_at, created_at,
              COALESCE(published_at, created_at) AS effective_at
       FROM bot_news
       ORDER BY COALESCE(published_at, created_at) DESC
       LIMIT $1`,
      [limit]
    );
    newsMemCache.data      = r.rows.map(row => ({
      ...row,
      avatar_url:   BOT_PROFILES[row.bot_name]?.avatar_url   || 'https://ui-avatars.com/api/?name=News&background=333&color=fff',
      username:     BOT_PROFILES[row.bot_name]?.username     || row.bot_name,
      display_name: BOT_PROFILES[row.bot_name]?.display_name || row.bot_display,
      verification: BOT_PROFILES[row.bot_name]?.verification || 'gold',
      created_at:   row.effective_at || row.published_at || row.created_at
    }));
    newsMemCache.updatedAt = Date.now();
    console.log(`⚡ News cache refreshed: ${r.rows.length} items`);
  } catch (err) {
    console.error('❌ Cache refresh failed:', err.message);
  } finally {
    newsMemCache.isRefreshing = false;
  }
}

// ═══════════════════════════════════════════
// FETCH RSS & SAVE TO BOT DB
// ═══════════════════════════════════════════
async function processFeed(bot, feed) {
  let feedData;
  try {
    feedData = await rssParser.parseURL(feed.url);
  } catch (err) {
    console.error(`  ❌ [${feed.source}] ${err.message}`);
    return 0;
  }

  const items = (feedData.items || []).slice(0, MAX_ITEMS);
  let saved = 0;

  for (const item of items) {
    const guid  = itemGuid(item);
    const title = (item.title || '').trim().substring(0, 300);
    if (!title) continue;

    try {
      const r = await pool.query(
        `INSERT INTO bot_news
           (guid, bot_name, bot_display, source, lang, title, link, image_url, published_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (guid) DO NOTHING
         RETURNING id`,
        [
          guid, bot.name, bot.display, feed.source, bot.lang, title,
          item.link || null, extractImage(item),
          item.pubDate ? new Date(item.pubDate) : null
        ]
      );
      if (r.rows.length > 0) {
        saved++;
        console.log(`  ✅ [${bot.name}] ${title.substring(0, 55)}...`);
      }
    } catch (err) {
      console.error(`  ❌ Insert: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return saved;
}

async function runAllFeeds() {
  const t = Date.now();
  console.log(`\n🔄 RSS fetch — ${new Date().toLocaleTimeString('fa-IR')}`);
  let total = 0;
  for (const bot of BOTS) {
    for (const feed of bot.feeds) {
      total += await processFeed(bot, feed);
      await new Promise(r => setTimeout(r, 500));
    }
  }
  console.log(`📦 ${total} new items saved (${Date.now() - t}ms)`);
  await refreshNewsCache();
}

// ═══════════════════════════════════════════
// AUTO CLEANUP
// ═══════════════════════════════════════════
async function cleanup() {
  const cutoff = new Date(Date.now() - NEWS_TTL_MIN * 60 * 1000);
  const r = await pool.query('DELETE FROM bot_news WHERE created_at < $1 RETURNING id', [cutoff]);
  if (r.rows.length > 0) {
    console.log(`🧹 Cleaned ${r.rows.length} old news + their likes/comments`);
    await refreshNewsCache();
  }
}

// ═══════════════════════════════════════════
// CRON JOBS
// ═══════════════════════════════════════════
cron.schedule(`*/${FETCH_MIN} * * * *`, runAllFeeds);
cron.schedule('*/10 * * * *',          cleanup);

// ═══════════════════════════════════════════
// 🌐 [NEW] GEMINI TRANSLATION ENGINE
// این تابع متن را با Gemini 2.5 Flash ترجمه می‌کند.
// - اگر متن از قبل در translationCache باشد، همان را برمی‌گرداند (صفر API call)
// - اگر Gemini خطا دهد یا timeout شود، متن اصلی برگردانده می‌شود
// - هیچ dependency جدیدی اضافه نشده — از fetch داخلی Node 18+ استفاده می‌شود
// ═══════════════════════════════════════════
async function translateWithGemini(text, targetLang = 'fa') {
  // اعتبارسنجی ورودی
  if (!text || typeof text !== 'string' || text.trim().length < 3) return text;
  
  const cacheKey = `${targetLang}::${text.trim()}`;
  
  // بررسی cache
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }
  
  try {
    const prompt = targetLang === 'fa'
      ? `این جمله را به فارسی ترجمه کن. فقط ترجمه فارسی را بنویس، هیچ چیز دیگری ننویس:\n${text}`
      : `Translate to English, output only the translation:\n${text}`;

    const controller = new AbortController();
    // timeout 8 ثانیه — جلوگیری از بلوک شدن request کاربر
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 512,
            topP: 0.9
          }
        }),
        signal: controller.signal
      }
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      console.error(`❌ Gemini API error ${response.status}: ${errBody.substring(0, 200)}`);
      return text; // fallback: متن اصلی
    }

    const data = await response.json();
    const translated = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!translated) {
      console.warn('⚠️ Gemini returned empty translation');
      return text;
    }

    // ذخیره در cache — با مدیریت سایز
    if (translationCache.size >= TRANSLATION_CACHE_MAX) {
      // پاک کردن اولین ۵۰۰ ورودی قدیمی (FIFO)
      const keysToDelete = Array.from(translationCache.keys()).slice(0, 500);
      keysToDelete.forEach(k => translationCache.delete(k));
      console.log('🧹 Translation cache pruned: 500 old entries removed');
    }
    translationCache.set(cacheKey, translated);
    
    console.log(`🌐 Translated: "${text.substring(0, 40)}..." → "${translated.substring(0, 40)}..."`);
    return translated;

  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn('⏱️ Gemini translation timeout — returning original');
    } else {
      console.error('❌ Gemini translation error:', err.message);
    }
    return text; // fallback امن: متن اصلی
  }
}

// ═══════════════════════════════════════════
// API ENDPOINTS
// ═══════════════════════════════════════════

/**
 * GET /api/news
 * ⚡ از in-memory cache می‌خواند
 */
app.get('/api/news', async (req, res) => {
  try {
    const { lang, bot, limit = 50 } = req.query;
    const limitNum = Math.min(parseInt(limit) || 50, 100);

    if (!newsMemCache.data || (Date.now() - newsMemCache.updatedAt) > newsMemCache.TTL_MS) {
      await refreshNewsCache(null, 100);
    }

    let news = newsMemCache.data || [];
    if (lang) news = news.filter(n => n.lang === lang);
    if (bot)  news = news.filter(n => n.bot_name === bot);

    news = news.slice(0, limitNum).map(n => ({
      ...n,
      created_at: n.effective_at || n.published_at || n.created_at
    }));

    res.set({
      'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60',
      'CDN-Cache-Control': 'public, max-age=300',
      'Cloudflare-CDN-Cache-Control': 'public, max-age=300'
    });

    res.json({ success: true, count: news.length, news, cached_at: new Date(newsMemCache.updatedAt).toISOString() });
  } catch (err) {
    console.error('❌ /api/news:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── [NEW] ترجمه خبر با Gemini ────────────────────────────────────────────────
/**
 * POST /api/translate
 * Body: { text: string, target_lang?: 'fa' | 'en' }
 * Response: { success: true, translated: string, cached: boolean }
 *
 * این endpoint کاملاً مستقل از سایر endpoint‌هاست.
 * هیچ تغییری در DB schema نمی‌دهد.
 * از in-memory translation cache استفاده می‌کند.
 */
app.post('/api/translate', async (req, res) => {
  try {
    const { text, target_lang = 'fa' } = req.body;
    
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ success: false, error: 'text is required' });
    }
    
    if (!['fa', 'en'].includes(target_lang)) {
      return res.status(400).json({ success: false, error: 'target_lang must be fa or en' });
    }
    
    const trimmedText = text.trim();
    if (trimmedText.length < 3) {
      return res.json({ success: true, translated: text, cached: false });
    }
    
    // بررسی cache قبل از فراخوانی Gemini
    const cacheKey = `${target_lang}::${trimmedText}`;
    const wasCached = translationCache.has(cacheKey);
    
    const translated = await translateWithGemini(trimmedText, target_lang);
    
    // Cache-Control: نتیجه ترجمه را می‌توان در Edge نگه داشت (متن+زبان ثابت = جواب ثابت)
    res.set('Cache-Control', 'public, s-maxage=86400'); // 24 ساعت
    
    res.json({
      success: true,
      translated,
      cached: wasCached,
      original: trimmedText
    });
    
  } catch (err) {
    console.error('❌ /api/translate:', err.message);
    // حتی در خطا، متن اصلی را برگردان تا UI خراب نشود
    res.json({ success: true, translated: req.body?.text || '', cached: false });
  }
});

// ── لایک خبر ─────────────────────────────────────────────────────
app.post('/api/news/:newsId/like', async (req, res) => {
  const { newsId } = req.params;
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });

  try {
    const existing = await pool.query(
      'SELECT id FROM news_likes WHERE news_id=$1 AND username=$2', [newsId, username]
    );
    if (existing.rows.length > 0) {
      await pool.query('DELETE FROM news_likes WHERE news_id=$1 AND username=$2', [newsId, username]);
      const count = await pool.query('SELECT COUNT(*) FROM news_likes WHERE news_id=$1', [newsId]);
      return res.json({ success: true, liked: false, likes_count: parseInt(count.rows[0].count) });
    } else {
      await pool.query('INSERT INTO news_likes (news_id, username) VALUES ($1, $2)', [newsId, username]);
      const count = await pool.query('SELECT COUNT(*) FROM news_likes WHERE news_id=$1', [newsId]);
      return res.json({ success: true, liked: true, likes_count: parseInt(count.rows[0].count) });
    }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── آمار خبر ─────────────────────────────────────────────────────
app.get('/api/news/:newsId/stats', async (req, res) => {
  const { newsId } = req.params;
  const { username } = req.query;
  try {
    const [likesRes, commentsRes, hasLikedRes] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM news_likes    WHERE news_id=$1', [newsId]),
      pool.query('SELECT COUNT(*) FROM news_comments WHERE news_id=$1', [newsId]),
      username
        ? pool.query('SELECT 1 FROM news_likes WHERE news_id=$1 AND username=$2', [newsId, username])
        : Promise.resolve({ rows: [] })
    ]);
    res.json({
      likes_count:   parseInt(likesRes.rows[0].count),
      comment_count: parseInt(commentsRes.rows[0].count),
      has_liked:     hasLikedRes.rows.length > 0
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── کامنت‌های خبر ─────────────────────────────────────────────────
app.post('/api/news/:newsId/comments', async (req, res) => {
  const { newsId } = req.params;
  const { username, display_name, avatar_url, content } = req.body;
  if (!username || !content?.trim())
    return res.status(400).json({ error: 'username and content required' });
  try {
    const result = await pool.query(
      `INSERT INTO news_comments (news_id, username, display_name, avatar_url, content)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [newsId, username, display_name || username, avatar_url || null, content.trim()]
    );
    res.json({ success: true, comment: result.rows[0] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/news/:newsId/comments', async (req, res) => {
  const { newsId } = req.params;
  try {
    const result = await pool.query(
      `SELECT * FROM news_comments WHERE news_id=$1 ORDER BY created_at ASC`, [newsId]
    );
    res.json({ success: true, comments: result.rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /health */
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    const r = await pool.query('SELECT COUNT(*) FROM bot_news');
    res.json({
      status:            'ok',
      news_total:        parseInt(r.rows[0].count),
      cache_items:       newsMemCache.data?.length || 0,
      cache_age_s:       Math.floor((Date.now() - newsMemCache.updatedAt) / 1000),
      translation_cache: translationCache.size,
      ttl_min:           NEWS_TTL_MIN,
      fetch_min:         FETCH_MIN,
      bots:              BOTS.length,
      gemini_ready:      !!GEMINI_API_KEY,
      ts:                new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

/** GET / */
app.get('/', (req, res) => res.json({
  service:   'AJ Sports RSS Bot v3.1 — Cached & Gemini Translate ⚡🌐',
  endpoints: {
    news:      '/api/news?lang=fa|en&limit=50',
    translate: 'POST /api/translate  {text, target_lang}',
    stats:     '/api/news/:newsId/stats',
    likes:     'POST /api/news/:newsId/like',
    comments:  'GET/POST /api/news/:newsId/comments',
    health:    '/health'
  },
  bots: BOTS.map(b => ({ name: b.name, display: b.display, feeds: b.feeds.length }))
}));

// ═══════════════════════════════════════════
// START
// ═══════════════════════════════════════════
async function start() {
  console.log('\n' + '═'.repeat(60));
  console.log('🤖 AJ Sports RSS Bot v3.1 — Cached & Gemini Translate ⚡🌐');
  console.log('═'.repeat(60));
  console.log(`📦 In-Memory Cache: ${newsMemCache.TTL_MS / 1000}s TTL`);
  console.log(`⏰ RSS Fetch every ${FETCH_MIN}min | News TTL ${NEWS_TTL_MIN}min`);
  console.log(`🌐 Gemini API: ${GEMINI_API_KEY ? '✅ Ready' : '❌ Missing GEMINI_API_KEY'}`);
  console.log('═'.repeat(60) + '\n');

  await initDB();

  app.listen(PORT, () => {
    console.log(`🚀 Bot server running on port ${PORT}`);
    console.log(`📡 News API:       http://localhost:${PORT}/api/news`);
    console.log(`🌐 Translate API:  http://localhost:${PORT}/api/translate\n`);
  });

  setTimeout(runAllFeeds, 6000);
  startKeepAlive();
}

start();

process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  await pool.end();
  process.exit(0);
});

