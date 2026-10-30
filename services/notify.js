// মালিকের কাছে নোটিফিকেশন: অ্যাপের ভেতরের তালিকায় সেভ হয়, আর ফোনে পুশ যায় (অ্যাপ বন্ধ থাকলেও)।
// Messenger/WhatsApp দিয়ে নিজেকে মেসেজ পাঠানো যায় না (২৪ ঘণ্টার নিয়ম), তাই Web Push ব্যবহার হচ্ছে।
const webpush = require('web-push');
const config = require('../config');
const store = require('./store');

let configured = false;
async function setup() {
  if (configured) return;
  const keys = await store.getVapidKeys(() => webpush.generateVAPIDKeys());
  webpush.setVapidDetails(config.publicUrl, keys.publicKey, keys.privateKey);
  configured = true;
}

async function getPublicKey() {
  const keys = await store.getVapidKeys(() => webpush.generateVAPIDKeys());
  return keys.publicKey;
}

async function sendToAll(payload) {
  await setup();
  const subs = await store.getPushSubs();
  const data = JSON.stringify(payload);
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(s.subscription, data, { TTL: 3600 });
      sent++;
    } catch (err) {
      // 404/410 মানে ফোন আর সাবস্ক্রিপশন রাখেনি — তালিকা থেকে মুছে দিই
      if (err.statusCode === 404 || err.statusCode === 410) await store.deletePushSub(s.endpoint);
      else console.error('পুশ পাঠাতে ব্যর্থ:', err.statusCode || '', err.body || err.message);
    }
  }));
  return sent;
}

// কখনো এরর ছুঁড়ে না — নোটিফিকেশন ব্যর্থ হলেও অর্ডার/চ্যাটের মূল কাজ যেন না থামে
async function notifyOwner({ type, title, body }) {
  try {
    await store.addNotification({ type, title, body });
    await sendToAll({ title, body: body || '', tag: type, url: './' });
  } catch (err) {
    console.error('notifyOwner ব্যর্থ:', err.message);
  }
}

module.exports = { notifyOwner, getPublicKey, sendToAll };
