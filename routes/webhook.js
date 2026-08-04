const express = require('express');
const router = express.Router();

const config = require('../config');
const store = require('../services/store');
const { getAIReply } = require('../services/ai');
const { getSheetContext } = require('../services/sheets');
const { sendFacebookMessage } = require('../services/facebook');
const { sendWhatsAppMessage } = require('../services/whatsapp');

const businessInfo = `ডেলিভারি চার্জ: ৳৭০ (ঢাকা), ৳১৩০ (ঢাকার বাইরে)। কাজের সময়: সকাল ৯টা - রাত ১০টা।`;

/* =============== FACEBOOK MESSENGER =============== */

router.get('/facebook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === config.webhookVerifyToken) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

router.post('/facebook', async (req, res) => {
  res.sendStatus(200);
  try {
    const entries = req.body.entry || [];
    for (const entry of entries) {
      const events = entry.messaging || [];
      for (const event of events) {
        const senderId = event.sender?.id;
        const text = event.message?.text;
        if (!senderId || !text) continue;
        await handleIncomingMessage({ platform: 'facebook', platformId: senderId, text });
      }
    }
  } catch (err) {
    console.error('Facebook webhook error:', err.message);
  }
});

/* =============== WHATSAPP CLOUD API =============== */

router.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === config.webhookVerifyToken) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

router.post('/whatsapp', async (req, res) => {
  res.sendStatus(200);
  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    const messages = value?.messages || [];
    for (const msg of messages) {
      const from = msg.from;
      const text = msg.text?.body;
      const name = value?.contacts?.[0]?.profile?.name;
      if (!from || !text) continue;
      await handleIncomingMessage({ platform: 'whatsapp', platformId: from, text, name, phone: from });
    }
  } catch (err) {
    console.error('WhatsApp webhook error:', err.message);
  }
});

/* =============== SHARED HANDLER =============== */

async function handleIncomingMessage({ platform, platformId, text, name, phone }) {
  const settings = store.getSettings();
  const customer = store.findOrCreateCustomer({ platform, platformId, name, phone });

  store.appendMessage(customer.id, 'user', text);

  if (!customer.ai) return;

  if (!settings.aiKey) {
    console.warn('AI API key সেট করা নেই — Settings থেকে বসান।');
    return;
  }

  const sheetContext = settings.sheetLink ? await getSheetContext(settings.sheetLink) : '';
  const history = store.getConversation(customer.id).slice(0, -1);

  const { reply, order } = await getAIReply({
    apiKey: settings.aiKey,
    provider: settings.aiProvider,
    customerMessage: text,
    history,
    sheetContext,
    businessInfo
  });

  store.appendMessage(customer.id, 'assistant', reply);

  if (platform === 'facebook' && settings.fbToken) {
    await sendFacebookMessage(platformId, reply, settings.fbToken);
  } else if (platform === 'whatsapp' && settings.waToken && settings.waPhoneNumberId) {
    await sendWhatsAppMessage(platformId, reply, settings.waPhoneNumberId, settings.waToken);
  }

  if (order && order.product) {
    store.createOrder({
      customerId: customer.id,
      name: customer.name,
      product: order.product,
      qty: order.qty || 1,
      price: order.price || 0,
      source: platform === 'facebook' ? 'Messenger' : 'WhatsApp'
    });
  }
}

/* =============== BAZAAR ADMIN (ই-কমার্স ওয়েবসাইট) থেকে আসা ওয়েবহুক =============== */
// এই দুটো লিংক SmartBiz অ্যাপের Settings ট্যাব থেকে কপি করে Bazaar Admin-এর
// "অর্ডার Webhook URL" ও "AI অটোমেশন Webhook URL" ঘরে বসাতে হবে।

router.post('/order', async (req, res) => {
  try {
    const order = store.createWebsiteOrder(req.body || {});
    res.json({ ok: true, orderId: order.id });
  } catch (err) {
    console.error('Order webhook error:', err.message);
    res.status(500).json({ error: 'অর্ডার সেভ করা যায়নি' });
  }
});

router.post('/ai-reply', async (req, res) => {
  try {
    const settings = store.getSettings();
    const message = (req.body?.message || req.body?.text || '').toString();

    if (!settings.aiAutoReply) {
      return res.json({ reply: '' });
    }
    if (!settings.aiKey) {
      return res.status(400).json({ error: 'AI API key সংযুক্ত নেই — SmartBiz Settings-এ বসান' });
    }
    if (!message.trim()) {
      return res.status(400).json({ error: 'message খালি' });
    }

    const sheetContext = settings.sheetLink ? await getSheetContext(settings.sheetLink) : '';
    const { reply } = await getAIReply({
      apiKey: settings.aiKey,
      provider: settings.aiProvider,
      customerMessage: message,
      history: [],
      sheetContext,
      businessInfo
    });

    res.json({ reply });
  } catch (err) {
    console.error('AI-reply webhook error:', err.message);
    res.status(500).json({ error: 'AI রিপ্লাই তৈরি করা যায়নি' });
  }
});

module.exports = router;
