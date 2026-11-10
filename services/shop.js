// ই-কমার্স ওয়েবসাইট (Firebase Firestore-ভিত্তিক অ্যাডমিন প্যানেল) ↔ SmartBiz সংযোগ।
// কাজ: ১) প্রোডাক্ট/দাম/স্টক/কুপন পড়ে AI-কে জানানো  ২) স্টক কম/শেষ হলে মালিককে সতর্ক করা
//       ৩) ওয়েবসাইট চ্যাটে নতুন মেসেজ এলে মালিককে জানানো  ৪) অ্যাপের "ই-কমার্স" পেজের জন্য সারাংশ।
// প্রোডাক্ট পড়তে কোনো অ্যাকাউন্ট লাগে না (পাবলিক)। অর্ডার/চ্যাট পড়তে অ্যাডমিন প্যানেলের "অটোমেশন API" পেজে বানানো বট ইউজার লাগে (ঐচ্ছিক)।
const axios = require('axios');
const store = require('./store');
const { notifyOwner } = require('./notify');
const config = require('../config');

const DEFAULT_ROOT = 'bazaar_store/khanglobalshop_main';
const DEFAULT_SITE = 'https://farukvaiy199-netizen.github.io/khanglobalshop/';
// ছবি ছাড়া হালকা ফিল্ড — প্রোডাক্টের ছবি অনেক সময় ডেটাবেসের ভেতরে বড় base64 হয়ে থাকে, তাই প্রতি মিনিটে সেটা টানা হয় না
const LIGHT_FIELDS = ['name', 'category', 'price', 'oldPrice', 'stock', 'sku', 'desc', 'status', 'emoji'];
const CACHE_MS = 60 * 1000; // AI রিপ্লাইয়ের সময় সর্বোচ্চ ১ মিনিটের পুরনো তথ্য — মানে প্রায় "লাইভ"

function defaults() {
  return {
    connected: false, projectId: '', apiKey: '', root: DEFAULT_ROOT, site: DEFAULT_SITE, productLink: '', botEmail: '', botPassword: '',
    show: { products: true, stock: true, orders: true, messages: true, offers: true },
    low: 5, every: 'live', lastSync: null, counts: null
  };
}

/* ---------- কনফিগ (MongoDB meta কালেকশনে) ---------- */
async function getCfg() {
  const db = await store.getDb();
  const doc = await db.collection('meta').findOne({ _id: 'shop' });
  const d = doc || {};
  delete d._id;
  return { ...defaults(), ...d, show: { ...defaults().show, ...(d.show || {}) } };
}
async function saveCfg(patch) {
  const db = await store.getDb();
  await db.collection('meta').updateOne({ _id: 'shop' }, { $set: patch }, { upsert: true });
}
async function getState() {
  const db = await store.getDb();
  const doc = await db.collection('meta').findOne({ _id: 'shopState' });
  return doc || { _id: 'shopState', init: false, flags: {}, chatSeen: {} };
}
async function saveState(st) {
  const db = await store.getDb();
  const { _id, ...rest } = st;
  await db.collection('meta').updateOne({ _id: 'shopState' }, { $set: rest }, { upsert: true });
}

/* ---------- Firestore REST ---------- */
function fromValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return ((v.arrayValue && v.arrayValue.values) || []).map(fromValue);
  if ('mapValue' in v) return fromFields((v.mapValue && v.mapValue.fields) || {});
  return null;
}
function fromFields(fields) {
  const o = {};
  Object.keys(fields || {}).forEach(k => { o[k] = fromValue(fields[k]); });
  return o;
}
function docOut(d) {
  const name = String(d.name || '');
  return { id: name.slice(name.lastIndexOf('/') + 1), ...fromFields(d.fields) };
}

function baseUrl(cfg) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}/databases/(default)/documents/${cfg.root.replace(/^\/+|\/+$/g, '')}`;
}

function explain(err) {
  const d = err && err.response && err.response.data;
  const e = d && d.error;
  const msg = String((e && (e.message || e.status)) || (err && err.message) || err);
  if (/EMAIL_NOT_FOUND/.test(msg)) return 'বটের ইমেইল পাওয়া যায়নি';
  if (/INVALID_PASSWORD|INVALID_LOGIN_CREDENTIALS/.test(msg)) return 'বটের ইমেইল বা পাসওয়ার্ড ভুল';
  if (/API key not valid|API_KEY_INVALID/i.test(msg)) return 'Web API Key ভুল';
  if (/PERMISSION_DENIED|Missing or insufficient/i.test(msg)) return 'অনুমতি নেই — Firestore Rules-এ বটের নিয়ম বসানো হয়েছে কিনা দেখুন';
  if (/NOT_FOUND/.test(msg)) return 'Project ID বা শপের রুট পাথ ভুল';
  return msg.slice(0, 160);
}

let tokenCache = { id: '', token: '', exp: 0 };
async function botToken(cfg) {
  if (!cfg.botEmail || !cfg.botPassword) return '';
  const id = cfg.botEmail + '|' + cfg.botPassword + '|' + cfg.apiKey;
  if (tokenCache.id === id && tokenCache.token && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const r = await axios.post(
    'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + encodeURIComponent(cfg.apiKey),
    { email: cfg.botEmail, password: cfg.botPassword, returnSecureToken: true },
    { timeout: 15000 }
  );
  tokenCache = { id, token: r.data.idToken, exp: Date.now() + Number(r.data.expiresIn || 3600) * 1000 };
  return tokenCache.token;
}

async function fsGet(cfg, path, params, token) {
  const r = await axios.get(baseUrl(cfg) + '/' + path, {
    params: { key: cfg.apiKey, ...(params || {}) },
    headers: token ? { Authorization: 'Bearer ' + token } : {},
    paramsSerializer: { indexes: null },
    timeout: 20000
  });
  return r.data;
}

async function listDocs(cfg, col, { pageSize = 300, maxPages = 10, orderBy, token, mask } = {}) {
  const out = [];
  let pageToken = '';
  for (let i = 0; i < maxPages; i++) {
    const params = { pageSize };
    if (orderBy) params.orderBy = orderBy;
    if (mask) params['mask.fieldPaths'] = mask;
    if (pageToken) params.pageToken = pageToken;
    let data;
    try {
      data = await fsGet(cfg, col, params, '');
    } catch (err) {
      const st = err.response && err.response.status;
      if ((st === 403 || st === 401) && token) data = await fsGet(cfg, col, params, token); // পাবলিক না হলে বট দিয়ে
      else throw err;
    }
    (data.documents || []).forEach(d => out.push(docOut(d)));
    pageToken = data.nextPageToken || '';
    if (!pageToken) break;
  }
  return out;
}

async function queryDocs(cfg, structuredQuery, token) {
  const r = await axios.post(baseUrl(cfg) + ':runQuery', { structuredQuery },
    { params: { key: cfg.apiKey }, headers: { Authorization: 'Bearer ' + token }, timeout: 20000 });
  return (r.data || []).filter(x => x.document).map(x => docOut(x.document));
}

/* ---------- ডেটা স্বাভাবিক করা ---------- */
const toNum = v => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? null : Number(v);

function normProduct(p) {
  return {
    id: p.id,
    name: String(p.name || '').trim(),
    category: String(p.category || '').trim(),
    price: toNum(p.price),
    oldPrice: toNum(p.oldPrice),
    stock: toNum(p.stock),
    sku: String(p.sku || ''),
    desc: String(p.desc || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    status: String(p.status || 'active')
  };
}

function activeProducts(products) { return products.filter(p => p.name && p.status === 'active'); }

function summarize(products, low) {
  const act = activeProducts(products);
  const out = act.filter(p => p.stock !== null && p.stock <= 0);
  const lowItems = act.filter(p => p.stock !== null && p.stock > 0 && p.stock <= low);
  return {
    counts: { products: act.length, out: out.length, low: lowItems.length },
    outItems: out.slice(0, 12).map(p => ({ name: p.name, stock: 0 })),
    lowItems: lowItems.sort((a, b) => a.stock - b.stock).slice(0, 12).map(p => ({ name: p.name, stock: p.stock }))
  };
}

/* ---------- স্ন্যাপশট (ক্যাশ সহ) ---------- */
let snap = null; // { products, settings, fetchedAt }

async function fetchSnapshot(cfg) {
  const token = await botToken(cfg).catch(() => '');
  const [prodDocs, setDoc] = await Promise.all([
    listDocs(cfg, 'products', { token, mask: LIGHT_FIELDS }),
    fsGet(cfg, 'parts/settings', {}, '').catch(() => null)
  ]);
  let settings = {};
  try {
    const d = setDoc && setDoc.fields && fromFields(setDoc.fields);
    if (d && d.json) settings = (JSON.parse(d.json).settings) || {};
  } catch (e) { /* সেটিংস না পড়া গেলেও প্রোডাক্ট চলবে */ }
  return { products: prodDocs.map(normProduct), settings, fetchedAt: Date.now() };
}

// maxAgeMs-এর বেশি পুরনো হলে আবার আনে; আনতে না পারলে আগেরটাই দেয়
async function getSnapshot(maxAgeMs) {
  const cfg = await getCfg();
  if (!cfg.connected) return { cfg, snap: null };
  if (snap && Date.now() - snap.fetchedAt < (maxAgeMs === undefined ? CACHE_MS : maxAgeMs)) return { cfg, snap };
  try {
    snap = await fetchSnapshot(cfg);
  } catch (err) {
    console.error('ই-কমার্স ডেটা আনা যায়নি:', explain(err));
  }
  return { cfg, snap };
}

/* ---------- AI-র জন্য লেখা ---------- */
const tokensOf = s => String(s || '').toLowerCase().split(/[\s,.;:!?()\-_/]+/).filter(w => w.length >= 2);

function stockText(p, cfg) {
  if (!cfg.show.stock || p.stock === null) return '';
  if (p.stock <= 0) return 'স্টক শেষ';
  if (p.stock <= cfg.low) return `স্টক কম (${p.stock}টি বাকি)`;
  return 'স্টকে আছে';
}

function siteUrl(cfg) { return String(cfg.site || DEFAULT_SITE).trim() || DEFAULT_SITE; }
// প্রোডাক্টের সরাসরি লিংকের ছাঁচ থাকলে (যেমন https://.../?product={id}) সেটা, নইলে ওয়েবসাইটের মূল লিংক
function productUrl(cfg, p) {
  const t = String(cfg.productLink || '').trim();
  return t ? t.replace('{id}', encodeURIComponent(p.id)) : siteUrl(cfg);
}

async function usesWebsiteProducts() {
  try {
    const cfg = await getCfg();
    return !!(cfg.connected && cfg.show.products);
  } catch (e) { return false; }
}

async function getAiContext(message) {
  try {
    const { cfg, snap: s } = await getSnapshot();
    if (!s) return '';
    const site = siteUrl(cfg);
    let txt = '\n=== ই-কমার্স ওয়েবসাইটের লাইভ তথ্য (অ্যাডমিন প্যানেল থেকে) ===\n' +
      'প্রোডাক্ট, দাম, স্টক ও অফারের জন্য এই অংশটাই একমাত্র নির্ভরযোগ্য উৎস। শিটে বা আগের কথোপকথনে অন্য কোনো প্রোডাক্ট-তালিকা থাকলে সেটা পুরনো ধরে নেবে — এই তালিকার সাথে না মিললে এই তালিকাই ঠিক।\n' +
      `ওয়েবসাইট: ${site}\n`;
    if (cfg.show.products) {
      const act = activeProducts(s.products);
      let list = act;
      let note = '';
      if (act.length > 40) {
        const words = tokensOf(message);
        const scored = act.map(p => {
          const hay = (p.name + ' ' + p.category + ' ' + p.sku).toLowerCase();
          return { p, sc: words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0) };
        }).filter(x => x.sc > 0).sort((a, b) => b.sc - a.sc);
        list = (scored.length ? scored.map(x => x.p) : act).slice(0, 30);
        const cats = Array.from(new Set(act.map(p => p.category).filter(Boolean))).slice(0, 20);
        note = `ওয়েবসাইটে মোট ${act.length}টি সক্রিয় প্রোডাক্ট আছে` + (cats.length ? ` (বিভাগ: ${cats.join(', ')})` : '') +
          `। নিচে কাস্টমারের প্রশ্নের সাথে মেলে এমন (বা মেলা না গেলে প্রথম ${list.length}টি) দেওয়া হলো। কোনোটা নিচে না থাকলে বলবে "এই নামে কিছু পাচ্ছি না, নাম একটু ভিন্নভাবে বলবেন?" অথবা ওয়েবসাইটের লিংক দেবে।\n`;
      }
      txt += note + `ওয়েবসাইটের প্রোডাক্ট (মোট ${act.length}টি):\n`;
      txt += list.length
        ? list.map(p => {
            const parts = [`[ID: ${p.id}]`, p.name];
            if (p.price !== null) parts.push('৳' + p.price + (p.oldPrice && p.oldPrice > p.price ? ` (আগে ৳${p.oldPrice})` : ''));
            if (p.category) parts.push(p.category);
            const st = stockText(p, cfg); if (st) parts.push(st);
            if (p.desc) parts.push(p.desc);
            parts.push('লিংক: ' + productUrl(cfg, p));
            return '- ' + parts.join(' | ');
          }).join('\n') + '\n'
        : '(ওয়েবসাইটে এখন কোনো সক্রিয় প্রোডাক্ট নেই)\n';
      txt += 'কাস্টমার "কী কী পণ্য আছে" জানতে চাইলে এই তালিকার সবগুলো প্রোডাক্টের নাম ও দাম (স্টক শেষ হলে সেটাও) গুছিয়ে বলবে, শেষে ওয়েবসাইটের লিংক দেবে।\n';
    }
    if (cfg.show.offers) {
      const st = s.settings || {};
      const offers = [];
      const coupons = st.coupons && typeof st.coupons === 'object' ? Object.entries(st.coupons) : [];
      coupons.forEach(([code, amt]) => offers.push(`কুপন কোড ${code}: ৳${amt} ছাড়`));
      if (st.freeShip) offers.push(`৳${st.freeShip}-এর বেশি অর্ডারে ডেলিভারি ফ্রি`);
      if (st.announce) offers.push('ঘোষণা: ' + String(st.announce).slice(0, 200));
      if (offers.length) txt += 'চলমান অফার:\n' + offers.map(o => '- ' + o).join('\n') + '\n';
    }
    txt += `
=== ছবি ও লিংক (ওয়েবসাইটের প্রোডাক্ট) ===
- কাস্টমার কোনো প্রোডাক্টের ছবি দেখতে চাইলে (বা প্রোডাক্ট দেখানোর সময় ছবি দিলে ভালো হয়) সেই প্রোডাক্টের [ID] থেকে হুবহু ID "shopProductId"-তে বসাবে। ছবি সিস্টেম নিজেই পাঠিয়ে দেবে — তুমি ছবির লিংক বানাবে না, "imageUrl" ও "imageId" null রাখবে। ছবি পাঠানো না গেলে সিস্টেম কিছু করবে না, তাই reply-তে সবসময় প্রোডাক্টের লিংকও দেবে।
- প্রোডাক্ট নিয়ে কথা বললে উপরের "লিংক:" অংশ থেকে হুবহু লিংক কপি করে দেবে। লিংক নিজে বানাবে না।

=== অর্ডার নেওয়ার নীতি (ওয়েবসাইট সংযুক্ত থাকায় — নিচের "অর্ডার নেওয়ার নিয়ম"-এর উপরে প্রযোজ্য) ===
১) কাস্টমার কোনো প্রোডাক্ট কিনতে বা অর্ডার করতে চাইলে সাথে সাথে "order" বানাবে না এবং নাম/ফোন/ঠিকানা চাইতে শুরু করবে না।
২) প্রথমে প্রোডাক্টের নাম, দাম ও ওয়েবসাইটের লিংক দিয়ে ভদ্রভাবে জিজ্ঞেস করবে: "আপনি কি আমাদের ওয়েবসাইট থেকে নিজে অর্ডার করবেন, নাকি আমাকে দিয়ে এখানেই অর্ডার দিতে চান?"
৩) কাস্টমার ওয়েবসাইট বাছলে লিংকটা আবার দিয়ে সহজ করে বলবে কীভাবে অর্ডার করবে। "order" অবশ্যই null।
৪) কাস্টমার স্পষ্টভাবে এখানেই (চ্যাটে) অর্ডার দিতে চাইলে তবেই নিচের অর্ডার-নিয়ম মেনে নাম, ফোন, ঠিকানা, পরিমাণ নিয়ে অর্ডার নেবে।
৫) যে প্রোডাক্ট "স্টক শেষ", তার অর্ডার কোনোভাবেই নেবে না; বিকল্প প্রোডাক্ট সাজেস্ট করবে।
৬) কাস্টমার আগেই ওয়েবসাইট বা চ্যাট — যেকোনো একটা বেছে নিয়ে থাকলে (কথোপকথনে দেখা গেলে) আবার একই প্রশ্ন করবে না।
`;
    return txt;
  } catch (err) {
    console.error('AI-র জন্য ই-কমার্স তথ্য বানানো যায়নি:', err.message);
    return '';
  }
}

/* ---------- প্রোডাক্টের ছবি ---------- */
// ছবি হয় পাবলিক লিংক (Cloudinary ইত্যাদি) নয়তো ডেটাবেসের ভেতর base64। দ্বিতীয় ক্ষেত্রে আমাদের সার্ভার /shopimg/<id>.jpg থেকে পরিবেশন করে।
const imgCache = new Map(); // id -> { v: string, at }
async function getRawImage(cfg, id) {
  const hit = imgCache.get(id);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.v;
  let doc;
  try {
    doc = await fsGet(cfg, 'products/' + encodeURIComponent(id), { 'mask.fieldPaths': ['image'] }, '');
  } catch (err) {
    const token = await botToken(cfg).catch(() => '');
    if (!token) return '';
    doc = await fsGet(cfg, 'products/' + encodeURIComponent(id), { 'mask.fieldPaths': ['image'] }, token);
  }
  const v = String((fromFields(doc.fields || {}).image) || '');
  if (imgCache.size > 25) imgCache.delete(imgCache.keys().next().value);
  imgCache.set(id, { v, at: Date.now() });
  return v;
}

// কাস্টমারকে পাঠানোর মতো পাবলিক ছবির লিংক; ছবি না থাকলে/পাওয়া না গেলে null
async function getProductImage(id) {
  try {
    if (!id) return null;
    const cfg = await getCfg();
    if (!cfg.connected) return null;
    const v = await getRawImage(cfg, String(id));
    if (/^https?:\/\//i.test(v)) return v;
    if (/^data:image\//i.test(v)) return `${config.publicUrl}/shopimg/${encodeURIComponent(id)}.jpg`;
    return null;
  } catch (err) {
    console.error('প্রোডাক্টের ছবি আনা যায়নি:', explain(err));
    return null;
  }
}

// GET /shopimg/:id — base64 ছবিকে আসল ছবি হিসেবে পরিবেশন
async function serveProductImage(id, res) {
  const cfg = await getCfg();
  if (!cfg.connected) return res.sendStatus(404);
  const v = await getRawImage(cfg, String(id));
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(v);
  if (m) {
    res.set('Content-Type', m[1]);
    res.set('Cache-Control', 'public, max-age=3600');
    return res.send(Buffer.from(m[2], 'base64'));
  }
  if (/^https?:\/\//i.test(v)) return res.redirect(v);
  return res.sendStatus(404);
}

/* ---------- সংযোগ, সিঙ্ক, সতর্কতা ---------- */
function publicStatus(cfg, sum) {
  return {
    connected: !!cfg.connected,
    lastSync: cfg.lastSync || null,
    counts: sum ? sum.counts : cfg.counts,
    lowItems: sum ? sum.lowItems : (cfg.lowItems || []),
    outItems: sum ? sum.outItems : (cfg.outItems || []),
    orders: cfg.ordersInfo || null,
    hasBot: !!(cfg.botEmail && cfg.botPassword),
    site: cfg.site || DEFAULT_SITE,
    productLink: cfg.productLink || ''
  };
}

// অ্যাপ থেকে Connect চাপলে: তথ্য যাচাই করে সংরক্ষণ করে প্রথম সিঙ্ক চালায়
async function connect(input) {
  const old = await getCfg();
  const projectId = String(input.projectId || '').trim();
  const apiKey = String(input.apiKey || '').trim() || old.apiKey;
  const root = String(input.root || DEFAULT_ROOT).trim().replace(/^\/+|\/+$/g, '');
  const botEmail = String(input.botEmail || '').trim();
  const botPassword = String(input.botPassword || '') || (botEmail && botEmail === old.botEmail ? old.botPassword : '');
  if (!projectId) throw new Error('Firebase Project ID দিন');
  if (!apiKey) throw new Error('Web API Key দিন');
  const show = { ...defaults().show, ...(input.show || {}) };
  const low = Math.max(1, parseInt(input.low, 10) || 5);
  const every = ['live', '5', '15', '60'].includes(String(input.every)) ? String(input.every) : 'live';

  const site = String(input.site || '').trim() || old.site || DEFAULT_SITE;
  const productLink = input.productLink !== undefined ? String(input.productLink || '').trim() : (old.productLink || '');
  const cfg = { ...defaults(), connected: true, projectId, apiKey, root, site, productLink, botEmail, botPassword, show, low, every };
  try {
    tokenCache = { id: '', token: '', exp: 0 };
    if (botEmail) await botToken(cfg); // বটের তথ্য ভুল হলে এখানেই ধরা পড়বে
    const fresh = await fetchSnapshot(cfg);
    snap = fresh;
    const sum = summarize(fresh.products, low);
    cfg.counts = sum.counts; cfg.lowItems = sum.lowItems; cfg.outItems = sum.outItems;
    cfg.lastSync = new Date().toISOString();
  } catch (err) {
    throw new Error(explain(err));
  }
  await saveCfg(cfg);
  const ordersInfo = await syncAlerts(cfg, true).catch(e => { console.error('ই-কমার্স সতর্কতা এরর:', e.message); return null; });
  if (ordersInfo) { cfg.ordersInfo = ordersInfo; await saveCfg({ ordersInfo }); }
  return publicStatus(cfg, summarize(snap.products, low));
}

async function status() {
  const cfg = await getCfg();
  return publicStatus(cfg, null);
}

// প্রতিবার সিঙ্কে: নতুন স্টক-সমস্যা ও ওয়েবসাইট চ্যাটের নতুন মেসেজ ধরে মালিককে জানায়
async function syncAlerts(cfg, baseline) {
  const st = await getState();
  const firstRun = baseline || !st.init;
  const flags = {};
  const act = activeProducts(snap.products);
  const newlyOut = [], newlyLow = [];
  act.forEach(p => {
    const f = p.stock === null ? 'ok' : p.stock <= 0 ? 'out' : p.stock <= cfg.low ? 'low' : 'ok';
    flags[p.id] = f;
    const before = (st.flags || {})[p.id];
    if (!firstRun && before !== undefined && before !== f) {
      if (f === 'out') newlyOut.push(p);
      else if (f === 'low' && before === 'ok') newlyLow.push(p);
    }
  });
  if (cfg.show.stock && (newlyOut.length || newlyLow.length)) {
    const names = arr => arr.slice(0, 4).map(p => p.name + (p.stock > 0 ? ` (${p.stock})` : '')).join(', ') + (arr.length > 4 ? ` +${arr.length - 4}টি` : '');
    if (newlyOut.length) await notifyOwner({ type: 'stock', title: `❌ ওয়েবসাইটে স্টক শেষ (${newlyOut.length}টি)`, body: names(newlyOut) }).catch(() => {});
    if (newlyLow.length) await notifyOwner({ type: 'stock', title: `⚠️ ওয়েবসাইটে স্টক কম (${newlyLow.length}টি)`, body: names(newlyLow) }).catch(() => {});
  }

  const chatSeen = { ...(st.chatSeen || {}) };
  let ordersInfo = null;
  const token = await botToken(cfg).catch(() => '');
  if (token) {
    // পেন্ডিং অর্ডার সংখ্যা (অ্যাপে দেখানোর জন্য)
    try {
      const orders = await listDocs(cfg, 'orders', { pageSize: 50, maxPages: 1, orderBy: 'createdAt desc', token });
      ordersInfo = { pending: orders.filter(o => o.status === 'pending').length, recent: orders.length };
    } catch (e) { /* অর্ডার না পড়া গেলেও বাকি কাজ চলবে */ }
    // ওয়েবসাইট চ্যাটে অপঠিত মেসেজ
    if (cfg.show.messages) {
      try {
        const chats = await queryDocs(cfg, {
          from: [{ collectionId: 'chats' }],
          where: { fieldFilter: { field: { fieldPath: 'unreadForAdmin' }, op: 'EQUAL', value: { booleanValue: true } } },
          limit: 20
        }, token);
        for (const c of chats) {
          const msgs = Array.isArray(c.messages) ? c.messages : [];
          const last = msgs[msgs.length - 1];
          if (!last || last.from !== 'customer') continue;
          if (chatSeen[c.id] === msgs.length) continue;
          chatSeen[c.id] = msgs.length;
          if (!firstRun) {
            await notifyOwner({
              type: 'chat',
              title: `💬 ওয়েবসাইট চ্যাটে ${c.customerName || 'একজন কাস্টমার'}`,
              body: String(last.text || '').slice(0, 100)
            }).catch(() => {});
          }
        }
      } catch (e) { /* চ্যাট না পড়া গেলেও বাকি কাজ চলবে */ }
    }
  }
  await saveState({ init: true, flags, chatSeen });
  return ordersInfo;
}

let syncing = false;
// force=true হলে সাথে সাথে; নইলে সেটিংসের "আপডেট" সময়ের ব্যবধান মেনে চলে। কখনো এরর ছোঁড়ে না (শিডিউলার থেকে চলে)।
async function sync(force) {
  if (syncing) return null;
  syncing = true;
  try {
    const cfg = await getCfg();
    if (!cfg.connected) return null;
    const mins = cfg.every === 'live' ? 2 : Number(cfg.every) || 5; // "লাইভ" মানে প্রতি ক্রনে (UptimeRobot ৫ মিনিটে ডাকলে ৫ মিনিটে)
    if (!force && cfg.lastSync && Date.now() - new Date(cfg.lastSync).getTime() < mins * 60000 - 5000) return null;
    snap = await fetchSnapshot(cfg);
    const sum = summarize(snap.products, cfg.low);
    const ordersInfo = await syncAlerts(cfg, false);
    const patch = { lastSync: new Date().toISOString(), counts: sum.counts, lowItems: sum.lowItems, outItems: sum.outItems };
    if (ordersInfo) patch.ordersInfo = ordersInfo;
    await saveCfg(patch);
    return publicStatus({ ...cfg, ...patch }, sum);
  } catch (err) {
    console.error('ই-কমার্স সিঙ্ক এরর:', explain(err));
    if (force) throw new Error(explain(err));
    return null;
  } finally {
    syncing = false;
  }
}

async function disconnect() {
  snap = null;
  tokenCache = { id: '', token: '', exp: 0 };
  await saveCfg({ connected: false, botPassword: '', counts: null, lowItems: [], outItems: [], ordersInfo: null, lastSync: null });
}

module.exports = { connect, status, sync, disconnect, getAiContext, getProductImage, serveProductImage, usesWebsiteProducts, summarize, normProduct, fromFields, docOut };
