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
    .concat(['https://farukvaiy199-netizen.github.io', 'https://khanglobalshop.com', 'https://www.khanglobalshop.com'])
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
router.use(['/api/place-order', '/api/chat-ai', '/api/admin/reset-password'], (req, res, next) => {
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
    if (phone) {
      const q = await db.collection(`${ROOT}/orders`).where('phone', '==', phone).limit(30).get();
      const pending = q.docs.filter(d => d.data().status === 'pending').length;
      if (pending >= 5) throw new UserError('এই নম্বরে ইতিমধ্যে অনেকগুলো অর্ডার অপেক্ষায় আছে — আমাদের সাথে যোগাযোগ করুন');
    }
    // আইডি আসে মালিকের অর্ডার-শিট থেকে। আগে অর্ডারটা যাচাই করি (ভুল হলে শিটের ঘর নষ্ট হবে না), তারপর ঘর নিই।
    let sheetId = null;
    if (orderSheet.enabled()) {
      const ids0 = [...new Set((Array.isArray(input.items) ? input.items : []).map(i => String((i && i.pid) || '')))].filter(id => id && id.indexOf('/') < 0).slice(0, 30);
      const snaps0 = await Promise.all(ids0.map(id => db.doc(`${ROOT}/products/${id}`).get()));
      const pmap0 = {}; snaps0.forEach(s => { if (s.exists) pmap0[s.id] = s.data(); });
      const c0 = computeOrder(settings, pmap0, input); // সমস্যা থাকলে এখানেই UserError
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
      const calc = computeOrder(settings, pmap, input);
      const next = counterSnap.exists ? counterSnap.data().next : 1001;
      const orderId = sheetId || (orderSheet.enabled() ? 'ORD-E' + next : 'ORD-' + next);
      const order = {
        id: orderId, ownerUid: uid, ownerEmail: req.user.email || '',
        customer: calc.name, phone: calc.phone, address: calc.address, items: calc.items,
        subtotal: calc.subtotal, discount: calc.discount, tax: calc.tax, shipping: calc.shipping, total: calc.total,
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
