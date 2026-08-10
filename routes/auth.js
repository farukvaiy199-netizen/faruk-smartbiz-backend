const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config');

const router = express.Router();

// শুধু আপনি (অ্যাডমিন) লগইন করতে পারবেন —
// ইমেইল ও পাসওয়ার্ড Render Environment Variable-এ বসাতে হবে (ADMIN_EMAIL, ADMIN_PASSWORD)
router.post('/login', (req, res) => {
  const { email, password } = req.body || {};

  if (!config.adminEmail || !config.adminPassword) {
    return res.status(500).json({
      error: 'সার্ভারে ADMIN_EMAIL ও ADMIN_PASSWORD এখনো সেট করা হয়নি (Render Environment-এ যোগ করুন)'
    });
  }

  if (!email || !password) {
    return res.status(400).json({ error: 'ইমেইল ও পাসওয়ার্ড দুটোই দিন' });
  }

  if (email.trim().toLowerCase() !== config.adminEmail.trim().toLowerCase() || password !== config.adminPassword) {
    return res.status(401).json({ error: 'ইমেইল বা পাসওয়ার্ড ভুল হয়েছে' });
  }

  const token = jwt.sign({ email: config.adminEmail }, config.jwtSecret, { expiresIn: '30d' });
  res.json({ token });
});

module.exports = router;
