import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());

// تابع گرفتن HTML از Goal
async function getPage(url) {
  const res = await fetch(url);
  const text = await res.text();
  return text;
}

// مسیرهای مختلف لیگ برتر
app.get("/overview", async (req, res) => {
  const html = await getPage("https://www.goal.com/en-us/premier-league/overview/2kwbbcootiqqgmrzs6o5inle5");
  res.send(html);
});

app.get("/news", async (req, res) => {
  const html = await getPage("https://www.goal.com/en-us/premier-league/news/2kwbbcootiqqgmrzs6o5inle5");
  res.send(html);
});

app.get("/matches", async (req, res) => {
  const html = await getPage("https://www.goal.com/en-us/premier-league/fixtures-results/2kwbbcootiqqgmrzs6o5inle5");
  res.send(html);
});

app.get("/standings", async (req, res) => {
  const html = await getPage("https://www.goal.com/en-us/premier-league/standings/2kwbbcootiqqgmrzs6o5inle5");
  res.send(html);
});

app.get("/players", async (req, res) => {
  const html = await getPage("https://www.goal.com/en-us/premier-league/top-players/2kwbbcootiqqgmrzs6o5inle5");
  res.send(html);
});

// صفحه اصلی
app.get("/", (req, res) => {
  res.send("✅ سرور لیگ برتر آماده است. مسیرها: /overview /news /matches /standings /players");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});