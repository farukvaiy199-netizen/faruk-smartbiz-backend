const express = require('express');
const router = express.Router();
const axios = require('axios');

const config = require('../config');
const store = require('../services/store');
const { sendFacebookMessage } = require('../services/facebook');
const { sendWhatsAppMessage } = require('../services/whatsapp');
const { getOwnerChatReply, getSlots } = require('../services/ai');
const { notifyOwner, getPublicKey } = require('../services/notify');
const { getSheetProducts } = require('../services/sheets');
const { generatePostDraft } = require('../services/content');
const { publishPagePhoto, deleteFbPost } = require('../services/facebook');
const { detectInstagramAccount, sendInstagramMessage, ensurePageSubscription } = require('../services/instagram');
const { publishIgJob } = require('../services/scheduler');
const videoPosts = require('../services/videoPosts');
const shop = require('../services/shop');
const assistant = require('../services/assistant');
const comments = require('../services/comments');
const multer = require('multer');
const os = require('os');
const fs = require('fs');

// বাংলাদেশের সময় (UTC+6) অনুযায়ী তারিখ বের করে
function bdDateString(d) {
  return new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
}

/* ---------- Dashboard summary ---------- */
router.get('/dashboard/summary', async (req, res) => {
  const orders = await store.getOrders();
  const customers = await store.getCustomers();
  const today = bdDateString(new Date());
  const todayOrders = orders.filter(o => bdDateString(o.createdAt) === today);
  const liveOrders = orders.filter(o => o.status !== 'Cancelled');
  const trend = [6, 5, 4, 3, 2, 1, 0].map(i => {
    const day = bdDateString(new Date(Date.now() - i * 86400000));
    return liveOrders.filter(o => bdDateString(o.createdAt) === day).reduce((sum, o) => sum + (o.price || 0) * (o.qty || 1), 0);
  });
  const settings = await store.getSettings();
  const threshold = settings.lowStockThreshold ?? 5;
  const stockEntries = await store.getStockList();
  res.json({
    lowStockCount: stockEntries.filter(e => e.qty <= threshold).length,
    todayRevenue: todayOrders.filter(o => o.status !== 'Cancelled').reduce((sum, o) => sum + (o.price || 0) * (o.qty || 1), 0),
    trend,
    todayOrders: todayOrders.length,
    pendingCount: orders.filter(o => o.status === 'Pending').length,
    totalCustomers: customers.length
  });
});

/* ---------- Orders ---------- */
router.get('/orders', async (req, res) => {
  res.json(await store.getOrders());
});

// স্ট্যাটাস বদলালে কাস্টমারকে যে মেসেজ যাবে
const STATUS_MESSAGES = {
  Processing: id => `আপনার অর্ডার ${id} এখন প্রসেসিং-এ আছে। শীঘ্রই কুরিয়ারে পাঠানো হবে। 🙏`,
  Delivered: id => `আপনার অর্ডার ${id} ডেলিভারি সম্পন্ন হয়েছে। আমাদের সাথে থাকার জন্য ধন্যবাদ! 🙏`,
  Cancelled: id => `দুঃখিত, আপনার অর্ডার ${id} বাতিল করা হয়েছে। কোনো প্রশ্ন থাকলে আমাদের জানান।`
};

router.patch('/orders/:id', async (req, res) => {
  const { status, notify } = req.body;
  const valid = ['Pending', 'Processing', 'Delivered', 'Cancelled'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'অবৈধ status' });

  const before = await store.getOrderById(req.params.id);
  if (!before) return res.status(404).json({ error: 'অর্ডার পাওয়া যায়নি' });
  let order = await store.updateOrderStatus(req.params.id, status);

  // বাতিল করলে স্টক ফেরত যায়, বাতিল থেকে আবার চালু করলে স্টক আবার কমে
  if (before.stockItem) {
    const qty = Number(before.qty) || 1;
    if (status === 'Cancelled' && before.status !== 'Cancelled' && !before.stockRestored) {
      await store.incrementStock(before.stockItem, qty);
      order = await store.setOrderFields(before.id, { stockRestored: true });
    } else if (before.status === 'Cancelled' && status !== 'Cancelled' && before.stockRestored) {
      const dec = await store.decrementStock(before.stockItem, qty);
      if (dec.ok) order = await store.setOrderFields(before.id, { stockRestored: false });
    }
  }

  // কাস্টমারকে জানানো (Messenger/WhatsApp-এ কাস্টমারের শেষ মেসেজের ২৪ ঘণ্টার মধ্যে হলে তবেই যায়)
  let notifyStatus = 'skipped', notifyNote = '';
  if (notify !== false && status !== before.status && STATUS_MESSAGES[status]) {
    const customer = before.customerId ? await store.getCustomerById(before.customerId) : null;
    const settings = await store.getSettings();
    const text = STATUS_MESSAGES[status](before.id);
    try {
      if (customer && customer.platform === 'facebook' && settings.fbToken) {
        await sendFacebookMessage(customer.platformId, text, settings.fbToken);
        notifyStatus = 'sent';
      } else if (customer && customer.platform === 'whatsapp' && settings.waToken && settings.waPhoneNumberId) {
        await sendWhatsAppMessage(customer.platformId, text, settings.waPhoneNumberId, settings.waToken);
        notifyStatus = 'sent';
      } else if (customer && customer.platform === 'instagram' && settings.fbToken) {
        await sendInstagramMessage(customer.platformId, text, settings.fbToken);
        notifyStatus = 'sent';
      } else {
        notifyNote = customer ? 'ওয়েবসাইট কাস্টমার — মেসেজ পাঠানোর মাধ্যম নেই' : 'কাস্টমার পাওয়া যায়নি';
      }
    } catch (err) {
      notifyStatus = 'failed';
      const m = String((err.response && err.response.data && err.response.data.error && err.response.data.error.message) || err.message);
      notifyNote = /window|24|outside|allowed|session/i.test(m) ? '২৪ ঘণ্টা পেরিয়ে গেছে — কাস্টমারকে নিজে জানান' : m.slice(0, 120);
    }
    order = await store.setOrderFields(before.id, { notifyStatus, notifyNote, notifyAt: new Date().toISOString() });
  }
  res.json({ ...order, notifyStatus, notifyNote });
});

// অর্ডার CSV আকারে ডাউনলোড (Excel-এ খোলা যায়)
router.get('/orders/export', async (req, res) => {
  const orders = await store.getOrders();
  const header = ['Order ID', 'Name', 'Phone', 'Address', 'Email', 'Product', 'Qty', 'Price', 'Total', 'Status', 'Source', 'Date'];
  const rows = orders.map(o => [
    o.id, o.name, o.phone, o.address, o.email || '', o.product, o.qty, o.price,
    (o.price || 0) * (o.qty || 1), o.status, o.source, o.createdAt
  ]);
  const csvEscape = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [header, ...rows].map(r => r.map(csvEscape).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
  res.send('\uFEFF' + csv);
});

/* ---------- Customers ---------- */
router.get('/customers', async (req, res) => {
  res.json(await store.getCustomers());
});

router.patch('/customers/:id/ai', async (req, res) => {
  const { ai } = req.body;
  const customer = await store.setCustomerAI(req.params.id, !!ai);
  if (!customer) return res.status(404).json({ error: 'কাস্টমার পাওয়া যায়নি' });
  res.json(customer);
});

// "মানুষের অপেক্ষায়" ট্যাগ সরানো (মালিক দেখে নিয়েছেন)
router.patch('/customers/:id/handled', async (req, res) => {
  const c = await store.clearNeedsHuman(req.params.id);
  if (!c) return res.status(404).json({ error: 'কাস্টমার পাওয়া যায়নি' });
  res.json(c);
});

// কারো নামে ট্যাপ করলে তার সম্পূর্ণ অর্ডার + কথোপকথন হিস্টোরি
router.get('/customers/:id', async (req, res) => {
  const customers = await store.getCustomers();
  const customer = customers.find(c => c.id === req.params.id);
  if (!customer) return res.status(404).json({ error: 'কাস্টমার পাওয়া যায়নি' });
  const orders = await store.getOrdersByCustomer(customer.id);
  const conversation = await store.getConversation(customer.id);
  res.json({ customer, orders, conversation });
});

// সাপ্তাহিক/মাসিক রিপোর্ট
router.get('/reports', async (req, res) => {
  const rangeDays = req.query.range === 'month' ? 30 : 7;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - rangeDays);

  const allOrders = await store.getOrders();
  const filtered = allOrders.filter(o => new Date(o.createdAt) >= cutoff);

  const productMap = {};
  const platformMap = {};
  let totalRevenue = 0;

  filtered.forEach(o => {
    const qty = o.qty || 1;
    productMap[o.product] = (productMap[o.product] || 0) + qty;
    platformMap[o.source] = (platformMap[o.source] || 0) + 1;
    totalRevenue += (o.price || 0) * qty;
  });

  const topProducts = Object.entries(productMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([product, qty]) => ({ product, qty }));

  const platformBreakdown = Object.entries(platformMap)
    .sort((a, b) => b[1] - a[1])
    .map(([platform, count]) => ({ platform, count }));

  res.json({
    range: rangeDays === 30 ? 'month' : 'week',
    totalOrders: filtered.length,
    totalRevenue,
    topProducts,
    platformBreakdown
  });
});

/* ---------- Broadcast ---------- */
router.post('/broadcast', async (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'মেসেজ খালি' });

  const settings = await store.getSettings();
  const customers = await store.getCustomers();
  let success = 0, failed = 0;
  const reasons = {};
  const why = (e) => {
    const er = e && e.response && e.response.data && e.response.data.error;
    if (er && (er.code === 10 || er.error_subcode === 2018278 || er.code === 551)) return '২৪ ঘণ্টার বাইরে/ব্লক (Meta অনুমতি দেয় না)';
    if (er && er.code === 190) return 'টোকেন মেয়াদোত্তীর্ণ';
    if (er && er.code === 200) return 'অনুমতি নেই';
    return String((er && er.message) || (e && e.message) || 'অজানা').slice(0, 80);
  };
  // Messenger/Instagram: সফল ধরা হবে শুধু যখন Meta message_id ফেরত দেয় — নইলে মিথ্যা "সফল" দেখাত
  const sendMeta = async (id) => {
    const r = await axios.post('https://graph.facebook.com/v19.0/me/messages',
      { recipient: { id }, messaging_type: 'RESPONSE', message: { text: message } },
      { params: { access_token: settings.fbToken }, timeout: 15000 });
    if (!r.data || !r.data.message_id) throw new Error('Meta মেসেজ-আইডি দেয়নি');
  };

  for (const c of customers) {
    try {
      if ((c.platform === 'facebook' || c.platform === 'instagram') && settings.fbToken) {
        await sendMeta(c.platformId);
      } else if (c.platform === 'whatsapp' && settings.waToken && settings.waPhoneNumberId) {
        await sendWhatsAppMessage(c.platformId, message, settings.waPhoneNumberId, settings.waToken);
      } else if (c.platform === 'website') {
        throw new Error('ওয়েবসাইটের কাস্টমারকে এখান থেকে পাঠানো যায় না');
      } else {
        throw new Error('প্ল্যাটফর্ম সংযুক্ত নেই');
      }
      success++;
    } catch (e) {
      failed++;
      const r = why(e); reasons[r] = (reasons[r] || 0) + 1;
    }
    await new Promise(r => setTimeout(r, 120));
  }

  const record = await store.addBroadcast({
    msg: message, total: customers.length, success, failed, reasons,
    date: new Date().toLocaleDateString('bn-BD')
  });
  res.json(record);
});

router.get('/broadcast', async (req, res) => {
  res.json(await store.getBroadcasts());
});

/* ---------- AI নির্দেশনা — মালিক অ্যাপ থেকে AI-কে শেখান (নতুন) ---------- */
const MAX_AI_RULES = 40;
const MAX_AI_IMAGES = 30;

router.get('/ai-rules', async (req, res) => {
  res.json(await store.getAiRules());
});

/* ---------- মালিকের সহকারী ---------- */
router.get('/assistant/owner', async (req, res) => {
  res.json(await assistant.getPublicOwnerCfg());
});
router.post('/assistant/owner', async (req, res) => {
  try {
    const b = req.body || {};
    const out = await assistant.setOwner({ waNumber: b.waNumber, pin: b.pin ? String(b.pin) : '' });
    let subNote = '';
    if (b.commentAuto === 'on' || b.commentAuto === 'off') await store.saveSettings({ commentAuto: b.commentAuto });
    if (b.commentAuto === 'on') {
      try { await comments.ensureFeedSubscription(); } catch (e) { subNote = 'কমেন্ট সাবস্ক্রিপশন হয়নি: ' + e.message; }
    }
    res.json({ ...out, commentAuto: b.commentAuto === 'on' || b.commentAuto === 'off' ? b.commentAuto : out.commentAuto, subNote });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/assistant/chat', async (req, res) => {
  const text = String(req.body.message || '').trim().slice(0, 1500);
  const m = String(req.body.imageData || '').match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
  if (!text && !m) return res.status(400).json({ error: 'মেসেজ খালি' });
  if (m && m[1].length > 2500000) return res.status(400).json({ error: 'ছবিটা অনেক বড়' });
  const settings = await store.getSettings();
  if (!getSlots(settings).length) return res.status(400).json({ error: 'আগে Settings-এ AI Key সংযুক্ত করুন' });
  const out = await assistant.handleOwnerMessage({ key: 'app', text: text || 'এই ছবিটা দিয়ে পোস্ট বানাও।', settings, imageB64: m ? m[1] : '', imageMime: 'image/jpeg' });
  res.json(out);
});
router.get('/comments/diagnose', async (req, res) => {
  try { res.json(await comments.diagnose()); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/comments/recent', async (req, res) => {
  res.json(await comments.recent(20));
});

router.post('/ai-rules/chat', async (req, res) => {
  const imageData = typeof req.body.imageData === 'string' ? req.body.imageData : '';
  let message = (req.body.message || '').toString().trim().slice(0, 600);
  if (!message && !imageData) return res.status(400).json({ error: 'মেসেজ খালি' });
  if (!message) message = 'এই ছবিটা সংরক্ষণ করো।';

  const settings = await store.getSettings();
  if (!getSlots(settings).length) return res.status(400).json({ error: 'আগে Settings-এ AI Key সংযুক্ত করুন' });

  // ছবি থাকলে আগেই যাচাই: ফরম্যাট, সাইজ, সর্বোচ্চ সংখ্যা
  let image = null;
  if (imageData) {
    const m = imageData.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return res.status(400).json({ error: 'ছবির ফরম্যাট সঠিক না (JPG/PNG/WEBP দিন)' });
    if (m[2].length > 1200000) return res.status(400).json({ error: 'ছবিটা অনেক বড়, ছোট করে দিন' });
    const existing = await store.getAiImages();
    if (existing.length >= MAX_AI_IMAGES) {
      return res.json({ reply: `ছবির সংখ্যা ${MAX_AI_IMAGES}-এ পৌঁছে গেছে। আগে তালিকা থেকে কিছু মুছে দিন।`, saved: null, savedImage: null });
    }
    image = { mime: m[1], b64: m[2] };
  }

  const rules = await store.getAiRules();
  const history = (Array.isArray(req.body.history) ? req.body.history : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.text)
    .slice(-6)
    .map(m => ({ role: m.role, text: String(m.text).slice(0, 600) }));

  try {
    const { reply, rule, imageLabel } = await getOwnerChatReply({ settings, message, history, rules, hasImage: !!image });
    let saved = null, savedImage = null;

    if (rule && String(rule).trim()) {
      if (rules.length >= MAX_AI_RULES) {
        return res.json({ reply: `নির্দেশনার সংখ্যা ${MAX_AI_RULES}-এ পৌঁছে গেছে। আগে তালিকা থেকে কিছু মুছে দিন, তারপর নতুনটা বলুন।`, saved: null, savedImage: null });
      }
      saved = await store.addAiRule(String(rule).trim().slice(0, 400));
    }
    if (image && imageLabel && String(imageLabel).trim()) {
      savedImage = await store.addAiImage({ label: String(imageLabel).trim().slice(0, 120), mime: image.mime, b64: image.b64 });
      savedImage.url = `${config.publicUrl}/media/${savedImage.id}`;
    }
    res.json({ reply, saved, savedImage });
  } catch (err) {
    console.error('ai-rules chat error:', err.response?.data ? JSON.stringify(err.response.data) : err.message);
    res.status(500).json({ error: 'AI এই মুহূর্তে উত্তর দিতে পারছে না (কোটা শেষ হতে পারে) — একটু পরে আবার চেষ্টা করুন' });
  }
});

router.delete('/ai-rules/:id', async (req, res) => {
  const ok = await store.deleteAiRule(req.params.id);
  if (!ok) return res.status(404).json({ error: 'নির্দেশনাটা পাওয়া যায়নি' });
  res.json({ ok: true });
});

router.get('/ai-images', async (req, res) => {
  const list = await store.getAiImages();
  res.json(list.map(i => ({ ...i, url: `${config.publicUrl}/media/${i.id}` })));
});

router.delete('/ai-images/:id', async (req, res) => {
  const ok = await store.deleteAiImage(req.params.id);
  if (!ok) return res.status(404).json({ error: 'ছবিটা পাওয়া যায়নি' });
  res.json({ ok: true });
});

/* ---------- AI ব্যবহার (টোকেন/অনুরোধ) (নতুন) ---------- */
router.get('/ai-usage', async (req, res) => {
  const settings = await store.getSettings();
  const usage = await store.getAiUsage();
  res.json({
    ...usage,
    limits: settings.aiLimits || {},
    primary: settings.aiKey ? settings.aiProvider : null,
    backup: settings.aiKey2 ? settings.aiProvider2 : null,
    backup2: settings.aiKey3 ? settings.aiProvider3 : null
  });
});

/* ---------- নোটিফিকেশন ও পুশ (নতুন) ---------- */
router.get('/push/public-key', async (req, res) => {
  res.json({ publicKey: await getPublicKey() });
});

router.post('/push/subscribe', async (req, res) => {
  const sub = req.body.subscription;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'সাবস্ক্রিপশন পাওয়া যায়নি' });
  await store.savePushSub(sub);
  res.json({ ok: true });
});

router.post('/push/test', async (req, res) => {
  await notifyOwner({ type: 'test', title: '✅ নোটিফিকেশন চালু আছে', body: 'SmartBiz থেকে টেস্ট নোটিফিকেশন' });
  res.json({ ok: true });
});

router.get('/notifications', async (req, res) => {
  res.json(await store.getNotifications());
});

router.get('/notifications/count', async (req, res) => {
  res.json({ unread: await store.countUnreadNotifications() });
});

router.post('/notifications/read', async (req, res) => {
  await store.markNotificationsRead();
  res.json({ ok: true });
});

/* ---------- স্টক (অ্যাপের ভেতরে) (নতুন) ---------- */
router.get('/stock', async (req, res) => {
  const settings = await store.getSettings();
  const [entries, sheet] = await Promise.all([store.getStockList(), getSheetProducts(settings.sheetLink)]);
  const map = new Map(entries.map(e => [e.name, e]));
  const items = sheet.map(p => ({ name: p.name, qty: map.has(p.name) ? map.get(p.name).qty : null, sheetStock: p.stock, inSheet: true }));
  entries.forEach(e => {
    if (!sheet.some(p => p.name === e.name)) items.push({ name: e.name, qty: e.qty, sheetStock: null, inSheet: false });
  });
  res.json({ threshold: settings.lowStockThreshold ?? 5, items });
});

router.post('/stock', async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'প্রোডাক্টের নাম নেই' });
  const qty = req.body.qty;
  if (qty !== null && qty !== '' && qty !== undefined && !(Number(qty) >= 0)) return res.status(400).json({ error: 'সংখ্যা সঠিক না' });
  const item = await store.setStock(name, qty);
  res.json({ ok: true, item });
});

// শিটের Stock কলামে যেসব প্রোডাক্টের সংখ্যা আছে, অ্যাপে এখনো বসানো হয়নি এমনগুলো একবারে এনে দেয়
router.post('/stock/import', async (req, res) => {
  const settings = await store.getSettings();
  const [entries, sheet] = await Promise.all([store.getStockList(), getSheetProducts(settings.sheetLink)]);
  const have = new Set(entries.map(e => e.name));
  let count = 0;
  for (const p of sheet) {
    if (p.stock !== null && !have.has(p.name)) { await store.setStock(p.name, p.stock); count++; }
  }
  res.json({ ok: true, imported: count });
});

/* ---------- ফেসবুক পোস্ট (নতুন) ---------- */
router.get('/posts', async (req, res) => {
  res.json(await store.getPosts(30));
});

router.post('/posts/generate', async (req, res) => {
  const settings = await store.getSettings();
  if (!getSlots(settings).length) return res.status(400).json({ error: 'আগে Settings-এ AI Key সংযুক্ত করুন' });
  try {
    const draft = await generatePostDraft(settings, String(req.body.hint || ''));
    res.json({ draft });
  } catch (err) {
    console.error('post draft error:', err.response?.data ? JSON.stringify(err.response.data) : err.message);
    res.status(500).json({ error: err.message && err.message.startsWith('AI খসড়া') ? err.message : 'AI এই মুহূর্তে খসড়া বানাতে পারছে না (কোটা শেষ হতে পারে) — একটু পরে আবার চেষ্টা করুন' });
  }
});

router.post('/posts', async (req, res) => {
  const settings = await store.getSettings();
  if (!settings.fbToken) return res.status(400).json({ error: 'আগে Settings থেকে Facebook পেজ সংযুক্ত করুন' });

  const caption = String(req.body.caption || '').trim().slice(0, 2000);
  if (!caption) return res.status(400).json({ error: 'ক্যাপশন খালি' });

  const m = String(req.body.imageData || '').match(/^data:image\/(?:jpeg|png);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return res.status(400).json({ error: 'ছবির ডেটা সঠিক না' });
  if (m[1].length > 2500000) return res.status(400).json({ error: 'ছবিটা অনেক বড়' });
  const buffer = Buffer.from(m[1], 'base64');

  let whenMs = null;
  if (req.body.scheduledAt) {
    whenMs = new Date(req.body.scheduledAt).getTime();
    if (isNaN(whenMs)) return res.status(400).json({ error: 'সময় সঠিক না' });
    if (whenMs < Date.now() + 11 * 60000) return res.status(400).json({ error: 'অন্তত ১১ মিনিট পরের সময় দিন (ফেসবুকের নিয়ম)' });
    if (whenMs > Date.now() + 29 * 86400000) return res.status(400).json({ error: 'সর্বোচ্চ ২৯ দিন পর পর্যন্ত শিডিউল করা যায়' });
  }

  const thumb = typeof req.body.thumbData === 'string' && req.body.thumbData.length < 80000 && req.body.thumbData.startsWith('data:image/') ? req.body.thumbData : '';
  const base = { caption, productName: String(req.body.productName || '').slice(0, 120), thumb };

  try {
    const r = await publishPagePhoto({ token: settings.fbToken, caption, buffer, scheduledAtMs: whenMs });
    // Instagram-এও পোস্ট করার অনুরোধ থাকলে ছবি ডেটাবেসে রাখি (Instagram পাবলিক লিংক থেকে ছবি নেয়)
    const wantIg = req.body.postToInstagram === true;
    let igFields = {};
    if (wantIg) {
      if (!settings.igUserId) {
        igFields = { igStatus: 'skipped', igError: 'Instagram সংযুক্ত নেই' };
      } else {
        const mediaId = await store.addPostMedia({ mime: 'image/jpeg', b64: m[1] });
        igFields = {
          igStatus: whenMs ? 'pending' : 'publishing',
          igDueAt: whenMs ? new Date(whenMs).toISOString() : new Date().toISOString(),
          mediaId
        };
      }
    }
    const post = await store.addPost({
      ...base,
      ...igFields,
      status: whenMs ? 'scheduled' : 'published',
      scheduledAt: whenMs ? new Date(whenMs).toISOString() : null,
      fbPostId: r.fbPostId, fbPhotoId: r.fbPhotoId
    });
    // এখনই পোস্ট হলে Instagram-এও সাথে সাথে; শিডিউল হলে সময় এলে সার্ভার নিজে পোস্ট করবে
    if (igFields.igStatus === 'publishing') {
      await publishIgJob(post, settings, false);
      return res.json(await store.getPostById(post.id));
    }
    res.json(post);
  } catch (err) {
    console.error('fb publish error:', err.message);
    await store.addPost({ ...base, status: 'failed', error: String(err.message).slice(0, 200), scheduledAt: whenMs ? new Date(whenMs).toISOString() : null });
    res.status(502).json({ error: err.message });
  }
});

/* ---------- ভিডিও পোস্ট: গ্যালারি থেকে ভিডিও → Facebook পেজ ও Instagram রিল (নতুন) ---------- */
// ভিডিও বড় ফাইল, তাই JSON নয় — multipart আসে। ফাইল আগে সার্ভারের অস্থায়ী ফোল্ডারে নামে, তারপর পেছনে ফেসবুকে যায়।
const videoUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 200 * 1024 * 1024, files: 1 } });

router.post('/posts/video', (req, res, next) => {
  videoUpload.single('video')(req, res, err => {
    if (!err) return next();
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    res.status(tooBig ? 413 : 400).json({ error: tooBig ? 'ভিডিও ২০০ MB-এর বেশি — ছোট ভিডিও দিন' : 'ভিডিও আপলোড ব্যর্থ হয়েছে' });
  });
}, async (req, res) => {
  const file = req.file;
  const drop = () => { if (file) fs.unlink(file.path, () => {}); };
  try {
    if (!file) return res.status(400).json({ error: 'ভিডিও পাওয়া যায়নি' });
    if (!/^video\//i.test(file.mimetype || '')) { drop(); return res.status(400).json({ error: 'ভিডিও ফাইল বেছে নিন' }); }

    const caption = String(req.body.caption || '').trim().slice(0, 2000);
    if (!caption) { drop(); return res.status(400).json({ error: 'ক্যাপশন খালি' }); }

    const settings = await store.getSettings();
    const wantFb = req.body.postToFacebook !== 'false';
    const wantIg = req.body.postToInstagram === 'true';
    if (!wantFb && !wantIg) { drop(); return res.status(400).json({ error: 'Facebook বা Instagram অন্তত একটা বেছে নিন' }); }
    if (!settings.fbToken) { drop(); return res.status(400).json({ error: 'আগে Settings থেকে Facebook পেজ সংযুক্ত করুন' }); }
    if (!wantFb && !settings.igUserId) { drop(); return res.status(400).json({ error: 'Instagram সংযুক্ত নেই' }); }

    let whenMs = null;
    if (req.body.scheduledAt) {
      whenMs = new Date(req.body.scheduledAt).getTime();
      if (isNaN(whenMs)) { drop(); return res.status(400).json({ error: 'সময় সঠিক না' }); }
      if (whenMs < Date.now() + 11 * 60000) { drop(); return res.status(400).json({ error: 'অন্তত ১১ মিনিট পরের সময় দিন (ফেসবুকের নিয়ম)' }); }
      if (whenMs > Date.now() + 29 * 86400000) { drop(); return res.status(400).json({ error: 'সর্বোচ্চ ২৯ দিন পর পর্যন্ত শিডিউল করা যায়' }); }
    }

    const thumb = typeof req.body.thumbData === 'string' && req.body.thumbData.length < 80000 && req.body.thumbData.startsWith('data:image/') ? req.body.thumbData : '';
    const post = await store.addPost({
      caption, productName: String(req.body.productName || '').slice(0, 120), thumb,
      mediaType: 'video',
      status: 'processing',
      scheduledAt: whenMs ? new Date(whenMs).toISOString() : null
    });

    // ফাইল সার্ভারে পৌঁছে গেছে — অ্যাপকে সাথে সাথে জবাব দিই, ফেসবুক/Instagram-এ পাঠানো পেছনে চলে (তালিকায় অবস্থা দেখা যায়)
    res.json(post);
    videoPosts.processVideoPost({ post, filePath: file.path, mime: file.mimetype, settings, whenMs, wantFb, wantIg })
      .catch(err => console.error('video post error:', err.message));
  } catch (err) {
    drop();
    console.error('video upload error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'ভিডিও জমা নেওয়া যায়নি' });
  }
});

// নির্ধারিত পোস্ট ফেসবুক থেকে বাতিল করে তালিকা থেকে সরায়। পোস্ট হয়ে যাওয়া/ব্যর্থ পোস্ট শুধু তালিকা থেকে সরে (ফেসবুক থেকে মোছে না)
router.delete('/posts/:id', async (req, res) => {
  const post = await store.getPostById(req.params.id);
  if (!post) return res.status(404).json({ error: 'পোস্টটা পাওয়া যায়নি' });
  if (post.status === 'scheduled' && post.fbPostId) {
    const settings = await store.getSettings();
    try {
      await deleteFbPost({ token: settings.fbToken, id: post.fbPostId });
    } catch (err) {
      return res.status(502).json({ error: 'ফেসবুক থেকে বাতিল করা যায়নি (' + err.message + ') — Facebook-এর Publishing Tools থেকে নিজে বাতিল করুন' });
    }
  }
  if (post.mediaId) {
    if (post.mediaType === 'video') await videoPosts.deleteVideo(post.mediaId);
    else await store.deletePostMedia(post.mediaId);
  }
  await store.deletePostRecord(post.id);
  res.json({ ok: true });
});

/* ---------- Instagram (নতুন) ---------- */
router.post('/settings/ig-detect', async (req, res) => {
  const settings = await store.getSettings();
  if (!settings.fbToken) return res.status(400).json({ error: 'আগে Facebook পেজ সংযুক্ত করুন' });
  try {
    const ig = await detectInstagramAccount(settings.fbToken, settings.fbPageId);
    if (!ig) return res.json({ ok: false, message: 'এই পেজের সাথে যুক্ত কোনো Instagram Professional অ্যাকাউন্ট পাওয়া যায়নি, অথবা টোকেনে Instagram-এর অনুমতি নেই' });
    await store.saveSettings(ig);
    const sub = await ensurePageSubscription(settings.fbToken, settings.fbPageId);
    res.json({ ok: true, ...ig, pageFields: sub.fields, subscriptionChanged: sub.changed, subscriptionError: sub.error });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// UptimeRobot-এ যে গোপন লিংক বসাতে হবে (শিডিউল করা Instagram পোস্ট সময়মতো চালাতে)
router.get('/cron-info', async (req, res) => {
  const key = await store.getCronKey();
  res.json({ url: `${config.publicUrl}/cron/run?key=${key}` });
});

/* ---------- Email Logs ---------- */
router.get('/email-logs', async (req, res) => {
  res.json(await store.getEmailLogs());
});

/* ---------- Settings ---------- */
router.get('/settings', async (req, res) => {
  const s = await store.getSettings();
  res.json({
    fbPageId: s.fbPageId,
    fbAppId: s.fbAppId,
    waPhoneNumberId: s.waPhoneNumberId,
    waBusinessId: s.waBusinessId,
    waConfigId: s.waConfigId,
    waAppId: s.waAppId,
    sheetLink: s.sheetLink,
    faqSheetLink: s.faqSheetLink,
    aiProvider: s.aiProvider,
    aiProvider2: s.aiProvider2,
    aiProvider3: s.aiProvider3,
    aiModel: s.aiModel, aiModel2: s.aiModel2, aiModel3: s.aiModel3,
    aiBaseUrl: s.aiBaseUrl, aiBaseUrl2: s.aiBaseUrl2, aiBaseUrl3: s.aiBaseUrl3,
    postNotes: s.postNotes,
    commentAuto: s.commentAuto === 'on' ? 'on' : 'off',
    igUserId: s.igUserId, igUsername: s.igUsername,
    aiAutoReply: s.aiAutoReply,
    connected: s.connected,
    sheetStorageConfigured: !!config.sheetScriptUrl,
    emailConfigured: !!config.resendApiKey
  });
});

router.post('/settings', async (req, res) => {
  const updated = await store.saveSettings(req.body);
  res.json({
    connected: updated.connected,
    sheetSaved: updated.sheetSaved,
    sheetError: updated.sheetError || null
  });
});

/* ---------- Facebook অটো-কানেক্ট ---------- */
router.post('/settings/fb-auto', async (req, res) => {
  const { pageAccessToken, pageId, pageName, fbAppId } = req.body;
  if (!pageAccessToken || !fbAppId) {
    return res.status(400).json({ error: 'pageAccessToken ও fbAppId দুটোই দরকার' });
  }
  if (!config.fbAppSecret) {
    return res.status(500).json({ error: 'সার্ভারে FB_APP_SECRET সেট করা নেই — Render Environment-এ যোগ করুন' });
  }

  try {
    const params = new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: fbAppId,
      client_secret: config.fbAppSecret,
      fb_exchange_token: pageAccessToken
    });
    const r = await axios.get(`https://graph.facebook.com/v19.0/oauth/access_token?${params}`);
    const longLivedToken = r.data.access_token;

    await store.saveSettings({ fbToken: longLivedToken, fbPageId: pageId, fbAppId });
    // পেজের সাথে যুক্ত Instagram অ্যাকাউন্ট থাকলে নিজে থেকে খুঁজে সেভ করি (না পেলেও ফেসবুক কানেকশন ঠিকই থাকে)
    let ig = null;
    try {
      ig = await detectInstagramAccount(longLivedToken, pageId);
      if (ig) await store.saveSettings(ig);
    } catch (e) { console.warn('Instagram খোঁজা যায়নি:', e.message); }
    res.json({ ok: true, pageName, ig });
  } catch (err) {
    console.error('fb-auto error:', err.response?.data || err.message);
    res.status(400).json({ error: 'Facebook টোকেন এক্সচেঞ্জ ব্যর্থ হয়েছে' });
  }
});

/* ---------- WhatsApp Embedded Signup অটো-কানেক্ট ---------- */
router.post('/settings/wa-auto', async (req, res) => {
  const { code, phoneNumberId, wabaId, fbAppId } = req.body;
  if (!code || !fbAppId) {
    return res.status(400).json({ error: 'code ও fbAppId দুটোই দরকার' });
  }
  if (!config.waAppSecret) {
    return res.status(500).json({ error: 'সার্ভারে WA_APP_SECRET (বা FB_APP_SECRET) সেট করা নেই — Render Environment-এ যোগ করুন' });
  }

  try {
    const params = new URLSearchParams({
      client_id: fbAppId,
      client_secret: config.waAppSecret,
      code
    });
    const r = await axios.get(`https://graph.facebook.com/v19.0/oauth/access_token?${params}`);
    const accessToken = r.data.access_token;

    await store.saveSettings({
      waToken: accessToken,
      waPhoneNumberId: phoneNumberId || '',
      waBusinessId: wabaId || ''
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('wa-auto error:', err.response?.data || err.message);
    res.status(400).json({ error: 'WhatsApp টোকেন এক্সচেঞ্জ ব্যর্থ হয়েছে' });
  }
});

/* ---------- ই-কমার্স ওয়েবসাইট সংযোগ (নতুন) ---------- */
router.get('/shop/status', async (req, res) => {
  try { res.json(await shop.status()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/shop/connect', async (req, res) => {
  try { res.json(await shop.connect(req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/shop/sync', async (req, res) => {
  try { res.json((await shop.sync(true)) || (await shop.status())); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/shop/disconnect', async (req, res) => {
  try { await shop.disconnect(); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
