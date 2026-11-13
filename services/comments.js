// Facebook ও Instagram কমেন্টে স্বয়ংক্রিয় রিপ্লাই।
// নীতি: দাম/বিস্তারিত পাবলিক কমেন্টে না — ছোট ভদ্র উত্তর + ইনবক্সে (Private Reply) বিস্তারিত।
// অভিযোগ হলে পাবলিকে কিছু না লিখে মালিককে জানায়। ডিফল্ট বন্ধ (settings.commentAuto === 'on' হলে চালু)।
const axios = require('axios');
const store = require('./store');
const shop = require('./shop');
const { getJsonReply } = require('./ai');
const { notifyOwner } = require('./notify');

const GRAPH = 'https://graph.facebook.com/v19.0';
const HOURLY_CAP = 60; // এক ঘণ্টায় সর্বোচ্চ এতগুলো কমেন্টে সাড়া — স্প্যাম/খরচ ঠেকাতে

const clip = (s, n) => String(s || '').slice(0, n);
function errMsg(err) {
  const e = err && err.response && err.response.data && err.response.data.error;
  return clip((e && (e.message || e.error_user_msg)) || (err && err.message) || err, 200);
}

async function logCol() { return (await store.getDb()).collection('comment_log'); }

// একই কমেন্টে দুইবার সাড়া এড়াতে — আগে দাবি (claim) করে নিই; ফেরত true মানে এই প্রসেসই কাজটা করবে
async function claim(id, platform) {
  const col = await logCol();
  const r = await col.updateOne({ _id: platform + ':' + id }, { $setOnInsert: { at: new Date(), platform, status: 'claimed' } }, { upsert: true });
  return r.upsertedCount === 1;
}
async function finish(id, platform, fields) {
  const col = await logCol();
  await col.updateOne({ _id: platform + ':' + id }, { $set: { ...fields, at: new Date() } });
}
async function overCap() {
  const col = await logCol();
  const n = await col.countDocuments({ at: { $gte: new Date(Date.now() - 3600000) } });
  return n > HOURLY_CAP;
}

async function classify({ settings, text, who, platform }) {
  const rules = await store.getAiRules();
  const shopCtx = await shop.getAiContext(text).catch(() => '');
  const system = `
তুমি একটা অনলাইন দোকানের সোশ্যাল মিডিয়া কমেন্ট-সহকারী। কাস্টমার পোস্টে কমেন্ট করেছে; তুমি ঠিক করবে কী করা উচিত।
প্ল্যাটফর্ম: ${platform}। কমেন্টকারী: ${who || 'অজানা'}।

মালিকের নির্দেশনা:
${rules.length ? rules.map((r, i) => `${i + 1}) ${r.text}`).join('\n') : '(নেই)'}
${shopCtx}

intent বেছে নাও:
- "price"  : দাম/কত/প্রাইস/ডিটেইলস/কিভাবে নেব/অর্ডার করতে চাই/স্টক আছে কিনা — কিছু জানতে বা কিনতে চায়
- "praise" : প্রশংসা, শুভেচ্ছা, সাধারণ ভালো মন্তব্য
- "complaint": অভিযোগ, রাগ, খারাপ অভিজ্ঞতা, প্রতারণার অভিযোগ
- "spam"   : বিজ্ঞাপন, লিংক, অশালীন, অপ্রাসঙ্গিক
- "other"  : বাকি সব (বন্ধুদের ট্যাগ, অস্পষ্ট ইত্যাদি)

কঠোর নিয়ম:
- publicReply: পাবলিক কমেন্টের উত্তর, ১ লাইন, বাংলায়, ভদ্র। এখানে কখনো দাম, ফোন নম্বর, লিংক বা বিস্তারিত দেবে না। "price" হলে এরকম: "ধন্যবাদ! আপনার ইনবক্সে বিস্তারিত পাঠিয়ে দিচ্ছি 📩"। "praise" হলে ছোট ধন্যবাদ। অন্যগুলোতে খালি রাখো ("")।
- privateReply: শুধু "price" হলে। ইনবক্সের বার্তা, বাংলায়, শুরুতে বলো যে উনি পণ্যটির বিষয়ে জানতে চেয়েছেন তাই বিস্তারিত দিচ্ছ। উপরের ওয়েবসাইট/মালিকের তথ্য থেকে দাম, স্টক ও কী করে অর্ডার করবেন লেখো। কোন পণ্য নিয়ে কমেন্ট তা স্পষ্ট না হলে পণ্যের নাম জিজ্ঞেস করো। তথ্যে না থাকলে বানাবে না। শেষে জিজ্ঞেস করো ওয়েবসাইট থেকে অর্ডার দেবেন নাকি এখানে চ্যাটে। ৫ লাইনের মধ্যে।
- তথ্য বানাবে না। স্টকে নেই বা জানা নেই এমন দাবি করবে না।

শুধু এই JSON-এ উত্তর দাও:
{"intent":"price|praise|complaint|spam|other","publicReply":"","privateReply":""}
`.trim();
  const r = await getJsonReply({ settings, systemPrompt: system, userMessage: `কমেন্ট: ${clip(text, 500)}` });
  const intent = ['price', 'praise', 'complaint', 'spam', 'other'].includes(r && r.intent) ? r.intent : 'other';
  return {
    intent,
    publicReply: intent === 'price' || intent === 'praise' ? clip(r.publicReply, 300).trim() : '',
    privateReply: intent === 'price' ? clip(r.privateReply, 1500).trim() : ''
  };
}

const hasWords = s => /[\p{L}\p{N}]/u.test(String(s || ''));

async function handleComment({ platform, commentId, text, fromId, fromName, ownId, send }) {
  const settings = await store.getSettings();
  if (settings.commentAuto !== 'on') return;
  if (!settings.fbToken || !commentId) return;
  if (!hasWords(text)) return; // শুধু ইমোজি/ফাঁকা — সাড়া দরকার নেই
  if (fromId && ownId && String(fromId) === String(ownId)) return; // নিজের কমেন্ট
  if (!(await claim(commentId, platform))) return;
  try {
    if (await overCap()) { await finish(commentId, platform, { status: 'skipped', note: 'ঘণ্টার সীমা' }); return; }
    const c = await classify({ settings, text, who: fromName, platform });
    if (c.intent === 'price') {
      let site = '';
      try { const st = await shop.status(); site = st && st.connected ? st.site : ''; } catch (e) { /* ঠিক আছে */ }
      c.publicReply = 'ধন্যবাদ! বিষয়টি ইনবক্সে জানিয়ে দেওয়া হচ্ছে 📩 বিস্তারিত জানতে আমাদের ইনবক্সে মেসেজ দিন' + (site ? ' বা ওয়েবসাইটে ভিজিট করুন 🌐 ' + site : '।');
    }
    let pub = '', priv = '', note = '';
    if (c.publicReply) {
      try { await send.public(c.publicReply); pub = 'ok'; } catch (e) { pub = 'fail'; note += 'পাবলিক: ' + errMsg(e) + ' '; }
    }
    if (c.privateReply) {
      try { await send.private(c.privateReply); priv = 'ok'; } catch (e) { priv = 'fail'; note += 'ইনবক্স: ' + errMsg(e) + ' '; }
    }
    if (c.intent === 'complaint') {
      await notifyOwner({ type: 'comment', title: `⚠️ কমেন্টে অভিযোগ (${platform === 'facebook' ? 'Facebook' : 'Instagram'})`, body: `${fromName || 'কেউ'}: ${clip(text, 160)}` }).catch(() => {});
    }
    // ইনবক্সে বিস্তারিত পাঠানো গেলে কথোপকথনেও লিখে রাখি — কাস্টমার উত্তর দিলে AI আগের প্রসঙ্গ জানবে
    if (priv === 'ok' && fromId) {
      try {
        const cust = await store.findOrCreateCustomer({ platform, platformId: String(fromId), name: fromName });
        await store.appendMessage(cust.id, 'user', `[পোস্টে কমেন্ট করেছিলেন]: ${clip(text, 300)}`);
        await store.appendMessage(cust.id, 'assistant', c.privateReply);
      } catch (e) { /* ঠিক আছে */ }
    }
    await finish(commentId, platform, { status: 'done', intent: c.intent, pub, priv, note: note.trim(), text: clip(text, 120) });
  } catch (err) {
    console.error('কমেন্ট প্রসেস ব্যর্থ:', errMsg(err));
    await finish(commentId, platform, { status: 'error', note: errMsg(err) }).catch(() => {});
  }
}

/* ---------- Facebook: webhook entry.changes[field=feed, item=comment] ---------- */
async function handleFacebookChange(entry, change) {
  const v = change && change.value;
  console.log(`💬 FB ওয়েবহুক change: field=${change && change.field} item=${v && v.item} verb=${v && v.verb}`);
  if (!change || change.field !== 'feed' || !v || v.item !== 'comment' || v.verb !== 'add') return;
  if (v.parent_id && v.post_id && String(v.parent_id) !== String(v.post_id)) return; // কমেন্টের রিপ্লাই — শুধু মূল কমেন্টে সাড়া
  const settings = await store.getSettings();
  const token = settings.fbToken;
  const pageId = String(entry.id || settings.fbPageId || '');
  await handleComment({
    platform: 'facebook', commentId: v.comment_id, text: v.message, fromId: v.from && v.from.id, fromName: v.from && v.from.name, ownId: pageId,
    send: {
      public: async msg => { await axios.post(`${GRAPH}/${v.comment_id}/comments`, null, { params: { message: msg, access_token: token }, timeout: 15000 }); },
      private: async msg => { await axios.post(`${GRAPH}/${v.comment_id}/private_replies`, null, { params: { message: msg, access_token: token }, timeout: 15000 }); }
    }
  });
}

/* ---------- Instagram: webhook entry.changes[field=comments] ---------- */
async function handleInstagramChange(entry, change) {
  const v = change && change.value;
  console.log(`💬 IG ওয়েবহুক change: field=${change && change.field}`);
  if (!change || change.field !== 'comments' || !v || !v.id) return;
  if (v.parent_id) return; // রিপ্লাই — বাদ
  const settings = await store.getSettings();
  const token = settings.fbToken;
  const igId = String(entry.id || settings.igUserId || '');
  await handleComment({
    platform: 'instagram', commentId: v.id, text: v.text, fromId: v.from && v.from.id, fromName: v.from && v.from.username, ownId: igId,
    send: {
      public: async msg => { await axios.post(`${GRAPH}/${v.id}/replies`, null, { params: { message: msg, access_token: token }, timeout: 15000 }); },
      private: async msg => { await axios.post(`${GRAPH}/${igId}/messages`, { recipient: { comment_id: v.id }, message: { text: msg } }, { params: { access_token: token }, timeout: 15000 }); }
    }
  });
}

// পেজকে 'feed' (কমেন্ট) ইভেন্টে সাবস্ক্রাইব করে — আগের সাবস্ক্রিপশন বজায় রেখে
async function ensureFeedSubscription() {
  const settings = await store.getSettings();
  if (!settings.fbToken || !settings.fbPageId) throw new Error('আগে Facebook পেজ সংযুক্ত করুন');
  const url = `${GRAPH}/${settings.fbPageId}/subscribed_apps`;
  let have = [];
  try {
    const r = await axios.get(url, { params: { access_token: settings.fbToken }, timeout: 15000 });
    const me = (r.data.data || [])[0];
    have = (me && (me.subscribed_fields || [])) || [];
  } catch (e) { /* না পড়া গেলে ডিফল্ট দিয়ে চলবে */ }
  const want = Array.from(new Set([...(have.length ? have : ['messages', 'messaging_postbacks']), 'feed']));
  try {
    await axios.post(url, null, { params: { subscribed_fields: want.join(','), access_token: settings.fbToken }, timeout: 15000 });
  } catch (e) { throw new Error(errMsg(e)); }
  return want;
}

async function recent(limit = 20) {
  const col = await logCol();
  return (await col.find({ status: { $in: ['done', 'error', 'skipped'] } }).sort({ at: -1 }).limit(limit).toArray())
    .map(d => ({ id: d._id, platform: d.platform, intent: d.intent || '', status: d.status, pub: d.pub || '', priv: d.priv || '', note: d.note || '', text: d.text || '', at: d.at }));
}

module.exports = { ensureFeedSubscription, handleFacebookChange, handleInstagramChange, classify, recent };
