// কাস্টমারকে সক্রিয় রাখার স্বয়ংক্রিয় কাজ:
//  ১) পণ্যের ভিডিও গাইড লিংক পাঠানো (কাস্টমার "কীভাবে খাব/ব্যবহার করব/ভিডিও" জিজ্ঞেস করলে)
//  ২) আগ্রহ দেখিয়ে কেনেনি — ৩-২১ ঘণ্টার মধ্যে একবার নরমভাবে মনে করানো (Meta-র ২৪ ঘণ্টার সীমার ভেতরে)
//  ৩) ডেলিভারির কিছু সময় পর রিভিউ-কার্ড (সীমার বাইরে হলে কাস্টমার পরের মেসেজ দিলেই যাবে)
//  ৪) রাত ৯টার পর মালিকের ফোনে আজকের সারসংক্ষেপ
// সব কাজ কখনো এরর ছোঁড়ে না। বন্ধ করতে: REVIEW_ASK=off, NUDGE=off, DAILY_REPORT=off (Render Environment)
const axios = require('axios');
const store = require('./store');
const crm = require('./crm');
const shop = require('./shop');

const CHAT = ['facebook', 'instagram', 'whatsapp', 'telegram'];
const BD = 6 * 3600e3;
const bdHour = (ms) => new Date((ms || Date.now()) + BD).getUTCHours();
const bdDay = (ms) => new Date((ms || Date.now()) + BD).toISOString().slice(0, 10);
const quiet = () => { const h = bdHour(); return h < 9 || h >= 22; };
const off = (k) => String(process.env[k] || '').toLowerCase() === 'off';
const num = (v, d) => { const n = Number(v); return isFinite(n) && n > 0 ? n : d; };

let cardSender = null; // webhook.js থেকে বসানো হয় (sendProductCards)
function setCardSender(fn) { cardSender = fn; }

const callName = (c) => {
  const real = c && c.name && c.name !== 'অজানা কাস্টমার' && !/^@/.test(c.name);
  return real ? String(c.name).split(/\s+/)[0] + ' স্যার/ম্যাম' : 'স্যার/ম্যাম';
};

/* ============ ১) ভিডিও গাইড ============ */
const VIDEO_RE = /ভিডিও|video|vedio|কীভাবে\s*(খাব|খেতে|খাওয়া|ব্যবহার|খুল|লাগাব|লাগাতে|চালাব|চালাতে)|কিভাবে\s*(খাব|খেতে|খাওয়া|ব্যবহার|খুল|লাগাব|লাগাতে|চালাব|চালাতে)|ব্যবহার(ের)?\s*(নিয়ম|পদ্ধতি|বিধি)|খাওয়ার\s*নিয়ম|উপকারিতা|কী\s*কী\s*উপকার|কি\s*কি\s*উপকার|use\s*kor|ব্যবহার\s*কর/i;
function wantsVideo(text) { return VIDEO_RE.test(String(text || '')); }

// ফেরত: পাঠানোর লেখা অথবা ''
async function videoMessage(productIds) {
  const lines = [];
  for (const id of (productIds || []).slice(0, 2)) {
    const vids = await shop.getProductVideos(id);
    if (!vids.length) continue;
    const card = await shop.getProductCard(id).catch(() => null);
    if (productIds.length > 1 && card) lines.push(`\n📦 ${card.name}`);
    vids.slice(0, 4).forEach(v => lines.push(`🎬 ${v.title || 'ভিডিও দেখুন'}\n${v.url}`));
  }
  return lines.length ? '📺 ভিডিও গাইড — ছোট ভিডিওতে দেখে নিন 👇\n' + lines.join('\n') : '';
}

/* ============ ২) আগ্রহী কিন্তু কেনেননি — একবার মনে করানো ============ */
async function runNudges() {
  if (off('NUDGE') || quiet()) return 0;
  const db = await store.getDb();
  const now = Date.now();
  const lo = new Date(now - 21 * 3600e3).toISOString(), hi = new Date(now - 3 * 3600e3).toISOString();
  const list = await db.collection('customers').find({ 'interest.at': { $gte: lo, $lte: hi }, platform: { $in: CHAT } }).limit(30).toArray();
  let n = 0;
  const settings = await store.getSettings();
  for (const raw of list) {
    if (n >= 3) break;
    const c = raw;
    try {
      if (c.ai === false || c.needsHuman) continue;
      if (c.lastOrderAt && c.lastOrderAt >= c.interest.at) continue;
      if (c.nudgedAt && c.nudgedAt >= c.interest.at) continue;
      if (c.followUp && c.followUp.done === false) continue; // "পরে মেসেজ দিন" ঠিক করা আছে — সেটাই কাজ করবে
      const last = c.lastMessageAt || c.updatedAt;
      if (last && now - new Date(last).getTime() < 2 * 3600e3) continue; // কাস্টমার এখনই কথা বলছেন
      const claim = await db.collection('customers').updateOne({ id: c.id, nudgedAt: c.nudgedAt === undefined ? { $exists: false } : c.nudgedAt }, { $set: { nudgedAt: new Date().toISOString() } });
      if (!claim.modifiedCount) continue;
      let msg = `আসসালামু আলাইকুম ${callName(c)}! 😊\nআপনি "${c.interest.product}" নিয়ে জানতে চেয়েছিলেন। কোনো প্রশ্ন থাকলে বা অর্ডার করতে চাইলে এখানেই জানান — আমি সাহায্য করছি।`;
      const alt = await shop.getAlternatives({ excludeIds: [], max: 0 }).catch(() => ({ offers: [] }));
      if (alt.offers && alt.offers.length) msg += '\n\nচলমান অফার:\n' + alt.offers.slice(0, 2).join('\n');
      await crm.sendPlain(c, msg, settings);
      await store.appendMessage(c.id, 'assistant', msg);
      const card = await shop.getProductCard(c.interest.productId).catch(() => null);
      if (card && cardSender) await cardSender(c.platform, c.platformId, settings, [card]).catch(() => {});
      n++;
      console.log(`💌 আগ্রহী-কাস্টমারকে মনে করানো: ${c.platform}/${c.platformId} (${c.interest.product})`);
    } catch (err) { console.error('মনে-করানো ব্যর্থ:', c.platform, err.response && err.response.data ? JSON.stringify(err.response.data) : err.message); }
  }
  return n;
}

/* ============ ৩) রিভিউ কার্ড ============ */
async function sendReviewCard(c, order, card, settings) {
  const title = ('📦 ' + (card && card.name ? card.name : order.product || 'আপনার অর্ডার') + ' কেমন লাগলো?').slice(0, 80);
  const sub = `${callName(c)}, আপনার একটা রিভিউ আমাদের অনেক কাজে লাগে 🙏`.slice(0, 80);
  const link = card && card.url ? card.url : '';
  if (c.platform === 'facebook' || c.platform === 'instagram') {
    if (!settings.fbToken) throw new Error('টোকেন নেই');
    const buttons = [];
    if (link) buttons.push({ type: 'web_url', url: link, title: '⭐ রিভিউ দিন' });
    buttons.push({ type: 'postback', title: '👍 ভালো লেগেছে', payload: 'RVG:' + order.id });
    buttons.push({ type: 'postback', title: '😕 সমস্যা আছে', payload: 'RVB:' + order.id });
    const el = { title, subtitle: sub, buttons };
    if (card && card.image) el.image_url = card.image;
    const host = c.platform === 'instagram' && /^IG/.test(String(settings.fbToken)) ? 'https://graph.instagram.com/v21.0' : 'https://graph.facebook.com/v21.0';
    await axios.post(host + '/me/messages', { recipient: { id: c.platformId }, messaging_type: 'RESPONSE', message: { attachment: { type: 'template', payload: { template_type: 'generic', elements: [el] } } } },
      { params: { access_token: settings.fbToken }, timeout: 15000 });
    return;
  }
  if (c.platform === 'whatsapp') {
    if (!settings.waToken || !settings.waPhoneNumberId) throw new Error('WhatsApp সেটিং নেই');
    const interactive = {
      type: 'button',
      body: { text: (title + '\n' + sub + (link ? '\n⭐ রিভিউ দিন: ' + link : '')).slice(0, 1000) },
      action: { buttons: [{ type: 'reply', reply: { id: 'RVG:' + order.id, title: '👍 ভালো লেগেছে' } }, { type: 'reply', reply: { id: 'RVB:' + order.id, title: '😕 সমস্যা আছে' } }] }
    };
    if (card && card.image) interactive.header = { type: 'image', image: { link: card.image } };
    await axios.post(`https://graph.facebook.com/v21.0/${settings.waPhoneNumberId}/messages`, { messaging_product: 'whatsapp', to: c.platformId, type: 'interactive', interactive },
      { headers: { Authorization: 'Bearer ' + settings.waToken }, timeout: 15000 });
    return;
  }
  // টেলিগ্রাম ইত্যাদি — সাধারণ লেখা
  await crm.sendPlain(c, `${title}\n${sub}${link ? '\n⭐ রিভিউ দিন: ' + link : ''}\nভালো লাগলে "ভালো", সমস্যা থাকলে "সমস্যা" লিখে জানান।`, settings);
}

async function cardForOrder(order) {
  try {
    const ids = await shop.resolveProducts({ reply: '', text: String(order.product || ''), history: [] });
    return ids && ids[0] ? await shop.getProductCard(ids[0]) : null;
  } catch (e) { return null; }
}

async function runReviewAsks() {
  if (off('REVIEW_ASK') || quiet()) return 0;
  const delayMs = num(process.env.REVIEW_DELAY_HOURS, 24) * 3600e3;
  const db = await store.getDb();
  const now = Date.now();
  const orders = await db.collection('orders').find({ status: 'Delivered', reviewState: { $exists: false }, createdAt: { $gte: new Date(now - 14 * 86400e3).toISOString() } }).limit(20).toArray();
  let n = 0;
  const settings = orders.length ? await store.getSettings() : null;
  for (const o of orders) {
    if (n >= 4) break;
    try {
      // প্রথমবার ডেলিভারড দেখা গেলে সময় লিখে রাখি — তারপর নির্ধারিত সময় পার হলে পাঠাই
      if (!o.deliveredSeenAt) { await db.collection('orders').updateOne({ id: o.id }, { $set: { deliveredSeenAt: new Date(now).toISOString() } }); continue; }
      if (now - new Date(o.deliveredSeenAt).getTime() < delayMs) continue;
      const c = o.customerId ? await store.getCustomerById(o.customerId) : null;
      if (!c || !CHAT.includes(c.platform)) { await db.collection('orders').updateOne({ id: o.id }, { $set: { reviewState: 'skip' } }); continue; }
      const claim = await db.collection('orders').updateOne({ id: o.id, reviewState: { $exists: false } }, { $set: { reviewState: 'sending' } });
      if (!claim.modifiedCount) continue;
      const card = await cardForOrder(o);
      try {
        await sendReviewCard(c, o, card, settings);
        await db.collection('orders').updateOne({ id: o.id }, { $set: { reviewState: 'sent', reviewAskedAt: new Date().toISOString() } });
        await store.appendMessage(c.id, 'assistant', '[রিভিউ কার্ড পাঠানো হয়েছে — ' + o.id + ']');
        console.log(`⭐ রিভিউ কার্ড গেছে: ${c.platform}/${c.platformId} ${o.id}`);
        n++;
      } catch (err) {
        // ২৪ ঘণ্টার সীমা পার — কাস্টমার পরের বার মেসেজ দিলেই কার্ড যাবে
        await db.collection('orders').updateOne({ id: o.id }, { $set: { reviewState: 'pending' } });
        await db.collection('customers').updateOne({ id: c.id }, { $set: { reviewPendingOrder: o.id } });
        console.log(`⭐ রিভিউ কার্ড এখন যায়নি (${c.platform}) — কাস্টমারের পরের মেসেজে যাবে: ${err.response && err.response.data && err.response.data.error ? err.response.data.error.message : err.message}`);
      }
    } catch (err) { console.error('রিভিউ-অনুরোধ এরর:', err.message); }
  }
  return n;
}

// কাস্টমার মেসেজ দিলে (২৪ ঘণ্টার ভেতরে আছেন) — অপেক্ষায় থাকা রিভিউ কার্ড এখন পাঠাই
async function flushPendingReview(customer, settings) {
  try {
    if (off('REVIEW_ASK') || !customer || !customer.reviewPendingOrder) return false;
    const db = await store.getDb();
    const pendingId = customer.reviewPendingOrder;
    const claim = await db.collection('customers').updateOne({ id: customer.id, reviewPendingOrder: pendingId }, { $unset: { reviewPendingOrder: '' } });
    if (!claim.modifiedCount) return false;
    const o = await db.collection('orders').findOne({ id: pendingId });
    if (!o) return false;
    await sendReviewCard(customer, o, await cardForOrder(o), settings);
    await db.collection('orders').updateOne({ id: o.id }, { $set: { reviewState: 'sent', reviewAskedAt: new Date().toISOString() } });
    console.log(`⭐ অপেক্ষার রিভিউ কার্ড গেছে: ${customer.platform}/${customer.platformId} ${o.id}`);
    return true;
  } catch (err) { console.error('অপেক্ষার রিভিউ কার্ড যায়নি:', err.response && err.response.data ? JSON.stringify(err.response.data) : err.message); return false; }
}

// কাস্টমার রিভিউ-কার্ডের বাটন চাপলে। ফেরত: { text, bad } অথবা null
async function reviewReply(kind, orderId) {
  try {
    const db = await store.getDb();
    const o = await db.collection('orders').findOne({ id: String(orderId) });
    if (!o) return null;
    await db.collection('orders').updateOne({ id: o.id }, { $set: { reviewState: kind === 'RVG' ? 'good' : 'bad', reviewAnsweredAt: new Date().toISOString() } });
    if (kind === 'RVG') {
      const card = await cardForOrder(o);
      return { bad: false, order: o, text: 'আলহামদুলিল্লাহ, শুনে খুব ভালো লাগলো! 🥰 সময় পেলে নিচের লিংকে ২ মিনিটে একটা রিভিউ লিখে দিলে নতুন কাস্টমারদের অনেক সাহায্য হয় 🙏' + (card && card.url ? '\n⭐ ' + card.url : '') };
    }
    return { bad: true, order: o, text: 'দুঃখিত, আপনার অসুবিধা হয়েছে জেনে খারাপ লাগছে 🙏 কী সমস্যা হয়েছে একটু লিখে জানাবেন? আমরা সাথে সাথে দেখছি এবং সমাধান করব।' };
  } catch (e) { return null; }
}

/* ============ ৪) দৈনিক রিপোর্ট ============ */
async function runDailyReport() {
  if (off('DAILY_REPORT')) return false;
  const now = Date.now();
  if (bdHour(now) < num(process.env.DAILY_REPORT_HOUR, 21) || bdHour(now) >= 24) return false;
  const day = bdDay(now);
  const db = await store.getDb();
  const meta = db.collection('meta');
  const cur = await meta.findOne({ _id: 'dailyReport' });
  if (cur && cur.day === day) return false;
  try {
    if (cur) { const r = await meta.updateOne({ _id: 'dailyReport', day: cur.day }, { $set: { day, at: new Date().toISOString() } }); if (!r.modifiedCount) return false; }
    else await meta.insertOne({ _id: 'dailyReport', day, at: new Date().toISOString() });
  } catch (e) { return false; }
  const all = await db.collection('orders').find({ createdAt: { $gte: new Date(now - 36 * 3600e3).toISOString() } }).toArray();
  const today = all.filter(o => bdDay(new Date(o.createdAt).getTime()) === day);
  const total = (o) => (Number(o.price) || 0) * (Number(o.qty) || 1) + (Number(o.shipping) || 0);
  const rev = today.filter(o => o.status !== 'Cancelled').reduce((s, o) => s + total(o), 0);
  const pending = await db.collection('orders').countDocuments({ status: 'Pending' });
  const by = {};
  today.forEach(o => { by[o.product] = (by[o.product] || 0) + (Number(o.qty) || 1); });
  const top = Object.entries(by).sort((a, b) => b[1] - a[1])[0];
  let hot = 0; try { hot = (await store.getInterestedCustomers()).filter(c => bdDay(new Date(c.interest.at).getTime()) === day).length; } catch (e) { /* গুরুত্বপূর্ণ নয় */ }
  const bn = (n) => String(n).replace(/\d/g, d => '০১২৩৪৫৬৭৮৯'[d]);
  const body = `আজ অর্ডার ${bn(today.length)}টি · বিক্রি ৳${bn(rev.toLocaleString('en-US'))}` + ` · পেন্ডিং (মোট) ${bn(pending)}টি` + (top ? ` · সেরা: ${String(top[0]).slice(0, 40)}` : '') + (hot ? ` · আগ্রহী কিন্তু কেনেনি ${bn(hot)} জন` : '');
  await require('./notify').notifyOwner({ type: 'report', title: '📊 আজকের ব্যবসার সারসংক্ষেপ', body });
  console.log('📊 দৈনিক রিপোর্ট পাঠানো হলো: ' + body);
  return true;
}

let running = false;
async function runAll() {
  if (running) return;
  running = true;
  try {
    await runNudges().catch(e => console.error('নাজ:', e.message));
    await runReviewAsks().catch(e => console.error('রিভিউ:', e.message));
    await runDailyReport().catch(e => console.error('রিপোর্ট:', e.message));
  } finally { running = false; }
}

module.exports = { setCardSender, wantsVideo, videoMessage, runNudges, runReviewAsks, flushPendingReview, reviewReply, runDailyReport, runAll };
