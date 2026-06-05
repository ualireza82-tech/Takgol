/**
 * AJ Sports 2026 - RSS News Bot Service
 * Version: 1.0.0
 * Deploy: Render (separate Web Service)
 *
 * Architecture:
 *   - Fetches RSS every 3 minutes
 *   - Posts as bot user accounts to main API
 *   - Auto-deletes tweets older than NEWS_TTL_MINUTES (default: 60)
 *   - Uses own Neon DB only for dedup tracking
 *   - Zero changes required to main backend or frontend
 */

require('dotenv').config();
const express  = require('express');
const { Pool } = require('pg');
const cron     = require('node-cron');
const Parser   = require('rss-parser');
const fetch    = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 4000;

// ============================================================
// ENVIRONMENT
// ============================================================
const MAIN_API        = (process.env.MAIN_API_URL || '').replace(/\/$/, '');
const BOT_DB_URL      = process.env.BOT_DATABASE_URL;
const NEWS_TTL_MIN    = parseInt(process.env.NEWS_TTL_MINUTES  || '60');   // Delete after X min
const FETCH_INTERVAL  = parseInt(process.env.FETCH_INTERVAL_MIN || '3');   // Fetch every X min
const MAX_ITEMS_FEED  = parseInt(process.env.MAX_ITEMS_PER_FEED || '5');   // Max new items per feed run
const BOT_SECRET      = process.env.BOT_SECRET || 'ajsports-rss-bot-2026'; // Simple auth header

if (!MAIN_API)    { console.error('❌ MAIN_API_URL is required'); process.exit(1); }
if (!BOT_DB_URL)  { console.error('❌ BOT_DATABASE_URL is required'); process.exit(1); }

// ============================================================
// BOT DATABASE (Separate Neon DB — stays tiny, auto-cleaned)
// ============================================================
const pool = new Pool({
  connectionString: BOT_DB_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000
});

pool.on('error', err => console.error('❌ Bot DB error:', err.message));

// ============================================================
// BOT ACCOUNT DEFINITIONS
// ============================================================
const BOT_ACCOUNTS = [

  // ---- Account 1: Persian general sports news ----
  {
    username:     'khabar_varzeshi',
    display_name: 'خبرورزشی 📰',
    email:        'khabar.varzeshi@ajsports.bot',
    avatar_url:   'https://ui-avatars.com/api/?name=%D8%AE%D8%A8%D8%B1%D9%88%D8%B1%D8%B2%D8%B4%DB%8C&background=d32f2f&color=fff&size=200&bold=true',
    lang:         'fa',
    feeds: [
      { url: 'https://www.irna.ir/rss/tp/14',              source: 'ایرنا'         },
      { url: 'https://www.khabaronline.ir/rss/tp/6',       source: 'خبرآنلاین'    },
      { url: 'https://kayhanvarzeshi.ir/fa/rss/allnews',   source: 'کیهان ورزشی'  },
      { url: 'https://www.tabnak.ir/fa/rss/2',             source: 'تابناک'        },
      { url: 'https://borna.news/fa/rss/7',                source: 'برنا'          }
    ]
  },

  // ---- Account 2: Persian breaking sports news ----
  {
    username:     'khabar_foori_sport',
    display_name: 'خبر فوری ورزشی ⚡',
    email:        'khabar.foori.sport@ajsports.bot',
    avatar_url:   'https://ui-avatars.com/api/?name=%D8%AE%D8%A8%D8%B1+%D9%81%D9%88%D8%B1%DB%8C&background=f57c00&color=fff&size=200&bold=true',
    lang:         'fa',
    feeds: [
      {
        url:    'https://www.khabarfoori.com/fa/feeds/?p=Y2F0ZWdvcmllcz0xNzMmZGF0ZVJhbmdlJTVCc3RhcnQlNUQ9LTYwNDgwMCZwb3NpdGlvbkZyb250PTQ%2C',
        source: 'خبر فوری'
      }
    ]
  },

  // ---- Account 3: English international sports news ----
  {
    username:     'sport_news_en',
    display_name: 'Sport News 🌍',
    email:        'sport.news.en@ajsports.bot',
    avatar_url:   'https://ui-avatars.com/api/?name=Sport+News&background=1565c0&color=fff&size=200&bold=true',
    lang:         'en',
    feeds: [
      { url: 'https://media.rss.com/world-cup-watchpoint/feed.xml',  source: 'World Cup Watch' },
      { url: 'https://e00-marca.uecdn.es/rss/en/index.xml',          source: 'Marca EN'        }
    ]
  }

];

// ============================================================
// RSS PARSER
// ============================================================
const rssParser = new Parser({
  timeout: 12000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; AJSportsRSSBot/1.0; +https://ajsports.ir)',
    'Accept':     'application/rss+xml, application/xml, text/xml, */*'
  },
  customFields: {
    item: [
      ['media:content',   'mediaContent',   { keepArray: false }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: false }],
      ['enclosure',       'enclosure']
    ]
  }
});

// ============================================================
// HELPERS
// ============================================================

/** Extract best available image URL from an RSS item */
function extractImage(item) {
  // media:content
  if (item.mediaContent) {
    if (typeof item.mediaContent === 'object') {
      const url = item.mediaContent?.$ ?.url || item.mediaContent?.url;
      if (url) return url;
    }
  }

  // media:thumbnail
  if (item.mediaThumbnail) {
    const url = item.mediaThumbnail?.$ ?.url || item.mediaThumbnail?.url;
    if (url) return url;
  }

  // enclosure (podcast/image)
  if (item.enclosure?.url) {
    const t = (item.enclosure.type || '');
    if (t.startsWith('image/') || item.enclosure.url.match(/\.(jpg|jpeg|png|webp|gif)/i)) {
      return item.enclosure.url;
    }
  }

  // Scan description / content HTML for <img>
  const html = item['content:encoded'] || item.content || item.description || '';
  if (html) {
    const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m && m[1] && !m[1].startsWith('data:')) return m[1];
  }

  return null;
}

/** Stable unique ID for deduplication */
function itemGuid(item) {
  return item.guid || item.link || item.title || `${Date.now()}-${Math.random()}`;
}

/** Truncate text safely */
function truncate(str, len) {
  if (!str) return '';
  str = str.trim().replace(/\s+/g, ' ');
  return str.length > len ? str.substring(0, len - 3) + '...' : str;
}

/** Build tweet text from RSS item */
function buildTweetContent(item, source, lang) {
  const title = truncate(item.title || '', 200);
  const link  = item.link || '';

  if (lang === 'fa') {
    return `📰 ${title}\n\n📌 منبع: ${source}\n🔗 ${link}`;
  }
  return `📰 ${title}\n\n📌 Source: ${source}\n🔗 ${link}`;
}

// ============================================================
// MAIN API CALLS
// ============================================================

async function apiPost(path, body) {
  const res = await fetch(`${MAIN_API}${path}`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-bot-secret': BOT_SECRET
    },
    body: JSON.stringify(body),
    timeout: 15000
  });
  return res.json();
}

async function apiDelete(path, body) {
  try {
    await fetch(`${MAIN_API}${path}`, {
      method:  'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'x-bot-secret': BOT_SECRET
      },
      body: JSON.stringify(body),
      timeout: 10000
    });
  } catch { /* ignore */ }
}

/** Register / sync bot accounts in main DB */
async function registerBotAccounts() {
  console.log('🤖 Registering bot accounts...');
  for (const bot of BOT_ACCOUNTS) {
    try {
      const data = await apiPost('/api/auth/sync', {
        email:        bot.email,
        username:     bot.username,
        display_name: bot.display_name,
        avatar_url:   bot.avatar_url
      });
      if (data.success) {
        console.log(`  ✅ ${bot.username} (${bot.display_name})`);
      } else {
        console.log(`  ⚠️  ${bot.username}: ${JSON.stringify(data)}`);
      }
    } catch (err) {
      console.error(`  ❌ ${bot.username}:`, err.message);
    }
  }
}

/** Post a tweet as a bot account. Returns tweet ID or null. */
// ✅ دیگه به Main API نمی‌فرستیم — فقط در Bot DB ذخیره میکنیم
async function postTweet(username, content, mediaUrl) {
  try {
    const result = await pool.query(
      `INSERT INTO rss_news_tweets 
       (username, content, media_url, created_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING id`,
      [username, content, mediaUrl || null]
    );
    const tweetId = result.rows[0]?.id;
    return tweetId;
  } catch (err) {
    console.error(`  ❌ postTweet error:`, err.message);
    return null;
  }
}

/** Delete a tweet by its owner */
async function deleteTweet(tweetId, username) {
  await apiDelete(`/api/tweets/${tweetId}`, { username });
}

// ============================================================
// DATABASE OPERATIONS
// ============================================================

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posted_items (
      id           SERIAL PRIMARY KEY,
      guid         TEXT        NOT NULL,
      bot_username TEXT        NOT NULL,
      tweet_id     INTEGER,
      feed_source  TEXT,
      posted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(guid, bot_username)
    );

    CREATE INDEX IF NOT EXISTS idx_pi_posted_at    ON posted_items (posted_at);
    CREATE INDEX IF NOT EXISTS idx_pi_bot_username ON posted_items (bot_username);
    CREATE INDEX IF NOT EXISTS idx_pi_guid_bot     ON posted_items (guid, bot_username);

    CREATE TABLE IF NOT EXISTS rss_news_tweets (
      id           SERIAL PRIMARY KEY,
      username     TEXT        NOT NULL,
      content      TEXT        NOT NULL,
      media_url    TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_rss_created_at ON rss_news_tweets (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_rss_username   ON rss_news_tweets (username);
  `);
  console.log('✅ Bot DB ready');
}

async function isAlreadyPosted(guid, botUsername) {
  const r = await pool.query(
    'SELECT 1 FROM posted_items WHERE guid = $1 AND bot_username = $2',
    [guid, botUsername]
  );
  return r.rows.length > 0;
}

async function savePostedItem(guid, botUsername, tweetId, feedSource) {
  await pool.query(
    `INSERT INTO posted_items (guid, bot_username, tweet_id, feed_source)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (guid, bot_username) DO NOTHING`,
    [guid, botUsername, tweetId, feedSource]
  );
}

// ============================================================
// CORE: FETCH + POST RSS
// ============================================================

async function processFeed(bot, feed) {
  let feedData;
  try {
    feedData = await rssParser.parseURL(feed.url);
  } catch (err) {
    console.error(`  ❌ RSS parse failed [${feed.source}]: ${err.message}`);
    return { posted: 0, skipped: 0, errors: 1 };
  }

  const items = (feedData.items || []).slice(0, MAX_ITEMS_FEED);
  let posted = 0, skipped = 0;

  for (const item of items) {
    const guid = itemGuid(item);

    if (await isAlreadyPosted(guid, bot.username)) {
      skipped++;
      continue;
    }

    const image   = extractImage(item);
    const content = buildTweetContent(item, feed.source, bot.lang);
    const tweetId = await postTweet(bot.username, content, image);

    await savePostedItem(guid, bot.username, tweetId, feed.source);
    posted++;

    console.log(`  📤 [${bot.username}] ${truncate(item.title, 60)}`);

    // Polite delay: don't spam the main API
    await new Promise(r => setTimeout(r, 1200));
  }

  return { posted, skipped, errors: 0 };
}

async function runAllFeeds() {
  const start = Date.now();
  console.log(`\n🔄 RSS fetch cycle — ${new Date().toISOString()}`);

  let totalPosted = 0;

  for (const bot of BOT_ACCOUNTS) {
    for (const feed of bot.feeds) {
      const result = await processFeed(bot, feed);
      totalPosted += result.posted;
      await new Promise(r => setTimeout(r, 600));
    }
  }

  console.log(`✅ Cycle done — ${totalPosted} new tweets — ${Date.now() - start}ms\n`);
}

// ============================================================
// CLEANUP: Delete expired tweets from main DB
// ============================================================



  if (expired.length === 0) return;

  console.log(`🧹 Cleaning ${expired.length} expired news tweets...`);

  for (const row of expired) {
    await deleteTweet(row.tweet_id, row.bot_username);
    await new Promise(r => setTimeout(r, 200));
  }

  // Remove from tracking DB
  await pool.query('DELETE FROM posted_items WHERE posted_at < $1', [cutoff]);

  console.log(`🧹 Done — ${expired.length} tweets deleted from main DB`);
}

// ============================================================
// CRON SCHEDULES
// ============================================================

// RSS fetch — every FETCH_INTERVAL minutes
cron.schedule(`*/${FETCH_INTERVAL} * * * *`, runAllFeeds);

// Cleanup — every 10 minutes
cron.schedule('*/10 * * * *', cleanupExpiredTweets);

// ============================================================
// HEALTH / STATUS ENDPOINTS
// ============================================================

app.get('/', async (req, res) => {
  let dbOk = false;
  let tracked = 0;
  try {
    const r = await pool.query('SELECT COUNT(*) FROM posted_items');
    tracked = parseInt(r.rows[0].count);
    dbOk = true;
  } catch {}

  res.json({
    service:           'AJ Sports RSS Bot v1.0',
    status:            dbOk ? 'healthy' : 'db_error',
    main_api:          MAIN_API,
    news_ttl_minutes:  NEWS_TTL_MIN,
    fetch_every_min:   FETCH_INTERVAL,
    tracked_items:     tracked,
    bots: BOT_ACCOUNTS.map(b => ({
      username:   b.username,
      lang:       b.lang,
      feed_count: b.feeds.length,
      sources:    b.feeds.map(f => f.source)
    }))
  });
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', ts: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ status: 'unhealthy', error: e.message });
  }
});

// Manual trigger endpoint (protect with secret)
app.post('/trigger/fetch', async (req, res) => {
  const auth = req.headers['x-bot-secret'];
  if (auth !== BOT_SECRET) return res.status(403).json({ error: 'forbidden' });
  runAllFeeds().catch(console.error);
  res.json({ message: 'fetch triggered' });
});

app.post('/trigger/cleanup', async (req, res) => {
  const auth = req.headers['x-bot-secret'];
  if (auth !== BOT_SECRET) return res.status(403).json({ error: 'forbidden' });
  cleanupExpiredTweets().catch(console.error);
  res.json({ message: 'cleanup triggered' });
});
app.get('/api/news', async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  || '30'), 100);
  const offset = parseInt(req.query.offset || '0');
  const lang   = req.query.lang || null;

  try {
    let whereClause = `WHERE t.created_at > NOW() - INTERVAL '${NEWS_TTL_MIN} minutes'`;
    const params = [limit, offset];

    if (lang) {
      const usernames = BOT_ACCOUNTS
        .filter(b => b.lang === lang)
        .map(b => b.username);
      if (usernames.length === 0) {
        return res.json({ success: true, news: [], total: 0 });
      }
      const placeholders = usernames.map((_, i) => `$${i + 3}`).join(',');
      whereClause += ` AND t.username IN (${placeholders})`;
      params.push(...usernames);
    }

    const r = await pool.query(
      `SELECT t.id, t.username, t.content, t.media_url, t.created_at
       FROM rss_news_tweets t
       ${whereClause}
       ORDER BY t.created_at DESC
       LIMIT $1 OFFSET $2`,
      params
    );

    // اضافه کردن اطلاعات بات به هر توییت
    const botMap = {};
    BOT_ACCOUNTS.forEach(b => {
      botMap[b.username] = { display_name: b.display_name, avatar_url: b.avatar_url, lang: b.lang };
    });

    const news = r.rows.map(row => ({
      ...row,
      display_name: botMap[row.username]?.display_name || row.username,
      avatar_url:   botMap[row.username]?.avatar_url   || null,
      lang:         botMap[row.username]?.lang          || 'fa',
    }));

    res.json({ success: true, news, total: news.length });
  } catch (err) {
    console.error('❌ /api/news error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// STARTUP
// ============================================================

async function start() {
  console.log('='.repeat(60));
  console.log('🤖 AJ Sports RSS Bot v1.0');
  console.log('='.repeat(60));
  console.log(`📡 Main API    : ${MAIN_API}`);
  console.log(`⏰ Fetch every : ${FETCH_INTERVAL} minutes`);
  console.log(`🗑️  TTL         : ${NEWS_TTL_MIN} minutes`);
  console.log(`👥 Bot accounts: ${BOT_ACCOUNTS.length}`);
  console.log('='.repeat(60) + '\n');

  try {
    await initDB();
    await registerBotAccounts();

    app.listen(PORT, () => {
      console.log(`\n🚀 Bot server running on port ${PORT}`);
    });

    // Initial fetch after 10s startup delay
    setTimeout(runAllFeeds, 10000);

  } catch (err) {
    console.error('❌ Fatal startup error:', err);
    process.exit(1);
  }
}

start();

process.on('SIGTERM', async () => {
  console.log('SIGTERM received — shutting down gracefully');
  await pool.end();
  process.exit(0);
});
