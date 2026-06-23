const crypto = require('crypto');
const { Client } = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');

// Vercel 預設會解析 JSON body，但驗證 LINE 簽章需要原始字串，故關閉自動解析
const config = { api: { bodyParser: false } };

const lineClient = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const VACCINE_REMINDER_DAYS = 30;
const BIRTHDAY_REMINDER_DAYS = 30;

const HELP_TEXT =
  '你好！我是寵物日誌小幫手 🐾\n\n' +
  '輸入「綁定 你的Email」可以連結你的帳號，之後就能在這裡查詢提醒。\n' +
  '例如：綁定 example@gmail.com\n\n' +
  '輸入「查詢」可以查看即將到期的疫苗和生日提醒。';

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifySignature(rawBody, signature) {
  if (!signature) return false;
  const hash = crypto
    .createHmac('sha256', process.env.LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest('base64');
  return hash === signature;
}

async function getUserIdByEmail(email) {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`,
    {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      },
    }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const users = data.users || data;
  if (!Array.isArray(users) || users.length === 0) return null;
  const match = users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  return match ? match.id : null;
}

function daysUntil(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [y, m, d] = dateStr.split('-').map(Number);
  return Math.ceil((new Date(y, m - 1, d) - today) / 86400000);
}

function nextBirthdayDays(birthday) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [, m, d] = birthday.split('-').map(Number);
  let next = new Date(today.getFullYear(), m - 1, d);
  if (next < today) next = new Date(today.getFullYear() + 1, m - 1, d);
  return Math.ceil((next - today) / 86400000);
}

async function handleBind(lineUserId, email, replyToken) {
  const userId = await getUserIdByEmail(email);
  if (!userId) {
    await lineClient.replyMessage(replyToken, {
      type: 'text',
      text: `找不到 Email「${email}」對應的帳號，請確認輸入是否正確。`,
    });
    return;
  }

  const { error } = await supabase
    .from('line_bindings')
    .upsert({ user_id: userId, line_user_id: lineUserId }, { onConflict: 'line_user_id' });

  if (error) {
    console.error('line_bindings upsert error', error);
    await lineClient.replyMessage(replyToken, {
      type: 'text',
      text: '綁定失敗，請稍後再試一次。',
    });
    return;
  }

  await lineClient.replyMessage(replyToken, {
    type: 'text',
    text: `綁定成功！已連結帳號 ${email}，之後可輸入「查詢」查看提醒。`,
  });
}

async function handleQuery(lineUserId, replyToken) {
  const { data: binding } = await supabase
    .from('line_bindings')
    .select('user_id')
    .eq('line_user_id', lineUserId)
    .maybeSingle();

  if (!binding) {
    await lineClient.replyMessage(replyToken, {
      type: 'text',
      text: '尚未綁定帳號，請先輸入「綁定 你的Email」完成綁定。',
    });
    return;
  }

  const { data: pets } = await supabase
    .from('pets')
    .select('id,name,birthday')
    .eq('user_id', binding.user_id);

  if (!pets || pets.length === 0) {
    await lineClient.replyMessage(replyToken, { type: 'text', text: '目前沒有任何寵物資料。' });
    return;
  }

  const petIds = pets.map((p) => p.id);
  const petById = Object.fromEntries(pets.map((p) => [p.id, p]));

  const { data: events } = await supabase
    .from('events')
    .select('pet_id,content,next_due_date')
    .eq('type', 'vaccine')
    .in('pet_id', petIds)
    .not('next_due_date', 'is', null);

  const lines = [];

  (events || [])
    .map((e) => ({ ...e, days: daysUntil(e.next_due_date) }))
    .filter((e) => e.days <= VACCINE_REMINDER_DAYS)
    .sort((a, b) => a.days - b.days)
    .forEach((e) => {
      const pet = petById[e.pet_id];
      const label = e.days < 0 ? `逾期 ${Math.abs(e.days)} 天` : e.days === 0 ? '今天' : `${e.days} 天後`;
      lines.push(`💉 ${pet?.name || ''} - ${e.content || '疫苗'} (${label})`);
    });

  pets
    .filter((p) => p.birthday)
    .map((p) => ({ ...p, days: nextBirthdayDays(p.birthday) }))
    .filter((p) => p.days <= BIRTHDAY_REMINDER_DAYS)
    .sort((a, b) => a.days - b.days)
    .forEach((p) => {
      const label = p.days === 0 ? '今天生日 🎉' : `${p.days} 天後生日`;
      lines.push(`🎂 ${p.name} - ${label}`);
    });

  const text = lines.length > 0 ? lines.join('\n') : '目前沒有即將到期的疫苗或生日提醒。';
  await lineClient.replyMessage(replyToken, { type: 'text', text });
}

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const text = event.message.text.trim();
  const lineUserId = event.source.userId;
  const replyToken = event.replyToken;

  if (text === '查詢') {
    await handleQuery(lineUserId, replyToken);
    return;
  }

  const bindMatch = text.match(/^綁定\s+(.+)$/);
  if (bindMatch) {
    await handleBind(lineUserId, bindMatch[1].trim(), replyToken);
    return;
  }

  await lineClient.replyMessage(replyToken, { type: 'text', text: HELP_TEXT });
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers['x-line-signature'];

  if (!verifySignature(rawBody, signature)) {
    res.status(401).end('Invalid signature');
    return;
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch (e) {
    res.status(400).end('Invalid body');
    return;
  }

  try {
    await Promise.all((body.events || []).map(handleEvent));
  } catch (e) {
    console.error('line-webhook handler error', e);
  }

  res.status(200).end();
}

module.exports = handler;
module.exports.config = config;
