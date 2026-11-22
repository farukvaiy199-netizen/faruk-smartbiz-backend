const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config');

const router = express.Router();

// শুধু আপনি (অ্যাডমিন) লগইন করতে পারবেন —
// ইমেইল ও পাসওয়ার্ড Render Environment Variable-এ বসাতে হবে (ADMIN_EMAIL, ADMIN_PASSWORD)
// সেশন ১ বছর চলে (AUTH_DAYS দিয়ে বদলানো যায়) — ফোনে বারবার লগইন করতে হয় না, পুশ নোটিফিকেশনও থেমে যায় না।
const DAYS = Math.min(Math.max(parseInt(process.env.AUTH_DAYS, 10) || 365, 1), 730);

const safeEq = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

// ভুল পাসওয়ার্ড বারবার দিয়ে অনুমান ঠেকানো — একই আইপি থেকে ১৫ মিনিটে ১০ বার
const fails = new Map();
function blocked(ip) {
  const now = Date.now();
  const e = fails.get(ip);
  return !!(e && now - e.t < 15 * 60e3 && e.n >= 10);
}
function bump(ip) {
  const now = Date.now();
  const e = fails.get(ip);
  fails.set(ip, { n: (e && now - e.t < 15 * 60e3 ? e.n : 0) + 1, t: now });
  if (fails.size > 2000) for (const [k, v] of fails) if (now - v.t > 15 * 60e3) fails.delete(k);
}

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || 'x';

  if (!config.adminEmail || !config.adminPassword) {
    return res.status(500).json({
      error: 'সার্ভারে ADMIN_EMAIL ও ADMIN_PASSWORD এখনো সেট করা হয়নি (Render Environment-এ যোগ করুন)'
    });
  }
  if (blocked(ip)) return res.status(429).json({ error: 'অনেকবার ভুল হয়েছে — ১৫ মিনিট পর আবার চেষ্টা করুন' });

  if (!email || !password) {
    return res.status(400).json({ error: 'ইমেইল ও পাসওয়ার্ড দুটোই দিন' });
  }

  const okEmail = safeEq(String(email).trim().toLowerCase(), String(config.adminEmail).trim().toLowerCase());
  const okPass = safeEq(password, config.adminPassword);
  if (!(okEmail && okPass)) {
    bump(ip);
    return res.status(401).json({ error: 'ইমেইল বা পাসওয়ার্ড ভুল হয়েছে' });
  }

  fails.delete(ip);
  const token = jwt.sign({ email: config.adminEmail }, config.jwtSecret, { expiresIn: DAYS + 'd' });
  res.json({ token });
});

module.exports = router;
