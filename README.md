# Faruk's SmartBiz — Backend Server

এই সার্ভারটা Facebook Messenger ও WhatsApp থেকে মেসেজ রিসিভ করে, AI (Groq/OpenAI) দিয়ে উত্তর বানায়, Google Sheet থেকে প্রোডাক্ট তথ্য পড়ে, আর ড্যাশবোর্ডের জন্য API দেয় (অর্ডার, কাস্টমার, ব্রডকাস্ট)।

## ১. ইনস্টল

```bash
cd smartbiz-backend
npm install
cp .env.example .env
```

`.env` ফাইলে `WEBHOOK_VERIFY_TOKEN` আর `SETTINGS_ENCRYPTION_KEY` — নিজের মতো যেকোনো র‍্যান্ডম শব্দ বসান।

## ২. লোকালি চালানো

```bash
npm start
```

সার্ভার চলবে: `http://localhost:3000`

মোবাইল/ইন্টারনেট থেকে Facebook/WhatsApp-কে এই সার্ভারে পৌঁছাতে দিতে হলে **ngrok** দিয়ে সাময়িক পাবলিক লিংক বানান:

```bash
ngrok http 3000
```

## ৩. আসল হোস্টিং (প্রোডাকশন)

লোকাল সার্ভার শুধু টেস্টের জন্য — সবসময় চালু রাখতে **Render.com**, **Railway.app**, বা **VPS**-এ ডিপ্লয় করুন। ডিপ্লয় করার সময় `.env`-এর ভ্যারিয়েবলগুলো হোস্টিং প্যানেলে "Environment Variables" হিসেবে বসাতে হবে।

## ৪. Facebook Messenger সেটআপ

1. [Meta for Developers](https://developers.facebook.com) এ একটা App বানান, তাতে **Messenger** প্রোডাক্ট যোগ করুন।
2. Webhook যোগ করুন:
   - Callback URL: `https://আপনার-ডোমেইন/webhook/facebook`
   - Verify Token: `.env`-এ যা দিয়েছেন সেটাই
   - Subscribe fields: `messages`
3. আপনার পেজের **Page Access Token** কপি করে রাখুন — এটা ড্যাশবোর্ডের Settings-এ "Facebook Page Access Token" ঘরে বসাবেন।

## ৫. WhatsApp Cloud API সেটআপ

1. Meta App-এ **WhatsApp** প্রোডাক্ট যোগ করুন।
2. Webhook: `https://আপনার-ডোমেইন/webhook/whatsapp`, Verify Token একই।
3. **Temporary/Permanent Access Token** আর **Phone Number ID** কপি করুন — এই দুটো Settings থেকে বসাতে হবে (দুটো আলাদা ঘর — নিচে নোট দেখুন)।

## ৬. Google Sheet সংযুক্ত করা

শিটটা **File → Share → "Anyone with the link" (Viewer)** করে শেয়ার করুন, তারপর সেই লিংকটা ড্যাশবোর্ডের Settings-এ বসান। প্রথম সারিতে হেডার (যেমন: `Product, Price, Stock`) রাখলে AI সেটা বুঝে কাস্টমারকে উত্তর দিতে পারবে।

## ৭. AI API Key

[Groq Console](https://console.groq.com) থেকে ফ্রি API Key নিতে পারেন (দ্রুত ও সস্তা), অথবা OpenAI-এর Key ব্যবহার করতে পারেন।

## ৮. Settings API যেভাবে কাজ করে

ড্যাশবোর্ডের Settings ট্যাব থেকে "Connect" চাপলে এই এন্ডপয়েন্টে POST হবে:

```
POST /api/settings
{
  "fbToken": "...",
  "waToken": "...",
  "waPhoneNumberId": "...",
  "sheetLink": "...",
  "aiKey": "..."
}
```

টোকেনগুলো ডিস্কে **এনক্রিপ্ট করে** সেভ হয় (`data/db.json`), আর `/api/settings`-এ GET করলে কখনো টোকেন ফেরত আসে না — শুধু `connected: true/false`।

## ৯. Frontend ড্যাশবোর্ডের সাথে যুক্ত করা

আগে যে HTML ড্যাশবোর্ড বানানো হয়েছিল, সেটার এখনকার ডেটা (orders, customers ইত্যাদি) হার্ডকোডেড JS array। এই ব্যাকএন্ডের সাথে যুক্ত করতে হলে dashboard-এর ওই array গুলোর বদলে এই এন্ডপয়েন্টগুলো `fetch()` দিয়ে কল করতে হবে:

- `GET /api/dashboard/summary`
- `GET /api/orders`, `PATCH /api/orders/:id` (body: `{status}`)
- `GET /api/customers`, `PATCH /api/customers/:id/ai` (body: `{ai:true/false}`)
- `POST /api/broadcast` (body: `{message}`), `GET /api/broadcast`
- `GET /api/settings`, `POST /api/settings`

এই অংশটা চাইলে বলবেন — dashboard HTML-টা আমি এই API-গুলোর সাথে যুক্ত করে দিতে পারি, যাতে পুরো সিস্টেম এন্ড-টু-এন্ড কাজ করে।

## গুরুত্বপূর্ণ নোট

- WhatsApp-এর জন্য দুটো জিনিস লাগে — Access Token আর Phone Number ID। বর্তমান dashboard UI-তে শুধু একটা ঘর আছে; API-তে `waPhoneNumberId` আলাদা ফিল্ড হিসেবে পাঠাতে হবে (dashboard আপডেট করার সময় এটাও যোগ করে দেব)।
- এই কোডে অর্ডার-শনাক্তকরণ (AI থেকে) একটা সহজ heuristic — বাস্তব ব্যবহারে ভুল অর্ডারও তৈরি হতে পারে, তাই শুরুতে Orders ট্যাব থেকে যাচাই করে নেওয়া ভালো।
- production-এ যাওয়ার আগে JSON ফাইলের বদলে আসল ডেটাবেস (PostgreSQL/MongoDB) ব্যবহার করা উচিত, বিশেষ করে একাধিক কাস্টমার/অর্ডার বেশি হলে।
