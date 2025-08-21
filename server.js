const express = require('express');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 3000;

// جایگذاری توکن واقعی شما
const API_TOKEN = 'c68ed51ebea54a4d948cbe7b54496815';

app.use(express.static('./'));

app.get('/matches', async (req, res) => {
  try {
    const response = await fetch('https://api.football-data.org/v4/competitions/IRN/matches', {
      headers: { 'X-Auth-Token': API_TOKEN }
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'مشکل در دریافت اطلاعات' });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));