// মালিককে জানানো: (১) অ্যাপের ঘণ্টায় তালিকা, (২) ফোনে পুশ নোটিফিকেশন (অ্যাপ বন্ধ থাকলেও)
const webpush = require('web-push');
const store = require('./store');

let ready = null;
async function init() {
  if (ready) return ready;
  ready = (async () => {
    const keys = await store.getVapidKeys(() => webpush.generateVAPIDKeys());
    const subject = process.env.VAPID_SUBJECT || 'mailto:' + (process.env.ADMIN_EMAIL || 'admin@example.com');
    webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
    return keys;
  })().catch(e => { ready = null; throw e; });
  return ready;
}

async function getPublicKey() { return (await init()).publicKey; }

const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// ফেরত: { sent, failed, removed }
async function sendPush(payload) {
  const out = { sent: 0, failed: 0, removed: 0 };
  await init();
  const subs = await store.getPushSubs();
  const body = JSON.stringify(payload);
  await Promise.all(subs.map(async s => {
    try {
      await webpush.sendNotification(s.subscription, body, { TTL: 86400, urgency: 'high', topic: String(payload.tag || 'smartbiz').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'smartbiz' });
      out.sent++;
    } catch (e) {
      // ফোন থেকে সাবস্ক্রিপশন মুছে গেছে (৪০৪/৪১০) — তালিকা থেকে বাদ
      if (e && (e.statusCode === 404 || e.statusCode === 410)) { out.removed++; await store.deletePushSub(s.endpoint).catch(() => {}); }
      else { out.failed++; console.error('পুশ পাঠানো যায়নি:', e && (e.statusCode || e.message)); }
    }
  }));
  return out;
}

// কখনো এরর ছোঁড়ে না — নোটিফিকেশন ব্যর্থ হলেও আসল কাজ চলবে
async function notifyOwner({ type, title, body }) {
  try { await store.addNotification({ type, title, body }); } catch (e) { console.error('নোটিফিকেশন সেভ হয়নি:', e.message); }
  try {
    const r = await sendPush({ title: clip(title, 80), body: clip(body, 200), tag: type || 'smartbiz', type: type || '' });
    if (r.sent || r.failed || r.removed) console.log(`🔔 পুশ: গেছে=${r.sent} ব্যর্থ=${r.failed} বাদ=${r.removed}`);
    return r;
  } catch (e) { console.error('পুশ ত্রুটি:', e.message); return { sent: 0, failed: 1, removed: 0 }; }
}

module.exports = { notifyOwner, getPublicKey, sendPush };
