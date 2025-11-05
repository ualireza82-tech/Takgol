import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

let clients = [];

// ✅ مسیر مخصوص UptimeRobot برای بیدار نگه داشتن سرور
// سبک، سریع و بدون تاثیر روی عملکرد
app.get("/ping", (req, res) => {
res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
res.status(200).send("pong ✅ server alive");
});

// ✅ مسیر SSE برای ارسال بلادرنگ پیام‌ها
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

// ✅ مسیر ارسال پیام از کلاینت
app.post("/send", (req, res) => {
const msg = {
text: req.body.text,
sender: req.body.sender || "کاربر",
time: Date.now(),
};
for (const client of clients) {
try {
client.write(data: ${JSON.stringify(msg)}\n\n);
} catch {}
}
res.json({ ok: true });
});

// ✅ سرور روی پورت مناسب Render اجرا می‌شود
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(✅ Chat server running on port ${PORT}));