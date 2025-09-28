# پایه سبک Node.js
FROM node:18-alpine

# پوشه کاری
WORKDIR /app

# کپی فایل‌ها
COPY . .

# نصب Express
RUN npm init -y && npm install express

# ساخت سرور ساده
RUN echo "const express=require('express');const app=express();const port=process.env.PORT||3000;app.use(express.static('.'));app.listen(port,()=>console.log('Server running on port',port));" > server.js

# پورت
EXPOSE 3000

# دستور اجرا
CMD ["node","server.js"]