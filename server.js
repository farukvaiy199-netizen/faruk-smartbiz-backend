const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const store = require('./services/store');
const { runDueInstagramPosts } = require('./services/scheduler');
const videoPosts = require('./services/videoPosts');

const authRoutes = require('./routes/auth');
const requireAuth = require('./middleware/auth');
const webhookRoutes = require('./routes/webhook');
const apiRoutes = require('./routes/api');

const app = express();
// Render একটা প্রক্সির পেছনে চলে (X-Forwarded-For হেডার আসে) — এটা বলে না দিলে
// express-rate-limit সব রিকোয়েস্টকে ভুল করে একই ব্যবহারকারীর ধরে নিয়ে সবাইকে ব্লক করে দেয়।
app.set('trust proxy', 1);
app.use(cors());
// ডিফল্ট সীমা মাত্র ১০০KB — মালিকের আপলোড করা ছবি (ডেটা হিসেবে) এর চেয়ে বড় হয়, তাই ২MB করা হলো
// rawBody রাখা হয় Meta-র সই যাচাই করার জন্য (সই মূল রিকোয়েস্ট বডির উপর হিসেব হয়)
app.use(express.json({ limit: '2mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

app.get('/', (req, res) => {
  res.send('Faruk\'s SmartBiz backend চলছে ✅');
});

// লগইন ছাড়াই অ্যাক্সেসযোগ্য — শুধু সার্ভার জেগে আছে কিনা চেক করার জন্য
app.get('/api/ping', (req, res) => res.json({ ok: true }));

// লগইন রুট — টোকেন ছাড়াই অ্যাক্সেসযোগ্য
app.use('/api/auth', authRoutes);

// কেউ ইচ্ছাকৃতভাবে স্প্যাম করে AI কোটা/বিল দ্রুত শেষ করে দিতে না পারে, তাই ওয়েবহুকে সীমা —
// প্রতি IP থেকে মিনিটে সর্বোচ্চ ২০টা রিকোয়েস্ট। সাধারণ ব্যবহারে এটা কখনো ধরা পড়বে না।
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'অনেক বেশি রিকোয়েস্ট, একটু পরে চেষ্টা করুন' }
});

// ওয়েবহুক পাবলিক থাকবে — Meta/Bazaar Admin সরাসরি এখানে কল করে, তাদের কাছে লগইন টোকেন থাকে না
// সীমা শুধু ওয়েবসাইট চ্যাট ও অর্ডার ওয়েবহুকে (ব্রাউজার থেকে সরাসরি আসে, প্রতিটা ব্যবহারকারীর আলাদা IP)।
// Messenger/WhatsApp-এর রিকোয়েস্ট সব Meta-র হাতে-গোনা কয়েকটা সার্ভার থেকে আসে — ওখানে IP-ভিত্তিক সীমা বসালে
// সক্রিয় সময়ে আসল কাস্টমারের মেসেজও ব্লক হয়ে যায় (কিছু কাস্টমার তালিকায় না আসার একটা কারণ এটাও ছিল)।
app.use('/webhook/ai-reply', webhookLimiter);
app.use('/webhook/order', webhookLimiter);
app.use('/webhook', webhookRoutes);

// শিডিউল করা পোস্টের ছবি — Instagram এই পাবলিক লিংক থেকে ছবি নিয়ে পোস্ট করে
app.get('/pmedia/:file', async (req, res) => {
  try {
    const id = String(req.params.file).replace(/\.[a-z0-9]+$/i, '');
    const m = await store.getPostMedia(id);
    if (!m) return res.sendStatus(404);
    res.set('Content-Type', m.mime || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(Buffer.from(m.b64, 'base64'));
  } catch (err) {
    res.sendStatus(500);
  }
});

// শিডিউল/পোস্ট করা ভিডিও — Instagram এই পাবলিক লিংক থেকে ভিডিও নিয়ে রিল বানায় (MongoDB GridFS থেকে)
app.get('/pvideo/:file', async (req, res) => {
  try {
    const id = String(req.params.file).replace(/\.[a-z0-9]+$/i, '');
    await videoPosts.streamVideo(id, req, res);
  } catch (err) {
    if (!res.headersSent) res.sendStatus(500);
  }
});

// UptimeRobot প্রতি ৫ মিনিটে এই লিংকে পিং করলে সার্ভার জেগে ওঠে এবং সময় হয়ে যাওয়া Instagram পোস্ট চালায়
app.get('/cron/run', async (req, res) => {
  try {
    const key = await store.getCronKey();
    const given = String(req.query.key || '');
    const ok = given.length === key.length && require('crypto').timingSafeEqual(Buffer.from(given), Buffer.from(key));
    if (!ok) return res.sendStatus(403);
    const ran = await runDueInstagramPosts();
    res.json({ ok: true, ran });
  } catch (err) {
    res.status(500).json({ ok: false });
  }
});

// মালিকের আপলোড করা প্রোডাক্ট ছবি — Messenger/WhatsApp এই পাবলিক লিংক থেকে ছবি নিয়ে কাস্টমারকে দেখায়
app.get('/media/:id', async (req, res) => {
  try {
    const img = await store.getAiImageData(req.params.id);
    if (!img) return res.sendStatus(404);
    res.set('Content-Type', img.mime);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(img.b64, 'base64'));
  } catch (err) {
    res.sendStatus(500);
  }
});

// বাকি সব /api রুট — বৈধ লগইন টোকেন ছাড়া কেউ ডেটা দেখতে বা কিছু পরিবর্তন করতে পারবে না
app.use('/api', requireAuth, apiRoutes);

// সার্ভার জেগে থাকলে প্রতি মিনিটে সময় হয়ে যাওয়া Instagram পোস্ট চালাই; চালু হওয়ার ২০ সেকেন্ড পরেও একবার (ঘুম থেকে ওঠার পর বাকি কাজ ধরতে)
setInterval(() => { runDueInstagramPosts().catch(() => {}); }, 60 * 1000);
setTimeout(() => { runDueInstagramPosts().catch(() => {}); }, 20 * 1000);

const server = app.listen(config.port, () => {
  console.log(`✅ Server চলছে: http://localhost:${config.port}`);
});
// বড় ভিডিও আপলোডে মোবাইল নেটে ৫ মিনিটের বেশি লাগতে পারে — Node-এর ডিফল্ট ৫ মিনিটের সীমা বাড়ানো হলো
server.requestTimeout = 30 * 60 * 1000;
