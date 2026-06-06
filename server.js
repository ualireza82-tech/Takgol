/**
 * AJ Sports 2026 — RSS Bot Server v2.0
 *
 * ✅ RSS → فقط bot_news در Bot DB ذخیره می‌شود
 * ✅ GET /api/news → فرانت‌اند مستقیم می‌خواند
 * ❌ هیچ تماسی با بک‌اند اصلی یا DB اصلی وجود ندارد
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
const BOT_DB_URL   = process.env.BOT_DATABASE_URL;
const NEWS_TTL_MIN = parseInt(process.env.NEWS_TTL_MINUTES    || '120');
const FETCH_MIN    = parseInt(process.env.FETCH_INTERVAL_MIN  || '3');
const MAX_ITEMS    = parseInt(process.env.MAX_ITEMS_PER_FEED  || '5');

if (!BOT_DB_URL) {
  console.error('❌ BOT_DATABASE_URL is required');
  process.exit(1);
}

// ═══════════════════════════════════════════
// CORS — فرانت‌اند از هر origin بتواند GET بزند
// ═══════════════════════════════════════════
app.use(cors({ origin: '*', methods: ['GET'] }));
app.use(express.json());

// ═══════════════════════════════════════════
// DATABASE — فقط Bot DB، هیچ ربطی به DB اصلی ندارد
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
// BOT ACCOUNTS DEFINITION
// ═══════════════════════════════════════════
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
      {
        url:    'https://www.khabarfoori.com/fa/feeds/?p=Y2F0ZWdvcmllcz0xNzMmZGF0ZVJhbmdlJTVCc3RhcnQlNUQ9LTYwNDgwMCZwb3NpdGlvbkZyb250PTQ%2C',
        source: 'خبر فوری'
      }
    ]
  },
  {
    name:    'sport_news_en',
    display: 'Sport News 🌍',
    lang:    'en',
    feeds: [
      { url: 'https://media.rss.com/world-cup-watchpoint/feed.xml', source: 'World Cup Watch' },
      { url: 'https://e00-marca.uecdn.es/rss/en/index.xml',         source: 'Marca EN'        }
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
  // media:content
  if (item.mediaContent) {
    const u = item.mediaContent?.$.url || item.mediaContent?.url;
    if (u) return u;
  }
  // media:thumbnail
  if (item.mediaThumbnail) {
    const u = item.mediaThumbnail?.$.url || item.mediaThumbnail?.url;
    if (u) return u;
  }
  // enclosure
  if (item.enclosure?.url) {
    const t = item.enclosure.type || '';
    if (t.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif)/i.test(item.enclosure.url))
      return item.enclosure.url;
  }
  // img tag inside description/content
  const html = item['content:encoded'] || item.content || item.description || '';
  const m    = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (m && m[1] && !m[1].startsWith('data:')) return m[1];
  return null;
}

function itemGuid(item) {
  return item.guid || item.link || item.title || `${Date.now()}-${Math.random()}`;
}

// ═══════════════════════════════════════════
// DB INIT — فقط یک جدول در Bot DB
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
  `);
  console.log('✅ bot_news table ready in Bot DB');
}

// ═══════════════════════════════════════════
// FETCH RSS & SAVE TO BOT DB ONLY
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
          guid,
          bot.name,
          bot.display,
          feed.source,
          bot.lang,
          title,
          item.link   || null,
          extractImage(item),
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

  console.log(`📦 ${total} new items saved to Bot DB (${Date.now() - t}ms)\n`);
}

// ═══════════════════════════════════════════
// AUTO CLEANUP — فقط از Bot DB پاک می‌کند
// ═══════════════════════════════════════════
async function cleanup() {
  const cutoff = new Date(Date.now() - NEWS_TTL_MIN * 60 * 1000);
  const r = await pool.query(
    'DELETE FROM bot_news WHERE created_at < $1 RETURNING id',
    [cutoff]
  );
  if (r.rows.length > 0)
    console.log(`🧹 Cleaned ${r.rows.length} old news (TTL: ${NEWS_TTL_MIN}min)`);
}

// ═══════════════════════════════════════════
// CRON JOBS
// ═══════════════════════════════════════════
cron.schedule(`*/${FETCH_MIN} * * * *`, runAllFeeds);
cron.schedule('*/10 * * * *',          cleanup);

// ═══════════════════════════════════════════
// API ENDPOINTS
// ═══════════════════════════════════════════

/**
 * GET /api/news
 * query: lang=fa|en  bot=khabar_varzeshi  limit=50
 * فرانت‌اند مستقیم از اینجا می‌خواند — هیچ ربطی به بک‌اند اصلی ندارد
 */
app.get('/api/news', async (req, res) => {
  try {
    const { lang, bot, limit = 50 } = req.query;
    const limitNum = Math.min(parseInt(limit) || 50, 100);

    const conditions = [];
    const params     = [];
    let   i          = 1;

    if (lang) { conditions.push(`lang = $${i++}`);     params.push(lang); }
    if (bot)  { conditions.push(`bot_name = $${i++}`); params.push(bot);  }

    const whereSQL = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(limitNum);

    const r = await pool.query(
      `SELECT id, bot_name, bot_display, source, lang,
              title, link, image_url, published_at, created_at
       FROM bot_news
       ${whereSQL}
       ORDER BY created_at DESC
       LIMIT $${i}`,
      params
    );

    res.json({ success: true, count: r.rows.length, news: r.rows });
  } catch (err) {
    console.error('❌ /api/news:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /health */
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    const r = await pool.query('SELECT COUNT(*) FROM bot_news');
    res.json({
      status:     'ok',
      news_total: parseInt(r.rows[0].count),
      ttl_min:    NEWS_TTL_MIN,
      fetch_min:  FETCH_MIN,
      bots:       BOTS.length,
      ts:         new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

/** GET / */
app.get('/', (req, res) => res.json({
  service:   'AJ Sports RSS Bot v2.0 — Isolated',
  endpoints: { news: '/api/news?lang=fa|en&limit=50', health: '/health' },
  bots:      BOTS.map(b => ({ name: b.name, display: b.display, feeds: b.feeds.length }))
}));

// ═══════════════════════════════════════════
// START
// ═══════════════════════════════════════════
async function start() {
  console.log('\n' + '═'.repeat(55));
  console.log('🤖 AJ Sports RSS Bot v2.0 — Isolated Mode');
  console.log('═'.repeat(55));
  console.log(`📦 Bot DB only — ZERO contact with main backend`);
  console.log(`⏰ Fetch every ${FETCH_MIN}min | TTL ${NEWS_TTL_MIN}min`);
  console.log('═'.repeat(55) + '\n');

  await initDB();

  app.listen(PORT, () => {
    console.log(`🚀 Bot server running on port ${PORT}`);
    console.log(`📡 News API: http://localhost:${PORT}/api/news\n`);
  });

  // اولین fetch بعد از ۶ ثانیه
  setTimeout(runAllFeeds, 6000);
}

start();

process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  await pool.end();
  process.exit(0);
});
