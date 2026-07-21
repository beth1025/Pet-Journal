# 🐾 寵物日誌 Pet Journal

記錄毛小孩的體重、疫苗、就醫等日常，並透過 LINE Bot 推播提醒。

## 技術架構

- **前端**：純 HTML / CSS / JavaScript（單頁應用，`index.html`）
- **後端**：Vercel Serverless Functions（`api/` 目錄）
- **資料庫 / 認證**：Supabase（PostgreSQL + Auth）
- **推播通知**：LINE Messaging API
- **排程**：Vercel Cron（每日 UTC 01:00 觸發）

---

## 環境啟動方式

### 1. 安裝相依套件

```bash
npm install
```

### 2. 建立環境變數

```bash
cp .env.example .env
```

填入 `.env` 中的實際值（詳見下方說明）。

### 3. 本地開發（使用 Vercel CLI）

```bash
npx vercel dev
```

瀏覽器開啟 `http://localhost:3000` 即可使用。

> 不需要 Vercel CLI 也可直接開啟 `index.html`，但 API 路由（LINE Webhook / Cron）無法在本地運作。

### 4. 部署至 Vercel

```bash
npx vercel --prod
```

部署後到 Vercel Dashboard → Settings → Environment Variables，將 `.env` 中的所有變數貼入。

---

## .env.example 說明

| 變數名稱 | 說明 | 取得方式 |
|---|---|---|
| `SUPABASE_URL` | Supabase 專案的 API 端點 | Supabase Dashboard → Project Settings → API |
| `SUPABASE_SERVICE_KEY` | Service Role 金鑰（具有 bypass RLS 的完整權限） | 同上，**勿公開** |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Bot 發送訊息用的長期 Token | LINE Developers Console → Messaging API Channel |
| `LINE_CHANNEL_SECRET` | 用於驗證 Webhook 請求簽章 | 同上 |
| `CRON_SECRET` | 保護 Cron 端點，防止未授權呼叫 | 自行產生：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

> `SUPABASE_SERVICE_KEY` 擁有完整資料庫存取權，**只能放在伺服器端（Vercel 環境變數）**，不可出現在前端程式碼。

---

## 資料表結構說明

### `pets` — 寵物資料

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | uuid PK | 主鍵 |
| `user_id` | uuid | 建立者（對應 Supabase Auth user） |
| `group_id` | uuid \| null | 所屬家庭群組（null 表示私人） |
| `name` | text | 寵物名稱 |
| `species` | text \| null | 種類（狗、貓…） |
| `breed` | text \| null | 品種 |
| `birthday` | date \| null | 生日 |
| `gender` | text \| null | 性別（male / female） |
| `photo_url` | text \| null | 頭像圖片 URL |
| `created_at` | timestamptz | 建立時間 |

---

### `events` — 寵物記錄

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | uuid PK | 主鍵 |
| `pet_id` | uuid FK→pets | 所屬寵物 |
| `user_id` | uuid | 建立者 |
| `group_id` | uuid \| null | 所屬群組 |
| `type` | text | 記錄類型：`weight` / `vaccine` / `medical` / `grooming` / `other` |
| `date` | date | 記錄日期 |
| `content` | text \| null | 詳細說明 |
| `cost` | numeric \| null | 費用（NT$） |
| `weight` | numeric \| null | 體重（type=weight 時使用） |
| `next_due_date` | date \| null | 下次疫苗施打日期（type=vaccine 時使用） |
| `created_at` | timestamptz | 建立時間 |

---

### `groups` — 家庭群組

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | uuid PK | 主鍵 |
| `name` | text | 群組名稱 |
| `created_by` | uuid | 建立者（群組擁有者） |
| `invite_code` | text | 邀請碼（大寫英數，唯一） |
| `created_at` | timestamptz | 建立時間 |

---

### `group_members` — 群組成員

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | uuid PK | 主鍵 |
| `group_id` | uuid FK→groups | 所屬群組 |
| `user_id` | uuid | 成員 |
| `role` | text | 角色：`owner` / `member` |
| `joined_at` | timestamptz | 加入時間 |

---

### `line_bindings` — LINE 帳號綁定

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | uuid PK | 主鍵 |
| `user_id` | uuid | 對應的 Supabase 使用者 |
| `line_user_id` | text | LINE 使用者 ID（`U...`） |
| `created_at` | timestamptz | 綁定時間 |

> 唯一限制在 `line_user_id`，同一 LINE 帳號只能綁一個 App 帳號。

---

### `notification_log` — 推播紀錄（防重複通知）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | uuid PK | 主鍵 |
| `event_id` | text | 對應事件的識別字串：疫苗為 `events.id`；生日為 `birthday-{pet_id}-{year}` |
| `notified_at` | timestamptz | 推播時間 |

> Cron Job 每次執行前會先查此表，已推播過的項目當天不再重複發送。

---

## LINE Bot 指令

| 輸入 | 說明 |
|---|---|
| `綁定 your@email.com` | 將 LINE 帳號與 App 帳號連結 |
| `查詢` | 查看近期疫苗到期及生日提醒 |
| 其他 | 顯示使用說明 |

---

## Cron 排程

`vercel.json` 設定每日 **UTC 01:00**（台灣時間 09:00）執行 `/api/cron-check-reminders`，向所有已綁定 LINE 的使用者推送疫苗與生日提醒。

可透過環境變數調整提醒天數（未設定時預設 30 天）：

| 變數 | 預設值 | 說明 |
|---|---|---|
| `VACCINE_REMINDER_DAYS` | `30` | 疫苗提前幾天推播 |
| `BIRTHDAY_REMINDER_DAYS` | `30` | 生日提前幾天推播 |
