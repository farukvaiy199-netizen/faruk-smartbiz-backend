require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  webhookVerifyToken: process.env.WEBHOOK_VERIFY_TOKEN || 'change_me',
  encryptionKey: process.env.SETTINGS_ENCRYPTION_KEY || 'change_this_to_a_long_random_string',
  fbAppSecret: process.env.FB_APP_SECRET || '',
  // WhatsApp আলাদা একটা Meta App দিয়ে হলে এই Secret আলাদাভাবে বসাতে হয় —
  // না বসালে ডিফল্টভাবে FB_APP_SECRET-ই ব্যবহার হবে (একই App হলে যথেষ্ট)
  waAppSecret: process.env.WA_APP_SECRET || process.env.FB_APP_SECRET || '',
  // Render-এর ফ্রি সার্ভিসে ডিস্ক অস্থায়ী (প্রতি ডিপ্লয়ে মুছে যায়),
  // তাই সব সেটিংস (AI Key, Facebook Token ইত্যাদি) স্থায়ীভাবে Google Sheet-এ সেভ হয়।
  // এই দুটো Render Environment ভ্যারিয়েবলে বসাতে হবে (একবারই, আর কখনো মুছবে না)।
  sheetScriptUrl: process.env.SHEET_SCRIPT_URL || '',
  sheetScriptToken: process.env.SHEET_SCRIPT_TOKEN || '',

  // ============ অ্যাডমিন লগইন (নতুন) ============
  // এই তিনটা অবশ্যই Render Dashboard → Environment-এ বসাতে হবে।
  // ADMIN_EMAIL / ADMIN_PASSWORD আপনি নিজে যা খুশি বসাতে পারেন (Gmail হতে হবে এমন কোনো নিয়ম নেই,
  // শুধু মনে রাখার মতো একটা ইমেইল-স্টাইল আইডি ও একটা শক্তিশালী পাসওয়ার্ড দিন)।
  // JWT_SECRET একটা লম্বা এলোমেলো স্ট্রিং হওয়া উচিত — এটা দিয়েই লগইন টোকেন সই (sign) করা হয়।
  adminEmail: process.env.ADMIN_EMAIL || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  jwtSecret: process.env.JWT_SECRET || 'change_this_to_a_long_random_string_too'
};
