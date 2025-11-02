import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

let clients = [];

app.get("/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  clients.push(res);
  req.on("close", () => {
    clients = clients.filter(c => c !== res);
  });
});

app.post("/send", (req, res) => {
  const msg = { text: req.body.text, sender: req.body.sender || "کاربر", time: Date.now() };
  for (const client of clients) client.write(`data: ${JSON.stringify(msg)}\n\n`);
  res.json({ ok: true });
});

app.listen(10000, () => console.log("✅ Chat server running on port 10000"));