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

// Facebook কমেন্টে ইনবক্স (Private Reply): প্রথমে সরাসরি এন্ডপয়েন্ট, না হলে Send API (recipient.comment_id)
async function fbPrivateReply(commentId, token, msg) {
  try {
    await axios.post(`${GRAPH}/${commentId}/private_replies`, null, { params: { message: msg, access_token: token }, timeout: 15000 });
  } catch (e1) {
    try {
      await axios.post(`${GRAPH}/me/messages`, { recipient: { comment_id: commentId }, message: { text: msg }, messaging_type: 'RESPONSE' }, { params: { access_token: token }, timeout: 15000 });
    } catch (e2) { throw new Error(errMsg(e2) + ' | আগের চেষ্টা: ' + errMsg(e1)); }
  }
}
let pageIdCache = '';
// ব্যবহারকারীর (User) টোকেন বসে গেলে সেটা থেকে পেজের স্থায়ী টোকেন বের করে সংরক্ষণ করে। Page টোকেন হলে কিছু করে না।
let checkedToken = '';
async function ensurePageToken(settings, force) {
  const token = settings.fbToken;
  if (!token || (!force && checkedToken === token)) return { settings, changed: false };
  let accounts;
  try {
    const r = await axios.get(`${GRAPH}/me/accounts`, { params: { fields: 'id,name,access_token,instagram_business_account{id}', limit: 50, access_token: token }, timeout: 15000 });
    accounts = r.data.data || [];
  } catch (e) { checkedToken = token; return { settings, changed: false }; } // Page টোকেনে এটা চলে না — মানে ঠিক আছে
  const cfg = require('../config');
  let userTok = token;
  const appId = settings.fbAppId || cfg.fbAppId;
  if (appId && cfg.fbAppSecret) {
    try {
      const r = await axios.get(`${GRAPH}/oauth/access_token`, { params: { grant_type: 'fb_exchange_token', client_id: appId, client_secret: cfg.fbAppSecret, fb_exchange_token: token }, timeout: 15000 });
      userTok = r.data.access_token || token;
      const r2 = await axios.get(`${GRAPH}/me/accounts`, { params: { fields: 'id,name,access_token,instagram_business_account{id}', limit: 50, access_token: userTok }, timeout: 15000 });
      if ((r2.data.data || []).length) accounts = r2.data.data; // দীর্ঘমেয়াদি টোকেন থেকে পাওয়া পেজ-টোকেন কখনো মেয়াদোত্তীর্ণ হয় না
    } catch (e) { /* এক্সচেঞ্জ না হলেও পাওয়া টোকেন দিয়ে চলবে */ }
  }
  if (!accounts.length) throw new Error('এই অ্যাকাউন্টে কোনো পেজ পাওয়া যায়নি — Graph Explorer-এ পেজ নির্বাচন করে আবার টোকেন বানান');
  const want = String(settings.fbPageId || '');
  const page = accounts.find(a => want && a.id === want) || accounts.find(a => /sundarban|honey/i.test(a.name)) || (accounts.length === 1 ? accounts[0] : null);
  if (!page) throw new Error('একাধিক পেজ পাওয়া গেছে (' + accounts.map(a => a.name).join(', ') + ') — কোনটা ব্যবহার হবে বোঝা যাচ্ছে না');
  const patch = { fbToken: page.access_token, fbPageId: page.id };
  if (!settings.igUserId && page.instagram_business_account) patch.igUserId = page.instagram_business_account.id;
  await store.saveSettings(patch);
  pageIdCache = page.id; checkedToken = page.access_token;
  return { settings: { ...settings, ...patch }, changed: true, pageName: page.name };
}

async function getPageId(settings) {
  if (settings.fbPageId) return String(settings.fbPageId);
  if (pageIdCache) return pageIdCache;
  try { const r = await axios.get(`${GRAPH}/me`, { params: { fields: 'id', access_token: settings.fbToken }, timeout: 15000 }); pageIdCache = String(r.data.id || ''); } catch (e) { /* ঠিক আছে */ }
  return pageIdCache;
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
  const pageId = String(entry.id || await getPageId(settings) || '');
  await handleComment({
    platform: 'facebook', commentId: v.comment_id, text: v.message, fromId: v.from && v.from.id, fromName: v.from && v.from.name, ownId: pageId,
    send: {
      public: async msg => { await axios.post(`${GRAPH}/${v.comment_id}/comments`, null, { params: { message: msg, access_token: token }, timeout: 15000 }); },
      private: msg => fbPrivateReply(v.comment_id, token, msg)
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
  let settings = await store.getSettings();
  if (!settings.fbToken) throw new Error('আগে Facebook পেজের টোকেন সংযুক্ত করুন');
  await ensurePageToken(settings).catch(() => {});
  settings = await store.getSettings();
  const pid = await getPageId(settings);
  if (!pid) throw new Error('টোকেন থেকে পেজ চেনা যায়নি — টোকেন ঠিক আছে কিনা পরীক্ষা করুন');
  const url = `${GRAPH}/${pid}/subscribed_apps`;
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

// Webhook না এলে বিকল্প: নিয়মিত পেজের সাম্প্রতিক পোস্টের নতুন কমেন্ট নিজে তুলে আনা (cron থেকে চলে)।
// একই কমেন্ট webhook ও poll দুইভাবে এলেও claim() এর কারণে একবারই সাড়া যায়।
let polling = false;
let lastPermWarn = 0;
async function pollFacebook() {
  if (polling) return 0;
  polling = true;
  let handled = 0;
  try {
    const settings = await store.getSettings();
    if (settings.commentAuto !== 'on' || !settings.fbToken) return 0;
    try { await ensurePageToken(settings); } catch (e) { /* ঠিক আছে */ }
    const token = (await store.getSettings()).fbToken;
    const db = await store.getDb();
    const st = await db.collection('meta').findOne({ _id: 'commentPoll' });
    const since = st && st.since ? new Date(st.since).getTime() : Date.now(); // প্রথমবার: পুরনো কমেন্ট ধরা হবে না
    const startedAt = Date.now();
    const posts = await axios.get(`${GRAPH}/me/posts`, { params: { fields: 'id', limit: 6, access_token: token }, timeout: 15000 });
    const pageId = await getPageId(settings);
    for (const p of (posts.data.data || [])) {
      if (handled >= 6) break;
      let list = [];
      try {
        const r = await axios.get(`${GRAPH}/${p.id}/comments`, { params: { fields: 'id,message,from,created_time,parent{id}', filter: 'toplevel', order: 'reverse_chronological', limit: 15, access_token: token }, timeout: 15000 });
        list = r.data.data || [];
      } catch (e) {
        const code = e.response && e.response.data && e.response.data.error && e.response.data.error.code;
        if (code === 10 || code === 200) { // অনুমতি নেই — প্রতিটা পোস্টে একই এরর না দেখিয়ে একবার জানিয়ে থামি
          if (Date.now() - lastPermWarn > 3600000) { lastPermWarn = Date.now(); console.warn('কমেন্ট পোল: অনুমতি নেই (pages_read_user_content) — Settings থেকে Facebook আবার Connect করুন। ' + errMsg(e)); }
          return handled;
        }
        console.warn('কমেন্ট পোল ব্যর্থ:', errMsg(e)); continue;
      }
      for (const c of list.reverse()) {
        if (new Date(c.created_time).getTime() <= since) continue;
        if (c.parent) continue;
        handled++;
        await handleComment({
          platform: 'facebook', commentId: c.id, text: c.message, fromId: c.from && c.from.id, fromName: c.from && c.from.name, ownId: pageId,
          send: {
            public: async msg => { await axios.post(`${GRAPH}/${c.id}/comments`, null, { params: { message: msg, access_token: token }, timeout: 15000 }); },
            private: msg => fbPrivateReply(c.id, token, msg)
          }
        });
      }
    }
    await db.collection('meta').updateOne({ _id: 'commentPoll' }, { $set: { since: new Date(handled >= 6 ? since : startedAt - 60000) } }, { upsert: true });
  } catch (err) {
    console.warn('কমেন্ট পোল এরর:', errMsg(err));
  } finally { polling = false; }
  return handled;
}

// অ্যাপের "কমেন্ট পরীক্ষা" বাটন — টোকেন ও অনুমতির আসল অবস্থা বাংলায় বলে দেয়
async function diagnose() {
  const out = [];
  const add = (ok, msg) => out.push({ ok, msg });
  const settings = await store.getSettings();
  if (!settings.fbToken) { add(false, 'Facebook পেজের টোকেন সংরক্ষিত নেই — Settings-এ Facebook Connect করুন'); return out; }
  let token = settings.fbToken;
  try {
    const fx = await ensurePageToken(settings, true);
    if (fx.changed) { token = fx.settings.fbToken; add(true, `আপনার দেওয়া টোকেন ছিল ব্যক্তিগত (User) টোকেন — সেটা থেকে পেজ "${fx.pageName}"-এর স্থায়ী টোকেন নিজে বের করে সংরক্ষণ করেছি`); }
  } catch (e) { add(false, e.message); return out; }
  add(true, `টোকেন সংরক্ষিত আছে (দৈর্ঘ্য ${token.length} অক্ষর${token.startsWith('EAA') ? '' : ' — কিন্তু EAA দিয়ে শুরু হয়নি, ভুল জিনিস পেস্ট হতে পারে'})`);
  add(settings.commentAuto === 'on', settings.commentAuto === 'on' ? 'কমেন্ট অটো-রিপ্লাই চালু আছে' : 'কমেন্ট অটো-রিপ্লাই বন্ধ — টিক দিয়ে সংরক্ষণ করুন');
  let page = null;
  try {
    const r = await axios.get(`${GRAPH}/me`, { params: { fields: 'id,name', access_token: token }, timeout: 15000 });
    page = r.data;
    add(true, `টোকেন কাজ করছে — পেজ: ${page.name} (${page.id})`);
  } catch (e) { add(false, 'টোকেন বাতিল/ভুল: ' + errMsg(e) + ' — নতুন করে Page Access Token বসান'); return out; }
  try {
    const r = await axios.get(`${GRAPH}/debug_token`, { params: { input_token: token, access_token: token }, timeout: 15000 });
    const d = r.data.data || {};
    const sc = d.scopes || [];
    const need = ['pages_read_engagement', 'pages_read_user_content', 'pages_manage_engagement', 'pages_messaging'];
    need.forEach(n => add(sc.includes(n), sc.includes(n) ? `অনুমতি আছে: ${n}` : `অনুমতি নেই: ${n}`));
    ['instagram_manage_comments', 'instagram_manage_messages', 'instagram_basic'].forEach(n => add(sc.includes(n), sc.includes(n) ? `অনুমতি আছে: ${n}` : `অনুমতি নেই: ${n} (Instagram কমেন্ট/মেসেজের জন্য লাগে)`));
    if (d.expires_at === 0) add(true, 'টোকেনের মেয়াদ নেই (স্থায়ী)');
    else if (d.expires_at) add(true, 'টোকেনের মেয়াদ শেষ হবে: ' + new Date(d.expires_at * 1000).toLocaleString('bn-BD'));
  } catch (e) { add(false, 'অনুমতির তালিকা পড়া যায়নি: ' + errMsg(e)); }
  try {
    const r = await axios.get(`${GRAPH}/me/posts`, { params: { fields: 'id', limit: 1, access_token: token }, timeout: 15000 });
    const p = (r.data.data || [])[0];
    if (!p) add(false, 'পেজে কোনো পোস্ট পাওয়া যায়নি');
    else {
      add(true, 'পেজের পোস্ট পড়া যাচ্ছে');
      try { await axios.get(`${GRAPH}/${p.id}/comments`, { params: { fields: 'id', limit: 1, access_token: token }, timeout: 15000 }); add(true, 'কমেন্ট পড়া যাচ্ছে ✅ — এখন নতুন কমেন্টে সাড়া দেওয়ার কথা'); }
      catch (e) { add(false, 'কমেন্ট পড়া যাচ্ছে না: ' + errMsg(e)); }
    }
  } catch (e) { add(false, 'পোস্ট পড়া যাচ্ছে না: ' + errMsg(e)); }
  return out;
}

async function recent(limit = 20) {
  const col = await logCol();
  return (await col.find({ status: { $in: ['done', 'error', 'skipped'] } }).sort({ at: -1 }).limit(limit).toArray())
    .map(d => ({ id: d._id, platform: d.platform, intent: d.intent || '', status: d.status, pub: d.pub || '', priv: d.priv || '', note: d.note || '', text: d.text || '', at: d.at }));
}

module.exports = { diagnose, pollFacebook, ensureFeedSubscription, handleFacebookChange, handleInstagramChange, classify, recent };
