// نصب پیش‌نیاز: npm i express puppeteer cors
const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
app.use(cors()); // حل مشکل CORS

const PORT = process.env.PORT || 3000;

app.get('/api/premier-league', async (req, res) => {
  try {
    const browser = await puppeteer.launch({ headless: true, args:['--no-sandbox'] });
    const page = await browser.newPage();
    await page.goto('https://www.goal.com/en-us/competitions/premier-league/1', { waitUntil: 'networkidle2' });

    // استخراج داده‌ها از جدول بازیکنان برتر
    const data = await page.evaluate(() => {
      const players = [];
      document.querySelectorAll('.playerList__row').forEach(row => {
        const name = row.querySelector('.playerName')?.innerText || '';
        const team = row.querySelector('.teamName')?.innerText || '';
        const goals = row.querySelector('.playerGoals')?.innerText || '';
        players.push({ name, team, goals });
      });
      return players;
    });

    await browser.close();
    res.json({ players: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch data' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});