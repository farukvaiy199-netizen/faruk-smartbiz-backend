const express = require('express');
const router = express.Router();
const axios = require('axios');

const config = require('../config');
const store = require('../services/store');
const { sendFacebookMessage } = require('../services/facebook');
const { sendWhatsAppMessage } = require('../services/whatsapp');
const { getOwnerChatReply } = require('../services/ai');
const { notifyOwner, getPublicKey } = require('../services/notify');
const { getSheetProducts } = require('../services/sheets');

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
  const settings = await store.getSettings();
  const threshold = settings.lowStockThreshold ?? 5;
  const stockEntries = await store.getStockList();
  res.json({
    lowStockCount: stockEntries.filter(e => e.qty <= threshold).length,
    todayRevenue: todayOrders.reduce((sum, o) => sum + (o.price * o.qty), 0),
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

  for (const c of customers) {
    try {
      if (c.platform === 'facebook' && settings.fbToken) {
        await sendFacebookMessage(c.platformId, message, settings.fbToken);
      } else if (c.platform === 'whatsapp' && settings.waToken && settings.waPhoneNumberId) {
        await sendWhatsAppMessage(c.platformId, message, settings.waPhoneNumberId, settings.waToken);
      } else {
        throw new Error('platform not connected');
      }
      success++;
    } catch (e) {
      failed++;
    }
  }

  const record = await store.addBroadcast({
    msg: message, total: customers.length, success, failed,
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

router.post('/ai-rules/chat', async (req, res) => {
  const imageData = typeof req.body.imageData === 'string' ? req.body.imageData : '';
  let message = (req.body.message || '').toString().trim().slice(0, 600);
  if (!message && !imageData) return res.status(400).json({ error: 'মেসেজ খালি' });
  if (!message) message = 'এই ছবিটা সংরক্ষণ করো।';

  const settings = await store.getSettings();
  if (!settings.aiKey) return res.status(400).json({ error: 'আগে Settings-এ AI Key সংযুক্ত করুন' });

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
    backup: settings.aiKey2 ? settings.aiProvider2 : null
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
    res.json({ ok: true, pageName });
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

module.exports = router;
