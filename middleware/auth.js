const jwt = require('jsonwebtoken');
const config = require('../config');

// এই মিডলওয়্যার /api রুটগুলোর আগে বসবে — বৈধ টোকেন ছাড়া কেউ কোনো ডেটা/অ্যাকশন পাবে না
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'লগইন প্রয়োজন' });
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'সেশনের মেয়াদ শেষ হয়ে গেছে, আবার লগইন করুন' });
  }
}

module.exports = requireAuth;
