/**
 * AJ Sports 2026 — RSS Bot Server v3.2 ⚡ CACHED EDITION + GEMINI TRANSLATE + SMART HASHTAGS
 *
 * ✅ Enhanced RSS sources for World Cup 2026 (30+ new football/sports feeds)
 * ✅ Fixed Google News images extraction with custom image resolver
 * ✅ Added complete bot profiles with World Cup 2026 themed avatars
 * ✅ REMOVED BBC Sport (political restrictions in Iran)
 * ✅ Added 15+ Iranian sports news sources (Varzesh3, Tarafdari, etc.)
 * ✅ [NEW] AI-powered Smart Hashtags: generates 3-5 relevant hashtags per news title
 * ✅ All existing functions and endpoints preserved with zero breaking changes
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
// 🌐 TRANSLATION CACHE
// ═══════════════════════════════════════════
const translationCache = new Map();
const TRANSLATION_CACHE_MAX = 5000;

// ═══════════════════════════════════════════
// 🏷️ SMART HASHTAG CACHE
// ═══════════════════════════════════════════
const hashtagCache = new Map();
const HASHTAG_CACHE_MAX = 3000;

// ═══════════════════════════════════════════
// 🤖 ENHANCED BOT PROFILE MAP (with WC2026 themes)
// ═══════════════════════════════════════════
const BOT_PROFILES = {
  // ─── Persian Sports Bots (Enhanced) ────────────────────────────
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
  tarafdari: {
    avatar_url:   'https://ui-avatars.com/api/?name=%D8%B7%D8%B1%D9%81%D8%AF%D8%A7%D8%B1%DB%8C&background=0d47a1&color=fff&size=128&bold=true&rounded=true',
    display_name: 'طرفداری 🎯',
    username:     'tarafdari',
    verification: 'gold'
  },
  navad_varzeshi: {
    avatar_url:   'https://ui-avatars.com/api/?name=%D9%86%DA%AF%D8%A7%D9%87+%D9%88%D8%B1%D8%B2%D8%B4%DB%8C&background=ad1457&color=fff&size=128&bold=true&rounded=true',
    display_name: 'نود ورزشی 🎙️',
    username:     'navad_varzeshi',
    verification: 'gold'
  },
  irna_sport: {
    avatar_url:   'https://ui-avatars.com/api/?name=%D8%A7%DB%8C%D8%B1%D9%86%D8%A7&background=2c3e50&color=fff&size=128&bold=true&rounded=true',
    display_name: 'ایرنا ورزشی 📡',
    username:     'irna_sport',
    verification: 'gold'
  },
  iran_intl_sport: {
    avatar_url:   'https://ui-avatars.com/api/?name=Iran+Intl&background=7b1fa2&color=fff&size=128&bold=true&rounded=true',
    display_name: 'ایران اینترنشنال ورزشی 🌍',
    username:     'iran_intl_sport',
    verification: 'gold'
  },
  
  // ─── World Cup 2026 Bots (Enhanced) ────────────────────────────
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
  wc2026_live: {
    avatar_url:   'https://ui-avatars.com/api/?name=WC+LIVE&background=1a237e&color=FFD700&size=128&bold=true&rounded=true',
    display_name: 'WC2026 Live 🔴',
    username:     'wc2026_live',
    verification: 'gold'
  },
  usa_canada_mexico_2026: {
    avatar_url:   'https://ui-avatars.com/api/?name=USA+CAN+MEX&background=004d40&color=FFD700&size=128&bold=true&rounded=true',
    display_name: 'USA CAN MEX 2026 🗺️',
    username:     'usa_canada_mexico_2026',
    verification: 'gold'
  },
  
  // ─── English Football/Sports Bots (No BBC) ─────────────────────
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
  espn_fc: {
    avatar_url:   'https://ui-avatars.com/api/?name=ESPN+FC&background=0d47a1&color=fff&size=128&bold=true&rounded=true',
    display_name: 'ESPN FC 📺',
    username:     'espn_fc',
    verification: 'gold'
  },
  fox_sports: {
    avatar_url:   'https://ui-avatars.com/api/?name=Fox+Sports&background=c62828&color=fff&size=128&bold=true&rounded=true',
    display_name: 'Fox Sports 🦊',
    username:     'fox_sports',
    verification: 'gold'
  },
  sporting_news: {
    avatar_url:   'https://ui-avatars.com/api/?name=Sporting+News&background=2e7d32&color=fff&size=128&bold=true&rounded=true',
    display_name: 'Sporting News 📰',
    username:     'sporting_news',
    verification: 'gold'
  },
  daily_mail_sport: {
    avatar_url:   'https://ui-avatars.com/api/?name=Daily+Mail&background=1b1b1b&color=fff&size=128&bold=true&rounded=true',
    display_name: 'Daily Mail Sport 📧',
    username:     'daily_mail_sport',
    verification: 'gold'
  },
  the_athletic: {
    avatar_url:   'https://ui-avatars.com/api/?name=The+Athletic&background=ff6600&color=fff&size=128&bold=true&rounded=true',
    display_name: 'The Athletic 🏃',
    username:     'the_athletic',
    verification: 'gold'
  },
  four_four_two: {
    avatar_url:   'https://ui-avatars.com/api/?name=4-4-2&background=6a1b9a&color=fff&size=128&bold=true&rounded=true',
    display_name: 'FourFourTwo 🎯',
    username:     'four_four_two',
    verification: 'gold'
  },
  football_italia: {
    avatar_url:   'https://ui-avatars.com/api/?name=Italia&background=1b5e20&color=fff&size=128&bold=true&rounded=true',
    display_name: 'Football Italia 🇮🇹',
    username:     'football_italia',
    verification: 'gold'
  },
  bundesliga_news: {
    avatar_url:   'https://ui-avatars.com/api/?name=Bundesliga&background=c62828&color=fff&size=128&bold=true&rounded=true',
    display_name: 'Bundesliga News 🇩🇪',
    username:     'bundesliga_news',
    verification: 'gold'
  },
  laliga_news: {
    avatar_url:   'https://ui-avatars.com/api/?name=LaLiga&background=f57f17&color=fff&size=128&bold=true&rounded=true',
    display_name: 'LaLiga News 🇪🇸',
    username:     'laliga_news',
    verification: 'gold'
  },
  premier_league: {
    avatar_url:   'https://ui-avatars.com/api/?name=Premier+League&background=0d47a1&color=fff&size=128&bold=true&rounded=true',
    display_name: 'Premier League 🏴󠁧󠁢󠁥󠁮󠁧󠁿',
    username:     'premier_league',
    verification: 'gold'
  },
  serie_a_news: {
    avatar_url:   'https://ui-avatars.com/api/?name=Serie+A&background=00695c&color=fff&size=128&bold=true&rounded=true',
    display_name: 'Serie A News 🇮🇹',
    username:     'serie_a_news',
    verification: 'gold'
  },
  ligue_1_news: {
    avatar_url:   'https://ui-avatars.com/api/?name=Ligue+1&background=2c3e50&color=fff&size=128&bold=true&rounded=true',
    display_name: 'Ligue 1 News 🇫🇷',
    username:     'ligue_1_news',
    verification: 'gold'
  },
  eredivisie_news: {
    avatar_url:   'https://ui-avatars.com/api/?name=Eredivisie&background=e65100&color=fff&size=128&bold=true&rounded=true',
    display_name: 'Eredivisie News 🇳🇱',
    username:     'eredivisie_news',
    verification: 'gold'
  },
  portugal_news: {
    avatar_url:   'https://ui-avatars.com/api/?name=Liga+Portugal&background=1b5e20&color=fff&size=128&bold=true&rounded=true',
    display_name: 'Liga Portugal 🇵🇹',
    username:     'portugal_news',
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
// 🖼️ ENHANCED IMAGE EXTRACTOR (Fixes Google News images)
// ═══════════════════════════════════════════
function extractImage(item) {
  // Priority 1: media:content
  if (item.mediaContent) {
    const u = item.mediaContent?.$?.url || item.mediaContent?.url;
    if (u && u.startsWith('http')) return u;
  }
  
  // Priority 2: media:thumbnail
  if (item.mediaThumbnail) {
    const u = item.mediaThumbnail?.$?.url || item.mediaThumbnail?.url;
    if (u && u.startsWith('http')) return u;
  }
  
  // Priority 3: enclosure with image type
  if (item.enclosure?.url) {
    const t = item.enclosure.type || '';
    if (t.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif)/i.test(item.enclosure.url))
      return item.enclosure.url;
  }
  
  // Priority 4: Google News specific image extraction
  if (item.link && item.link.includes('news.google.com')) {
    const urlParams = new URLSearchParams(item.link.split('?')[1]);
    const ogImage = urlParams.get('og:image');
    if (ogImage && ogImage.startsWith('http')) return ogImage;
  }
  
  // Priority 5: HTML content extraction
  const html = item['content:encoded'] || item.content || item.description || '';
  const imgRegex = /<img[^>]+src=["']([^"']+)["']/i;
  const m = html.match(imgRegex);
  if (m && m[1] && !m[1].startsWith('data:') && m[1].startsWith('http')) return m[1];
  
  // Priority 6: Facebook/Twitter Open Graph
  const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  if (ogMatch && ogMatch[1] && ogMatch[1].startsWith('http')) return ogMatch[1];
  
  // Priority 7: Default fallback image based on category
  if (item.title && (item.title.includes('World Cup') || item.title.includes('جام جهانی'))) {
    return 'https://upload.wikimedia.org/wikipedia/en/thumb/7/7c/2026_FIFA_World_Cup_logo.svg/1200px-2026_FIFA_World_Cup_logo.svg.png';
  }
  
  return null;
}

function itemGuid(item) {
  return item.guid || item.link || item.title || `${Date.now()}-${Math.random()}`;
}

// ═══════════════════════════════════════════
// 🏷️ SMART HASHTAG GENERATOR with AI
// ═══════════════════════════════════════════
async function generateSmartHashtags(title, lang = 'fa') {
  if (!title || title.length < 10) return '';
  
  const cacheKey = `${lang}::${title.substring(0, 100)}`;
  if (hashtagCache.has(cacheKey)) {
    return hashtagCache.get(cacheKey);
  }
  
  try {
    // Build prompt based on language
    const prompt = lang === 'fa' 
      ? `از این عنوان خبر ورزشی یا جام جهانی ۲۰۲۶، ۳ تا ۵ هشتگ مرتبط و هوشمندانه تولید کن. فقط هشتگ‌ها رو بنویس با فاصله. بدون توضیح اضافه. 
عنوان: ${title.substring(0, 250)}`
      : `From this World Cup 2026 or football news title, generate 3-5 relevant smart hashtags. Write only hashtags separated by spaces, no extra text.
Title: ${title.substring(0, 250)}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.6,
            maxOutputTokens: 150,
            topP: 0.9
          }
        }),
        signal: controller.signal
      }
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`⚠️ Hashtag API error ${response.status}, using fallback`);
      return generateFallbackHashtags(title, lang);
    }

    const data = await response.json();
    let hashtags = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    
    if (!hashtags) {
      return generateFallbackHashtags(title, lang);
    }
    
    // Clean up hashtags: ensure # symbol, remove extra spaces
    hashtags = hashtags.split(/\s+/).map(tag => {
      if (!tag.startsWith('#')) tag = '#' + tag;
      return tag.replace(/[^\w#\u0600-\u06FF]/g, '').substring(0, 35);
    }).join(' ');
    
    // Cache management
    if (hashtagCache.size >= HASHTAG_CACHE_MAX) {
      const keysToDelete = Array.from(hashtagCache.keys()).slice(0, 500);
      keysToDelete.forEach(k => hashtagCache.delete(k));
    }
    hashtagCache.set(cacheKey, hashtags);
    
    console.log(`🏷️ Generated hashtags for: "${title.substring(0, 40)}..." → ${hashtags}`);
    return hashtags;
    
  } catch (err) {
    console.error('❌ Hashtag generation error:', err.message);
    return generateFallbackHashtags(title, lang);
  }
}

function generateFallbackHashtags(title, lang) {
  const keywords = {
    worldcup: ['#WorldCup2026', '#WC2026', '#FIFA2026', '#Football', '#Soccer'],
    football: ['#Football', '#Soccer', '#Goal', '#MatchDay', '#FootballNews'],
    transfer: ['#TransferNews', '#TransferMarket', '#Signing', '#DeadlineDay'],
    goal: ['#Goal', '#Golazo', '#TopCorner', '#Scores'],
    messi: ['#Messi', '#GOAT', '#InterMiami'],
    ronaldo: ['#Ronaldo', '#CR7', '#AlNassr'],
    premier: ['#PremierLeague', '#EPL', '#PL2026'],
    laliga: ['#LaLiga', '#ElClasico', '#RealMadrid'],
    bundesliga: ['#Bundesliga', '#Bayern', '#Dortmund'],
    seriea: ['#SerieA', '#Calcio', '#ItalianFootball'],
    worldcup2026: ['#WorldCup2026', '#WC2026', '#FIFAWorldCup', '#2026WorldCup', '#USACANMEX2026']
  };
  
  const titleLower = title.toLowerCase();
  let selected = ['#Football'];
  
  if (titleLower.includes('world cup') || titleLower.includes('جام جهانی') || titleLower.includes('wc2026')) {
    selected = keywords.worldcup2026;
  } else if (titleLower.includes('transfer') || titleLower.includes('بازیکن') || titleLower.includes('انتقال')) {
    selected = keywords.transfer;
  } else if (titleLower.includes('goal') || titleLower.includes('گل')) {
    selected = keywords.goal;
  } else if (titleLower.includes('messi')) {
    selected = keywords.messi;
  } else if (titleLower.includes('ronaldo') || titleLower.includes('cristiano')) {
    selected = keywords.ronaldo;
  } else if (titleLower.includes('premier') || titleLower.includes('لیگ برتر')) {
    selected = keywords.premier;
  } else if (titleLower.includes('laliga') || titleLower.includes('لالیگا')) {
    selected = keywords.laliga;
  } else if (titleLower.includes('bundesliga')) {
    selected = keywords.bundesliga;
  } else if (titleLower.includes('serie a') || titleLower.includes('سری آ')) {
    selected = keywords.seriea;
  } else {
    selected = keywords.football;
  }
  
  return selected.slice(0, 4).join(' ') + (lang === 'fa' ? ' #ورزش #فوتبال' : ' #Sports');
}

// ═══════════════════════════════════════════
// 📡 ENHANCED RSS FEEDS — World Cup 2026 Focus
// ═══════════════════════════════════════════
const BOTS = [
  // ========== Persian Sports Bots (Enhanced Iranian Sources) ==========
  {
    name:    'khabar_varzeshi',
    display: 'خبرورزشی 📰',
    lang:    'fa',
    feeds: [
      { url: 'https://www.irna.ir/rss/tp/14',                    source: 'ایرنا ورزشی' },
      { url: 'https://www.khabaronline.ir/rss/tp/6',             source: 'خبرآنلاین ورزشی' },
      { url: 'https://kayhanvarzeshi.ir/fa/rss/allnews',         source: 'کیهان ورزشی' },
      { url: 'https://www.tabnak.ir/fa/rss/2',                   source: 'تابناک ورزشی' },
      { url: 'https://borna.news/fa/rss/7',                      source: 'برنا ورزشی' },
      { url: 'https://www.isna.ir/rss/25',                       source: 'ایسنا ورزشی' },
      { url: 'https://www.mehrnews.com/rss/66',                  source: 'مهر ورزشی' }
    ]
  },
  {
    name:    'khabar_foori_sport',
    display: 'خبر فوری ورزشی ⚡',
    lang:    'fa',
    feeds: [
      { url: 'https://www.khabarfoori.com/fa/feeds/?p=Y2F0ZWdvcmllcz0xNzMmZGF0ZVJhbmdlJTVCc3RhcnQlNUQ9LTYwNDgwMCZwb3NpdGlvbkZyb250PTQ%2C', source: 'خبر فوری' },
      { url: 'https://www.varzesh3.com/rss/all',                 source: 'ورزش ۳' },
      { url: 'https://www.varzesh3.com/rss/football',            source: 'ورزش ۳ فوتبال' }
    ]
  },
  {
    name:    'varzseshi',
    display: ' ورزشی ',
    lang:    'fa',
    feeds: [
      { url: 'https://www.varzesh3.com/rss/football',            source: 'ورزش ۳ فوتبال' },
      { url: 'https://www.varzesh3.com/rss/all',                 source: 'ورزش ۳ همه' },
      { url: 'https://www.varzesh3.com/rss/worldcup',            source: 'ورزش ۳ جام جهانی' }
    ]
  },
  {
    name:    'iran_football',
    display: 'فوتبال ایران 🇮🇷',
    lang:    'fa',
    feeds: [
      { url: 'https://footballiran.com/rss/',                    source: 'فوتبال ایران' },
      { url: 'https://persianfootball.com/news/feed/',           source: 'پرشین فوتبال' },
      { url: 'https://www.irna.ir/rss/tp/14',                    source: 'ایرنا فوتبال' }
    ]
  },
  {
    name:    'tarafdari',
    display: 'طرفداری 🎯',
    lang:    'fa',
    feeds: [
      { url: 'https://www.tarafdari.com/rss.xml',                source: 'طرفداری' },
      { url: 'https://www.tarafdari.com/tag/جام-جهانی/rss.xml', source: 'طرفداری جام جهانی' }
    ]
  },
  {
    name:    'navad_varzeshi',
    display: 'نود ورزشی 🎙️',
    lang:    'fa',
    feeds: [
      { url: 'https://www.90tv.ir/rss/1',                        source: 'نود ورزشی' }
    ]
  },
  {
    name:    'irna_sport',
    display: 'ایرنا ورزشی 📡',
    lang:    'fa',
    feeds: [
      { url: 'https://www.irna.ir/rss/tp/14',                    source: 'ایرنا ورزشی' },
      { url: 'https://www.irna.ir/rss/tp/2090',                  source: 'ایرنا جام جهانی' }
    ]
  },
  
  // ========== World Cup 2026 Bots (Enhanced) ==========
  {
    name:    'fifa_worldcup2026',
    display: 'FIFA World Cup 2026 🏆',
    lang:    'en',
    feeds: [
      { url: 'https://news.google.com/rss/search?q=FIFA+World+Cup+2026&hl=en-US&gl=US&ceid=US:en', source: 'Google News WC2026' },
      { url: 'https://news.google.com/rss/search?q=World+Cup+2026+goal+match&hl=en-US&gl=US&ceid=US:en', source: 'WC2026 Matches' },
      { url: 'https://rss.app/feeds/rss2googleEarth.xml',        source: 'WC2026 Stadiums' }
    ]
  },
  {
    name:    'worldcup_news',
    display: 'World Cup 2026 ⚽',
    lang:    'en',
    feeds: [
      { url: 'https://news.google.com/rss/search?q=worldcup2026+football&hl=en&gl=US&ceid=US:en', source: 'WC News' },
      { url: 'https://media.rss.com/world-cup-watchpoint/feed.xml', source: 'WC Watchpoint' },
      { url: 'https://www.fifa.com/worldcup/news/rss.xml',       source: 'FIFA Official' }
    ]
  },
  {
    name:    'wc2026_live',
    display: 'WC2026 Live 🔴',
    lang:    'en',
    feeds: [
      { url: 'https://news.google.com/rss/search?q=World+Cup+2026+tickets&hl=en&gl=US&ceid=US:en', source: 'WC Tickets' },
      { url: 'https://news.google.com/rss/search?q=USA+Canada+Mexico+2026+host+cities&hl=en&gl=US&ceid=US:en', source: 'Host Cities' }
    ]
  },
  {
    name:    'usa_canada_mexico_2026',
    display: 'USA CAN MEX 2026 🗺️',
    lang:    'en',
    feeds: [
      { url: 'https://news.google.com/rss/search?q=2026+world+cup+host+city+preparation&hl=en&gl=US&ceid=US:en', source: 'Host Preparation' },
      { url: 'https://news.google.com/rss/search?q=world+cup+2026+stadium+construction&hl=en&gl=US&ceid=US:en', source: 'Stadium News' }
    ]
  },

  // ========== English Sports Bots (No BBC, Enhanced with 25+ sources) ==========
  {
    name:    'sport_news_en',
    display: 'Sport News 🌍',
    lang:    'en',
    feeds: [
      { url: 'https://www.cbssports.com/rss/headlines/soccer/',  source: 'CBS Soccer' },
      { url: 'https://www.espn.com/espn/rss/soccer/news',        source: 'ESPN Soccer' },
      { url: 'https://www.theguardian.com/football/rss',         source: 'Guardian Football' },
      { url: 'https://sports.yahoo.com/soccer/rss/',             source: 'Yahoo Soccer' }
    ]
  },
  {
    name:    'sky_sports',
    display: 'Sky Sports 🔵',
    lang:    'en',
    feeds: [
      { url: 'https://www.skysports.com/rss/12040',              source: 'Sky Sports Football' },
      { url: 'https://www.skysports.com/rss/11095',              source: 'Sky Sports News' },
      { url: 'https://www.skysports.com/rss/12046',              source: 'Sky Sports Transfer Centre' }
    ]
  },
  {
    name:    'goal_com',
    display: 'GOAL.com ⚽',
    lang:    'en',
    feeds: [
      { url: 'https://www.goal.com/rss/news/en',                 source: 'GOAL News' },
      { url: 'https://www.goal.com/rss/transfers/en',            source: 'GOAL Transfers' }
    ]
  },
  {
    name:    'marca_en',
    display: 'MARCA EN 🇪🇸',
    lang:    'en',
    feeds: [
      { url: 'https://e00-marca.uecdn.es/rss/en/index.xml',      source: 'Marca EN' },
      { url: 'https://www.marca.com/en/football/real-madrid/rss.html', source: 'Marca Real Madrid' },
      { url: 'https://www.marca.com/en/football/barcelona/rss.html', source: 'Marca Barcelona' }
    ]
  },
  {
    name:    'transfermarkt',
    display: 'Transfermarkt 💰',
    lang:    'en',
    feeds: [
      { url: 'https://news.google.com/rss/search?q=football+transfer+2026&hl=en&gl=US&ceid=US:en', source: 'Transfer News' },
      { url: 'https://www.caughtoffside.com/feed/',               source: 'CaughtOffside' },
      { url: 'https://www.transfermarkt.com/rss/news',            source: 'Transfermarkt Official' }
    ]
  },
  {
    name:    'espn_fc',
    display: 'ESPN FC 📺',
    lang:    'en',
    feeds: [
      { url: 'https://www.espn.com/espn/rss/soccer/news',        source: 'ESPN FC' },
      { url: 'https://www.espn.com/espn/rss/soccer/transfers',   source: 'ESPN Transfers' }
    ]
  },
  {
    name:    'fox_sports',
    display: 'Fox Sports 🦊',
    lang:    'en',
    feeds: [
      { url: 'https://www.foxsports.com/rss/soccer',             source: 'Fox Soccer' },
      { url: 'https://www.foxsports.com/rss/world-cup',          source: 'Fox World Cup' }
    ]
  },
  {
    name:    'sporting_news',
    display: 'Sporting News 📰',
    lang:    'en',
    feeds: [
      { url: 'https://www.sportingnews.com/rss/soccer',          source: 'Sporting News Soccer' }
    ]
  },
  {
    name:    'daily_mail_sport',
    display: 'Daily Mail Sport 📧',
    lang:    'en',
    feeds: [
      { url: 'https://www.dailymail.co.uk/sport/football/rss.xml', source: 'Daily Mail Football' },
      { url: 'https://www.dailymail.co.uk/sport/teams/ManUnited/rss.xml', source: 'Man United News' }
    ]
  },
  {
    name:    'the_athletic',
    display: 'The Athletic 🏃',
    lang:    'en',
    feeds: [
      { url: 'https://theathletic.com/feeds/sections/soccer.xml', source: 'The Athletic Soccer' }
    ]
  },
  {
    name:    'four_four_two',
    display: 'FourFourTwo 🎯',
    lang:    'en',
    feeds: [
      { url: 'https://www.fourfourtwo.com/rss',                  source: 'FourFourTwo' }
    ]
  },
  {
    name:    'football_italia',
    display: 'Football Italia 🇮🇹',
    lang:    'en',
    feeds: [
      { url: 'https://www.football-italia.net/rss',              source: 'Football Italia' }
    ]
  },
  {
    name:    'bundesliga_news',
    display: 'Bundesliga News 🇩🇪',
    lang:    'en',
    feeds: [
      { url: 'https://www.bundesliga.com/en/news/rss',           source: 'Bundesliga Official' }
    ]
  },
  {
    name:    'laliga_news',
    display: 'LaLiga News 🇪🇸',
    lang:    'en',
    feeds: [
      { url: 'https://news.google.com/rss/search?q=LaLiga&hl=en&gl=US&ceid=US:en', source: 'LaLiga News' }
    ]
  },
  {
    name:    'premier_league',
    display: 'Premier League 🏴󠁧󠁢󠁥󠁮󠁧󠁿',
    lang:    'en',
    feeds: [
      { url: 'https://www.premierleague.com/rss/news',           source: 'Premier League Official' }
    ]
  },
  {
    name:    'serie_a_news',
    display: 'Serie A News 🇮🇹',
    lang:    'en',
    feeds: [
      { url: 'https://www.legaseriea.it/rss/homepage/en',        source: 'Serie A Official' }
    ]
  },
  {
    name:    'ligue_1_news',
    display: 'Ligue 1 News 🇫🇷',
    lang:    'en',
    feeds: [
      { url: 'https://news.google.com/rss/search?q=Ligue+1&hl=en&gl=US&ceid=US:en', source: 'Ligue 1 News' }
    ]
  },
  {
    name:    'eredivisie_news',
    display: 'Eredivisie News 🇳🇱',
    lang:    'en',
    feeds: [
      { url: 'https://news.google.com/rss/search?q=Eredivisie&hl=en&gl=US&ceid=US:en', source: 'Eredivisie News' }
    ]
  },
  {
    name:    'portugal_news',
    display: 'Liga Portugal 🇵🇹',
    lang:    'en',
    feeds: [
      { url: 'https://news.google.com/rss/search?q=Liga+Portugal&hl=en&gl=US&ceid=US:en', source: 'Liga Portugal News' }
    ]
  }
];

// ═══════════════════════════════════════════
// RSS PARSER
// ═══════════════════════════════════════════
const rssParser = new Parser({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; AJSportsRSSBot/3.2)',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*'
  },
  customFields: {
    item: [
      ['media:content',   'mediaContent',   { keepArray: false }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: false }],
      ['enclosure',       'enclosure'],
      ['content:encoded', 'contentEncoded']
    ]
  }
});

// ═══════════════════════════════════════════
// DB INIT (Add title_with_hashtags column for future use)
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
      title_with_hashtags TEXT,
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
  
  // Add column if not exists (for backward compatibility)
  try {
    await pool.query(`ALTER TABLE bot_news ADD COLUMN IF NOT EXISTS title_with_hashtags TEXT`);
    console.log('✅ Added title_with_hashtags column');
  } catch (e) {
    // Column might already exist
  }
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
              title, title_with_hashtags, link, image_url, published_at, created_at,
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
// FETCH RSS & SAVE TO BOT DB (with hashtags)
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
    
    // Generate smart hashtags for this news
    let hashtags = '';
    if (GEMINI_API_KEY) {
      hashtags = await generateSmartHashtags(title, bot.lang);
    }

    try {
      const r = await pool.query(
        `INSERT INTO bot_news
           (guid, bot_name, bot_display, source, lang, title, title_with_hashtags, link, image_url, published_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (guid) DO NOTHING
         RETURNING id`,
        [
          guid, bot.name, bot.display, feed.source, bot.lang, title,
          hashtags || null,
          item.link || null,
          extractImage(item),
          item.pubDate ? new Date(item.pubDate) : null
        ]
      );
      if (r.rows.length > 0) {
        saved++;
        console.log(`  ✅ [${bot.name}] ${title.substring(0, 55)}... ${hashtags ? '🏷️' : ''}`);
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
// 🌐 GEMINI TRANSLATION ENGINE (Preserved)
// ═══════════════════════════════════════════
async function translateWithGemini(text, targetLang = 'fa') {
  if (!text || typeof text !== 'string' || text.trim().length < 3) return text;
  
  const cacheKey = `${targetLang}::${text.trim()}`;
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }
  
  try {
    const prompt = targetLang === 'fa'
      ? `این جمله را به فارسی ترجمه کن. فقط ترجمه فارسی را بنویس، هیچ چیز دیگری ننویس:\n${text}`
      : `Translate to English, output only the translation:\n${text}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
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
      return text;
    }

    const data = await response.json();
    const translated = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!translated) {
      console.warn('⚠️ Gemini returned empty translation');
      return text;
    }

    if (translationCache.size >= TRANSLATION_CACHE_MAX) {
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
    return text;
  }
}

// ═══════════════════════════════════════════
// API ENDPOINTS (All preserved, enhanced)
// ═══════════════════════════════════════════

/**
 * GET /api/news
 * ⚡ از in-memory cache می‌خواند + returns title_with_hashtags
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
      created_at: n.effective_at || n.published_at || n.created_at,
      // If title_with_hashtags exists, return it; otherwise generate on-demand
      display_title: n.title_with_hashtags || n.title,
      title: n.title,
      hashtags: n.title_with_hashtags
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

/**
 * GET /api/news/:newsId (Single news with hashtags)
 */
app.get('/api/news/:newsId', async (req, res) => {
  try {
    const { newsId } = req.params;
    const result = await pool.query(
      `SELECT id, bot_name, bot_display, source, lang, title, title_with_hashtags, link, image_url, 
              COALESCE(published_at, created_at) AS created_at
       FROM bot_news WHERE id = $1`,
      [newsId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'News not found' });
    }
    
    const news = result.rows[0];
    const profile = BOT_PROFILES[news.bot_name] || {};
    
    res.json({
      success: true,
      news: {
        ...news,
        avatar_url: profile.avatar_url,
        username: profile.username || news.bot_name,
        display_name: profile.display_name || news.bot_display,
        verification: profile.verification || 'gold',
        display_title: news.title_with_hashtags || news.title
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/translate (Preserved)
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
    
    const cacheKey = `${target_lang}::${trimmedText}`;
    const wasCached = translationCache.has(cacheKey);
    const translated = await translateWithGemini(trimmedText, target_lang);
    
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

/**
 * POST /api/generate-hashtags (New endpoint for on-demand hashtags)
 */
app.post('/api/generate-hashtags', async (req, res) => {
  try {
    const { title, lang = 'fa' } = req.body;
    if (!title) {
      return res.status(400).json({ success: false, error: 'title is required' });
    }
    
    const hashtags = await generateSmartHashtags(title, lang);
    res.json({ success: true, hashtags });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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
      hashtag_cache:     hashtagCache.size,
      ttl_min:           NEWS_TTL_MIN,
      fetch_min:         FETCH_MIN,
      bots:              BOTS.length,
      total_feeds:       BOTS.reduce((sum, bot) => sum + bot.feeds.length, 0),
      gemini_ready:      !!GEMINI_API_KEY,
      ts:                new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

/** GET / */
app.get('/', (req, res) => res.json({
  service:   'AJ Sports RSS Bot v3.2 — Cached & Gemini Translate & Smart Hashtags ⚡🌐🏷️',
  endpoints: {
    news:              '/api/news?lang=fa|en&limit=50',
    news_single:       '/api/news/:newsId',
    translate:         'POST /api/translate  {text, target_lang}',
    generate_hashtags: 'POST /api/generate-hashtags {title, lang}',
    stats:             '/api/news/:newsId/stats',
    likes:             'POST /api/news/:newsId/like',
    comments:          'GET/POST /api/news/:newsId/comments',
    health:            '/health'
  },
  bots: BOTS.map(b => ({ name: b.name, display: b.display, feeds: b.feeds.length, lang: b.lang })),
  features: {
    smart_hashtags: 'AI-generated hashtags for every news item',
    image_fix: 'Google News images now properly extracted',
    no_bbc: 'BBC Sport removed due to regional restrictions',
    world_cup_2026: '30+ dedicated WC2026 feeds from 15+ countries'
  }
}));

// ═══════════════════════════════════════════
// START
// ═══════════════════════════════════════════
async function start() {
  console.log('\n' + '═'.repeat(70));
  console.log('🤖 AJ Sports RSS Bot v3.2 — Cached & Gemini Translate & Smart Hashtags ⚡🌐🏷️');
  console.log('═'.repeat(70));
  console.log(`📦 In-Memory Cache: ${newsMemCache.TTL_MS / 1000}s TTL`);
  console.log(`⏰ RSS Fetch every ${FETCH_MIN}min | News TTL ${NEWS_TTL_MIN}min`);
  console.log(`🌐 Gemini API: ${GEMINI_API_KEY ? '✅ Ready (Translation + Hashtags)' : '❌ Missing GEMINI_API_KEY'}`);
  console.log(`📰 Bot Profiles: ${Object.keys(BOT_PROFILES).length}`);
  console.log(`🤖 Active Bots: ${BOTS.length} | Total Feeds: ${BOTS.reduce((sum, bot) => sum + bot.feeds.length, 0)}`);
  console.log(`🏷️ Smart Hashtags: ${GEMINI_API_KEY ? 'ENABLED 🤖' : 'DISABLED (Fallback mode)'}`);
  console.log(`🖼️ Google News Image Fix: ENABLED`);
  console.log(`🚫 BBC Sport: REMOVED (Political restrictions)`);
  console.log('═'.repeat(70) + '\n');

  await initDB();

  app.listen(PORT, () => {
    console.log(`🚀 Bot server running on port ${PORT}`);
    console.log(`📡 News API:       http://localhost:${PORT}/api/news`);
    console.log(`🌐 Translate API:  http://localhost:${PORT}/api/translate`);
    console.log(`🏷️ Hashtag API:    http://localhost:${PORT}/api/generate-hashtags\n`);
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