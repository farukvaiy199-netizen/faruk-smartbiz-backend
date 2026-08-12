const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config');

const authRoutes = require('./routes/auth');
const requireAuth = require('./middleware/auth');
const webhookRoutes = require('./routes/webhook');
const apiRoutes = require('./routes/api');

const app = express();
// Render একটা প্রক্সির পেছনে চলে (X-Forwarded-For হেডার আসে) — এটা বলে না দিলে
// express-rate-limit সব রিকোয়েস্টকে ভুল করে একই ব্যবহারকারীর ধরে নিয়ে সবাইকে ব্লক করে দেয়।
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

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
app.use('/webhook', webhookLimiter, webhookRoutes);

// বাকি সব /api রুট — বৈধ লগইন টোকেন ছাড়া কেউ ডেটা দেখতে বা কিছু পরিবর্তন করতে পারবে না
app.use('/api', requireAuth, apiRoutes);

app.listen(config.port, () => {
  console.log(`✅ Server চলছে: http://localhost:${config.port}`);
});
