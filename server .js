const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const HF_API_KEY = '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';
const MODEL = 'salam/gpt-neo-fa';

app.post('/chat', async (req, res) => {
  const userMessage = req.body.message;

  // پاسخ سفارشی برای سوال درباره سازنده
  if(userMessage.includes('سازنده') || userMessage.includes('کی ساخته')) {
    return res.json({ reply: 'علیرضا جدیدی سازنده است.' });
  }

  try {
    const response = await fetch(`https://api-inference.huggingface.co/models/${MODEL}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HF_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ inputs: userMessage })
    });

    const data = await response.json();
    const aiMessage = data[0]?.generated_text || 'متاسفانه نتوانستم پاسخی بدهم.';
    res.json({ reply: aiMessage });

  } catch (err) {
    res.json({ reply: 'خطا در ارتباط با سرور Hugging Face.' });
  }
});

app.listen(3000, () => console.log('Server running on http://localhost:3000'));