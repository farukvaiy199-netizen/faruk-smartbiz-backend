require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  webhookVerifyToken: process.env.WEBHOOK_VERIFY_TOKEN || 'change_me',
  encryptionKey: process.env.SETTINGS_ENCRYPTION_KEY || 'change_this_to_a_long_random_string',
  fbAppSecret: process.env.FB_APP_SECRET || '',
  waAppSecret: process.env.WA_APP_SECRET || process.env.FB_APP_SECRET || '',
  sheetScriptUrl: process.env.SHEET_SCRIPT_URL || '',
  sheetScriptToken: process.env.SHEET_SCRIPT_TOKEN || '',

  // ============ অ্যাডমিন লগইন ============
  adminEmail: process.env.ADMIN_EMAIL || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  jwtSecret: process.env.JWT_SECRET || 'change_this_to_a_long_random_string_too',

  // ============ অর্ডার কনফার্মেশন ইমেইল (নতুন) ============
  // Gmail ব্যবহার করলে EMAIL_USER = আপনার জিমেইল, EMAIL_PASS = Gmail App Password
  // (সাধারণ পাসওয়ার্ড না — Google Account → Security → App Passwords থেকে বানাতে হয়)
  // দুটো Render Environment-এ বসাতে হবে। না বসালে ইমেইল ফিচার নিজে থেকে বন্ধ থাকবে,
  // মেসেজ কনফার্মেশন তখনও কাজ করবে।
  emailUser: process.env.EMAIL_USER || '',
  emailPass: process.env.EMAIL_PASS || '',
  emailFrom: process.env.EMAIL_FROM || process.env.EMAIL_USER || ''
};
