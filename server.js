/**
 * AJ Sports 2026 — RSS Bot Server v3.4 ⚡ MEGA FEEDS + SMART HASHTAGS
 *
 * ✅ In-Memory Cache: ۲۰ میلیون کاربر فقط RAM را می‌خوانند — صفر Query به DB
 * ✅ Cache-Control headers: Cloudflare این API را 5 دقیقه Edge Cache می‌کند
 * ✅ Stampede Protection: اگر ۱۰۰۰ کاربر همزمان cache منقضی کنند، فقط ۱ DB query می‌رود
 * ✅ Background Refresh: Cron job در پس‌زمینه cache را تازه می‌کند
 * ✅ RSS → فقط bot_news در Bot DB ذخیره می‌شود
 * ✅ دارای سیستم ایزوله لایک و کامنت با حذف خودکار (Cascade)
 * ✅ [UPDATE v3.2] ترجمه ۱۰۰٪ رایگان و بدون لیمیت با Google Translate Bypass
 *    - بدون نیاز به هیچ گونه API Key (حذف وابستگی به Gemini)
 *    - In-Memory Translation Cache: هر متن فقط یک بار ترجمه می‌شود
 *    - Rate-Limit Safe: دارای سیستم Fallback (بازگشت متن اصلی در صورت قطعی شبکه)
 * ✅ [UPDATE v3.3] افزودن Live Fan Rooms Proxy (APIFootball Cached Endpoint)
 *    - بدون هیچ تغییری در منطق RSS / لایک / کامنت / ترجمه قبلی
 *    - فقط افزونه: GET /live_matches.json (کش‌شده، هر ۵ دقیقه)
 * ✅ [UPDATE v3.4] افزودن فیدهای بین‌المللی گسترده + هوش مصنوعی هشتگ
 *    - ۲۵+ اکانت بات جدید با فیدهای EN / FR / AR / DE / ES / PT / IT
 *    - فیدهای تخصصی جام جهانی ۲۰۲۶ از منابع مختلف زبانی
 *    - Smart Hashtag Engine: تولید خودکار ۳-۵ هشتگ مرتبط برای هر خبر
 *    - بدون هیچ تداخلی با منطق قبلی — فقط افزونه
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

// ── [NEW v3.3] Live Fan Rooms ENV ───────────────────────────────────
const APIFOOTBALL_KEY      = process.env.APIFOOTBALL_KEY;
const LIVE_MATCHES_FETCH_MIN = parseInt(process.env.LIVE_MATCHES_FETCH_MIN || '5');

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
// 🌐 [NEW] TRANSLATION CACHE — جلوگیری از درخواست‌های تکراری
// کلید: متن اصلی (trim شده) — مقدار: ترجمه فارسی
// ═══════════════════════════════════════════
const translationCache = new Map();
const TRANSLATION_CACHE_MAX = 5000;

// ═══════════════════════════════════════════
// 🔴 [NEW v3.3] LIVE FAN ROOMS — IN-MEMORY CACHE
// ═══════════════════════════════════════════
const liveMatchesCache = {
  matches: [],
  updatedAt: 0,
  isRefreshing: false
};

// ═══════════════════════════════════════════
// 🤖 BOT PROFILE MAP
// ═══════════════════════════════════════════
const BOT_PROFILES = {
  // ── فارسی ──────────────────────────────────────────────────────────
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
  // ── جام جهانی ۲۰۲۶ ─────────────────────────────────────────────
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
  worldcup_fr: {
    avatar_url:   'https://ui-avatars.com/api/?name=CM+2026&background=002395&color=FFD700&size=128&bold=true&rounded=true',
    display_name: 'Coupe du Monde 2026 🇫🇷',
    username:     'worldcup_fr',
    verification: 'gold'
  },
  worldcup_ar: {
    avatar_url:   'https://ui-avatars.com/api/?name=%D9%83%D8%A3%D8%B3+2026&background=006600&color=fff&size=128&bold=true&rounded=true',
    display_name: 'كأس العالم ٢٠٢٦ 🌙',
    username:     'worldcup_ar',
    verification: 'gold'
  },
  worldcup_de: {
    avatar_url:   'https://ui-avatars.com/api/?name=WM+2026&background=000000&color=FFD700&size=128&bold=true&rounded=true',
    display_name: 'WM 2026 Deutschland 🇩🇪',
    username:     'worldcup_de',
    verification: 'gold'
  },
  worldcup_es: {
    avatar_url:   'https://ui-avatars.com/api/?name=CM+ES&background=aa151b&color=FFD700&size=128&bold=true&rounded=true',
    display_name: 'Copa del Mundo 2026 🇪🇸',
    username:     'worldcup_es',
    verification: 'gold'
  },
  worldcup_pt: {
    avatar_url:   'https://ui-avatars.com/api/?name=CM+PT&background=006600&color=FFD700&size=128&bold=true&rounded=true',
    display_name: 'Copa do Mundo 2026 🇧🇷',
    username:     'worldcup_pt',
    verification: 'gold'
  },
  worldcup_it: {
    avatar_url:   'https://ui-avatars.com/api/?name=CM+IT&background=009246&color=fff&size=128&bold=true&rounded=true',
    display_name: 'Coppa del Mondo 2026 🇮🇹',
    username:     'worldcup_it',
    verification: 'gold'
  },
  // ── انگلیسی ─────────────────────────────────────────────────────
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
  },
  the_guardian_sport: {
    avatar_url:   'https://ui-avatars.com/api/?name=Guardian&background=052962&color=fff&size=128&bold=true&rounded=true',
    display_name: 'The Guardian Sport 🗞️',
    username:     'the_guardian_sport',
    verification: 'gold'
  },
  eurosport_en: {
    avatar_url:   'https://ui-avatars.com/api/?name=Euro&background=e53935&color=fff&size=128&bold=true&rounded=true',
    display_name: 'Eurosport EN 🌍',
    username:     'eurosport_en',
    verification: 'gold'
  },
  the_athletic: {
    avatar_url:   'https://ui-avatars.com/api/?name=Athletic&background=111827&color=fff&size=128&bold=true&rounded=true',
    display_name: 'The Athletic ⚡',
    username:     'the_athletic',
    verification: 'gold'
  },
  // ── فرانسوی ─────────────────────────────────────────────────────
  lequipe_fr: {
    avatar_url:   'https://ui-avatars.com/api/?name=L+Equipe&background=003399&color=fff&size=128&bold=true&rounded=true',
    display_name: "L'Équipe 🇫🇷",
    username:     'lequipe_fr',
    verification: 'gold'
  },
  eurosport_fr: {
    avatar_url:   'https://ui-avatars.com/api/?name=Euro+FR&background=e53935&color=FFD700&size=128&bold=true&rounded=true',
    display_name: 'Eurosport FR 🇫🇷',
    username:     'eurosport_fr',
    verification: 'gold'
  },
  // ── عربی ────────────────────────────────────────────────────────
  bein_sports_ar: {
    avatar_url:   'https://ui-avatars.com/api/?name=beIN&background=7b1fa2&color=fff&size=128&bold=true&rounded=true',
    display_name: 'beIN Sports عربي 📺',
    username:     'bein_sports_ar',
    verification: 'gold'
  },
  kooora_ar: {
    avatar_url:   'https://ui-avatars.com/api/?name=%D9%83%D9%88%D8%B1%D8%A9&background=00796b&color=fff&size=128&bold=true&rounded=true',
    display_name: 'كووورة ⚽',
    username:     'kooora_ar',
    verification: 'gold'
  },
  // ── آلمانی ──────────────────────────────────────────────────────
  sport_bild_de: {
    avatar_url:   'https://ui-avatars.com/api/?name=BILD+Sport&background=e30613&color=fff&size=128&bold=true&rounded=true',
    display_name: 'Sport BILD 🇩🇪',
    username:     'sport_bild_de',
    verification: 'gold'
  },
  kicker_de: {
    avatar_url:   'https://ui-avatars.com/api/?name=kicker&background=FF6600&color=fff&size=128&bold=true&rounded=true',
    display_name: 'kicker 🇩🇪',
    username:     'kicker_de',
    verification: 'gold'
  },
  // ── اسپانیایی ──────────────────────────────────────────────────
  as_es: {
    avatar_url:   'https://ui-avatars.com/api/?name=AS+Sport&background=cc0000&color=fff&size=128&bold=true&rounded=true',
    display_name: 'AS Sport 🇪🇸',
    username:     'as_es',
    verification: 'gold'
  },
  sport_es: {
    avatar_url:   'https://ui-avatars.com/api/?name=Sport+ES&background=004fa3&color=fff&size=128&bold=true&rounded=true',
    display_name: 'Sport.es 🇪🇸',
    username:     'sport_es',
    verification: 'gold'
  },
  // ── ایتالیایی ──────────────────────────────────────────────────
  gazzetta_it: {
    avatar_url:   'https://ui-avatars.com/api/?name=Gazzetta&background=e60026&color=fff&size=128&bold=true&rounded=true',
    display_name: 'Gazzetta dello Sport 🇮🇹',
    username:     'gazzetta_it',
    verification: 'gold'
  },
  // ── پرتغالی/برزیلی ─────────────────────────────────────────────
  globoesporte_pt: {
    avatar_url:   'https://ui-avatars.com/api/?name=Globo&background=009c3b&color=FFD700&size=128&bold=true&rounded=true',
    display_name: 'Globo Esporte 🇧🇷',
    username:     'globoesporte_pt',
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

// ═══════════════════════════════════════════
// 🤖 BOTS — فیدهای گسترده بین‌المللی
// ═══════════════════════════════════════════
const BOTS = [
  // ── فارسی ──────────────────────────────────────────────────────────
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

  // ── جام جهانی ۲۰۲۶ — چند‌زبانه ────────────────────────────────────
  {
    name:    'fifa_worldcup2026',
    display: 'FIFA World Cup 2026 🏆',
    lang:    'en',
    feeds: [
      { url: 'https://news.google.com/rss/search?q=FIFA+World+Cup+2026&hl=en-US&gl=US&ceid=US:en',              source: 'Google News WC2026'  },
      { url: 'https://news.google.com/rss/search?q=World+Cup+2026+goal+match&hl=en-US&gl=US&ceid=US:en',        source: 'WC2026 Matches'      },
      { url: 'https://news.google.com/rss/search?q=WorldCup2026+FIFA+schedule+result&hl=en&gl=US&ceid=US:en',   source: 'WC2026 Schedule'     },
      { url: 'https://www.fifa.com/fifaplus/en/articles/rss',                                                    source: 'FIFA Official'       }
    ]
  },
  {
    name:    'worldcup_news',
    display: 'World Cup 2026 ⚽',
    lang:    'en',
    feeds: [
      { url: 'https://news.google.com/rss/search?q=worldcup2026+football&hl=en&gl=US&ceid=US:en',              source: 'WC News'         },
      { url: 'https://media.rss.com/world-cup-watchpoint/feed.xml',                                             source: 'WC Watchpoint'   },
      { url: 'https://news.google.com/rss/search?q=%22World+Cup+2026%22+final+winner&hl=en&gl=US&ceid=US:en',  source: 'WC Final'        }
    ]
  },
  {
    name:    'worldcup_fr',
    display: 'Coupe du Monde 2026 🇫🇷',
    lang:    'fr',
    feeds: [
      { url: 'https://news.google.com/rss/search?q=Coupe+du+Monde+2026&hl=fr&gl=FR&ceid=FR:fr',               source: 'Google Actu CM2026' },
      { url: 'https://news.google.com/rss/search?q=%22Mondial+2026%22+football&hl=fr&gl=FR&ceid=FR:fr',        source: 'Mondial 2026 FR'    },
      { url: 'https://www.lequipe.fr/rss/actu_rss.xml',                                                        source: "L'Équipe"           }
    ]
  },
  {
    name:    'worldcup_ar',
    display: 'كأس العالم ٢٠٢٦ 🌙',
    lang:    'ar',
    feeds: [
      { url: 'https://news.google.com/rss/search?q=%D9%83%D8%A3%D8%B3+%D8%A7%D9%84%D8%B9%D8%A7%D9%84%D9%85+2026&hl=ar&gl=SA&ceid=SA:ar', source: 'أخبار كأس العالم' },
      { url: 'https://news.google.com/rss/search?q=%22World+Cup+2026%22&hl=ar&gl=SA&ceid=SA:ar',                                              source: 'Google AR WC'    },
      { url: 'https://www.bbc.com/arabic/sport/index.xml',                                                                                     source: 'BBC عربي'        }
    ]
  },
  {
    name:    'worldcup_de',
    display: 'WM 2026 Deutschland 🇩🇪',
    lang:    'de',
    feeds: [
      { url: 'https://news.google.com/rss/search?q=WM+2026+Fussball&hl=de&gl=DE&ceid=DE:de',                 source: 'Google WM 2026'   },
      { url: 'https://news.google.com/rss/search?q=%22Weltmeisterschaft+2026%22&hl=de&gl=DE&ceid=DE:de',     source: 'WM 2026 DE'       },
      { url: 'https://www.kicker.de/news/fussball/intligen/rss/news.rss',                                     source: 'kicker WM'        }
    ]
  },
  {
    name:    'worldcup_es',
    display: 'Copa del Mundo 2026 🇪🇸',
    lang:    'es',
    feeds: [
      { url: 'https://news.google.com/rss/search?q=Copa+del+Mundo+2026&hl=es&gl=ES&ceid=ES:es',              source: 'Google CM 2026 ES' },
      { url: 'https://news.google.com/rss/search?q=%22Mundial+2026%22+futbol&hl=es&gl=ES&ceid=ES:es',        source: 'Mundial 2026 ES'   },
      { url: 'https://as.com/rss/tags/copa_del_mundo.xml',                                                    source: 'AS Mundial'        }
    ]
  },
  {
    name:    'worldcup_pt',
    display: 'Copa do Mundo 2026 🇧🇷',
    lang:    'pt',
    feeds: [
      { url: 'https://news.google.com/rss/search?q=Copa+do+Mundo+2026&hl=pt-BR&gl=BR&ceid=BR:pt-419',       source: 'Google CM 2026 PT' },
      { url: 'https://news.google.com/rss/search?q=%22Mundial+2026%22+futebol&hl=pt-BR&gl=BR&ceid=BR:pt-419', source: 'Mundial 2026 PT'  },
      { url: 'https://ge.globo.com/rss/feed.xml',                                                             source: 'Globo Esporte'     }
    ]
  },
  {
    name:    'worldcup_it',
    display: 'Coppa del Mondo 2026 🇮🇹',
    lang:    'it',
    feeds: [
      { url: 'https://news.google.com/rss/search?q=Mondiale+2026+calcio&hl=it&gl=IT&ceid=IT:it',             source: 'Google Mondiale IT' },
      { url: 'https://news.google.com/rss/search?q=%22Coppa+del+Mondo+2026%22&hl=it&gl=IT&ceid=IT:it',      source: 'CM 2026 IT'         }
    ]
  },

  // ── انگلیسی ─────────────────────────────────────────────────────
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
      { url: 'https://www.90min.com/feed',       source: '90min'      },
      { url: 'https://soccerlens.com/feed',      source: 'SoccerLens' }
    ]
  },
  {
    name:    'marca_en',
    display: 'MARCA EN 🇪🇸',
    lang:    'en',
    feeds: [
      { url: 'https://e00-marca.uecdn.es/rss/en/index.xml',      source: 'Marca EN'    },
      { url: 'https://www.fourfourtwo.com/rss',                   source: 'FourFourTwo' }
    ]
  },
  {
    name:    'sport_news_en',
    display: 'Sport News 🌍',
    lang:    'en',
    feeds: [
      { url: 'https://www.cbssports.com/rss/headlines/soccer/',  source: 'CBS Soccer'  },
      { url: 'https://www.espn.com/espn/rss/soccer/news',        source: 'ESPN Soccer' }
    ]
  },
  {
    name:    'transfermarkt',
    display: 'Transfermarkt 💰',
    lang:    'en',
    feeds: [
      { url: 'https://news.google.com/rss/search?q=football+transfer+2026&hl=en&gl=US&ceid=US:en', source: 'Transfer News'  },
      { url: 'https://www.caughtoffside.com/feed/',               source: 'CaughtOffside' }
    ]
  },
  {
    name:    'the_guardian_sport',
    display: 'The Guardian Sport 🗞️',
    lang:    'en',
    feeds: [
      { url: 'https://www.theguardian.com/football/rss',                          source: 'Guardian Football'     },
      { url: 'https://www.theguardian.com/sport/worldcup/rss',                    source: 'Guardian World Cup'    },
      { url: 'https://www.theguardian.com/football/championsleague/rss',          source: 'Guardian UCL'          }
    ]
  },
  {
    name:    'eurosport_en',
    display: 'Eurosport EN 🌍',
    lang:    'en',
    feeds: [
      { url: 'https://www.eurosport.com/football/rss.xml',                         source: 'Eurosport Football'    },
      { url: 'https://news.google.com/rss/search?q=eurosport+football+2026&hl=en&gl=US&ceid=US:en', source: 'Eurosport GN' }
    ]
  },
  {
    name:    'the_athletic',
    display: 'The Athletic ⚡',
    lang:    'en',
    feeds: [
      { url: 'https://news.google.com/rss/search?q=site:theathletic.com+football&hl=en&gl=US&ceid=US:en', source: 'The Athletic'     },
      { url: 'https://www.football365.com/feed',                                                           source: 'Football365'      },
      { url: 'https://talksport.com/feed/',                                                                 source: 'talkSPORT'        }
    ]
  },

  // ── فرانسوی ─────────────────────────────────────────────────────
  {
    name:    'lequipe_fr',
    display: "L'Équipe 🇫🇷",
    lang:    'fr',
    feeds: [
      { url: 'https://www.lequipe.fr/rss/actu_rss.xml',                                                       source: "L'Équipe"         },
      { url: 'https://news.google.com/rss/search?q=football+ligue+1+2026&hl=fr&gl=FR&ceid=FR:fr',            source: 'Ligue 1 FR'      }
    ]
  },
  {
    name:    'eurosport_fr',
    display: 'Eurosport FR 🇫🇷',
    lang:    'fr',
    feeds: [
      { url: 'https://www.eurosport.fr/football/rss.xml',                                                      source: 'Eurosport FR'    },
      { url: 'https://news.google.com/rss/search?q=football+france+2026&hl=fr&gl=FR&ceid=FR:fr',             source: 'Foot FR'         }
    ]
  },

  // ── عربی ────────────────────────────────────────────────────────
  {
    name:    'bein_sports_ar',
    display: 'beIN Sports عربي 📺',
    lang:    'ar',
    feeds: [
      { url: 'https://www.bein.com/ar/rss/news.xml',                                                           source: 'beIN Sports AR'   },
      { url: 'https://news.google.com/rss/search?q=%D9%83%D8%B1%D8%A9+%D8%A7%D9%84%D9%82%D8%AF%D9%85+2026&hl=ar&gl=SA&ceid=SA:ar', source: 'كرة القدم AR' }
    ]
  },
  {
    name:    'kooora_ar',
    display: 'كووورة ⚽',
    lang:    'ar',
    feeds: [
      { url: 'https://www.kooora.com/?rss',                                                                    source: 'كووورة'          },
      { url: 'https://news.google.com/rss/search?q=%D8%A7%D9%84%D8%AF%D9%88%D8%B1%D9%8A+%D8%A7%D9%84%D8%B9%D8%B1%D8%A8%D9%8A&hl=ar&gl=SA&ceid=SA:ar', source: 'الدوري العربي' }
    ]
  },

  // ── آلمانی ──────────────────────────────────────────────────────
  {
    name:    'kicker_de',
    display: 'kicker 🇩🇪',
    lang:    'de',
    feeds: [
      { url: 'https://www.kicker.de/news/fussball/intligen/rss/news.rss',                                     source: 'kicker International' },
      { url: 'https://www.kicker.de/news/fussball/bundesliga/rss/news.rss',                                   source: 'kicker Bundesliga'    },
      { url: 'https://news.google.com/rss/search?q=Fussball+Bundesliga+2026&hl=de&gl=DE&ceid=DE:de',         source: 'Bundesliga GN'        }
    ]
  },
  {
    name:    'sport_bild_de',
    display: 'Sport BILD 🇩🇪',
    lang:    'de',
    feeds: [
      { url: 'https://news.google.com/rss/search?q=sport+fussball+aktuell&hl=de&gl=DE&ceid=DE:de',           source: 'Sport DE Aktuell'  },
      { url: 'https://www.spox.com/rss/fussball.xml',                                                         source: 'SPOX Fußball'      }
    ]
  },

  // ── اسپانیایی ──────────────────────────────────────────────────
  {
    name:    'as_es',
    display: 'AS Sport 🇪🇸',
    lang:    'es',
    feeds: [
      { url: 'https://as.com/rss/tags/ultimas_noticias.xml',                                                   source: 'AS Últimas'     },
      { url: 'https://as.com/rss/tags/futbol.xml',                                                             source: 'AS Fútbol'      },
      { url: 'https://news.google.com/rss/search?q=futbol+liga+espanola+2026&hl=es&gl=ES&ceid=ES:es',        source: 'La Liga GN'     }
    ]
  },
  {
    name:    'sport_es',
    display: 'Sport.es 🇪🇸',
    lang:    'es',
    feeds: [
      { url: 'https://www.sport.es/es/rss/sport-es.xml',                                                      source: 'Sport.es'        },
      { url: 'https://www.mundodeportivo.com/rss/home.xml',                                                    source: 'Mundo Deportivo' }
    ]
  },

  // ── ایتالیایی ──────────────────────────────────────────────────
  {
    name:    'gazzetta_it',
    display: 'Gazzetta dello Sport 🇮🇹',
    lang:    'it',
    feeds: [
      { url: 'https://www.gazzetta.it/rss/calcio.xml',                                                         source: 'Gazzetta Calcio'   },
      { url: 'https://news.google.com/rss/search?q=calcio+serie+a+2026&hl=it&gl=IT&ceid=IT:it',              source: 'Serie A GN'        },
      { url: 'https://www.corrieredellosport.it/rss',                                                           source: 'Corriere Sport'    }
    ]
  },

  // ── پرتغالی/برزیلی ─────────────────────────────────────────────
  {
    name:    'globoesporte_pt',
    display: 'Globo Esporte 🇧🇷',
    lang:    'pt',
    feeds: [
      { url: 'https://ge.globo.com/rss/feed.xml',                                                              source: 'Globo Esporte'     },
      { url: 'https://news.google.com/rss/search?q=futebol+brasileiro+2026&hl=pt-BR&gl=BR&ceid=BR:pt-419',   source: 'Futebol BR'        },
      { url: 'https://www.record.pt/rss',                                                                      source: 'Record PT'         }
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
// 🏷️ [NEW v3.4] SMART HASHTAG ENGINE
// تولید خودکار ۳-۵ هشتگ مرتبط با محتوای هر خبر
// بدون API — بر اساس تطبیق کلیدواژه‌های چندزبانه
// ═══════════════════════════════════════════

// دیکشنری هشتگ‌ها: [کلیدواژه‌های چندزبانه] → هشتگ فارسی + انگلیسی
const HASHTAG_RULES = [
  // ── جام جهانی ──────────────────────────────────────────────────────
  { keys: ['world cup','worldcup','coupe du monde','كأس العالم','wm 2026','copa del mundo','coppa del mondo','copa do mundo','mondial','weltmeisterschaft'], tags: ['#جام_جهانی_۲۰۲۶','#WorldCup2026','#FIFA2026'] },
  { keys: ['fifa'],                        tags: ['#FIFA','#جام_جهانی'] },
  { keys: ['usa','united states','canada','mexico','host city','venue'],  tags: ['#USA2026','#میزبان_جام_جهانی'] },
  { keys: ['group stage','مرحله گروهی','phase de groupes','مرحلة المجموعات'], tags: ['#مرحله_گروهی','#GroupStage'] },
  { keys: ['final','فینال','finale','نهائي'],   tags: ['#فینال','#Final'] },
  { keys: ['semifinal','نیمه‌نهایی','demi-finale','نصف نهائي'], tags: ['#نیمه_نهایی','#Semifinal'] },

  // ── لیگ‌های بزرگ ────────────────────────────────────────────────
  { keys: ['premier league','premiership','epl'],                          tags: ['#PremierLeague','#لیگ_برتر_انگلیس'] },
  { keys: ['la liga','laliga'],                                             tags: ['#LaLiga','#لیگ_اسپانیا'] },
  { keys: ['bundesliga','bunde'],                                           tags: ['#Bundesliga','#لیگ_آلمان'] },
  { keys: ['serie a','seriea'],                                             tags: ['#SerieA','#لیگ_ایتالیا'] },
  { keys: ['ligue 1','ligue1'],                                             tags: ['#Ligue1','#لیگ_فرانسه'] },
  { keys: ['champions league','ucl','liga dos campeões','liga de campeones'], tags: ['#ChampionsLeague','#لیگ_قهرمانان'] },
  { keys: ['europa league','uel'],                                          tags: ['#EuropaLeague','#لیگ_اروپا'] },
  { keys: ['liga iran','لیگ ایران','آزادگان'],                              tags: ['#لیگ_ایران','#IranLeague'] },
  { keys: ['مجلس','لیگ برتر ایران'],                                        tags: ['#لیگ_برتر_ایران'] },

  // ── تیم‌های بزرگ ────────────────────────────────────────────────
  { keys: ['real madrid','رئال مادرید','real'],                             tags: ['#RealMadrid','#رئال_مادرید'] },
  { keys: ['barcelona','بارسلونا','barça','barca'],                         tags: ['#Barcelona','#بارسلونا'] },
  { keys: ['manchester united','man united','man utd'],                     tags: ['#ManUnited','#منچستر_یونایتد'] },
  { keys: ['manchester city','man city'],                                   tags: ['#ManCity','#منچستر_سیتی'] },
  { keys: ['liverpool'],                                                     tags: ['#Liverpool','#لیورپول'] },
  { keys: ['arsenal'],                                                       tags: ['#Arsenal','#آرسنال'] },
  { keys: ['chelsea'],                                                       tags: ['#Chelsea','#چلسی'] },
  { keys: ['psg','paris saint','paris saint-germain'],                      tags: ['#PSG','#پاری_سن_ژرمن'] },
  { keys: ['bayern','بایرن'],                                               tags: ['#BayernMunich','#بایرن_مونیخ'] },
  { keys: ['juventus','يوفنتوس','یوونتوس'],                                 tags: ['#Juventus','#یووه'] },
  { keys: ['inter milan','اینتر'],                                          tags: ['#InterMilan','#اینتر_میلان'] },
  { keys: ['ac milan','آث میلان','milan'],                                  tags: ['#ACMilan','#میلان'] },
  { keys: ['atletico','اتلتیکو'],                                           tags: ['#Atletico','#اتلتیکو_مادرید'] },
  { keys: ['dortmund','بوروسیا'],                                           tags: ['#BVB','#دورتموند'] },
  { keys: ['استقلال'],                                                       tags: ['#استقلال','#Esteghlal'] },
  { keys: ['پرسپولیس'],                                                      tags: ['#پرسپولیس','#Persepolis'] },

  // ── ستاره‌های فوتبال ─────────────────────────────────────────────
  { keys: ['mbappe','مبابه','mbappé'],                                      tags: ['#Mbappe','#مبابه'] },
  { keys: ['haaland','هالند'],                                              tags: ['#Haaland','#هالند'] },
  { keys: ['vinicius','ویینیسیوس'],                                          tags: ['#Vinicius','#ویینیسیوس'] },
  { keys: ['bellingham','بلینگهام'],                                         tags: ['#Bellingham','#بلینگهام'] },
  { keys: ['ronaldo','رونالدو'],                                             tags: ['#Ronaldo','#رونالدو'] },
  { keys: ['messi','مسی'],                                                   tags: ['#Messi','#مسی'] },
  { keys: ['neymar','نیمار'],                                                tags: ['#Neymar','#نیمار'] },
  { keys: ['salah','صلاح'],                                                  tags: ['#Salah','#صلاح'] },

  // ── رویدادهای فوتبالی ───────────────────────────────────────────
  { keys: ['transfer','نقل و انتقال','mercato','انتقال'],                    tags: ['#نقل_و_انتقال','#Transfer'] },
  { keys: ['injury','مصدومیت','blessure','lesión','verletzung','infortuni'], tags: ['#مصدومیت','#Injury'] },
  { keys: ['goal','گل','but ','tor ','gol '],                               tags: ['#گل','#Goal'] },
  { keys: ['red card','کارت قرمز','carton rouge','tarjeta roja'],            tags: ['#کارت_قرمز','#RedCard'] },
  { keys: ['penalty','پنالتی','penalti','pénalty'],                          tags: ['#پنالتی','#Penalty'] },
  { keys: ['hat trick','هتریک'],                                             tags: ['#هتریک','#HatTrick'] },
  { keys: ['manager','coach','مربی','entraîneur','entrenador','allenatore'], tags: ['#مربی','#Coach'] },
  { keys: ['contract','قرارداد','contrat','contrato'],                       tags: ['#قرارداد','#Contract'] },
  { keys: ['press conference','کنفرانس','conférence'],                       tags: ['#کنفرانس_خبری','#PressConference'] },

  // ── تیم‌های ملی ─────────────────────────────────────────────────
  { keys: ['iran','تیم ملی ایران'],                                          tags: ['#تیم_ملی_ایران','#IranFootball'] },
  { keys: ['france','فرانسه'],                                               tags: ['#France','#تیم_فرانسه'] },
  { keys: ['brazil','برزیل','brasil'],                                       tags: ['#Brazil','#برزیل'] },
  { keys: ['argentina','آرژانتین'],                                          tags: ['#Argentina','#آرژانتین'] },
  { keys: ['england','انگلیس'],                                              tags: ['#England','#تیم_انگلیس'] },
  { keys: ['germany','آلمان','deutschland'],                                  tags: ['#Germany','#آلمان'] },
  { keys: ['spain','اسپانیا','espana','españa'],                             tags: ['#Spain','#اسپانیا'] },
  { keys: ['portugal','پرتغال'],                                             tags: ['#Portugal','#پرتغال'] },
  { keys: ['italy','ایتالیا','italia'],                                      tags: ['#Italy','#ایتالیا'] },
  { keys: ['netherlands','هلند'],                                            tags: ['#Netherlands','#هلند'] },
  { keys: ['morocco','مراکش','maroc'],                                       tags: ['#Morocco','#مراکش'] },
  { keys: ['saudi','عربستان'],                                               tags: ['#SaudiArabia','#عربستان'] },
  { keys: ['japan','ژاپن'],                                                  tags: ['#Japan','#ژاپن'] },
  { keys: ['usa team','team usa','usmnt'],                                   tags: ['#USMNT','#آمریکا'] },

  // ── عمومی ─────────────────────────────────────────────────────
  { keys: ['football','soccer','فوتبال','futebol','calcio','fútbol','fussball'], tags: ['#فوتبال','#Football'] },
  { keys: ['breaking','فوری','آخرین خبر','عاجل'],                            tags: ['#خبر_فوری','#Breaking'] },
  { keys: ['live','زنده','en direct','en vivo'],                             tags: ['#زنده','#Live'] },
  { keys: ['result','نتیجه','resultado','résultat'],                          tags: ['#نتایج','#Results'] }
];

/**
 * تولید هشتگ‌های هوشمند برای یک خبر
 * @param {string} title  — عنوان خبر
 * @param {string} botName — نام بات (برای هشتگ اضافی منبع)
 * @param {string} lang — زبان اصلی بات
 * @returns {string[]} آرایه‌ای از هشتگ‌ها (۳ تا ۵ عدد)
 */
function generateHashtags(title, botName, lang) {
  if (!title) return [];

  const lowerTitle = title.toLowerCase();
  const matched    = new Set();

  for (const rule of HASHTAG_RULES) {
    if (rule.keys.some(k => lowerTitle.includes(k.toLowerCase()))) {
      rule.tags.forEach(t => matched.add(t));
    }
    if (matched.size >= 10) break; // حداکثر ۱۰ candidate — بعد فیلتر می‌کنیم
  }

  // هشتگ پایه بر اساس زبان بات
  const langBaseTag = {
    fa:  '#ورزش',
    en:  '#Sports',
    ar:  '#رياضة',
    fr:  '#Sport',
    de:  '#Sport',
    es:  '#Deporte',
    pt:  '#Esporte',
    it:  '#Sport'
  }[lang] || '#Sports';

  // همیشه هشتگ پایه زبان و فوتبال را اضافه کنیم اگر هنوز نیست
  if (!matched.has('#فوتبال') && !matched.has('#Football')) matched.add(langBaseTag);

  const result = Array.from(matched).slice(0, 5);

  // اگر کمتر از ۳ هشتگ داریم، هشتگ جام جهانی عمومی اضافه کنیم
  if (result.length < 3) result.push('#WorldCup2026', '#AJSports');

  return result.slice(0, 5);
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
      hashtags     TEXT[],
      published_at TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE bot_news ADD COLUMN IF NOT EXISTS hashtags TEXT[];
    CREATE INDEX IF NOT EXISTS idx_bn_created  ON bot_news (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bn_lang     ON bot_news (lang);
    CREATE INDEX IF NOT EXISTS idx_bn_bot      ON bot_news (bot_name);
    CREATE INDEX IF NOT EXISTS idx_bn_hashtags ON bot_news USING GIN (hashtags);

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
  console.log('✅ Tables ready: bot_news (+ hashtags[]), news_likes, news_comments');
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
              title, link, image_url, hashtags, published_at, created_at,
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
      created_at:   row.effective_at || row.published_at || row.created_at,
      hashtags:     row.hashtags || []
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

    // 🏷️ تولید هشتگ‌های هوشمند — [NEW v3.4]
    const hashtags = generateHashtags(title, bot.name, bot.lang);

    try {
      const r = await pool.query(
        `INSERT INTO bot_news
           (guid, bot_name, bot_display, source, lang, title, link, image_url, hashtags, published_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (guid) DO NOTHING
         RETURNING id`,
        [
          guid, bot.name, bot.display, feed.source, bot.lang, title,
          item.link || null, extractImage(item),
          hashtags,
          item.pubDate ? new Date(item.pubDate) : null
        ]
      );
      if (r.rows.length > 0) {
        saved++;
        console.log(`  ✅ [${bot.name}] ${title.substring(0, 55)}... 🏷️${hashtags.slice(0,2).join(' ')}`);
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
// 🔴 [NEW v3.3] LIVE FAN ROOMS — REFRESH FROM APIFOOTBALL
// ═══════════════════════════════════════════
async function refreshLiveMatchesCache() {
  if (!APIFOOTBALL_KEY) return;
  if (liveMatchesCache.isRefreshing) return;
  liveMatchesCache.isRefreshing = true;

  const url = `https://apiv3.apifootball.com/?action=get_events&match_live=1&APIkey=${APIFOOTBALL_KEY}`;

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(t);

    if (!res.ok) {
      console.error(`❌ APIFootball error: HTTP ${res.status}`);
      return;
    }

    const raw  = await res.json();

    if (raw && raw.error && raw.message) {
      console.error(`❌ APIFootball API Error (${raw.error}): ${raw.message}`);
      return;
    }

    const list = Array.isArray(raw) ? raw : [];

    liveMatchesCache.matches = list.map(m => ({
      match_id:             m.match_id,
      match_hometeam_name:  m.match_hometeam_name,
      match_awayteam_name:  m.match_awayteam_name,
      match_hometeam_score: m.match_hometeam_score,
      match_awayteam_score: m.match_awayteam_score,
      team_home_badge:      m.team_home_badge,
      team_away_badge:      m.team_away_badge,
      match_status:         m.match_status,
      match_time:           m.match_time,
      league_name:          m.league_name
    })).filter(m => m.match_id);

    liveMatchesCache.updatedAt = Date.now();
    console.log(`⚡ Live matches cache refreshed: ${liveMatchesCache.matches.length} match(es)`);
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn('⏱️ APIFootball timeout — کش قبلی حفظ شد');
    } else {
      console.error('❌ Live matches refresh error:', err.message);
    }
  } finally {
    liveMatchesCache.isRefreshing = false;
  }
}

// ═══════════════════════════════════════════
// CRON JOBS
// ═══════════════════════════════════════════
cron.schedule(`*/${FETCH_MIN} * * * *`, runAllFeeds);
cron.schedule('*/10 * * * *',          cleanup);
cron.schedule(`*/${LIVE_MATCHES_FETCH_MIN} * * * *`, refreshLiveMatchesCache);

// ═══════════════════════════════════════════
// 🌐 [NEW] FREE TRANSLATION ENGINE (Google Translate Bypass)
// ═══════════════════════════════════════════
async function translateWithFreeAPI(text, targetLang = 'fa') {
  if (!text || typeof text !== 'string' || text.trim().length < 3) return text;
  
  const trimmedText = text.trim();
  const cacheKey = `${targetLang}::${trimmedText}`;
  
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(trimmedText)}`;

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.error(`❌ Free Translation API error ${response.status}`);
      return text; 
    }

    const data = await response.json();
    
    let translated = '';
    if (data && data[0]) {
      data[0].forEach(item => {
        if (item[0]) translated += item[0];
      });
    }

    if (!translated) {
      console.warn('⚠️ Translation returned empty data');
      return text;
    }

    if (translationCache.size >= TRANSLATION_CACHE_MAX) {
      const keysToDelete = Array.from(translationCache.keys()).slice(0, 500);
      keysToDelete.forEach(k => translationCache.delete(k));
      console.log('🧹 Translation cache pruned: 500 old entries removed');
    }
    
    translationCache.set(cacheKey, translated);
    console.log(`🌐 Translated: "${trimmedText.substring(0, 40)}..." → "${translated.substring(0, 40)}..."`);
    
    return translated;

  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn('⏱️ Translation timeout — returning original');
    } else {
      console.error('❌ Translation error:', err.message);
    }
    return text;
  }
}

// ═══════════════════════════════════════════
// API ENDPOINTS
// ═══════════════════════════════════════════

/**
 * GET /api/news
 * پشتیبانی از فیلتر hashtag جدید: /api/news?hashtag=%23WorldCup2026
 */
app.get('/api/news', async (req, res) => {
  try {
    const { lang, bot, limit = 50, hashtag } = req.query;
    const limitNum = Math.min(parseInt(limit) || 50, 100);

    if (!newsMemCache.data || (Date.now() - newsMemCache.updatedAt) > newsMemCache.TTL_MS) {
      await refreshNewsCache(null, 100);
    }

    let news = newsMemCache.data || [];
    if (lang)    news = news.filter(n => n.lang === lang);
    if (bot)     news = news.filter(n => n.bot_name === bot);
    if (hashtag) news = news.filter(n => (n.hashtags || []).includes(hashtag));

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

// ── ترجمه ۱۰۰٪ رایگان ────────────────────────────────────────────────
app.post('/api/translate', async (req, res) => {
  try {
    const { text, target_lang = 'fa' } = req.body;
    
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ success: false, error: 'text is required' });
    }
    
    if (!['fa', 'en', 'ar', 'fr', 'de', 'es', 'pt', 'it'].includes(target_lang)) {
      return res.status(400).json({ success: false, error: 'unsupported target_lang' });
    }
    
    const trimmedText = text.trim();
    if (trimmedText.length < 3) {
      return res.json({ success: true, translated: text, cached: false });
    }
    
    const cacheKey = `${target_lang}::${trimmedText}`;
    const wasCached = translationCache.has(cacheKey);
    
    const translated = await translateWithFreeAPI(trimmedText, target_lang);
    
    res.set('Cache-Control', 'public, s-maxage=86400');
    
    res.json({
      success: true,
      translated,
      cached: wasCached,
      original: trimmedText
    });
    
  } catch (err) {
    console.error('❌ /api/translate:', err.message);
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

// ── [NEW v3.4] هشتگ‌های ترند ─────────────────────────────────────
/**
 * GET /api/trending_hashtags
 * برمی‌گرداند: ۲۰ هشتگ پرتکرار در ۶ ساعت اخیر
 */
app.get('/api/trending_hashtags', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT unnest(hashtags) AS tag, COUNT(*) AS count
      FROM bot_news
      WHERE created_at > NOW() - INTERVAL '6 hours'
        AND hashtags IS NOT NULL
      GROUP BY tag
      ORDER BY count DESC
      LIMIT 20
    `);
    res.set('Cache-Control', 'public, s-maxage=120');
    res.json({ success: true, trending: result.rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════
// 🔴 [NEW v3.3] LIVE FAN ROOMS ENDPOINT
// ═══════════════════════════════════════════
app.get('/live_matches.json', (req, res) => {
  res.set({
    'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60',
    'CDN-Cache-Control': 'public, max-age=300',
    'Cloudflare-CDN-Cache-Control': 'public, max-age=300'
  });

  res.json({
    success:    true,
    count:      liveMatchesCache.matches.length,
    matches:    liveMatchesCache.matches,
    updated_at: liveMatchesCache.updatedAt ? new Date(liveMatchesCache.updatedAt).toISOString() : null
  });
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
      bots_langs:        [...new Set(BOTS.map(b => b.lang))],
      translation_ready: true,
      hashtag_rules:     HASHTAG_RULES.length,
      // [NEW v3.3]
      live_matches_cached:   liveMatchesCache.matches.length,
      live_matches_age_s:    liveMatchesCache.updatedAt ? Math.floor((Date.now() - liveMatchesCache.updatedAt) / 1000) : null,
      live_matches_ready:    !!APIFOOTBALL_KEY,
      ts:                new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

/** GET / */
app.get('/', (req, res) => res.json({
  service:   'AJ Sports RSS Bot v3.4 — Mega Feeds + Smart Hashtags + Live Fan Rooms ⚡🏷️🔴',
  bots_count: BOTS.length,
  langs:      [...new Set(BOTS.map(b => b.lang))],
  endpoints: {
    news:               '/api/news?lang=fa|en|ar|fr|de|es|pt|it&limit=50&hashtag=%23WorldCup2026',
    translate:          'POST /api/translate  {text, target_lang}',
    stats:              '/api/news/:newsId/stats',
    likes:              'POST /api/news/:newsId/like',
    comments:           'GET/POST /api/news/:newsId/comments',
    trending_hashtags:  '/api/trending_hashtags',
    live_matches:       '/live_matches.json',
    health:             '/health'
  },
  bots: BOTS.map(b => ({ name: b.name, display: b.display, lang: b.lang, feeds: b.feeds.length }))
}));

// ═══════════════════════════════════════════
// START
// ═══════════════════════════════════════════
async function start() {
  console.log('\n' + '═'.repeat(70));
  console.log('🤖 AJ Sports RSS Bot v3.4 — Mega Feeds + Smart Hashtags + Live Fan Rooms ⚡🏷️🔴');
  console.log('═'.repeat(70));
  console.log(`📦 In-Memory Cache: ${newsMemCache.TTL_MS / 1000}s TTL`);
  console.log(`⏰ RSS Fetch every ${FETCH_MIN}min | News TTL ${NEWS_TTL_MIN}min`);
  console.log(`🌐 Translation API: ✅ Ready (100% Free - No API Key Needed)`);
  console.log(`🏷️  Smart Hashtags: ✅ Ready (${HASHTAG_RULES.length} rules, 8 languages)`);
  console.log(`🤖 Total Bots: ${BOTS.length} | Languages: ${[...new Set(BOTS.map(b=>b.lang))].join(', ')}`);
  console.log(`🔴 Live Fan Rooms: ${APIFOOTBALL_KEY ? '✅ Ready (every ' + LIVE_MATCHES_FETCH_MIN + 'min)' : '⚠️ APIFOOTBALL_KEY not set — disabled'}`);
  console.log('═'.repeat(70) + '\n');

  await initDB();

  app.listen(PORT, () => {
    console.log(`🚀 Bot server running on port ${PORT}`);
    console.log(`📡 News API:        http://localhost:${PORT}/api/news`);
    console.log(`🌐 Translate API:   http://localhost:${PORT}/api/translate`);
    console.log(`🏷️  Trending Tags:   http://localhost:${PORT}/api/trending_hashtags`);
    console.log(`🔴 Live Matches:    http://localhost:${PORT}/live_matches.json\n`);
  });

  setTimeout(runAllFeeds, 6000);
  if (APIFOOTBALL_KEY) setTimeout(refreshLiveMatchesCache, 8000);
  startKeepAlive();
}

start();

process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  await pool.end();
  process.exit(0);
});
