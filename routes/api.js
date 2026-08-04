const express = require('express');
const router = express.Router();
const axios = require('axios');

const config = require('../config');
const store = require('../services/store');
const { sendFacebookMessage } = require('../services/facebook');
const { sendWhatsAppMessage } = require('../services/whatsapp');

/* ---------- Dashboard summary ---------- */
router.get('/dashboard/summary', (req, res) => {
  const orders = store.getOrders();
  const customers = store.getCustomers();
  const today = new Date().toDateString();
  const todayOrders = orders.filter(o => new Date(o.createdAt).toDateString() === today);
  res.json({
    todayRevenue: todayOrders.reduce((sum, o) => sum + (o.price * o.qty), 0),
    todayOrders: todayOrders.length,
    pendingCount: orders.filter(o => o.status === 'Pending').length,
    totalCustomers: customers.length
  });
});

/* ---------- Orders ---------- */
router.get('/orders', (req, res) => {
  res.json(store.getOrders());
});

router.patch('/orders/:id', (req, res) => {
  const { status } = req.body;
  const valid = ['Pending', 'Processing', 'Delivered', 'Cancelled'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'অবৈধ status' });
  const order = store.updateOrderStatus(req.params.id, status);
  if (!order) return res.status(404).json({ error: 'অর্ডার পাওয়া যায়নি' });
  res.json(order);
});

/* ---------- Customers ---------- */
router.get('/customers', (req, res) => {
  res.json(store.getCustomers());
});

router.patch('/customers/:id/ai', (req, res) => {
  const { ai } = req.body;
  const customer = store.setCustomerAI(req.params.id, !!ai);
  if (!customer) return res.status(404).json({ error: 'কাস্টমার পাওয়া যায়নি' });
  res.json(customer);
});

/* ---------- Broadcast ---------- */
router.post('/broadcast', async (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'মেসেজ খালি' });

  const settings = store.getSettings();
  const customers = store.getCustomers();
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

  const record = store.addBroadcast({
    msg: message, total: customers.length, success, failed,
    date: new Date().toLocaleDateString('bn-BD')
  });
  res.json(record);
});

router.get('/broadcast', (req, res) => {
  res.json(store.getBroadcasts());
});

/* ---------- Settings ---------- */
// টোকেন/কী কখনো ফেরত পাঠানো হয় না (শুধু connected true/false), নিরাপত্তার জন্য
router.get('/settings', (req, res) => {
  const s = store.getSettings();
  res.json({
    fbPageId: s.fbPageId,
    fbAppId: s.fbAppId,
    waPhoneNumberId: s.waPhoneNumberId,
    sheetLink: s.sheetLink,
    aiProvider: s.aiProvider,
    aiAutoReply: s.aiAutoReply,
    connected: s.connected
  });
});

router.post('/settings', (req, res) => {
  const updated = store.saveSettings(req.body);
  res.json({
    connected: updated.connected
  });
});

/* ---------- Facebook অটো-কানেক্ট (নতুন ফিচার) ---------- */
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

    store.saveSettings({ fbToken: longLivedToken, fbPageId: pageId, fbAppId });
    res.json({ ok: true, pageName });
  } catch (err) {
    console.error('fb-auto error:', err.response?.data || err.message);
    res.status(400).json({ error: 'Facebook টোকেন এক্সচেঞ্জ ব্যর্থ হয়েছে' });
  }
});

module.exports = router;
