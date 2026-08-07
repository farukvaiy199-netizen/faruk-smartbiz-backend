const express = require('express');
const router = express.Router();

const config = require('../config');
const store = require('../services/store');
const { getAIReply } = require('../services/ai');
const { getSheetContext, writeOrderToSheet, writeCustomerToSheet } = require('../services/sheets');
const { sendFacebookMessage, sendFacebookImage, getFacebookProfile } = require('../services/facebook');
const { sendWhatsAppMessage, sendWhatsAppImage } = require('../services/whatsapp');

const businessInfo = `ডেলিভারি চার্জ: ৳৭০ (ঢাকা), ৳১৩০ (ঢাকার বাইরে)। কাজের সময়: সকাল ৯টা - রাত ১০টা।`;

// সাময়িক এরর/রেট-লিমিট হলে সাথে সাথে হাল ছেড়ে না দিয়ে একবার আবার চেষ্টা করে
async function withRetry(fn, retries = 1, delayMs = 1500) {
  try {
    return await fn();
  } catch (err) {
    if (retries <= 0) throw err;
    await new Promise(r => setTimeout(r, delayMs));
    return withRetry(fn, retries - 1, delayMs);
  }
}

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
  const entries = req.body.entry || [];
  for (const entry of entries) {
    const events = entry.messaging || [];
    for (const event of events) {
      const senderId = event.sender?.id;
      const text = event.message?.text;
      if (!senderId || !text) continue;
      try {
        await handleIncomingMessage({ platform: 'facebook', platformId: senderId, text });
      } catch (err) {
        console.error('Facebook webhook error (একটা মেসেজ প্রসেস করতে ব্যর্থ):', err.message);
      }
    }
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
  const value = req.body.entry?.[0]?.changes?.[0]?.value;
  const messages = value?.messages || [];
  for (const msg of messages) {
    const from = msg.from;
    const text = msg.text?.body;
    const name = value?.contacts?.[0]?.profile?.name;
    if (!from || !text) continue;
    try {
      await handleIncomingMessage({ platform: 'whatsapp', platformId: from, text, name, phone: from });
    } catch (err) {
      console.error('WhatsApp webhook error (একটা মেসেজ প্রসেস করতে ব্যর্থ):', err.message);
    }
  }
});

/* =============== SHARED HANDLER =============== */

async function handleIncomingMessage({ platform, platformId, text, name, phone }) {
  const settings = await store.getSettings();
  const customer = store.findOrCreateCustomer({ platform, platformId, name, phone });

  if (platform === 'facebook' && settings.fbToken && (!customer.name || customer.name === 'অজানা কাস্টমার')) {
    const fbName = await getFacebookProfile(platformId, settings.fbToken);
    if (fbName) store.updateCustomerContact(customer.id, { name: fbName });
  }

  await store.appendMessage(customer.id, 'user', text);

  if (!customer.ai) return;

  if (!settings.aiKey) {
    console.warn('AI API key সেট করা নেই — Settings থেকে বসান।');
    return;
  }

  const sheetContext = settings.sheetLink ? await getSheetContext(settings.sheetLink) : '';
  const fullHistory = await store.getConversation(customer.id);
  const history = fullHistory.slice(0, -1);

  const { reply, imageUrl, order } = await withRetry(() => getAIReply({
    apiKey: settings.aiKey,
    provider: settings.aiProvider,
    customerMessage: text,
    history,
    sheetContext,
    businessInfo
  }));

  await store.appendMessage(customer.id, 'assistant', reply);

  if (platform === 'facebook' && settings.fbToken) {
    await withRetry(() => sendFacebookMessage(platformId, reply, settings.fbToken));
    if (imageUrl) {
      try {
        await withRetry(() => sendFacebookImage(platformId, imageUrl, settings.fbToken));
      } catch (err) {
        console.error('প্রোডাক্টের ছবি পাঠাতে ব্যর্থ (Facebook):', err.message);
      }
    }
  } else if (platform === 'whatsapp' && settings.waToken && settings.waPhoneNumberId) {
    await withRetry(() => sendWhatsAppMessage(platformId, reply, settings.waPhoneNumberId, settings.waToken));
    if (imageUrl) {
      try {
        await withRetry(() => sendWhatsAppImage(platformId, imageUrl, settings.waPhoneNumberId, settings.waToken));
      } catch (err) {
        console.error('প্রোডাক্টের ছবি পাঠাতে ব্যর্থ (WhatsApp):', err.message);
      }
    }
  }

  if (order && order.product) {
    if (order.name || order.phone) {
      store.updateCustomerContact(customer.id, { name: order.name, phone: order.phone });
    }
    const savedOrder = store.createOrder({
      customerId: customer.id,
      name: order.name || customer.name,
      phone: order.phone || customer.phone || '',
      address: order.address || '',
      product: order.product,
      qty: order.qty || 1,
      price: order.price || 0,
      source: platform === 'facebook' ? 'Messenger' : 'WhatsApp'
    });

    if (config.sheetScriptUrl) {
      const updatedCustomer = store.getCustomers().find(c => c.id === customer.id) || customer;
      writeOrderToSheet({ scriptUrl: config.sheetScriptUrl, scriptToken: config.sheetScriptToken, order: savedOrder });
      writeCustomerToSheet({ scriptUrl: config.sheetScriptUrl, scriptToken: config.sheetScriptToken, customer: updatedCustomer });
    }
  }
}

/* =============== BAZAAR ADMIN (ই-কমার্স ওয়েবসাইট) থেকে আসা ওয়েবহুক =============== */

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
    const settings = await store.getSettings();
    const body = req.body || {};
    const message = (body.message || body.text || '').toString();

    const visitorName = body.name || body.customerName || body.visitorName || body.userName || '';
    const visitorPhone = body.phone || body.customerPhone || body.visitorPhone || body.mobile || body.number || '';

    console.log('ai-reply থেকে পাওয়া ডেটা:', JSON.stringify(body));

    if (visitorPhone) {
      const customer = store.findOrCreateCustomer({
        platform: 'website',
        platformId: visitorPhone,
        name: visitorName || 'ওয়েবসাইট কাস্টমার',
        phone: visitorPhone
      });
      if (visitorName) store.updateCustomerContact(customer.id, { name: visitorName, phone: visitorPhone });
      if (config.sheetScriptUrl) {
        const updatedCustomer = store.getCustomers().find(c => c.id === customer.id) || customer;
        writeCustomerToSheet({ scriptUrl: config.sheetScriptUrl, scriptToken: config.sheetScriptToken, customer: updatedCustomer });
      }
    }

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
