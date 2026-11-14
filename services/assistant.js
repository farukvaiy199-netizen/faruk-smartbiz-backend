// মালিকের ব্যক্তিগত AI সহকারী — অ্যাপের চ্যাট, WhatsApp ও Messenger/Instagram মেসেজ থেকে একই মস্তিষ্ক।
// মালিক জিজ্ঞেস করবেন (বিক্রি, অর্ডার, স্টক...), AI আসল তথ্য থেকে উত্তর দেবে; পোস্টের খসড়া বানিয়ে মালিকের অনুমতি নিয়ে ফেসবুক/ইনস্টাগ্রামে পোস্ট করবে।
// নিরাপত্তা: মালিক চেনা হয় নিবন্ধিত WhatsApp নম্বর বা গোপন PIN দিয়ে বাঁধা অ্যাকাউন্টে; এবং শুধু তখনই যখন Meta-র সই (signature) যাচাই হয়েছে।
const axios = require('axios');
const crypto = require('crypto');
const store = require('./store');
const shop = require('./shop');
const { getJsonReply } = require('./ai');
const { publishPagePhoto } = require('./facebook');
const imagegen = require('./imagegen');
const IG_RE = /ইনস্টা|ইন্সটা|ইনস্ট্যা|instagram|insta\b|আইজি/i;

const BD = 6 * 3600 * 1000; // ঢাকা = UTC+6 (ডে-লাইট সেভিং নেই)
const GRAPH = 'https://graph.facebook.com/v19.0';
const MAX_TURNS = 10;
const PENDING_MS = 6 * 3600 * 1000;

/* ---------- ছোট সহায়ক ---------- */
const digits = s => String(s || '').replace(/\D/g, '');
const sameNumber = (a, b) => { a = digits(a); b = digits(b); return !!a && !!b && a.slice(-10) === b.slice(-10); };
const clip = (s, n) => String(s || '').slice(0, n);
function errMsg(err) {
  const e = err && err.response && err.response.data && err.response.data.error;
  return clip((e && (e.message || e.error_user_msg)) || (err && err.message) || err, 200);
}

async function metaGet(id) {
  const db = await store.getDb();
  return db.collection('meta').findOne({ _id: id });
}
async function metaSet(id, fields) {
  const db = await store.getDb();
  await db.collection('meta').updateOne({ _id: id }, { $set: fields }, { upsert: true });
}
async function metaDel(id) {
  const db = await store.getDb();
  await db.collection('meta').deleteOne({ _id: id });
}

/* ---------- মালিক চেনা ---------- */
let ownerCache = { at: 0, v: null };
async function getOwnerCfg() {
  if (ownerCache.v && Date.now() - ownerCache.at < 20000) return ownerCache.v;
  const d = (await metaGet('owner')) || {};
  ownerCache = { at: Date.now(), v: { waNumber: d.waNumber || '', pinHash: d.pinHash || '', pinSalt: d.pinSalt || '', linked: d.linked || [] } };
  return ownerCache.v;
}

function hashPin(pin, salt) { return crypto.scryptSync(String(pin), salt, 32).toString('hex'); }

async function setOwner({ waNumber, pin }) {
  const cur = await getOwnerCfg();
  const patch = {};
  if (waNumber !== undefined) {
    const d = digits(waNumber);
    if (waNumber !== '' && d.length < 10) throw new Error('WhatsApp নম্বর সঠিক না (দেশের কোডসহ দিন)');
    patch.waNumber = d;
  }
  if (pin) {
    if (String(pin).length < 4) throw new Error('PIN কমপক্ষে ৪ অক্ষরের হতে হবে');
    const salt = crypto.randomBytes(12).toString('hex');
    patch.pinSalt = salt;
    patch.pinHash = hashPin(pin, salt);
    patch.linked = []; // নতুন PIN দিলে আগে বাঁধা সব অ্যাকাউন্ট আবার বাঁধতে হবে
  }
  if (Object.keys(patch).length) await metaSet('owner', patch);
  ownerCache = { at: 0, v: null };
  return getPublicOwnerCfg();
}

async function getPublicOwnerCfg() {
  const o = await getOwnerCfg();
  const s = await store.getSettings();
  return { waNumber: o.waNumber, pinSet: !!o.pinHash, linkedCount: (o.linked || []).length, commentAuto: s.commentAuto === 'on' ? 'on' : 'off' };
}

async function isOwner({ platform, platformId }) {
  const o = await getOwnerCfg();
  if (platform === 'whatsapp' && o.waNumber && sameNumber(o.waNumber, platformId)) return true;
  return (o.linked || []).includes(platform + ':' + platformId);
}

const LINK_RE = /^\s*(?:\/link|মালিক|owner)\s+(\S+)\s*$/i;
const attempts = new Map(); // key -> { n, until }

// "মালিক <PIN>" লিখলে ওই অ্যাকাউন্ট মালিক হিসেবে বাঁধা পড়ে। কমান্ড না হলে null (সাধারণ কাস্টমারের মেসেজ)।
async function tryLink({ platform, platformId, text }) {
  const m = LINK_RE.exec(String(text || ''));
  if (!m) return null;
  const o = await getOwnerCfg();
  if (!o.pinHash) return null; // PIN সেট না থাকলে সাধারণ মেসেজের মতোই চলবে
  const key = platform + ':' + platformId;
  const a = attempts.get(key) || { n: 0, until: 0 };
  if (a.until > Date.now()) return 'অনেকবার ভুল হয়েছে — কিছুক্ষণ পরে আবার চেষ্টা করুন।';
  let ok = false;
  try {
    const got = Buffer.from(hashPin(m[1], o.pinSalt), 'hex');
    const want = Buffer.from(o.pinHash, 'hex');
    ok = got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch (e) { ok = false; }
  if (!ok) {
    a.n += 1;
    if (a.n >= 5) { a.until = Date.now() + 15 * 60000; a.n = 0; }
    attempts.set(key, a);
    return 'PIN মেলেনি।';
  }
  attempts.delete(key);
  const linked = Array.from(new Set([...(o.linked || []), key])).slice(-6);
  await metaSet('owner', { linked });
  ownerCache = { at: 0, v: null };
  return '✅ আপনাকে মালিক হিসেবে চিনে নিলাম। এখন থেকে এখানে আমাকে সহকারীর মতো যা খুশি জিজ্ঞেস করতে বা বলতে পারেন।';
}

/* ---------- তারিখ ও হিসাব ---------- */
function startOfDay(ms) { const d = new Date(ms + BD); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - BD; }
function startOfMonth(ms, back = 0) { const d = new Date(ms + BD); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1) - BD; }
function bdString(ms) {
  const d = new Date(ms + BD);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// অর্ডারের পণ্যগুলো আলাদা করে। ওয়েবসাইট অর্ডারে পণ্য লেখা থাকে "নাম x২, নাম x১" ধরনে।
function lineItems(o) {
  const name = String(o.product || '').trim();
  if (o.source === 'Bazaar Admin' && name) {
    const parts = name.split(/,\s*/).map(s => s.trim()).filter(Boolean);
    const out = parts.map(p => {
      const m = /^(.*?)(?:\s+x\s*(\d+))?$/i.exec(p);
      return { name: (m && m[1] || p).trim(), qty: Number(m && m[2]) || 0 };
    });
    if (out.length === 1 && !out[0].qty) out[0].qty = Number(o.qty) || 1;
    return out.map(x => ({ name: x.name, qty: x.qty || 1 }));
  }
  return name ? [{ name, qty: Number(o.qty) || 1 }] : [];
}
const revenueOf = o => (o.source === 'Bazaar Admin' ? Number(o.price) || 0 : (Number(o.price) || 0) * (Number(o.qty) || 1));

function summarize(orders, from, to) {
  const inR = orders.filter(o => { const t = new Date(o.createdAt).getTime(); return t >= from && t < to; });
  const live = inR.filter(o => o.status !== 'Cancelled');
  const prod = {};
  let units = 0, revenue = 0;
  const bySource = {};
  live.forEach(o => {
    revenue += revenueOf(o);
    lineItems(o).forEach(it => { prod[it.name] = (prod[it.name] || 0) + it.qty; units += it.qty; });
    bySource[o.source || 'অজানা'] = (bySource[o.source || 'অজানা'] || 0) + 1;
  });
  return {
    অর্ডার: live.length,
    বিক্রিত_পিস: units,
    বিক্রয়_টাকা: revenue,
    বাতিল: inR.filter(o => o.status === 'Cancelled').length,
    পেন্ডিং: inR.filter(o => o.status === 'Pending').length,
    ডেলিভার্ড: inR.filter(o => o.status === 'Delivered').length,
    সবচেয়ে_বেশি_বিক্রি: Object.entries(prod).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([নাম, পিস]) => ({ নাম, পিস })),
    কোথা_থেকে: bySource
  };
}

async function buildSnapshot(settings) {
  const now = Date.now();
  const sod = startOfDay(now);
  const orders = await store.getOrders();
  const snap = {
    আজ: summarize(orders, sod, now + 1),
    গতকাল: summarize(orders, sod - 86400000, sod),
    গত_৭_দিন: summarize(orders, sod - 6 * 86400000, now + 1),
    এই_মাস: summarize(orders, startOfMonth(now), now + 1),
    গত_মাস: summarize(orders, startOfMonth(now, 1), startOfMonth(now))
  };
  const low = Number(settings.lowStockThreshold ?? 5);
  try {
    const list = await store.getStockList();
    snap.অ্যাপের_স্টক = {
      শেষ: list.filter(e => e.qty <= 0).map(e => e.name).slice(0, 15),
      কম: list.filter(e => e.qty > 0 && e.qty <= low).map(e => `${e.name} (${e.qty})`).slice(0, 15)
    };
  } catch (e) { /* স্টক না থাকলেও চলবে */ }
  try {
    const st = await shop.status();
    if (st && st.connected) {
      snap.ওয়েবসাইট = { প্রোডাক্ট: st.counts && st.counts.products, স্টক_শেষ: (st.outItems || []).map(i => i.name), স্টক_কম: (st.lowItems || []).map(i => `${i.name} (${i.stock})`), পেন্ডিং_অর্ডার_ওয়েবসাইটে: st.orders ? st.orders.pending : undefined };
    }
  } catch (e) { /* ওয়েবসাইট না থাকলেও চলবে */ }
  try {
    const customers = await store.getCustomers();
    snap.কাস্টমার = {
      মোট: customers.length,
      আজ_নতুন: customers.filter(c => new Date(c.createdAt).getTime() >= sod).length,
      এই_মাসে_নতুন: customers.filter(c => new Date(c.createdAt).getTime() >= startOfMonth(now)).length,
      মালিকের_সাহায্য_চান: customers.filter(c => c.needsHuman).length
    };
  } catch (e) { /* কাস্টমার না থাকলেও চলবে */ }
  snap.সাম্প্রতিক_অর্ডার = orders.slice(0, 5).map(o => ({ আইডি: o.id, নাম: o.name, পণ্য: clip(o.product, 50), স্ট্যাটাস: o.status, সময়: bdString(new Date(o.createdAt).getTime()) }));
  try {
    const posts = await store.getPosts(4);
    snap.সাম্প্রতিক_পোস্ট = posts.map(p => ({ ক্যাপশন: clip(p.caption, 50), অবস্থা: p.status }));
  } catch (e) { /* ঠিক আছে */ }
  try {
    const db = await store.getDb();
    snap.আজ_কমেন্টে_স্বয়ংক্রিয়_রিপ্লাই = await db.collection('comment_log').countDocuments({ at: { $gte: new Date(sod) } });
  } catch (e) { /* ঠিক আছে */ }
  return snap;
}

/* ---------- কথোপকথন ও খসড়ার মেমরি ---------- */
async function getTurns(key) { const d = await metaGet('assistantChat:' + key); return (d && d.turns) || []; }
async function saveTurns(key, turns) { await metaSet('assistantChat:' + key, { turns: turns.slice(-MAX_TURNS), at: new Date() }); }
async function getPending(key) {
  const d = await metaGet('assistantPending:' + key);
  if (!d || !d.caption) return null;
  if (d.at && Date.now() - new Date(d.at).getTime() > PENDING_MS) { await metaDel('assistantPending:' + key); return null; }
  return d;
}
async function setPending(key, p) { await metaSet('assistantPending:' + key, { ...p, at: new Date() }); }
async function clearPending(key) { await metaDel('assistantPending:' + key); }

/* ---------- ওয়েবসাইটে নতুন পণ্য ---------- */
async function getProdPending(key) {
  const d = await metaGet('assistantProduct:' + key);
  if (!d || !d.name) return null;
  if (d.at && Date.now() - new Date(d.at).getTime() > PENDING_MS) { await metaDel('assistantProduct:' + key); return null; }
  return d;
}
async function setProdPending(key, p) { await metaSet('assistantProduct:' + key, { ...p, at: new Date() }); }
async function clearProdPending(key) { await metaDel('assistantProduct:' + key); }
const taka = n => '৳' + Number(n).toLocaleString('bn-BD');

async function productImageData(pend) {
  if (!pend.imageB64) return '';
  let buf = Buffer.from(pend.imageB64, 'base64');
  try { buf = await imagegen.shrinkJpeg(buf, 900, 6); } catch (e) { /* ছোট করা না গেলে আসলটাই */ }
  if (buf.length > 700 * 1024) buf = await imagegen.shrinkJpeg(buf, 640, 10).catch(() => buf);
  if (buf.length > 800 * 1024) throw new Error('ছবিটা অনেক বড় — ছোট ছবি দিন');
  return 'data:image/jpeg;base64,' + buf.toString('base64');
}

/* ---------- পোস্ট ---------- */
async function generateCaption({ settings, hint, product, previous }) {
  const notes = settings.postNotes ? `\nদোকানের পোস্টের সাধারণ নির্দেশনা: ${settings.postNotes}` : '';
  const prod = product
    ? `\nপ্রোডাক্ট: ${product.name}${product.price !== null && product.price !== undefined ? ' | দাম ৳' + product.price : ''}${product.desc ? ' | ' + product.desc : ''}\nওয়েবসাইটের লিংক (ক্যাপশনের শেষে দিতে পারো): ${product.url}`
    : '';
  const system = `তুমি একটা অনলাইন দোকানের ফেসবুক/ইনস্টাগ্রাম পোস্টের ক্যাপশন-লেখক। বাংলায় আকর্ষণীয়, সংক্ষিপ্ত (৪-৭ লাইন), ইমোজি সহ, বিশ্বাসযোগ্য ক্যাপশন লেখো। বানানো দাবি, ভুয়া অফার বা তথ্যে নেই এমন দাম লিখবে না।${notes}
শুধুমাত্র এই JSON-এ উত্তর দাও: {"caption": "..."}`;
  const user = (previous ? `আগের খসড়া:\n${previous}\n\nমালিকের পরিবর্তনের নির্দেশ: ${hint}\nআগের খসড়াটা সেই অনুযায়ী বদলে নতুন করে লেখো।` : `মালিকের নির্দেশ/বিষয়: ${hint}`) + prod;
  const r = await getJsonReply({ settings, systemPrompt: system, userMessage: user });
  const caption = clip(r && r.caption, 2000).trim();
  if (!caption) throw new Error('AI ক্যাপশন বানাতে পারেনি');
  // [লিংক] ধরনের ফাঁকা বসানো অংশ রাখা চলবে না — আসল লিংক বসাই (না থাকলে বাদ)
  let site = product && product.url;
  if (!site) { try { const st = await shop.status(); site = st && st.connected ? st.site : ''; } catch (e) { site = ''; } }
  return caption.replace(/\[[^\]]*(লিংক|link|url)[^\]]*\]/gi, site || '').replace(/[ \t]+\n/g, '\n').trim();
}

async function publishPageText({ token, caption, scheduledAtMs }) {
  const params = { message: caption, access_token: token };
  if (scheduledAtMs) { params.published = false; params.scheduled_publish_time = Math.floor(scheduledAtMs / 1000); }
  try {
    const r = await axios.post(`${GRAPH}/me/feed`, null, { params, timeout: 20000 });
    return { fbPostId: String(r.data.id || ''), fbPhotoId: '' };
  } catch (err) { throw new Error(errMsg(err)); }
}

async function downloadImage(url) {
  const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000, maxContentLength: 8 * 1024 * 1024 });
  return { buffer: Buffer.from(r.data), mime: String(r.headers['content-type'] || 'image/jpeg').split(';')[0] };
}

function where_ok(action, r) { return action.facebook !== false || r.igDone; }

async function publishPending(settings, pending, { facebook, instagram, atMs }) {
  if (!settings.fbToken) throw new Error('Facebook পেজ সংযুক্ত নেই');
  let img = null;
  if (pending.imageB64) img = { buffer: Buffer.from(pending.imageB64, 'base64'), mime: pending.imageMime || 'image/jpeg' };
  else if (pending.imageUrl) img = await downloadImage(pending.imageUrl).catch(() => null);

  const wantIg = !!instagram;
  let igSkip = '';
  if (wantIg && !settings.igUserId) igSkip = 'Instagram সংযুক্ত নেই';
  else if (wantIg && !img) igSkip = 'Instagram-এর জন্য ছবি লাগে';
  else if (wantIg && img.mime !== 'image/jpeg') igSkip = 'Instagram-এ শুধু JPEG ছবি যায়';

  let fb = { fbPostId: '', fbPhotoId: '' };
  if (facebook !== false) {
    fb = img ? await publishPagePhoto({ token: settings.fbToken, caption: pending.caption, buffer: img.buffer, scheduledAtMs: atMs })
             : await publishPageText({ token: settings.fbToken, caption: pending.caption, scheduledAtMs: atMs });
  }

  let igFields = {};
  if (wantIg && !igSkip) {
    const mediaId = await store.addPostMedia({ mime: 'image/jpeg', b64: img.buffer.toString('base64') });
    igFields = { igStatus: atMs ? 'pending' : 'publishing', igDueAt: new Date(atMs || Date.now()).toISOString(), mediaId };
  } else if (wantIg) {
    igFields = { igStatus: 'skipped', igError: igSkip };
  }
  const tg = require('./telegram');
  const tgFields = await tg.postFields(settings, { buffer: img && img.buffer, whenMs: atMs }).catch(() => ({}));
  const tkFields = await require('./tiktok').postFields(settings, { buffer: img && img.buffer, whenMs: atMs }).catch(() => ({}));
  const post = await store.addPost({
    caption: pending.caption, productName: pending.productName || '', thumb: '',
    ...igFields, ...tgFields, ...tkFields,
    status: atMs ? 'scheduled' : 'published',
    scheduledAt: atMs ? new Date(atMs).toISOString() : null,
    fbPostId: fb.fbPostId, fbPhotoId: fb.fbPhotoId
  });
  if (igFields.igStatus === 'publishing') {
    const { publishIgJob } = require('./scheduler'); // দেরিতে require — গোলাকার নির্ভরতা এড়াতে
    await publishIgJob(post, settings, false);
  }
  if (tgFields.tgStatus === 'publishing') await tg.publishTgJob(post, settings);
  if (tkFields.tkStatus === 'publishing') await require('./tiktok').publishTkJob(post);
  return { igSkip, igDone: !!igFields.igStatus && igFields.igStatus !== 'skipped', tgDone: !!tgFields.tgStatus, tkDone: !!tkFields.tkStatus && tkFields.tkStatus !== 'skipped', tkSkip: tkFields.tkStatus === 'skipped' ? tkFields.tkError : '' };
}

/* ---------- AI-র নির্দেশ ---------- */
function systemPromptFor({ snapshot, rules, pending, prodPending, categories, settings }) {
  return `
তুমি "Faruk's SmartBiz"-এর মালিকের ব্যক্তিগত সহকারী। এখন যিনি কথা বলছেন তিনি দোকানের মালিক, কাস্টমার না।
একজন বিশ্বস্ত, চটপটে মানব সহকারীর মতো বাংলায়, ছোট ছোট লাইনে, আন্তরিকভাবে কথা বলবে (এটা WhatsApp/Messenger-এর মেসেজ — লম্বা টেবিল নয়, ইমোজি চলবে)।
বর্তমান সময় (ঢাকা): ${bdString(Date.now())}

=== ব্যবসার আসল তথ্য ===
${JSON.stringify(snapshot)}
- সংখ্যা (বিক্রি, অর্ডার, স্টক, কাস্টমার) শুধু এই তথ্য থেকে বলবে। এখানে না থাকলে সৎভাবে বলবে "এই তথ্য আমার কাছে নেই" — অনুমান বা বানিয়ে বলা একদম নিষেধ।
- বিক্রির হিসাব = অ্যাপের অর্ডার + ওয়েবসাইটের অর্ডার, বাতিল বাদ দিয়ে।
- রিটার্নের আলাদা কোনো রেকর্ড রাখা হয় না। "রিটার্ন/ফেরত" জিজ্ঞেস করলে বাতিল (Cancelled) অর্ডারের সংখ্যা দিয়ে বলবে যে আলাদা রিটার্ন-রেকর্ড নেই।
- তুলনা (যেমন গত মাসের চেয়ে বেশি/কম) করতে পারো, হিসাব সতর্কভাবে করবে।

=== কাস্টমারদের জন্য মালিকের আগের নির্দেশনা ===
${rules.length ? rules.map((r, i) => `${i + 1}) ${r.text}`).join('\n') : '(এখনো কোনোটা নেই)'}

=== ওয়েবসাইটের বিদ্যমান বিভাগ ===
${(categories || []).join(', ') || '(জানা নেই)'}

=== চলমান পণ্য-খসড়া ===
${prodPending ? `${prodPending.name} | ${taka(prodPending.price)} | স্টক ${prodPending.stock} | ${prodPending.category || 'বিভাগ ঠিক হয়নি'} | ছবি ${prodPending.imageB64 ? 'আছে' : 'নেই'}` : '(নেই)'}

=== চলমান পোস্টের খসড়া ===
${pending ? `ক্যাপশন: ${pending.caption}\nইনস্টাগ্রামেও: ${pending.wantIg ? 'হ্যাঁ' : 'না'} | সময়: ${pending.postAt || 'এখনই'}\nছবি: ${pending.imageUrl || pending.imageB64 ? 'আছে' : 'নেই'}` : '(নেই)'}

=== পোস্ট যেসব জায়গায় যায় ===
ফেসবুক: ${settings.fbToken ? 'সংযুক্ত' : 'নয়'} | ইনস্টাগ্রাম: ${settings.igUserId ? 'সংযুক্ত' : 'নয়'} | TikTok: ${settings.tkAccessToken ? 'সংযুক্ত' : 'নয়'} | টেলিগ্রাম চ্যানেল: ${settings.tgToken && settings.tgChannel ? 'সংযুক্ত' : 'নয়'}
- পোস্ট বানাতে বললে (মালিক TikTok বা টেলিগ্রামের নাম বললেও) নিচের post_draft/post_publish ব্যবহার করবে। TikTok ও টেলিগ্রাম সংযুক্ত থাকলে পোস্ট করার সময় নিজে থেকেই সেখানেও যায় — আলাদা কিছু করতে হয় না। TikTok-এ শুধু ছবিসহ পোস্ট যায়, তাই ছবি না থাকলে ছবি পাঠাতে বা বানিয়ে নিতে বলবে।
- কখনো বলবে না যে "আমি TikTok/টেলিগ্রামে পোস্ট করতে পারি না"। সংযুক্ত না থাকলে বলবে অ্যাপের সেটিংসে গিয়ে সংযুক্ত করতে হবে।

=== তুমি যা করতে পারো ===
১) প্রশ্নের উত্তর দেওয়া — "action": null।
২) মালিক কাস্টমারদের সাথে কথা বলার নতুন নির্দেশনা/তথ্য দিলে (যেমন "মধু এখন স্টকে আছে", "ডেলিভারি ৭০ টাকা") — "action": {"type":"save_rule","text":"পরিষ্কার সংক্ষিপ্ত নিয়ম"}।
৩) পোস্ট বানাতে বললে — "action": {"type":"post_draft","hint":"মালিকের কথা অনুযায়ী বিষয় ও সুর","product":"পণ্যের নাম বা null","noImage":false,"instagram":true/false,"at":"ISO সময় বা null","generateImage":false,"imagePrompt":""}। মালিক ইনস্টাগ্রাম বা সময় (যেমন "১২টায়") বললে instagram/at অবশ্যই এই খসড়াতেই বসাও — পরে ভুলে যাবে না। মালিক ছবি তৈরি করে দিতে বললে (ছবি পাঠায়নি) generateImage:true ও ইংরেজিতে বিস্তারিত imagePrompt দাও। ক্যাপশনে [লিংক]-এর মতো ফাঁকা বসানো অংশ থাকবে না। খসড়া থাকা অবস্থায় বদলাতে বললে আবার post_draft (hint-এ শুধু বদলের নির্দেশ)।
৪) মালিক স্পষ্টভাবে পোস্ট করতে বললে ("পোস্ট করো", "হ্যাঁ দাও") এবং খসড়া থাকলে — "action": {"type":"post_publish","facebook":true,"instagram":false,"at":null}। ইনস্টাগ্রামে চাইলে "instagram":true। খসড়াতে সময়/ইনস্টাগ্রাম আগেই ঠিক হয়ে থাকলে সেটাই চলবে। নতুন সময় বললে "at"-এ ISO সময় (যেমন "2026-11-14T10:00:00+06:00"), না বললে null।
৫) মালিক পোস্ট দরকার নেই/বাতিল বললে — "action": {"type":"post_cancel"}।
৬) ওয়েবসাইটে নতুন পণ্য যোগ করতে বললে — প্রথমে খসড়া: "action": {"type":"product_draft","name":"...","price":সংখ্যা,"oldPrice":সংখ্যা বা 0,"stock":সংখ্যা,"category":"বিদ্যমান বিভাগ থেকে বেছে (নিচে তালিকা)","desc":"মালিকের কথা থেকে সংক্ষিপ্ত বিবরণ"}। নাম বা দাম না বললে খসড়া বানাবে না — জিজ্ঞেস করবে (action: null)। স্টক না বললে জিজ্ঞেস করবে। মালিক ছবি পাঠালে সেটা পণ্যের ছবি হয়ে যাবে। খসড়ার সংশোধন চাইলে আবার product_draft (সব ঘর সহ)।
৭) মালিক "যোগ করো/হ্যাঁ/ঠিক আছে" বললে এবং পণ্যের খসড়া থাকলে — "action": {"type":"product_confirm"}। বাতিল চাইলে {"type":"product_cancel"}।

=== কঠোর নিয়ম ===
- মালিকের স্পষ্ট আদেশ ছাড়া post_publish দেবে না; খসড়া না থাকলে post_publish দেবে না। প্রথমে সবসময় খসড়া দেখাবে, মালিক অনুমতি দিলে তবেই পোস্ট।
- যা পারো না (ভিডিও পোস্ট, স্টক/দাম বদলানো, অর্ডার স্ট্যাটাস বদলানো, কাস্টমারকে মেসেজ পাঠানো) — সৎভাবে বলবে "এটা এখনো আমি করতে পারি না, অ্যাপ থেকে করে নিন"। করে ফেলেছ বলে মিথ্যা বলবে না।
- "reply"-তে মালিককে কী বলছ তা লেখো; action-এর ফলাফলের বিস্তারিত (খসড়া দেখানো, পোস্টের ফল) সিস্টেম নিজে যোগ করবে, তাই সেগুলো নিজে বানিয়ে লিখবে না।

শুধুমাত্র এই JSON ফরম্যাটে উত্তর দাও:
{"reply":"মালিককে বলার কথা","action":null}
`.trim();
}

/**
 * মালিকের একটা মেসেজ প্রসেস করে। channel: 'app' | 'whatsapp' | 'facebook' | 'instagram'।
 * ফেরত: { reply, imageUrl?, saved? } — কখনো এরর ছোঁড়ে না (AI-র সমস্যা হলে ভদ্র বার্তা দেয়)।
 */
async function handleOwnerMessage({ key, text, settings, imageB64, imageMime }) {
  settings = settings || await store.getSettings();
  const rules = await store.getAiRules();
  let pending = await getPending(key);
  let prodPending = await getProdPending(key);
  const categories = await shop.categoryNames().catch(() => []);
  const turns = await getTurns(key);

  let snapshot;
  try { snapshot = await buildSnapshot(settings); }
  catch (err) { console.error('সহকারী: তথ্য সংগ্রহ ব্যর্থ:', err.message); snapshot = { সমস্যা: 'ব্যবসার তথ্য এই মুহূর্তে আনা যায়নি' }; }

  const transcript = turns.map(t => `${t.role === 'user' ? 'মালিক' : 'সহকারী'}: ${t.text}`).join('\n');
  const userMessage = (transcript ? `আগের কথোপকথন:\n${transcript}\n\n` : '') + `মালিকের নতুন মেসেজ${imageB64 ? ' (সাথে একটা ছবি পাঠিয়েছেন)' : ''}: ${text}`;

  let out;
  try {
    out = await getJsonReply({ settings, systemPrompt: systemPromptFor({ snapshot, rules, pending, prodPending, categories, settings }), userMessage });
  } catch (err) {
    console.error('সহকারী AI এরর:', errMsg(err));
    return { reply: 'দুঃখিত, AI এই মুহূর্তে উত্তর দিতে পারছে না (কোটা শেষ হতে পারে)। একটু পরে আবার বলুন 🙏' };
  }

  let reply = clip(out && out.reply, 1500).trim() || 'বুঝেছি।';
  const action = out && out.action && typeof out.action === 'object' ? out.action : null;
  const result = { reply };

  try {
    if (action && action.type === 'save_rule' && action.text && String(action.text).trim()) {
      if (rules.length >= 60) {
        result.reply += '\n\n⚠️ নির্দেশনার সংখ্যা সীমায় পৌঁছে গেছে — অ্যাপের তালিকা থেকে কিছু মুছে দিন।';
      } else {
        const saved = await store.addAiRule(clip(action.text, 400).trim());
        result.saved = saved;
        result.reply += '\n\n✅ সংরক্ষণ করলাম।';
      }
    } else if (action && action.type === 'post_draft') {
      const hint = clip(action.hint || text, 500);
      const product = action.product ? await shop.findProduct(String(action.product)).catch(() => null) : null;
      const caption = await generateCaption({ settings, hint, product, previous: pending ? pending.caption : '' });
      const next = { caption, productName: product ? product.name : (action.product ? clip(action.product, 120) : ''), imageUrl: '', imageB64: '', imageMime: '' };
      next.wantIg = !!action.instagram || IG_RE.test(text) || !!(pending && pending.wantIg);
      next.postAt = action.at || (pending && pending.postAt) || '';
      let imgNote = '';
      if (imageB64) { next.imageB64 = imageB64; next.imageMime = imageMime || 'image/jpeg'; }
      else if (action.generateImage) {
        try {
          const buf = await imagegen.generateImage({ settings, prompt: clip(action.imagePrompt || hint, 800) });
          next.imageB64 = buf.toString('base64'); next.imageMime = 'image/jpeg';
        } catch (e) { imgNote = '\n⚠️ ' + e.message; }
      }
      else if (pending && (pending.imageUrl || pending.imageB64) && !product) { next.imageUrl = pending.imageUrl || ''; next.imageB64 = pending.imageB64 || ''; next.imageMime = pending.imageMime || ''; }
      else if (product && !action.noImage) { next.imageUrl = (await shop.getProductImage(product.id).catch(() => null)) || ''; }
      await setPending(key, next);
      pending = next;
      const hasImg = !!(next.imageUrl || next.imageB64);
      const when = next.postAt && !isNaN(new Date(next.postAt).getTime()) ? `\n⏰ সময়: ${bdString(new Date(next.postAt).getTime())} (ঢাকা)` : '';
      result.reply = `📝 পোস্টের খসড়া:\n\n${caption}\n\n🖼️ ${hasImg ? 'ছবি সংযুক্ত আছে' : 'ছবি ছাড়া (শুধু লেখা)'}${imgNote}\n📣 কোথায়: ফেসবুক${next.wantIg ? ' + ইনস্টাগ্রাম' : ''}${settings.tkAccessToken && settings.tkAutoPost !== false ? ' + TikTok' + (hasImg ? '' : ' (ছবি লাগবে)') : ''}${settings.tgToken && settings.tgChannel && settings.tgAutoPost !== false ? ' + টেলিগ্রাম চ্যানেল' : ''}${when}\n\nপোস্ট করব? "পোস্ট করো" বললে এখনই (বা উপরের সময়ে) যাবে। বদলাতে চাইলে বলুন, না চাইলে "দরকার নেই"।`;
      if (next.imageUrl) result.imageUrl = next.imageUrl;
      else if (next.imageB64 && !imageB64) {
        // AI-র বানানো ছবি দেখাতে অস্থায়ী পাবলিক লিংক (বিদ্যমান /pmedia রুট)
        try { const mid = await store.addPostMedia({ mime: 'image/jpeg', b64: next.imageB64 }); result.imageUrl = `${require('../config').publicUrl}/pmedia/${mid}.jpg`; } catch (e) { /* প্রিভিউ ছাড়াই চলবে */ }
      }
    } else if (action && action.type === 'post_publish') {
      if (!pending) {
        result.reply = 'এখন কোনো পোস্টের খসড়া নেই। আগে বলুন কী নিয়ে পোস্ট বানাব, আমি খসড়া দেখাই।';
      } else {
        let atMs = null;
        const atIn = action.at || pending.postAt;
        if (atIn) {
          atMs = new Date(atIn).getTime();
          if (isNaN(atMs)) { result.reply = 'সময়টা বুঝতে পারিনি — যেমন "কাল সকাল ১০টায়" বলুন।'; atMs = undefined; }
          else if (atMs < Date.now() + 11 * 60000) { result.reply = 'শিডিউলের জন্য অন্তত ১১ মিনিট পরের সময় লাগবে (ফেসবুকের নিয়ম)। সময়টা আবার বলুন।'; atMs = undefined; }
          else if (atMs > Date.now() + 29 * 86400000) { result.reply = 'সর্বোচ্চ ২৯ দিন পর পর্যন্ত শিডিউল করা যায়।'; atMs = undefined; }
        }
        if (atMs !== undefined) {
          const wantIg = !!action.instagram || !!pending.wantIg || IG_RE.test(text);
          const r = await publishPending(settings, pending, { facebook: action.facebook !== false, instagram: wantIg, atMs });
          await clearPending(key);
          const where = (action.facebook !== false ? 'ফেসবুকে' : '') + (r.igDone ? (action.facebook !== false ? ' ও ' : '') + 'ইনস্টাগ্রামে' : '') + (r.tgDone ? ((where_ok(action, r)) ? ' ও ' : '') + 'টেলিগ্রাম চ্যানেলে' : '') + (r.tkDone ? ((where_ok(action, r) || r.tgDone) ? ' ও ' : '') + 'TikTok-এ' : '');
          result.reply = atMs
            ? `🗓️ ${where || 'পোস্ট'} শিডিউল করা হয়েছে — ${bdString(atMs)} (ঢাকার সময়)।`
            : `✅ ${where || 'পোস্ট'} পোস্ট হয়ে গেছে!`;
          if (r.igSkip) result.reply += `\n⚠️ ইনস্টাগ্রামে যায়নি: ${r.igSkip}।`;
          if (r.tkSkip) result.reply += `\n⚠️ TikTok-এ যায়নি: ${r.tkSkip}।`;
        }
      }
    } else if (action && action.type === 'product_draft') {
      const price = Number(action.price);
      if (!action.name || !String(action.name).trim() || isNaN(price) || price < 0) {
        result.reply = 'পণ্যের নাম ও দাম জানালে খসড়া বানিয়ে দিই।';
      } else {
        const keepImg = prodPending && prodPending.imageB64 && !imageB64 ? prodPending.imageB64 : '';
        const next = {
          name: clip(action.name, 120).trim(), price, oldPrice: Number(action.oldPrice) || 0, stock: Math.max(0, Math.round(Number(action.stock) || 0)),
          category: clip(action.category, 60), desc: clip(action.desc, 800), imageB64: imageB64 || keepImg
        };
        await setProdPending(key, next);
        prodPending = next;
        result.reply = `🛍️ নতুন পণ্যের খসড়া:\n\n• নাম: ${next.name}\n• দাম: ${taka(next.price)}${next.oldPrice ? ' (আগের দাম ' + taka(next.oldPrice) + ')' : ''}\n• স্টক: ${next.stock}টি\n• বিভাগ: ${next.category || '(ঠিক হয়নি)'}\n• বিবরণ: ${next.desc || '—'}\n• ছবি: ${next.imageB64 ? 'আছে' : 'নেই (ছবি পাঠালে যুক্ত হবে)'}\n\nসব ঠিক থাকলে "যোগ করো" বলুন। বদলাতে চাইলে বলুন।`;
      }
    } else if (action && action.type === 'product_confirm') {
      if (!prodPending) {
        result.reply = 'এখন যোগ করার মতো কোনো পণ্যের খসড়া নেই। পণ্যের নাম, দাম ও স্টক বলুন।';
      } else {
        const image = await productImageData(prodPending);
        const p = await shop.addProduct({ ...prodPending, image });
        await clearProdPending(key);
        result.reply = `✅ "${p.name}" ওয়েবসাইটে যোগ হয়ে গেছে (${taka(p.price)}, স্টক ${p.stock})।${image ? '' : '\n⚠️ ছবি ছাড়া যোগ হয়েছে — অ্যাডমিন প্যানেল থেকে ছবি দিতে পারেন।'}`;
      }
    } else if (action && action.type === 'product_cancel') {
      await clearProdPending(key);
      result.reply = reply || 'ঠিক আছে, পণ্যটা যোগ করলাম না।';
    } else if (action && action.type === 'post_cancel') {
      await clearPending(key);
      result.reply = reply || 'ঠিক আছে, পোস্টটা বাতিল করলাম।';
    }
  } catch (err) {
    console.error('সহকারীর কাজ ব্যর্থ:', errMsg(err));
    result.reply = `দুঃখিত, কাজটা করা যায়নি: ${errMsg(err)}`;
    delete result.imageUrl;
  }

  await saveTurns(key, [...turns, { role: 'user', text: clip(text, 400) }, { role: 'assistant', text: clip(result.reply, 500) }]).catch(() => {});
  return result;
}

module.exports = { isOwner, tryLink, setOwner, getPublicOwnerCfg, handleOwnerMessage, buildSnapshot, lineItems, summarize };
