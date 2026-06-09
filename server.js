/**
 * AJ Sports 2026 — RSS Bot Server v3.2 ⚡ SMART HASHTAGS + EXTENDED FEEDS
 *
 * ✅ In-Memory Cache: ۲۰ میلیون کاربر فقط RAM را می‌خوانند — صفر Query به DB
 * ✅ Cache-Control headers: Cloudflare این API را 5 دقیقه Edge Cache می‌کند
 * ✅ Stampede Protection: ضد ریزش در برابر هجوم همزمان کاربران
 * ✅ Background Refresh: Cron job در پس‌زمینه
 * ✅ [NEW v3.2] Smart Hashtag Engine: تولید خودکار هشتگ بر اساس کلمات کلیدی خبر
 * ✅ [NEW v3.2] Enhanced Image Extractor: حل قطعی مشکل تصاویر Google News
 * ✅ [NEW v3.2] Extended World Cup Feeds: بیش از ۲۰ فید جدید ورزشی بدون سورس‌های ممنوعه (BBC)
 * ✅ دارای سیستم ایزوله لایک و کامنت با حذف خودکار (Cascade)
 * ✅ ترجمه خودکار عنوان خبر با Gemini Flash کاملا ایزوله و Safe
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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!BOT_DB_URL) {
  console.error('❌ BOT_DATABASE_URL is required');
  process.exit(1);
}

// ═══════════════════════════════════════════
// CORS & MIDDLEWARE
// ═══════════════════════════════════════════
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] }));
app.use(express.json());

// ═══════════════════════════════════════════
// DATABASE CONNECTION
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
// ⚡ IN-MEMORY CACHE
// ═══════════════════════════════════════════
const newsMemCache = {
  data: null,
  updatedAt: 0,
  isRefreshing: false,
  TTL_MS: 3 * 60 * 1000
};

const translationCache = new Map();
const TRANSLATION_CACHE_MAX = 5000;

// ═══════════════════════════════════════════
// 🤖 BOT PROFILE MAP (Updated & Extended)
// ═══════════════════════════════════════════
const BOT_PROFILES = {
  khabar_varzeshi: {
    avatar_url:   'https://ui-avatars.com/api/?name=%D8%AE%D8%A8%D8%B1+%D9%88%D8%B1%D8%B2%D8%B4%DB%8C&background=c62828&color=fff&size=128&bold=true',
    display_name: 'خبرورزشی 📰',
    username:     'khabar_varzeshi',
    verification: 'gold'
  },
  khabar_foori_sport: {
    avatar_url:   'https://ui-avatars.com/api/?name=%E2%9A%A1+%D9%81%D9%88%D8%B1%DB%8C&background=e65100&color=fff&size=128&bold=true',
    display_name: 'خبر فوری ورزشی ⚡',
    username:     'khabar_foori_sport',
    verification: 'gold'
  },
  varzsesh3: {
    avatar_url:   'https://ui-avatars.com/api/?name=%D9%88%D8%B1%D8%B2%D8%B4+3&background=6a1b9a&color=fff&size=128&bold=true',
    display_name: 'ورزش ۳ 📺',
    username:     'varzsesh3',
    verification: 'gold'
  },
  iran_football: {
    avatar_url:   'https://ui-avatars.com/api/?name=%D9%81%D9%88%D8%AA%D8%A8%D8%A7%D9%84+%D8%A7%DB%8C%D8%B1%D8%A7%D9%86&background=1b5e20&color=fff&size=128&bold=true',
    display_name: 'فوتبال ایران 🇮🇷',
    username:     'iran_football',
    verification: 'gold'
  },
  tasnim_sport: {
    avatar_url:   'https://ui-avatars.com/api/?name=%D8%AA%D8%B3%D9%86%DB%8C%D9%85&background=004d40&color=fff&size=128&bold=true',
    display_name: 'تسنیم ورزشی 🏟️',
    username:     'tasnim_sport',
    verification: 'gold'
  },
  mehr_sport: {
    avatar_url:   'https://ui-avatars.com/api/?name=%D9%85%D9%87%D8%B1&background=01579b&color=fff&size=128&bold=true',
    display_name: 'مهر ورزشی 🥇',
    username:     'mehr_sport',
    verification: 'gold'
  },
  fifa_worldcup2026: {
    avatar_url:   'https://upload.wikimedia.org/wikipedia/en/thumb/9/91/2026_FIFA_World_Cup_logo.svg/150px-2026_FIFA_World_Cup_logo.svg.png',
    display_name: 'FIFA World Cup 2026 🏆',
    username:     'fifa_worldcup2026',
    verification: 'gold'
  },
  worldcup_news: {
    avatar_url:   'https://ui-avatars.com/api/?name=WC+2026&background=880e4f&color=FFD700&size=128&bold=true',
    display_name: 'World Cup Updates ⚽',
    username:     'worldcup_news',
    verification: 'gold'
  },
  worldcup_global: {
    avatar_url:   'https://ui-avatars.com/api/?name=Global+WC&background=1a237e&color=fff&size=128&bold=true',
    display_name: 'WC Global coverage 🌍',
    username:     'worldcup_global',
    verification: 'gold'
  },
  sport_news_en: {
    avatar_url:   'https://ui-avatars.com/api/?name=Sport+News&background=1565c0&color=fff&size=128&bold=true',
    display_name: 'Sport News 🌍',
    username:     'sport_news_en',
    verification: 'gold'
  },
  fox_sports: {
    avatar_url:   'https://ui-avatars.com/api/?name=FOX+Sport&background=1a237e&color=fff&size=128&bold=true',
    display_name: 'FOX Sports 🔵',
    username:     'fox_sports',
    verification: 'gold'
  },
  goal_com: {
    avatar_url:   'https://ui-avatars.com/api/?name=GOAL&background=00695c&color=fff&size=128&bold=true',
    display_name: 'GOAL.com ⚽',
    username:     'goal_com',
    verification: 'gold'
  },
  marca_en: {
    avatar_url:   'https://ui-avatars.com/api/?name=MARCA&background=f57f17&color=fff&size=128&bold=true',
    display_name: 'MARCA EN 🇪🇸',
    username:     'marca_en',
    verification: 'gold'
  },
  transfermarkt: {
    avatar_url:   'https://ui-avatars.com/api/?name=Transfer&background=37474f&color=fff&size=128&bold=true',
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
    } catch (e) {}
  }, 14 * 60 * 1000);
}

// ═══════════════════════════════════════════
// 🌐 EXTENDED FEEDS (No BBC, High WC Focus)
// ═══════════════════════════════════════════
const BOTS = [
  // ─── فیدهای فارسی ───
  {
    name: 'khabar_varzeshi', display: 'خبرورزشی 📰', lang: 'fa',
    feeds: [
      { url: 'https://www.irna.ir/rss/tp/14', source: 'ایرنا' },
      { url: 'https://www.khabaronline.ir/rss/tp/6', source: 'خبرآنلاین' },
      { url: 'https://kayhanvarzeshi.ir/fa/rss/allnews', source: 'کیهان ورزشی' }
    ]
  },
  {
    name: 'tasnim_sport', display: 'تسنیم ورزشی 🏟️', lang: 'fa',
    feeds: [
      { url: 'https://www.tasnimnews.com/fa/rss/feed/0/7/0/%D9%88%D8%B1%D8%B2%D8%B4%DB%8C', source: 'تسنیم' },
      { url: 'https://www.farsnews.ir/rss/sports', source: 'فارس' }
    ]
  },
  {
    name: 'mehr_sport', display: 'مهر ورزشی 🥇', lang: 'fa',
    feeds: [
      { url: 'https://www.mehrnews.com/rss/tp/11', source: 'مهر نیوز' },
      { url: 'https://www.isna.ir/rss/tp/114', source: 'ایسنا' }
    ]
  },
  {
    name: 'varzsesh3', display: 'ورزش ۳ 📺', lang: 'fa',
    feeds: [
      { url: 'https://www.varzesh3.com/rss/football', source: 'ورزش ۳ فوتبال' },
      { url: 'https://www.varzesh3.com/rss/all', source: 'ورزش ۳ همه' }
    ]
  },
  {
    name: 'iran_football', display: 'فوتبال ایران 🇮🇷', lang: 'fa',
    feeds: [
      { url: 'https://footballiran.com/rss/', source: 'فوتبال ایران' },
      { url: 'https://news.google.com/rss/search?q=تیم+ملی+ایران+جام+جهانی&hl=fa&gl=IR&ceid=IR:fa', source: 'تیم ملی' }
    ]
  },
  
  // ─── فیدهای انگلیسی و جام جهانی (بدون BBC) ───
  {
    name: 'fifa_worldcup2026', display: 'FIFA World Cup 2026 🏆', lang: 'en',
    feeds: [
      { url: 'https://news.google.com/rss/search?q=FIFA+World+Cup+2026&hl=en-US&gl=US&ceid=US:en', source: 'Google News WC2026' },
      { url: 'https://news.google.com/rss/search?q=World+Cup+2026+goal+match&hl=en-US&gl=US&ceid=US:en', source: 'WC2026 Matches' },
      { url: 'https://sports.yahoo.com/soccer/world-cup/rss/', source: 'Yahoo WC' }
    ]
  },
  {
    name: 'worldcup_news', display: 'World Cup Updates ⚽', lang: 'en',
    feeds: [
      { url: 'https://news.google.com/rss/search?q=worldcup2026+football+news&hl=en&gl=US&ceid=US:en', source: 'WC News' },
      { url: 'https://media.rss.com/world-cup-watchpoint/feed.xml', source: 'WC Watchpoint' }
    ]
  },
  {
    name: 'worldcup_global', display: 'WC Global coverage 🌍', lang: 'en',
    feeds: [
      { url: 'https://www.theguardian.com/football/world-cup-2026/rss', source: 'Guardian WC' },
      { url: 'https://www.espn.com/espn/rss/soccer/news', source: 'ESPN Soccer' }
    ]
  },
  {
    name: 'fox_sports', display: 'FOX Sports 🔵', lang: 'en',
    feeds: [
      { url: 'https://api.foxsports.com/v2/content/optimized-rss?partnerKey=MB0Wehpmuj2lUhuRhQaafhBjAJqaPU244mlTDK1i&size=30&tags=fs/soccer', source: 'FOX Soccer' },
      { url: 'https://www.skysports.com/rss/12040', source: 'Sky Sports Football' }
    ]
  },
  {
    name: 'goal_com', display: 'GOAL.com ⚽', lang: 'en',
    feeds: [
      { url: 'https://www.90min.com/feed', source: '90min' },
      { url: 'https://soccerlens.com/feed', source: 'SoccerLens' }
    ]
  },
  {
    name: 'marca_en', display: 'MARCA EN 🇪🇸', lang: 'en',
    feeds: [
      { url: 'https://e00-marca.uecdn.es/rss/en/index.xml', source: 'Marca EN' },
      { url: 'https://www.fourfourtwo.com/rss', source: 'FourFourTwo' }
    ]
  },
  {
    name: 'transfermarkt', display: 'Transfermarkt 💰', lang: 'en',
    feeds: [
      { url: 'https://news.google.com/rss/search?q=football+transfer+2026&hl=en&gl=US&ceid=US:en', source: 'Transfer News' },
      { url: 'https://www.caughtoffside.com/feed/', source: 'CaughtOffside' }
    ]
  }
];

// ═══════════════════════════════════════════
// RSS PARSER
// ═══════════════════════════════════════════
const rssParser = new Parser({
  timeout: 12000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; AJSportsRSSBot/3.2)',
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
// HELPERS: SMART HASHTAGS & ENHANCED IMAGE EXTRACTOR
// ═══════════════════════════════════════════

/**
 * 🎯 استخراج هوشمند هشتگ بر اساس کلمات کلیدی موجود در عنوان
 */
function generateHashtags(title, lang) {
  const tags = new Set();
  const t = title.toLowerCase();

  if (lang === 'fa') {
    tags.add('#اخبار_ورزشی');
    if (t.includes('جام جهانی') || t.includes('2026') || t.includes('فیفا')) { tags.add('#جام_جهانی_2026'); tags.add('#FIFA2026'); }
    if (t.includes('استقلال')) tags.add('#استقلال');
    if (t.includes('پرسپولیس')) tags.add('#پرسپولیس');
    if (t.includes('سپاهان')) tags.add('#سپاهان');
    if (t.includes('تراکتور')) tags.add('#تراکتور');
    if (t.includes('تیم ملی') || t.includes('قلعه نویی')) tags.add('#تیم_ملی_ایران');
    if (t.includes('رونالدو')) tags.add('#کریستیانو_رونالدو');
    if (t.includes('مسی')) tags.add('#لیونل_مسی');
    if (t.includes('رئال')) tags.add('#رئال_مادرید');
    if (t.includes('بارسلونا') || t.includes('بارسا')) tags.add('#بارسلونا');
    if (t.includes('لژیونر')) tags.add('#لژیونرها');
  } else {
    tags.add('#SportsNews');
    if (t.includes('world cup') || t.includes('2026') || t.includes('fifa')) { tags.add('#WorldCup2026'); tags.add('#FIFA'); }
    if (t.includes('ronaldo') || t.includes('cr7')) tags.add('#CR7');
    if (t.includes('messi')) tags.add('#Messi');
    if (t.includes('madrid')) tags.add('#RealMadrid');
    if (t.includes('barcelona') || t.includes('barca')) tags.add('#FCBarcelona');
    if (t.includes('premier league') || t.includes('epl')) tags.add('#PremierLeague');
    if (t.includes('arsenal')) tags.add('#Arsenal');
    if (t.includes('chelsea')) tags.add('#Chelsea');
    if (t.includes('manchester united') || t.includes('man utd')) tags.add('#MUFC');
    if (t.includes('champions league') || t.includes('ucl')) tags.add('#UCL');
    if (t.includes('mbappe')) tags.add('#Mbappe');
  }

  // محدود کردن به حداکثر ۴ هشتگ مرتبط
  const tagsArray = Array.from(tags).slice(0, 4);
  return tagsArray.length > 0 ? '\n\n' + tagsArray.join(' ') : '';
}

/**
 * 🖼️ استخراج قطعی تصاویر (شامل حل مشکلات Google News)
 */
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
  
  // بررسی دقیق‌تر HTML برای یافتن تصویر پنهان (مخصوص Google News و Yahoo)
  const html = item['content:encoded'] || item.content || item.description || '';
  const match = html.match(/<img[^>]+(?:src|data-src)=["']([^"']+)["']/i);
  
  if (match && match[1]) {
    let imgUrl = match[1];
    // فیلتر کردن تصاویر بی‌ارزش (پیکسل‌های ترکینگ و بیس۶۴)
    if (!imgUrl.startsWith('data:') && !imgUrl.includes('1x1') && !imgUrl.includes('pixel')) {
      // اصلاح آدرس‌های نسبی گوگل
      if (imgUrl.startsWith('/')) {
         imgUrl = 'https://news.google.com' + imgUrl;
      }
      return imgUrl;
    }
  }
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
    const guid = itemGuid(item);
    let title  = (item.title || '').trim();
    if (!title) continue;

    // اعمال سیستم ساخت خودکار هشتگ
    const hashtags = generateHashtags(title, bot.lang);
    // ترکیب تایتل اصلی و هشتگ (تضمین جلوگیری از Overflow کلمات در دیتابیس)
    title = (title + hashtags).substring(0, 500);

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
        console.log(`  ✅ [${bot.name}] ${title.substring(0, 55).replace(/\n/g, ' ')}...`);
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

cron.schedule(`*/${FETCH_MIN} * * * *`, runAllFeeds);
cron.schedule('*/10 * * * *',          cleanup);

// ═══════════════════════════════════════════
// 🌐 GEMINI TRANSLATION ENGINE (Untouched - Guaranteed Safe)
// ═══════════════════════════════════════════
async function translateWithGemini(text, targetLang = 'fa') {
  if (!text || typeof text !== 'string' || text.trim().length < 3) return text;
  
  const cacheKey = `${targetLang}::${text.trim()}`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);
  
  try {
    const prompt = targetLang === 'fa'
      ? `این جمله را به فارسی ترجمه کن. فقط ترجمه فارسی را بنویس، هیچ چیز دیگری ننویس:\n${text}`
      : `Translate to English, output only the translation:\n${text}`;

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
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/translate', async (req, res) => {
  try {
    const { text, target_lang = 'fa' } = req.body;
    
    if (!text || typeof text !== 'string') return res.status(400).json({ success: false, error: 'text required' });
    if (!['fa', 'en'].includes(target_lang)) return res.status(400).json({ success: false, error: 'invalid lang' });
    
    const trimmedText = text.trim();
    if (trimmedText.length < 3) return res.json({ success: true, translated: text, cached: false });
    
    const cacheKey = `${target_lang}::${trimmedText}`;
    const wasCached = translationCache.has(cacheKey);
    const translated = await translateWithGemini(trimmedText, target_lang);
    
    res.set('Cache-Control', 'public, s-maxage=86400');
    res.json({ success: true, translated, cached: wasCached, original: trimmedText });
  } catch (err) {
    res.json({ success: true, translated: req.body?.text || '', cached: false });
  }
});

app.post('/api/news/:newsId/like', async (req, res) => {
  const { newsId } = req.params;
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });

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
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/news/:newsId/stats', async (req, res) => {
  const { newsId } = req.params;
  const { username } = req.query;
  try {
    const [likesRes, commentsRes, hasLikedRes] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM news_likes WHERE news_id=$1', [newsId]),
      pool.query('SELECT COUNT(*) FROM news_comments WHERE news_id=$1', [newsId]),
      username ? pool.query('SELECT 1 FROM news_likes WHERE news_id=$1 AND username=$2', [newsId, username]) : Promise.resolve({ rows: [] })
    ]);
    res.json({ likes_count: parseInt(likesRes.rows[0].count), comment_count: parseInt(commentsRes.rows[0].count), has_liked: hasLikedRes.rows.length > 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/news/:newsId/comments', async (req, res) => {
  const { newsId } = req.params;
  const { username, display_name, avatar_url, content } = req.body;
  if (!username || !content?.trim()) return res.status(400).json({ error: 'username and content required' });
  try {
    const result = await pool.query(
      `INSERT INTO news_comments (news_id, username, display_name, avatar_url, content) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [newsId, username, display_name || username, avatar_url || null, content.trim()]
    );
    res.json({ success: true, comment: result.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/news/:newsId/comments', async (req, res) => {
  const { newsId } = req.params;
  try {
    const result = await pool.query(`SELECT * FROM news_comments WHERE news_id=$1 ORDER BY created_at ASC`, [newsId]);
    res.json({ success: true, comments: result.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    const r = await pool.query('SELECT COUNT(*) FROM bot_news');
    res.json({
      status: 'ok', news_total: parseInt(r.rows[0].count), cache_items: newsMemCache.data?.length || 0,
      translation_cache: translationCache.size, bots: BOTS.length, gemini_ready: !!GEMINI_API_KEY
    });
  } catch (e) { res.status(500).json({ status: 'error', error: e.message }); }
});

app.get('/', (req, res) => res.json({ service: 'AJ Sports RSS Bot v3.2 — Smart Hashtags & WC Edition ⚡🌐', bots: BOTS.length }));

// ═══════════════════════════════════════════
// START
// ═══════════════════════════════════════════
async function start() {
  console.log('\n' + '═'.repeat(60));
  console.log('🤖 AJ Sports RSS Bot v3.2 — WC Edition & Smart Hashtags ⚡');
  console.log('═'.repeat(60));
  await initDB();
  app.listen(PORT, () => console.log(`🚀 Bot server running on port ${PORT}`));
  setTimeout(runAllFeeds, 6000);
  startKeepAlive();
}

start();

process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  await pool.end();
  process.exit(0);
});
