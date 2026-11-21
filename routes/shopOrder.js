'use strict';
// ওয়েবসাইট (khanglobalshop) এর সুরক্ষিত অর্ডার ও AI-চ্যাট রুট — SmartBiz সার্ভারের ভেতরেই চলে।
// গুরুত্বপূর্ণ: এই ফাইলে কোনো ভুল বা Firebase কী না থাকলে শুধু এই দুই রুট 503 দেয় — বাকি সার্ভার কখনো থামে না।
const express = require('express');
const { computeOrder, UserError } = require('../services/pricing');

const ROOT = process.env.FIRESTORE_ROOT || 'bazaar_store/khanglobalshop_main';
// AI_WEBHOOK_URL দেওয়া না থাকলে এই সার্ভারের নিজের /webhook/ai-reply-ই ব্যবহার হবে (আগে সাইট সরাসরি এটাকেই ডাকত)
const LOCAL_AI = 'http://127.0.0.1:' + (process.env.PORT || 10000) + '/webhook/ai-reply';
const AI_WEBHOOK_URL = process.env.AI_WEBHOOK_URL || LOCAL_AI;
const AI_WEBHOOK_SECRET = process.env.AI_WEBHOOK_SECRET || '';
// অনুমোদিত সাইটের ঠিকানা: Render-এর ALLOWED_ORIGINS + বর্তমান GitHub ঠিকানা + কেনা ডোমেন (ডোমেন চালু হলে বা মেয়াদ শেষ হলেও আলাদা কিছু বদলাতে হবে না)
const ALLOWED = Array.from(new Set(
  (process.env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim().replace(/\/+$/, '')).filter(Boolean)
    .concat(['https://farukvaiy199-netizen.github.io', 'https://khanglobalshop.com', 'https://www.khanglobalshop.com', 'https://khanglobalshop.pages.dev', 'https://khanglobalshop.web.app', 'https://khanglobalshop.firebaseapp.com'])
));
const ADMIN_UIDS = (process.env.ADMIN_UIDS || 'sJYwLDzg6TNj89EIvnMSJVDF0oT2').split(',').map(x => x.trim()).filter(Boolean);
const PHONE_DOMAIN = '@phone.khanglobalshop.com';

let admin = null, db = null, initError = '';
function init() {
  if (db) return true;
  if (initError) return false;
  try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('FIREBASE_SERVICE_ACCOUNT সেট করা নেই');
    admin = require('firebase-admin'); // দেরিতে লোড — না লাগলে মেমরি খরচ হয় না
    const cred = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    const appName = 'shop-order';
    const existing = admin.apps.find(a => a && a.name === appName);
    const app = existing || admin.initializeApp({ credential: admin.credential.cert(cred) }, appName);
    db = app.firestore();
    return true;
  } catch (e) {
    initError = e.message;
    console.error('[shopOrder] চালু হয়নি (বাকি সার্ভার ঠিক আছে):', e.message);
    return false;
  }
}

const orderSheet = require('../services/orderSheet');
const router = express.Router();

// শুধু নিজের সাইটের ঠিকানা থেকে আসা ব্রাউজার অনুরোধ নেবে (অর্ডার-সার্ভারের আগের নিয়ম)
router.use(['/api/place-order', '/api/chat-ai', '/api/admin/reset-password', '/api/otp/send', '/api/track'], (req, res, next) => {
  const o = req.headers.origin;
  if (o && !ALLOWED.includes(o)) return res.status(403).json({ error: 'এই ঠিকানা থেকে অনুমতি নেই' });
  next();
});

const hits = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now(), arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return false; }
  arr.push(now); hits.set(key, arr); return true;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

async function authMw(req, res, next) {
  if (!init()) return res.status(503).json({ error: 'অর্ডার সার্ভার এখনো চালু হয়নি' });
  const h = String(req.headers.authorization || '');
  if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'সাইন-ইন প্রয়োজন' });
  try { req.user = await admin.auth(admin.app('shop-order')).verifyIdToken(h.slice(7)); next(); }
  catch (e) { res.status(401).json({ error: 'সাইন-ইন মেয়াদ শেষ — পেজ রিফ্রেশ করুন' }); }
}
async function loadSettings() {
  const snap = await db.doc(`${ROOT}/parts/settings`).get();
  if (!snap.exists) return {};
  try { return JSON.parse(snap.data().json).settings || {}; } catch (e) { return {}; }
}
function bdDate() { return new Date(Date.now() + 6 * 3600e3).toISOString().slice(0, 10); }

router.get('/api/shop-health', (req, res) => res.json({ ok: init(), error: initError || undefined }));

router.post('/api/place-order', authMw, async (req, res) => {
  const uid = req.user.uid;
  if (!rateLimit('order:' + uid, 6, 3600e3) || !rateLimit('orderip:' + req.ip, 20, 3600e3)) return res.status(429).json({ error: 'অনেকবার চেষ্টা হয়েছে — কিছুক্ষণ পরে আবার চেষ্টা করুন' });
  try {
    const input = req.body || {};
    const settings = await loadSettings();
    const phone = String(input.phone || '').replace(/[\s-]/g, '');
    let priorOrders = 0;
    if (phone) {
      const q = await db.collection(`${ROOT}/orders`).where('phone', '==', phone).limit(30).get();
      const pending = q.docs.filter(d => d.data().status === 'pending').length;
      priorOrders = q.docs.filter(d => d.data().status !== 'cancelled').length;
      if (pending >= 5) throw new UserError('এই নম্বরে ইতিমধ্যে অনেকগুলো অর্ডার অপেক্ষায় আছে — আমাদের সাথে যোগাযোগ করুন');
    }
    // আইডি আসে মালিকের অর্ডার-শিট থেকে। আগে অর্ডারটা যাচাই করি (ভুল হলে শিটের ঘর নষ্ট হবে না), তারপর ঘর নিই।
    let sheetId = null;
    if (orderSheet.enabled()) {
      const ids0 = [...new Set((Array.isArray(input.items) ? input.items : []).map(i => String((i && i.pid) || '')))].filter(id => id && id.indexOf('/') < 0).slice(0, 30);
      const snaps0 = await Promise.all(ids0.map(id => db.doc(`${ROOT}/products/${id}`).get()));
      const pmap0 = {}; snaps0.forEach(s => { if (s.exists) pmap0[s.id] = s.data(); });
      const c0 = computeOrder(settings, pmap0, input, { priorOrders }); // সমস্যা থাকলে এখানেই UserError
      sheetId = await orderSheet.claim({
        name: c0.name, phone: c0.phone, address: c0.address, district: c0.district,
        product: c0.items.map(i => (i.name || '') + (i.variantName ? ' (' + i.variantName + ')' : '') + ' x' + (i.qty || 1)).join(', '),
        qty: c0.items.reduce((n, i) => n + (Number(i.qty) || 1), 0), price: c0.subtotal, shipping: c0.shipping, total: c0.total,
        payment: c0.payment, transactionId: c0.transactionId, source: 'ওয়েবসাইট', status: 'Pending'
      });
    }
    let result;
    try {
    result = await db.runTransaction(async tx => {
      const counterRef = db.doc(`${ROOT}/counters/orderCounter`);
      const counterSnap = await tx.get(counterRef);
      const ids = [...new Set((Array.isArray(input.items) ? input.items : []).map(i => String((i && i.pid) || '')))].filter(id => id && id.indexOf('/') < 0).slice(0, 30);
      const snaps = await Promise.all(ids.map(id => tx.get(db.doc(`${ROOT}/products/${id}`))));
      const pmap = {}; snaps.forEach(s => { if (s.exists) pmap[s.id] = s.data(); });
      const calc = computeOrder(settings, pmap, input, { priorOrders });
      const next = counterSnap.exists ? counterSnap.data().next : 1001;
      const orderId = sheetId || (orderSheet.enabled() ? 'ORD-E' + next : 'ORD-' + next);
      const order = {
        id: orderId, ownerUid: uid, ownerEmail: req.user.email || '',
        customer: calc.name, phone: calc.phone, address: calc.address, items: calc.items,
        subtotal: calc.subtotal, discount: calc.discount, couponCode: calc.couponCode || '', flashDiscount: calc.flashDiscount || 0, bundleDiscount: calc.bundleDiscount || 0, couponDiscount: calc.couponDiscount || 0, tax: calc.tax, shipping: calc.shipping, total: calc.total,
        district: calc.district, upazila: calc.upazila, shippingBase: calc.shippingBase, prepayDiscount: calc.prepayDiscount,
        status: 'pending', payment: calc.payment, paymentStatus: 'unpaid', transactionId: calc.transactionId,
        paymentPlanPercent: calc.paymentPlanPercent, advanceAmount: calc.advanceAmount, dueAmount: calc.dueAmount,
        courier: 'নির্ধারণ করা হয়নি', date: bdDate(), source: 'server'
      };
      tx.set(db.doc(`${ROOT}/orders/${orderId}`), Object.assign({}, order, { createdAt: admin.firestore.FieldValue.serverTimestamp() }));
      if (!sheetId) tx.set(counterRef, { next: next + 1 });
      calc.stockUpdates.forEach(u => tx.update(db.doc(`${ROOT}/products/${u.pid}`), u.variants ? { stock: u.newStock, variants: u.variants } : { stock: u.newStock }));
      return { orderId, total: calc.total, order };
    });
    } catch (txErr) { if (sheetId) await orderSheet.release(sheetId); throw txErr; }
    res.json(result);
  } catch (e) {
    if (e instanceof UserError) return res.status(400).json({ error: e.userMessage });
    console.error('place-order error:', e);
    res.status(500).json({ error: 'সার্ভারে সমস্যা হয়েছে — আবার চেষ্টা করুন' });
  }
});


// অর্ডার ট্র্যাকিং — অর্ডার আইডি + মোবাইল নম্বর দুটোই মিললে তবেই অবস্থা দেখায় (ঠিকানা/নাম দেখায় না)
router.post('/api/track', async (req, res) => {
  if (!rateLimit('track:' + req.ip, 40, 3600e3)) return res.status(429).json({ error: 'অনেকবার চেষ্টা হয়েছে — একটু পরে আবার চেষ্টা করুন' });
  if (!init()) return res.status(503).json({ error: 'সেবা এখন চালু নেই' });
  try {
    const id = String((req.body || {}).orderId || '').trim().toUpperCase().replace(/\s+/g, '');
    const phone = String((req.body || {}).phone || '').replace(/[\s-]/g, '');
    if (!/^[A-Z0-9-]{3,24}$/.test(id) || !/^01[3-9]\d{8}$/.test(phone)) return res.status(400).json({ error: 'সঠিক অর্ডার নম্বর ও মোবাইল নম্বর দিন' });
    const snap = await db.doc(`${ROOT}/orders/${id}`).get();
    const o = snap.exists ? snap.data() : null;
    if (!o || String(o.phone || '').replace(/[\s-]/g, '') !== phone) return res.status(404).json({ error: 'এই তথ্যে কোনো অর্ডার পাওয়া যায়নি' });
    res.json({
      id: o.id || id, status: o.status || 'pending', date: o.date || '', payment: o.payment || '', paymentStatus: o.paymentStatus || '',
      total: o.total || 0, courier: o.courier || '', district: o.district || '',
      items: (o.items || []).slice(0, 20).map(i => ({ name: i.name, qty: i.qty })),
      courierStatus: o.courierStatusText || '',
      tracking: o.steadfastTrackingId || o.pathaoConsignmentId || o.trackingCode || ''
    });
  } catch (e) { console.error('track error:', e); res.status(500).json({ error: 'সার্ভারে সমস্যা হয়েছে' }); }
});


// ---------- কুরিয়ারের অবস্থা (শুধু অ্যাডমিন): Steadfast / Pathao থেকে এনে অর্ডারে জমা রাখে ----------
const SF_TEXT = { pending: 'কুরিয়ার গ্রহণ করেছে (অপেক্ষায়)', in_review: 'রিভিউ হচ্ছে', delivered: 'ডেলিভারি সম্পন্ন', partial_delivered: 'আংশিক ডেলিভারি', cancelled: 'বাতিল', hold: 'হোল্ডে আছে', unknown: 'অজানা',
  delivered_approval_pending: 'ডেলিভারি হয়েছে (অনুমোদনের অপেক্ষায়)', partial_delivered_approval_pending: 'আংশিক ডেলিভারি (অনুমোদনের অপেক্ষায়)', cancelled_approval_pending: 'বাতিল (অনুমোদনের অপেক্ষায়)', unknown_approval_pending: 'যাচাই চলছে' };
const PATHAO_BASES = { live: 'https://api-hermes.pathao.com', sandbox: 'https://courier-api-sandbox.pathao.com' };
let secureCache = { at: 0, v: null }, pathaoTok = { sig: '', token: '', exp: 0 };
async function loadSecure() {
  if (secureCache.v && Date.now() - secureCache.at < 60e3) return secureCache.v;
  const snap = await db.doc(`${ROOT}/parts/settings_secure`).get();
  let v = {};
  if (snap.exists) { try { v = JSON.parse(snap.data().json).settingsSecure || {}; } catch (e) {} }
  secureCache = { at: Date.now(), v }; return v;
}
async function pathaoToken(c) {
  const sig = [c.clientId, c.clientSecret, c.username, c.password, c.env].join('|');
  if (pathaoTok.token && pathaoTok.sig === sig && Date.now() < pathaoTok.exp) return pathaoTok.token;
  const base = PATHAO_BASES[c.env] || PATHAO_BASES.live;
  const r = await fetch(base + '/aladdin/api/v1/issue-token', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: c.clientId, client_secret: c.clientSecret, username: c.username, password: c.password, grant_type: 'password' }) });
  const d = await r.json().catch(() => null);
  if (!r.ok || !d || !d.access_token) throw new Error('pathao-auth');
  pathaoTok = { sig, token: d.access_token, exp: Date.now() + ((d.expires_in || 3600) * 1000) - 60000 };
  return pathaoTok.token;
}
// একটি অর্ডারের কুরিয়ার অবস্থা আনে; ফেরত: { code, text } বা null
async function fetchCourierStatus(o, sec) {
  if (o.steadfastTrackingId && sec.steadfastApiKey && sec.steadfastSecretKey) {
    const r = await fetch('https://portal.packzy.com/api/v1/status_by_invoice/' + encodeURIComponent(o.id), { headers: { 'Api-Key': sec.steadfastApiKey, 'Secret-Key': sec.steadfastSecretKey, 'Content-Type': 'application/json' } });
    const d = await r.json().catch(() => null);
    if (r.ok && d && d.delivery_status) return { code: String(d.delivery_status), text: SF_TEXT[d.delivery_status] || String(d.delivery_status), courier: 'Steadfast' };
    return null;
  }
  const pc = sec.pathao;
  if (o.pathaoConsignmentId && pc && pc.connected) {
    const base = PATHAO_BASES[pc.env] || PATHAO_BASES.live;
    const get = async t => fetch(base + '/aladdin/api/v1/orders/' + encodeURIComponent(o.pathaoConsignmentId) + '/info', { headers: { Accept: 'application/json', Authorization: 'Bearer ' + t } });
    let r = await get(await pathaoToken(pc));
    if (r.status === 401) { pathaoTok.token = ''; r = await get(await pathaoToken(pc)); }
    const d = await r.json().catch(() => null);
    const st = d && d.data && (d.data.order_status || d.data.order_status_slug);
    if (r.ok && st) return { code: String(st), text: String(st), courier: 'Pathao' };
  }
  return null;
}
const FINAL_COURIER = /^(delivered|cancelled|Delivered|Cancelled|Return|Returned|Payment Invoice)/;
async function refreshOne(id, sec) {
  const ref = db.doc(`${ROOT}/orders/${id}`), snap = await ref.get();
  if (!snap.exists) return null;
  const o = Object.assign({ id }, snap.data());
  const st = await fetchCourierStatus(o, sec);
  if (!st) return null;
  await ref.update({ courierStatus: st.code, courierStatusText: st.text, courierStatusAt: new Date().toISOString() });
  return st;
}
router.post('/api/admin/courier-status', authMw, async (req, res) => {
  if (!ADMIN_UIDS.includes(req.user.uid)) return res.status(403).json({ error: 'শুধু অ্যাডমিন পারবেন' });
  if (!rateLimit('cour:' + req.user.uid, 30, 3600e3)) return res.status(429).json({ error: 'একটু পরে আবার চেষ্টা করুন' });
  try {
    const sec = await loadSecure(), body = req.body || {};
    if (body.orderId) {
      const id = String(body.orderId).replace(/[^A-Za-z0-9-]/g, '');
      const st = await refreshOne(id, sec);
      if (!st) return res.status(404).json({ error: 'কুরিয়ারের অবস্থা পাওয়া যায়নি — Key/কোড যাচাই করুন' });
      return res.json({ ok: true, id, status: st });
    }
    // সব চলমান অর্ডার (সর্বোচ্চ ৪০টি)
    const q = await db.collection(`${ROOT}/orders`).where('status', 'in', ['pending', 'processing']).limit(120).get();
    const ids = q.docs.filter(d => { const o = d.data(); return (o.steadfastTrackingId || o.pathaoConsignmentId) && !FINAL_COURIER.test(String(o.courierStatus || '')); }).slice(0, 40).map(d => d.id);
    const out = {};
    for (const id of ids) { try { const st = await refreshOne(id, sec); if (st) out[id] = st; } catch (e) {} }
    res.json({ ok: true, checked: ids.length, updated: Object.keys(out).length, statuses: out });
  } catch (e) { console.error('courier-status error:', e.message); res.status(500).json({ error: 'কুরিয়ারের অবস্থা আনা যায়নি' }); }
});


// ---------- পণ্যের শেয়ার লিংক: Facebook/WhatsApp-এ ছবি-নাম-দামসহ প্রিভিউ আসে, মানুষ ক্লিক করলে সোজা ওয়েবসাইটের পণ্যে যায় ----------
const escH = t => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
router.get('/p/:id', async (req, res) => {
  const DEFAULT_SITE = 'https://farukvaiy199-netizen.github.io/khanglobalshop/';
  let site = DEFAULT_SITE;
  try {
    const u = new URL(String(req.query.s || ''));
    if (ALLOWED.includes(u.origin) && /^[A-Za-z0-9\/_.-]*$/.test(u.pathname)) site = u.origin + (u.pathname.endsWith('/') ? u.pathname : u.pathname.replace(/[^/]*$/, ''));
  } catch (e) {}
  const id = String(req.params.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60);
  const target = site + '?product=' + encodeURIComponent(id);
  let title = 'Khan Global Shop', desc = 'অনলাইনে অর্ডার করুন — সারা বাংলাদেশে ডেলিভারি।', img = '';
  try {
    if (init() && id) {
      const [ps, st] = await Promise.all([db.doc(`${ROOT}/products/${id}`).get(), loadSettings()]);
      const store = (st && st.storeName && st.storeName !== 'Bazaar') ? st.storeName : 'Khan Global Shop';
      if (ps.exists && ps.data().status === 'active') {
        const p = ps.data();
        title = p.name + ' — ৳' + p.price + ' | ' + store;
        desc = String(p.desc || '').replace(/\s+/g, ' ').trim().slice(0, 150) || (p.name + ' এখনই অর্ডার করুন — সারা বাংলাদেশে ডেলিভারি, ক্যাশ অন ডেলিভারি।');
        if (/^https:\/\//.test(String(p.image || ''))) img = p.image;
      } else title = store;
      if (!img && /^https:\/\//.test(String((st && st.logo) || ''))) img = st.logo;
    }
  } catch (e) {}
  res.set('Cache-Control', 'public, max-age=300');
  res.type('html').send('<!doctype html><html lang="bn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + escH(title) + '</title><meta name="description" content="' + escH(desc) + '">' +
    '<meta property="og:type" content="product"><meta property="og:title" content="' + escH(title) + '"><meta property="og:description" content="' + escH(desc) + '"><meta property="og:url" content="' + escH(target) + '">' +
    (img ? '<meta property="og:image" content="' + escH(img) + '"><meta name="twitter:image" content="' + escH(img) + '">' : '') +
    '<meta name="twitter:card" content="' + (img ? 'summary_large_image' : 'summary') + '"><meta property="og:locale" content="bn_BD">' +
    '<meta http-equiv="refresh" content="0;url=' + escH(target) + '"><link rel="canonical" href="' + escH(target) + '"></head><body>' +
    '<script>location.replace(' + JSON.stringify(target).replace(/</g, '\\u003c') + ')</script><p><a href="' + escH(target) + '">পণ্যটি দেখতে এখানে চাপুন</a></p></body></html>');
});

// ওটিপি পাঠানো — আসল SMS সেবা যুক্ত হলে এখানে বসবে; এখন সৎভাবে "চালু হয়নি" জানায় (ওয়েবসাইটে কাউন্টডাউন উঠবে না)
router.post('/api/otp/send', (req, res) => {
  if (!rateLimit('otp:' + req.ip, 10, 3600e3)) return res.status(429).json({ ok: false, error: 'অনেকবার চেষ্টা হয়েছে — একটু পরে চেষ্টা করুন' });
  res.status(503).json({ ok: false, error: 'ওটিপি সেবা এখনো চালু হয়নি' });
});

router.post('/api/chat-ai', authMw, async (req, res) => {
  if (!rateLimit('ai:' + req.user.uid, 12, 60e3)) return res.status(429).json({ error: 'একটু ধীরে মেসেজ দিন' });
  const b = req.body || {};
  const message = String(b.message || '').slice(0, 1000);
  if (!message) return res.status(400).json({ error: 'মেসেজ খালি' });
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (AI_WEBHOOK_SECRET) headers['X-Secret'] = AI_WEBHOOK_SECRET;
    if (AI_WEBHOOK_URL === LOCAL_AI) headers['X-Forwarded-For'] = String(req.ip || '1.1.1.1'); // ওয়েবহুকের IP-সীমা প্রতিজন কাস্টমারের আলাদা ধরার জন্য
    const r = await fetch(AI_WEBHOOK_URL, { method: 'POST', headers,
      body: JSON.stringify({ message, customerName: String(b.customerName || '').slice(0, 80), customerEmail: req.user.email || '', history: Array.isArray(b.history) ? b.history.slice(-20) : [] }) });
    if (!r.ok) return res.status(502).json({ error: 'AI উত্তর দেয়নি' });
    const ct = r.headers.get('content-type') || '';
    let reply = '';
    if (ct.includes('application/json')) { const d = await r.json(); reply = (d && (d.reply || d.text || d.answer || d.message)) || ''; }
    else reply = await r.text();
    res.json({ reply: String(reply).slice(0, 2000) });
  } catch (e) { console.error('chat-ai error:', e.message); res.status(502).json({ error: 'AI-র সাথে সংযোগ হয়নি' }); }
});

// অ্যাডমিন প্যানেল থেকে: নম্বর-অ্যাকাউন্টের কাস্টমার পাসওয়ার্ড ভুলে গেলে নতুন পাসওয়ার্ড দেওয়া (শুধু অ্যাডমিনের UID পারবে)
router.post('/api/admin/reset-password', authMw, async (req, res) => {
  if (!ADMIN_UIDS.includes(req.user.uid)) return res.status(403).json({ error: 'শুধু অ্যাডমিন পারবেন' });
  if (!rateLimit('reset:' + req.user.uid, 20, 3600e3)) return res.status(429).json({ error: 'অনেকবার চেষ্টা হয়েছে' });
  try {
    const auth = admin.auth(admin.app('shop-order'));
    const uid = String((req.body && req.body.uid) || '');
    if (!uid) return res.status(400).json({ error: 'কাস্টমার বাছা হয়নি' });
    const user = await auth.getUser(uid);
    if (!String(user.email || '').endsWith(PHONE_DOMAIN)) return res.status(403).json({ error: 'শুধু নম্বর-অ্যাকাউন্টের পাসওয়ার্ড বদলানো যায়' });
    let pass = String((req.body && req.body.password) || '');
    if (!pass) { const abc = 'abcdefghjkmnpqrstuvwxyz23456789'; pass = Array.from(require('crypto').randomBytes(8)).map(b => abc[b % abc.length]).join(''); }
    if (pass.length < 6 || pass.length > 64) return res.status(400).json({ error: 'পাসওয়ার্ড ৬-৬৪ অক্ষরের হতে হবে' });
    await auth.updateUser(uid, { password: pass });
    await auth.revokeRefreshTokens(uid);
    res.json({ ok: true, password: pass });
  } catch (e) { console.error('reset-password error:', e.message); res.status(500).json({ error: 'পাসওয়ার্ড বদলানো যায়নি' }); }
});

module.exports = router;
module.exports.helpers = {
  init, ROOT, initError: () => initError,
  getDb: () => db,
  getAuth: () => admin.auth(admin.app('shop-order'))
};
