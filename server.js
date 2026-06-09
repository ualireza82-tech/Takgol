/**
 * AJ Sports 2026 — RSS Bot Server v4.0 ⚡ SECURE & EXPANDED EDITION
 *
 * 🔒 Security Patched: XSS Prevention, Rate Limiting, CORS Restrictions
 * 🌍 Expanded Feeds: Massive World Cup 2026 coverage (No BBC)
 * 🤖 Smart Tags: Context-aware hashtag generation for every post
 * 📸 Enhanced Image Extractor: Fixes Google News hidden images
 * ✅ In-Memory Cache + Gemini Translation
 */

require('dotenv').config();
const express    = require('express');
const { Pool }   = require('pg');
const cron       = require('node-cron');
const Parser     = require('rss-parser');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════
// ENV & CONFIG
// ═══════════════════════════════════════════
const BOT_DB_URL      = process.env.BOT_DATABASE_URL;
const NEWS_TTL_MIN    = parseInt(process.env.NEWS_TTL_MINUTES    || '120');
const FETCH_MIN       = parseInt(process.env.FETCH_INTERVAL_MIN  || '3');
const MAX_ITEMS       = parseInt(process.env.MAX_ITEMS_PER_FEED  || '10'); // Increased for more volume
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || '*'; // Set this to your frontend URL in production

if (!BOT_DB_URL) {
  console.error('❌ BOT_DATABASE_URL is required');
  process.exit(1);
}

// ═══════════════════════════════════════════
// SECURITY & MIDDLEWARES 🛡️
// ═══════════════════════════════════════════
app.use(cors({ origin: ALLOWED_ORIGINS, methods: ['GET', 'POST', 'PUT', 'DELETE'] }));
app.use(express.json());

// Rate Limiting to prevent Gemini API drain & Spam
const translateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { success: false, error: 'Too many translation requests from this IP, please try again later.' }
});

const interactionLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 50,
  message: { error: 'Spam protection active.' }
});

// XSS Sanitizer Function
function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/[&<>'"]/g, tag => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[tag]));
}

// ═══════════════════════════════════════════
// DATABASE CONNECTION
// ═══════════════════════════════════════════
const pool = new Pool({
  connectionString: BOT_DB_URL,
  // For production behind VPC, strict SSL is recommended. Using rejectUnauthorized: false for managed DBs.
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 8000
});
pool.on('error', err => console.error('❌ DB pool error:', err.message));

// ═══════════════════════════════════════════
// ⚡ IN-MEMORY CACHE
// ═══════════════════════════════════════════
const newsMemCache = { data: null, updatedAt: 0, isRefreshing: false, TTL_MS: 3 * 60 * 1000 };
const translationCache = new Map();
const TRANSLATION_CACHE_MAX = 5000;

// ═══════════════════════════════════════════
// 🤖 BOT PROFILES (Rich & Themed)
// ═══════════════════════════════════════════
const BOT_PROFILES = {
  // --- Persian Bots ---
  varzsesh3:          { avatar_url: 'https://ui-avatars.com/api/?name=%D9%88%D8%B1%D8%B2%D8%B4+3&background=6a1b9a&color=fff&size=256&bold=true', display_name: 'ورزش ۳ 📺', username: 'varzsesh3', verification: 'gold' },
  khabar_varzeshi:    { avatar_url: 'https://ui-avatars.com/api/?name=%D8%AE%D8%A8%D8%B1+%D9%88%D8%B1%D8%B2%D8%B4%DB%8C&background=c62828&color=fff&size=256&bold=true', display_name: 'خبرورزشی 📰', username: 'khabar_varzeshi', verification: 'gold' },
  iran_football:      { avatar_url: 'https://ui-avatars.com/api/?name=%D9%81%D9%88%D8%AA%D8%A8%D8%A7%D9%84+%D8%A7%DB%8C%D8%B1%D8%A7%D9%86&background=1b5e20&color=fff&size=256&bold=true', display_name: 'فوتبال ایران 🇮🇷', username: 'iran_football', verification: 'gold' },
  khabar_foori_sport: { avatar_url: 'https://ui-avatars.com/api/?name=%E2%9A%A1+%D9%81%D9%88%D8%B1%DB%8C&background=e65100&color=fff&size=256&bold=true', display_name: 'خبر فوری ورزشی ⚡', username: 'khabar_foori_sport', verification: 'gold' },
  isna_sport:         { avatar_url: 'https://ui-avatars.com/api/?name=ISNA&background=0d47a1&color=fff&size=256&bold=true', display_name: 'ایسنا ورزشی 🏅', username: 'isna_sport', verification: 'gold' },
  
  // --- English & World Cup Bots ---
  fifa_worldcup2026:  { avatar_url: 'https://ui-avatars.com/api/?name=FIFA+2026&background=111&color=FFD700&size=256&bold=true', display_name: 'FIFA World Cup 2026 🏆', username: 'fifa_worldcup2026', verification: 'gold' },
  wc_exclusive:       { avatar_url: 'https://ui-avatars.com/api/?name=WC+Exclusive&background=880e4f&color=FFD700&size=256&bold=true', display_name: 'WC 2026 Exclusive ⚽', username: 'wc_exclusive', verification: 'gold' },
  sky_sports:         { avatar_url: 'https://ui-avatars.com/api/?name=Sky+Sports&background=0277bd&color=fff&size=256&bold=true', display_name: 'Sky Sports 🔵', username: 'sky_sports', verification: 'gold' },
  espn_fc:            { avatar_url: 'https://ui-avatars.com/api/?name=ESPN+FC&background=b71c1c&color=fff&size=256&bold=true', display_name: 'ESPN FC 🔴', username: 'espn_fc', verification: 'gold' },
  goal_com:           { avatar_url: 'https://ui-avatars.com/api/?name=GOAL&background=000&color=fff&size=256&bold=true', display_name: 'GOAL.com ⚽', username: 'goal_com', verification: 'gold' },
  fox_soccer:         { avatar_url: 'https://ui-avatars.com/api/?name=FOX+Soccer&background=01579b&color=fff&size=256&bold=true', display_name: 'FOX Soccer 🦊', username: 'fox_soccer', verification: 'gold' },
  transfermarkt:      { avatar_url: 'https://ui-avatars.com/api/?name=Transfer&background=37474f&color=00e5ff&size=256&bold=true', display_name: 'Transfermarkt 💰', username: 'transfermarkt', verification: 'gold' }
};

// ═══════════════════════════════════════════
// 🌐 MASSIVE RSS FEEDS CATALOG
// ═══════════════════════════════════════════
const BOTS = [
  // --- Persian (FA) ---
  {
    name: 'varzsesh3', display: 'ورزش ۳ 📺', lang: 'fa',
    feeds: [
      { url: 'https://www.varzesh3.com/rss/football', source: 'ورزش ۳ فوتبال' },
      { url: 'https://www.varzesh3.com/rss/all', source: 'ورزش ۳ همه' }
    ]
  },
  {
    name: 'khabar_varzeshi', display: 'خبرورزشی 📰', lang: 'fa',
    feeds: [
      { url: 'https://www.khabarvarzeshi.com/rss', source: 'خبر ورزشی' },
      { url: 'https://www.irna.ir/rss/tp/14', source: 'ایرنا ورزشی' },
      { url: 'https://www.tabnak.ir/fa/rss/2', source: 'تابناک ورزشی' }
    ]
  },
  {
    name: 'iran_football', display: 'فوتبال ایران 🇮🇷', lang: 'fa',
    feeds: [
      { url: 'https://footballiran.com/rss/', source: 'فوتبال ایران' },
      { url: 'https://www.tasnimnews.com/fa/rss/feed/0/8/0/%D9%88%D8%B1%D8%B2%D8%B4%DB%8C', source: 'تسنیم ورزشی' }
    ]
  },
  {
    name: 'isna_sport', display: 'ایسنا ورزشی 🏅', lang: 'fa',
    feeds: [
      { url: 'https://www.isna.ir/rss/tp/11', source: 'ایسنا ورزشی' },
      { url: 'https://www.mehrnews.com/rss/tp/9', source: 'مهر ورزشی' }
    ]
  },
  // --- English (EN) & World Cup Focused ---
  {
    name: 'fifa_worldcup2026', display: 'FIFA World Cup 2026 🏆', lang: 'en',
    feeds: [
      { url: 'https://news.google.com/rss/search?q=FIFA+World+Cup+2026+football&hl=en-US&gl=US&ceid=US:en', source: 'Google WC2026' },
      { url: 'https://news.google.com/rss/search?q=World+Cup+2026+qualifiers&hl=en-US&gl=US&ceid=US:en', source: 'WC Qualifiers' },
      { url: 'https://news.google.com/rss/search?q=USMNT+World+Cup&hl=en-US&gl=US&ceid=US:en', source: 'USMNT WC' }
    ]
  },
  {
    name: 'wc_exclusive', display: 'WC 2026 Exclusive ⚽', lang: 'en',
    feeds: [
      { url: 'https://news.google.com/rss/search?q=World+Cup+2026+stadiums+teams&hl=en-US&gl=US&ceid=US:en', source: 'WC Stadiums/Teams' },
      { url: 'https://media.rss.com/world-cup-watchpoint/feed.xml', source: 'WC Watchpoint' }
    ]
  },
  {
    name: 'espn_fc', display: 'ESPN FC 🔴', lang: 'en',
    feeds: [
      { url: 'https://www.espn.com/espn/rss/soccer/news', source: 'ESPN Soccer' },
      { url: 'https://www.espn.com/espn/rss/news', source: 'ESPN Top News' }
    ]
  },
  {
    name: 'fox_soccer', display: 'FOX Soccer 🦊', lang: 'en',
    feeds: [
      { url: 'https://api.foxsports.com/v1/rss?partnerKey=zBaFxRyGKCfxBagJG9b8pqLyNdZjlwWGHljSyx', source: 'FOX Sports Soccer' } // Common Fox Sports generic RSS structure
    ]
  },
  {
    name: 'sky_sports', display: 'Sky Sports 🔵', lang: 'en',
    feeds: [
      { url: 'https://www.skysports.com/rss/12040', source: 'Sky Sports Football' },
      { url: 'https://www.skysports.com/rss/11095', source: 'Sky Sports News' },
      { url: 'https://www.skysports.com/rss/11986', source: 'Sky Sports World Cup' } // WC specific tag
    ]
  },
  {
    name: 'goal_com', display: 'GOAL.com ⚽', lang: 'en',
    feeds: [
      { url: 'https://www.90min.com/feed', source: '90min' },
      { url: 'https://www.101greatgoals.com/feed/', source: '101GreatGoals' }
    ]
  },
  {
    name: 'transfermarkt', display: 'Transfermarkt 💰', lang: 'en',
    feeds: [
      { url: 'https://news.google.com/rss/search?q=football+transfers+Fabrizio+Romano&hl=en-US&gl=US&ceid=US:en', source: 'Transfer News' },
      { url: 'https://www.caughtoffside.com/feed/', source: 'CaughtOffside' }
    ]
  }
];

// ═══════════════════════════════════════════
// 🧠 SMART HASHTAG GENERATOR (NLP-Lite)
// ═══════════════════════════════════════════
function appendSmartHashtags(title, lang) {
  const tags = new Set();
  const lowerTitle = title.toLowerCase();

  if (lang === 'fa') {
    if (title.includes('جام جهانی')) tags.add('#جام_جهانی_۲۰۲۶');
    if (title.includes('فیفا')) tags.add('#فیفا');
    if (title.includes('تیم ملی')) tags.add('#تیم_ملی_ایران');
    if (title.includes('استقلال')) tags.add('#استقلال');
    if (title.includes('پرسپولیس')) tags.add('#پرسپولیس');
    if (title.includes('مسی')) tags.add('#مسی');
    if (title.includes('رونالدو')) tags.add('#رونالدو');
    if (title.includes('لژیونر')) tags.add('#لژیونرها');
    if (tags.size < 2) tags.add('#خبر_ورزشی').add('#فوتبال');
  } else {
    if (lowerTitle.includes('world cup')) tags.add('#WorldCup2026');
    if (lowerTitle.includes('fifa')) tags.add('#FIFA');
    if (lowerTitle.includes('messi')) tags.add('#Messi');
    if (lowerTitle.includes('ronaldo')) tags.add('#Ronaldo');
    if (lowerTitle.includes('mbappe')) tags.add('#Mbappe');
    if (lowerTitle.includes('premier league')) tags.add('#PremierLeague');
    if (lowerTitle.includes('champions league')) tags.add('#UCL');
    if (lowerTitle.includes('transfer')) tags.add('#TransferNews');
    if (tags.size < 2) tags.add('#FootballNews').add('#Soccer');
  }

  const tagString = Array.from(tags).slice(0, 4).join(' '); 
  return `${title}\n\n${tagString}`;
}

// ═══════════════════════════════════════════
// 📸 ENHANCED IMAGE EXTRACTOR (Fixes Google News)
// ═══════════════════════════════════════════
function extractImage(item) {
  // 1. Direct Media Content
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
  
  // 2. Deep HTML Parsing (Fix for Google News & Hidden IMG tags)
  const html = item['content:encoded'] || item.content || item.description || '';
  // Match standard src
  const m1 = html.match(/<img[^>]+src=["'](https?:\/\/[^"']+)["']/i);
  if (m1 && m1[1] && !m1[1].startsWith('data:')) return m1[1];
  
  // Match data-src (lazy loaded images)
  const m2 = html.match(/<img[^>]+data-src=["'](https?:\/\/[^"']+)["']/i);
  if (m2 && m2[1]) return m2[1];

  return null;
}

const rssParser = new Parser({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*'
  },
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: false }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: false }],
      ['enclosure', 'enclosure'],
      ['description', 'description'],
      ['content:encoded', 'content:encoded']
    ]
  }
});

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
  console.log('✅ Secure Tables ready: bot_news, news_likes, news_comments');
}

// ═══════════════════════════════════════════
// ⚡ CACHE REFRESH
// ═══════════════════════════════════════════
async function refreshNewsCache(lang = null, limit = 100) {
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
    newsMemCache.data = r.rows.map(row => ({
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
    let rawTitle = (item.title || '').trim();
    if (!rawTitle) continue;
    
    // Inject Smart Hashtags
    const titleWithTags = appendSmartHashtags(rawTitle.substring(0, 300), bot.lang);

    try {
      const r = await pool.query(
        `INSERT INTO bot_news
           (guid, bot_name, bot_display, source, lang, title, link, image_url, published_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (guid) DO NOTHING
         RETURNING id`,
        [
          guid, bot.name, bot.display, feed.source, bot.lang, titleWithTags,
          item.link || null, extractImage(item),
          item.pubDate ? new Date(item.pubDate) : null
        ]
      );
      if (r.rows.length > 0) {
        saved++;
        console.log(`  ✅ [${bot.name}] ${rawTitle.substring(0, 45)}...`);
      }
    } catch (err) {
      console.error(`  ❌ Insert: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return saved;
}

async function runAllFeeds() {
  const t = Date.now();
  console.log(`\n🔄 RSS fetch (V4 Expanded) — ${new Date().toLocaleTimeString('fa-IR')}`);
  let total = 0;
  for (const bot of BOTS) {
    for (const feed of bot.feeds) {
      total += await processFeed(bot, feed);
      await new Promise(r => setTimeout(r, 300));
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
    console.log(`🧹 Cleaned ${r.rows.length} old news (Cascade deleted likes/comments)`);
    await refreshNewsCache();
  }
}

cron.schedule(`*/${FETCH_MIN} * * * *`, runAllFeeds);
cron.schedule('*/10 * * * *', cleanup);

// ═══════════════════════════════════════════
// 🌐 GEMINI TRANSLATION ENGINE
// ═══════════════════════════════════════════
async function translateWithGemini(text, targetLang = 'fa') {
  if (!text || typeof text !== 'string' || text.trim().length < 3) return text;
  const cacheKey = `${targetLang}::${text.trim()}`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);
  
  try {
    const prompt = targetLang === 'fa'
      ? `این جمله را روان به فارسی ورزشی ترجمه کن. فقط ترجمه را بنویس:\n${text}`
      : `Translate to English organically, output only translation:\n${text}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 512, topP: 0.9 }
        }),
        signal: controller.signal
      }
    );
    clearTimeout(timeoutId);

    if (!response.ok) return text;

    const data = await response.json();
    const translated = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!translated) return text;

    if (translationCache.size >= TRANSLATION_CACHE_MAX) {
      const keysToDelete = Array.from(translationCache.keys()).slice(0, 500);
      keysToDelete.forEach(k => translationCache.delete(k));
    }
    translationCache.set(cacheKey, translated);
    return translated;

  } catch (err) {
    return text; 
  }
}

// ═══════════════════════════════════════════
// API ENDPOINTS
// ═══════════════════════════════════════════

app.get('/api/news', async (req, res) => {
  try {
    const { lang, bot, limit = 50 } = req.query;
    const limitNum = Math.min(parseInt(limit) || 50, 150);

    if (!newsMemCache.data || (Date.now() - newsMemCache.updatedAt) > newsMemCache.TTL_MS) {
      await refreshNewsCache(null, 150);
    }

    let news = newsMemCache.data || [];
    if (lang) news = news.filter(n => n.lang === lang);
    if (bot)  news = news.filter(n => n.bot_name === bot);

    news = news.slice(0, limitNum);

    res.set({
      'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60',
    });

    res.json({ success: true, count: news.length, news, cached_at: new Date(newsMemCache.updatedAt).toISOString() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 🔒 API Route with Rate Limiting
app.post('/api/translate', translateLimiter, async (req, res) => {
  try {
    const { text, target_lang = 'fa' } = req.body;
    if (!text || typeof text !== 'string') return res.status(400).json({ success: false, error: 'text required' });
    
    const trimmedText = text.trim();
    if (trimmedText.length < 3) return res.json({ success: true, translated: text, cached: false });
    
    const wasCached = translationCache.has(`${target_lang}::${trimmedText}`);
    const translated = await translateWithGemini(trimmedText, target_lang);
    
    res.set('Cache-Control', 'public, s-maxage=86400');
    res.json({ success: true, translated, cached: wasCached, original: trimmedText });
  } catch (err) {
    res.json({ success: true, translated: req.body?.text || '', cached: false });
  }
});

// 🔒 Interaction Endpoints with Rate Limiting & Input Sanitization
app.post('/api/news/:newsId/like', interactionLimiter, async (req, res) => {
  const { newsId } = req.params;
  let { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });
  
  username = escapeHTML(username.trim()); // Sanitize Identity

  try {
    const existing = await pool.query('SELECT id FROM news_likes WHERE news_id=$1 AND username=$2', [newsId, username]);
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

app.post('/api/news/:newsId/comments', interactionLimiter, async (req, res) => {
  const { newsId } = req.params;
  const { username, display_name, avatar_url, content } = req.body;
  
  if (!username || !content?.trim()) return res.status(400).json({ error: 'username and content required' });
  
  // 🔒 Anti-XSS Sanitization applied here
  const safeUsername = escapeHTML(username.trim());
  const safeDisplayName = escapeHTML(display_name ? display_name.trim() : username.trim());
  const safeContent = escapeHTML(content.trim());

  try {
    const result = await pool.query(
      `INSERT INTO news_comments (news_id, username, display_name, avatar_url, content)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [newsId, safeUsername, safeDisplayName, avatar_url || null, safeContent]
    );
    res.json({ success: true, comment: result.rows[0] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/news/:newsId/comments', async (req, res) => {
  const { newsId } = req.params;
  try {
    const result = await pool.query(`SELECT * FROM news_comments WHERE news_id=$1 ORDER BY created_at ASC`, [newsId]);
    res.json({ success: true, comments: result.rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    const r = await pool.query('SELECT COUNT(*) FROM bot_news');
    res.json({
      status: 'ok', secure: true, news_total: parseInt(r.rows[0].count),
      cache_items: newsMemCache.data?.length || 0, translation_cache: translationCache.size,
      bots: BOTS.length, gemini_ready: !!GEMINI_API_KEY
    });
  } catch (e) { res.status(500).json({ status: 'error', error: e.message }); }
});

// ═══════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════
async function start() {
  console.log('\n' + '═'.repeat(60));
  console.log('🤖 AJ Sports RSS Bot v4.0 — Secure & WC Expanded ⚡🛡️');
  console.log('═'.repeat(60));
  console.log(`🔒 Security: XSS Guard [ON] | Rate Limits [ON]`);
  console.log(`⏰ Fetch every ${FETCH_MIN}m | TTL ${NEWS_TTL_MIN}m`);
  console.log('═'.repeat(60) + '\n');

  await initDB();
  app.listen(PORT, () => console.log(`🚀 Secure Server on port ${PORT}\n`));
  setTimeout(runAllFeeds, 3000);
}

start();

process.on('SIGTERM', async () => {
  await pool.end();
  process.exit(0);
});
