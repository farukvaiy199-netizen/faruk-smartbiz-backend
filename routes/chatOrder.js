'use strict';
// চ্যাট "অর্ডার কার্ড": মেসেঞ্জার/ইনস্টাগ্রাম/হোয়াটসঅ্যাপ/টেলিগ্রাম/টিকটকে কার্ডের বাটন চাপলে এই পেজ খোলে।
// ওয়েবসাইটের মতোই: কুপন, জেলা-ভিত্তিক ক্যাশ অন ডেলিভারি, বিকাশ/নগদ (TrxID যাচাইসহ), পণ্য সাজেস্ট, অর্ডার আইডি।
// লিংক সই-করা (গোপন টোকেন) — কাস্টমার ছাড়া অন্য কেউ বানাতে পারে না। রুট শুধু /co/... — বাকি সার্ভারে কোনো প্রভাব নেই।
const express = require('express');
const crypto = require('crypto');
const store = require('../services/store');
const shop = require('../services/shop');
const payments = require('../services/payments');
const { DISTRICTS } = require('../services/delivery');
const { computeOrder, dealDiscount, calcShipping, UserError, num } = require('../services/pricing');
const config = require('../config');
const { notifyOwner } = require('../services/notify');

const router = express.Router();
const TOKEN_DAYS = 7;

/* ---------- সই-করা টোকেন ---------- */
let secretCache = '';
async function secret() {
  if (secretCache) return secretCache;
  if (process.env.CHAT_ORDER_SECRET) return (secretCache = process.env.CHAT_ORDER_SECRET);
  const db = await store.getDb();
  let d = await db.collection('meta').findOne({ _id: 'chatOrderSecret' });
  if (!d) {
    const v = crypto.randomBytes(32).toString('hex');
    await db.collection('meta').updateOne({ _id: 'chatOrderSecret' }, { $setOnInsert: { v } }, { upsert: true });
    d = await db.collection('meta').findOne({ _id: 'chatOrderSecret' });
  }
  return (secretCache = d.v);
}
const b64 = b => Buffer.from(b).toString('base64url');
async function makeToken(customerId, productId) {
  const body = b64(JSON.stringify({ c: customerId, p: String(productId || ''), e: Date.now() + TOKEN_DAYS * 86400e3 }));
  const sig = crypto.createHmac('sha256', await secret()).update(body).digest('base64url').slice(0, 22);
  return body + '.' + sig;
}
async function readToken(t) {
  const [body, sig] = String(t || '').split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', await secret()).update(body).digest('base64url').slice(0, 22);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try { const d = JSON.parse(Buffer.from(body, 'base64url').toString()); return d && d.e > Date.now() ? d : null; } catch (e) { return null; }
}
// অন্য ফাইল থেকে: কাস্টমার + পণ্যের জন্য অর্ডার-পেজের লিংক
async function orderLink(customerId, productId) { return `${config.publicUrl}/co/${await makeToken(customerId, productId)}`; }

/* ---------- সীমা ---------- */
const hits = new Map();
function limit(key, max, ms) {
  const now = Date.now(), a = (hits.get(key) || []).filter(t => now - t < ms);
  if (a.length >= max) { hits.set(key, a); return false; }
  a.push(now); hits.set(key, a); return true;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (!v.some(t => n - t < 3600e3)) hits.delete(k); }, 600e3).unref();
const done = new Map(); // idempotency: কী → ফলাফল (ডাবল-ক্লিক ঠেকাতে)
const sourceLabel = pf => pf === 'facebook' ? 'Messenger' : pf === 'instagram' ? 'Instagram' : pf === 'telegram' ? 'Telegram' : pf === 'tiktok' ? 'TikTok' : pf === 'email' ? 'Email' : 'WhatsApp';

router.use('/co', (req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('X-Robots-Tag', 'noindex, nofollow'); next(); });

async function ctxOf(req, res) {
  const t = await readToken(req.params.token);
  if (!t) { res.status(410).json({ error: 'এই অর্ডার-লিংকের মেয়াদ শেষ — চ্যাটে ফিরে আবার "অর্ডার করতে চাই" লিখুন' }); return null; }
  const data = await shop.getOrderData();
  if (!data) { res.status(503).json({ error: 'দোকানের তথ্য এখন আনা যাচ্ছে না — একটু পরে চেষ্টা করুন' }); return null; }
  return { t, data };
}

// পণ্যের তথ্য ক্লায়েন্টের জন্য (সংবেদনশীল কিছু নয়)
async function pubProduct(p) {
  return { id: p.id, name: p.name, price: p.price, oldPrice: p.oldPrice, stock: p.stock, sku: p.sku, variantLabel: p.variantLabel,
    variants: p.variants.map(v => ({ id: v.id, name: v.name, price: v.price, oldPrice: v.oldPrice, stock: v.stock })), image: await shop.getProductImage(p.id) };
}
const prodMap = list => { const m = {}; list.forEach(p => { m[p.id] = p; }); return m; };

router.get('/co/:token/data', async (req, res) => {
  try {
    if (!limit('cod:' + req.ip, 60, 60e3)) return res.status(429).json({ error: 'একটু ধীরে চেষ্টা করুন' });
    const c = await ctxOf(req, res); if (!c) return;
    const { products, settings: st } = c.data;
    const act = products.filter(p => p.name && p.status === 'active' && (p.stock === null || p.stock > 0 || p.variants.length));
    const main = act.find(p => String(p.id) === c.t.p) || null;
    if (!main) return res.status(404).json({ error: 'দুঃখিত, পণ্যটি এখন পাওয়া যাচ্ছে না' });
    const cust = await store.getCustomerById(c.t.c);
    // সাজেস্ট: একই বিভাগ আগে
    const sug = [...act.filter(p => p.id !== main.id && p.category === main.category), ...act.filter(p => p.id !== main.id && p.category !== main.category)].slice(0, 4);
    // আগের অর্ডার থেকে ঠিকানা ভরে দিই
    let prefill = { name: '', phone: '', address: '', district: '' };
    if (cust) {
      const prev = (await store.getOrdersByCustomer(cust.id))[0];
      prefill = { name: (prev && prev.name) || (cust.name && cust.name !== 'অজানা কাস্টমার' ? cust.name : ''), phone: (prev && prev.phone) || cust.phone || '', address: (prev && prev.address) || '', district: (prev && prev.district) || '' };
    }
    const fo = st.flash && st.flash.on && num(st.flash.pct, 0) > 0 && num(st.flash.endAt, 0) > Date.now();
    res.json({
      shop: (st.storeName && st.storeName !== 'Bazaar') ? st.storeName : 'Khan Global Shop', logo: /^https:\/\//.test(String(st.logo || '')) ? st.logo : '',
      product: await pubProduct(main), suggest: await Promise.all(sug.map(pubProduct)), prefill,
      districts: DISTRICTS, cod: Array.isArray(st.codDistricts) ? st.codDistricts : ['ঢাকা'],
      pay: { bkash: String(st.bkashNumber || '').trim(), nagad: String(st.nagadNumber || '').trim(), plans: (Array.isArray(st.paymentPlans) ? st.paymentPlans : []).map(Number).filter(n => n > 0 && n <= 100), verify: payments.enabled() },
      ship: { inside: num(st.shipInsideDhaka, 60), outside: num(st.shipOutsideDhaka, 120), prepay: num(st.prepayDiscount, 30), free: num(st.freeShip, 0) },
      flash: fo ? { pct: num(st.flash.pct, 0), endAt: num(st.flash.endAt, 0) } : null
    });
  } catch (e) { console.error('[chatOrder] data:', e.message); res.status(500).json({ error: 'পেজ লোড হয়নি — আবার চেষ্টা করুন' }); }
});

// দাম হিসাব (কুপন, ছাড়, ডেলিভারি) — অর্ডার না করেই
function quote(st, pmap, body, priorOrders) {
  const raw = Array.isArray(body.items) ? body.items.slice(0, 12) : [];
  const items = []; let note = '';
  for (const it of raw) {
    const p = pmap[String(it.pid)], qty = Math.max(1, Math.min(50, parseInt(it.qty, 10) || 1));
    if (!p || p.status !== 'active') continue;
    if (p.variants.length) {
      const v = p.variants.find(x => x.id === String(it.vid)) || null;
      if (!v) { note = 'অপশন বেছে নিন'; continue; }
      if (qty > (v.stock || 0)) note = `"${p.name} (${v.name})" স্টকে মাত্র ${v.stock || 0}টি`;
      items.push({ pid: p.id, vid: v.id, name: p.name + ' (' + v.name + ')', qty, price: v.price });
    } else {
      if (p.stock !== null && qty > p.stock) note = `"${p.name}" স্টকে মাত্র ${p.stock}টি`;
      items.push({ pid: p.id, name: p.name, qty, price: p.price });
    }
  }
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  const dd = dealDiscount(st, items, body.coupon, { priorOrders });
  const discount = dd.total, taxable = Math.max(subtotal - discount, 0);
  const district = String(body.district || ''), payment = ['cod', 'bkash', 'nagad'].includes(body.payment) ? body.payment : 'cod';
  const ship = calcShipping(st, subtotal, district, payment);
  const total = taxable + ship.final;
  const plans = Array.isArray(st.paymentPlans) ? st.paymentPlans.map(Number).filter(n => n > 0 && n <= 100) : [];
  let advance = 0;
  if (payment !== 'cod' && plans.length && plans.includes(Number(body.plan))) advance = Math.round(total * Number(body.plan) / 100);
  return { items, subtotal, flash: dd.flash, bundle: dd.bundle, coupon: dd.coupon, discount, shipBase: ship.base, prepayOff: ship.off, shipping: ship.final, total,
    advance, due: advance ? Math.max(total - advance, 0) : 0, couponError: dd.couponError, couponOk: !!(dd.couponCode && !dd.couponError), note,
    free: ship.base === 0 && num(st.freeShip, 0) > 0 };
}

router.post('/co/:token/quote', async (req, res) => {
  try {
    if (!limit('coq:' + req.ip, 120, 60e3)) return res.status(429).json({ error: 'একটু ধীরে চেষ্টা করুন' });
    const c = await ctxOf(req, res); if (!c) return;
    const cust = await store.getCustomerById(c.t.c);
    const prior = cust ? (await store.getOrdersByCustomer(cust.id)).filter(o => o.status !== 'Cancelled').length : 0;
    res.json(quote(c.data.settings, prodMap(c.data.products), req.body || {}, prior));
  } catch (e) { console.error('[chatOrder] quote:', e.message); res.status(500).json({ error: 'হিসাব করা যায়নি' }); }
});

router.post('/co/:token/place', async (req, res) => {
  const body = req.body || {};
  const idem = String(body.key || '').slice(0, 60);
  try {
    if (!limit('cop:' + req.ip, 12, 3600e3)) return res.status(429).json({ error: 'অনেকবার চেষ্টা হয়েছে — কিছুক্ষণ পরে আবার চেষ্টা করুন' });
    const c = await ctxOf(req, res); if (!c) return;
    const cacheKey = idem ? c.t.c + ':' + idem : '';
    if (cacheKey && done.has(cacheKey)) return res.json(done.get(cacheKey));
    const cust = await store.getCustomerById(c.t.c);
    if (!cust) return res.status(410).json({ error: 'কাস্টমারের তথ্য পাওয়া যায়নি — চ্যাটে ফিরে আবার চেষ্টা করুন' });
    const st = c.data.settings, pmap = prodMap(c.data.products);
    const prior = (await store.getOrdersByCustomer(cust.id)).filter(o => o.status !== 'Cancelled').length;
    const pending = (await store.getOrdersByCustomer(cust.id)).filter(o => o.status === 'Pending').length;
    if (pending >= 5) throw new UserError('আপনার অনেকগুলো অর্ডার অপেক্ষায় আছে — আমাদের সাথে যোগাযোগ করুন');
    const input = { name: body.name, phone: body.phone, address: body.address, district: body.district, upazila: body.upazila, payment: body.payment,
      transactionId: body.transactionId, paymentPlanPercent: body.plan, couponCode: body.coupon,
      items: (Array.isArray(body.items) ? body.items : []).map(i => ({ pid: i.pid, vid: i.vid || '', qty: parseInt(i.qty, 10) || 1 })) };
    const calc = computeOrder(st, pmap, input, { priorOrders: prior }); // সব যাচাই এখানে: নাম, ফোন, ঠিকানা, জেলা, COD নিয়ম, স্টক, কুপন
    // বিকাশ/নগদ: TrxID যাচাই (SMS_HOOK_KEY থাকলে)
    let verified, paidAmount = 0, claimed = '';
    if (payments.enabled() && calc.payment !== 'cod' && calc.transactionId) {
      const minPay = calc.paymentPlanPercent ? calc.advanceAmount : calc.total;
      const v = await payments.verify(calc.transactionId, minPay, 9000);
      const tkey = 'co:' + cust.id;
      if (v.state === 'ok') {
        if (!(await payments.claim(calc.transactionId, 'chat:' + cust.id))) throw new UserError('এই ট্রানজেকশন আইডি দিয়ে আগেই একটি অর্ডার হয়েছে — নতুন পেমেন্টের আইডি দিন');
        verified = true; paidAmount = v.payment.amount; claimed = calc.transactionId; payments.clearTry(tkey);
      } else if (v.state === 'used') throw new UserError('এই ট্রানজেকশন আইডি দিয়ে আগেই একটি অর্ডার হয়েছে — নতুন পেমেন্টের আইডি দিন');
      else if (v.state === 'low') throw new UserError(`আপনার পেমেন্ট ৳${v.payment.amount} এসেছে, কিন্তু কমপক্ষে ৳${minPay} দরকার — বাকি টাকা পাঠিয়ে নতুন TrxID দিন`);
      else if (payments.bumpTry(tkey) < 2) throw new UserError('এই ট্রানজেকশন আইডি দিয়ে আমাদের নম্বরে কোনো পেমেন্ট পাইনি — TrxID হুবহু মিলিয়ে আবার দিন, আর টাকা আমাদের নম্বরে পাঠিয়েছেন কিনা দেখে নিন');
      else verified = false; // ২য় বারও না মিললে অর্ডার যায়, "যাচাই-বাকি" চিহ্নসহ — মালিক নিজে দেখে নেবেন
    }
    const qtyAll = calc.items.reduce((n, i) => n + i.qty, 0);
    const afterDisc = Math.max(calc.subtotal - calc.discount, 0) + calc.tax;
    const paymentStatus = calc.payment === 'cod' ? 'unpaid' : (verified === true ? (paidAmount + 1 >= calc.total ? 'paid' : 'partial') : 'unverified');
    let saved;
    try {
      saved = await store.createOrder({
        customerId: cust.id, name: calc.name, phone: calc.phone, address: calc.address + (calc.upazila ? ', ' + calc.upazila : ''), email: '',
        product: calc.items.map(i => i.name + ' x' + i.qty).join(', '), qty: qtyAll, price: Math.round(afterDisc / Math.max(qtyAll, 1)),
        source: sourceLabel(cust.platform), district: calc.district, payment: calc.payment, transactionId: calc.transactionId, shipping: calc.shipping,
        paymentVerified: verified, paidAmount,
        extra: { items: calc.items.map(i => ({ pid: i.pid, name: i.name, qty: i.qty, price: i.price })), subtotal: calc.subtotal, discount: calc.discount, couponCode: calc.couponCode || '',
          total: calc.total, upazila: calc.upazila, shippingBase: calc.shippingBase, prepayDiscount: calc.prepayDiscount, paymentStatus,
          paymentPlanPercent: calc.paymentPlanPercent, advanceAmount: calc.advanceAmount, dueAmount: calc.dueAmount, via: 'order-card' }
      });
    } catch (e) { if (claimed) await payments.release(claimed, 'chat:' + cust.id); throw e; }
    if (claimed) payments.setRef(claimed, saved.id);
    await store.updateCustomerContact(cust.id, { orderName: calc.name, phone: calc.phone }).catch(() => {});

    const payLabel = calc.payment === 'bkash' ? 'বিকাশ' : calc.payment === 'nagad' ? 'নগদ' : 'ক্যাশ অন ডেলিভারি';
    const payNote = calc.payment === 'cod' ? `ডেলিভারির সময় ৳${calc.total} দিতে হবে` : verified === true ? (paymentStatus === 'paid' ? '✅ পেমেন্ট পেয়েছি' : `✅ ৳${paidAmount} অগ্রিম পেয়েছি, বাকি ৳${calc.total - paidAmount}`) : '⏳ পেমেন্ট যাচাই চলছে';
    const owner = [`${saved.name} · ${saved.product}`, `মোট ৳${calc.total} · ${payLabel}` + (calc.couponCode ? ` · কুপন ${calc.couponCode}` : ''), verified === true ? `✅ পেমেন্ট SMS-এর সাথে মিলেছে (৳${paidAmount})` : verified === false ? '⚠️ TrxID আপনার SMS-এ পাওয়া যায়নি — পাঠানোর আগে নিজে মিলিয়ে নিন' : ''].filter(Boolean).join('\n');
    notifyOwner({ type: 'order', title: `🛒 নতুন অর্ডার ${saved.id} (অর্ডার কার্ড)`, body: owner }).catch(() => {});

    // চ্যাটেও কনফার্মেশন
    try {
      const msg = ['✅ আপনার অর্ডারটি পেয়েছি!', '', `অর্ডার আইডি: ${saved.id}`, ...calc.items.map(i => `• ${i.name} x${i.qty} — ৳${i.price * i.qty}`),
        calc.discount ? `ছাড়: −৳${calc.discount}` : '', `ডেলিভারি চার্জ: ৳${calc.shipping}`, `মোট: ৳${calc.total}`, `পেমেন্ট: ${payLabel} — ${payNote}`, `ঠিকানা: ${calc.address}, ${calc.upazila}, ${calc.district}`, '', 'শীঘ্রই আমাদের প্রতিনিধি ফোন করে কনফার্ম করবেন। ধন্যবাদ! 🙏'].filter(x => x !== '').join('\n');
      await store.appendMessage(cust.id, 'assistant', msg);
      await require('../services/crm').sendPlain(cust, msg, await store.getSettings());
    } catch (e) { console.error('[chatOrder] চ্যাটে কনফার্মেশন যায়নি (অর্ডার হয়ে গেছে):', e.message); }

    const out = { ok: true, orderId: saved.id, total: calc.total, payment: calc.payment, payLabel, payNote, paymentStatus, items: calc.items, discount: calc.discount, shipping: calc.shipping, subtotal: calc.subtotal, district: calc.district };
    if (cacheKey) { done.set(cacheKey, out); setTimeout(() => done.delete(cacheKey), 600e3).unref(); }
    res.json(out);
  } catch (e) {
    if (e instanceof UserError) return res.status(400).json({ error: e.userMessage });
    console.error('[chatOrder] place:', e.message); res.status(500).json({ error: 'অর্ডার করা যায়নি — আবার চেষ্টা করুন' });
  }
});

router.get('/co/:token', async (req, res) => {
  const t = await readToken(req.params.token).catch(() => null);
  res.type('html').send(require('../services/orderPage')(req.params.token, !!t));
});

console.log('🧾 অর্ডার কার্ড মডিউল লোড হয়েছে (/co)');
module.exports = router;
module.exports.orderLink = orderLink;
