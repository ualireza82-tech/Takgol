const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// پوشه public برای فایل HTML
app.use(express.static('public'));

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});