const express = require('express');
const router = express.Router();

const config = require('../config');
const store = require('../services/store');
const { getAIReply } = require('../services/ai');
const { getSheetContext, getCombinedSheetContext, writeOrderToSheet, writeCustomerToSheet } = require('../services/sheets');
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

// Meta webhook verification (Meta App Dashboard এ setup করার সময় একবার কল হয়)
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
  res.sendStatus(200); // Meta কে সাথে সাথে 200 ফেরত দিতে হয়, তারপর প্রসেস করি
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
        // একটা মেসেজে সমস্যা হলেও বাকি মেসেজগুলো যেন থেমে না যায়, তাই এখানেই ধরে ফেলি
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
    const from = msg.from; // ফোন নাম্বার
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

  // Facebook Messenger নিজে থেকে নাম দেয় না, তাই প্রথমবার মেসেজ এলে Graph API দিয়ে নাম টেনে আনি
  if (platform === 'facebook' && settings.fbToken && (!customer.name || customer.name === 'অজানা কাস্টমার')) {
    const fbName = await getFacebookProfile(platformId, settings.fbToken);
    if (fbName) store.updateCustomerContact(customer.id, { name: fbName });
  }

  await store.appendMessage(customer.id, 'user', text);

  // কাস্টমারের জন্য AI বন্ধ করা থাকলে (Customers ট্যাব থেকে) — মানুষ নিজে হাতে চ্যাট করছেন, AI চুপ থাকবে
  if (!customer.ai) return;

  if (!settings.aiKey) {
    console.warn('AI API key সেট করা নেই — Settings থেকে বসান।');
    return;
  }

  const sheetContext = await getCombinedSheetContext(settings.sheetLink, settings.faqSheetLink);
  const fullHistory = await store.getConversation(customer.id);
  const history = fullHistory.slice(0, -1); // শেষেরটা বাদ, ওইটাই এখনকার মেসেজ

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
        console.error('প্রোডাক্টের ছবি পাঠাতে ব্যর্থ (Facebook):', err.response ? JSON.stringify(err.response.data) : err.message);
      }
    }
  } else if (platform === 'whatsapp' && settings.waToken && settings.waPhoneNumberId) {
    await withRetry(() => sendWhatsAppMessage(platformId, reply, settings.waPhoneNumberId, settings.waToken));
    if (imageUrl) {
      try {
        await withRetry(() => sendWhatsAppImage(platformId, imageUrl, settings.waPhoneNumberId, settings.waToken));
      } catch (err) {
        console.error('প্রোডাক্টের ছবি পাঠাতে ব্যর্থ (WhatsApp):', err.response ? JSON.stringify(err.response.data) : err.message);
      }
    }
  }

  if (order && order.product) {
    // AI-এর কাছ থেকে পাওয়া নাম/ফোন থাকলে কাস্টমারের প্রোফাইলও আপডেট করে দিই,
    // যাতে Customers ট্যাবে আর "অজানা কাস্টমার" না দেখায়
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

    // Google Sheet Script (Render Environment Variable থেকে) কনফিগার করা থাকলে অর্ডার ও কাস্টমার শিটে পাঠিয়ে দিই
    if (config.sheetScriptUrl) {
      const updatedCustomer = store.getCustomers().find(c => c.id === customer.id) || customer;
      writeOrderToSheet({ scriptUrl: config.sheetScriptUrl, scriptToken: config.sheetScriptToken, order: savedOrder });
      writeCustomerToSheet({ scriptUrl: config.sheetScriptUrl, scriptToken: config.sheetScriptToken, customer: updatedCustomer });
    }
  }
}

/* =============== BAZAAR ADMIN (ই-কমার্স ওয়েবসাইট) থেকে আসা ওয়েবহুক =============== */
// এই দুটো লিংক SmartBiz অ্যাপের Settings ট্যাব থেকে কপি করে Bazaar Admin-এর
// "অর্ডার Webhook URL" ও "AI অটোমেশন Webhook URL" ঘরে বসাতে হবে।

// নতুন অর্ডার — Bazaar Admin প্রতিটা নতুন অর্ডারে এখানে POST করবে
router.post('/order', async (req, res) => {
  try {
    const order = store.createWebsiteOrder(req.body || {});
    res.json({ ok: true, orderId: order.id });
  } catch (err) {
    console.error('Order webhook error:', err.message);
    res.status(500).json({ error: 'অর্ডার সেভ করা যায়নি' });
  }
});

// AI অটো-রিপ্লাই — কাস্টমার Bazaar Admin-এর চ্যাটে মেসেজ পাঠালে এখানে POST হবে,
// আমরা সিঙ্ক্রোনাসভাবে { "reply": "..." } ফেরত পাঠাই যাতে Bazaar Admin সাথে সাথে দেখাতে পারে।
router.post('/ai-reply', async (req, res) => {
  try {
    const settings = await store.getSettings();
    const body = req.body || {};
    const message = (body.message || body.text || '').toString();

    // Bazaar Admin ঠিক কোন নামে নাম/নাম্বার পাঠায় তা নিশ্চিত না জানায়,
    // সাধারণ কয়েকটা সম্ভাব্য field name একসাথে চেক করছি — যেটা পাওয়া যায় সেটাই নেব
    const visitorName = body.name || body.customerName || body.visitorName || body.userName || '';
    const visitorPhone = body.phone || body.customerPhone || body.visitorPhone || body.mobile || body.number || '';

    // এখনো ডিবাগ করার প্রয়োজন হলে Render Logs-এ পুরো payload দেখা যাবে
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
      return res.json({ reply: '' }); // ড্যাশবোর্ডে AI টগল বন্ধ থাকলে চুপ থাকি, মানুষ নিজে রিপ্লাই দেবে
    }
    if (!settings.aiKey) {
      return res.status(400).json({ error: 'AI API key সংযুক্ত নেই — SmartBiz Settings-এ বসান' });
    }
    if (!message.trim()) {
      return res.status(400).json({ error: 'message খালি' });
    }

    const sheetContext = await getCombinedSheetContext(settings.sheetLink, settings.faqSheetLink);
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
