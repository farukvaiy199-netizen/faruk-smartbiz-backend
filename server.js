const express = require('express');
const cors = require('cors');
const config = require('./config');

const authRoutes = require('./routes/auth');
const requireAuth = require('./middleware/auth');
const webhookRoutes = require('./routes/webhook');
const apiRoutes = require('./routes/api');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Faruk\'s SmartBiz backend চলছে ✅');
});

// লগইন ছাড়াই অ্যাক্সেসযোগ্য — শুধু সার্ভার জেগে আছে কিনা চেক করার জন্য (dashboard-এর Connect বাটন এটা ব্যবহার করে)
app.get('/api/ping', (req, res) => res.json({ ok: true }));

// লগইন রুট — টোকেন ছাড়াই অ্যাক্সেসযোগ্য (টোকেন এখান থেকেই পাওয়া যায়)
app.use('/api/auth', authRoutes);

// ওয়েবহুক পাবলিক থাকবে — Meta/Bazaar Admin সরাসরি এখানে কল করে, তাদের কাছে লগইন টোকেন থাকে না
app.use('/webhook', webhookRoutes);

// বাকি সব /api রুট — এখন থেকে বৈধ লগইন টোকেন ছাড়া কেউ ডেটা দেখতে বা কিছু পরিবর্তন করতে পারবে না
app.use('/api', requireAuth, apiRoutes);

app.listen(config.port, () => {
  console.log(`✅ Server চলছে: http://localhost:${config.port}`);
});
