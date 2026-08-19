const express = require('express');
const router = express.Router();
const axios = require('axios');

const config = require('../config');
const store = require('../services/store');
const { sendFacebookMessage } = require('../services/facebook');
const { sendWhatsAppMessage } = require('../services/whatsapp');

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
  res.json({
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

router.patch('/orders/:id', async (req, res) => {
  const { status } = req.body;
  const valid = ['Pending', 'Processing', 'Delivered', 'Cancelled'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'অবৈধ status' });
  const order = await store.updateOrderStatus(req.params.id, status);
  if (!order) return res.status(404).json({ error: 'অর্ডার পাওয়া যায়নি' });
  res.json(order);
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
