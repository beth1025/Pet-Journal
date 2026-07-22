const path = require('path');
const express = require('express');
const cron = require('node-cron');

const lineWebhookHandler = require('./api/line-webhook');
const cronCheckHandler = require('./api/cron-check-reminders');

const app = express();
const PORT = process.env.PORT || 8080;

// 提供 index.html 等靜態檔案（前端頁面）
app.use(express.static(path.join(__dirname)));

// 注意：這兩條路由「不要」在前面加 express.json()，
// 因為 line-webhook.js 自己會讀取 raw body 來驗證 LINE 簽章，
// 如果先被 express.json() 解析過，簽章驗證會失敗。
app.all('/api/line-webhook', (req, res) => {
  lineWebhookHandler(req, res).catch((err) => {
    console.error('line-webhook error:', err);
    if (!res.headersSent) res.status(500).end();
  });
});

app.all('/api/cron-check-reminders', (req, res) => {
  cronCheckHandler(req, res).catch((err) => {
    console.error('cron-check-reminders error:', err);
    if (!res.headersSent) res.status(500).end();
  });
});

app.listen(PORT, () => {
  console.log(`Pet Journal server listening on port ${PORT}`);
});

// --- 排程：原本 vercel.json 設定的是「Vercel Cron」，
// 但 Zeabur 沒有這個機制，所以改用 node-cron 在伺服器內部排程。
// 時間：每日 UTC 01:00（台灣時間 09:00），跟原本設定一致。
cron.schedule('0 1 * * *', () => {
  console.log('[cron] Running daily reminder check...');

  // 模擬一個 request，帶上正確的 Authorization，
  // 因為 cron-check-reminders.js 內部會檢查這個 header 是否等於 CRON_SECRET。
  const fakeReq = {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  };
  const fakeRes = {
    status(code) {
      this._code = code;
      return this;
    },
    json(body) {
      console.log(`[cron] Finished with status ${this._code}:`, body);
    },
    end() {
      console.log(`[cron] Finished with status ${this._code}`);
    },
  };

  cronCheckHandler(fakeReq, fakeRes).catch((err) => {
    console.error('[cron] Failed to run scheduled check:', err);
  });
});
