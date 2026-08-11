const express = require('express');
const router = express.Router();

const config = require('../config');
const store = require('../services/store');
const { getAIReplyWithFallback, getVisionReply, isVisionCapable } = require('../services/ai');
const { transcribeAudio, isWhisperCapable } = require('../services/speech');
const { getCombinedSheetContext, writeOrderToSheet, writeCustomerToSheet } = require('../services/sheets');
const { sendFacebookMessage, sendFacebookImage, getFacebookProfile, downloadMedia } = require('../services/facebook');
const { sendWhatsAppMessage, sendWhatsAppImage, getWhatsAppMediaBuffer } = require('../services/whatsapp');
const { sendOrderConfirmationEmail } = require('../services/email');

const businessInfo = `ডেলিভারি চার্জ: ৳৭০ (ঢাকা), ৳১৩০ (ঢাকার বাইরে)। কাজের সময়: সকাল ৯টা - রাত ১০টা।`;

async function withRetry(fn, retries = 1, delayMs = 1500) {
  try {
    return await fn();
  } catch (err) {
    if (retries <= 0) throw err;
    await new Promise(r => setTimeout(r, delayMs));
    return withRetry(fn, retries - 1, delayMs);
  }
}

// settings-এ প্রধান/ব্যাকআপ দুটো Key-এর মধ্যে যেটা নির্দিষ্ট কাজের (vision/voice) উপযোগী সেটা বেছে দেয়
function pickCapableKey(settings, capableCheck) {
  if (settings.aiKey && capableCheck(settings.aiProvider)) return { apiKey: settings.aiKey, provider: settings.aiProvider };
  if (settings.aiKey2 && capableCheck(settings.aiProvider2)) return { apiKey: settings.aiKey2, provider: settings.aiProvider2 };
  return null;
}

function buildConfirmationText(order) {
  const total = (order.price || 0) * (order.qty || 1);
  return `✅ আপনার অর্ডারটি কনফার্ম হয়েছে!\n\nঅর্ডার আইডি: ${order.id}\nপ্রোডাক্ট: ${order.product} x${order.qty}\nমোট মূল্য: ৳${total}\nঠিকানা: ${order.address || ''}\n\nধন্যবাদ আমাদের সাথে থাকার জন্য! 🙏`;
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
      const msg = event.message;
      if (!senderId || !msg) continue;
      try {
        const text = msg.text;
        const attachments = msg.attachments || [];
        const imageAttachment = attachments.find(a => a.type === 'image');
        const audioAttachment = attachments.find(a => a.type === 'audio');

        let imageBuffer = null, imageMime = null, audioBuffer = null;
        if (imageAttachment?.payload?.url) {
          imageBuffer = await downloadMedia(imageAttachment.payload.url);
          imageMime = 'image/jpeg';
        }
        if (audioAttachment?.payload?.url) {
          audioBuffer = await downloadMedia(audioAttachment.payload.url);
        }

        if (!text && !imageBuffer && !audioBuffer) continue;

        await handleIncomingMessage({ platform: 'facebook', platformId: senderId, text, imageBuffer, imageMime, audioBuffer });
      } catch (err) {
        console.error('Facebook webhook error (একটা মেসেজ প্রসেস করতে ব্যর্থ):', err.response?.data ? JSON.stringify(err.response.data) : err.message);
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
  if (!messages.length) return;

  const settings = await store.getSettings(); // মিডিয়া ডাউনলোডে token লাগবে

  for (const msg of messages) {
    const from = msg.from;
    const name = value?.contacts?.[0]?.profile?.name;
    let text = msg.text?.body;
    let imageBuffer = null, imageMime = null, audioBuffer = null;

    try {
      if (msg.type === 'image' && msg.image?.id && settings.waToken) {
        const media = await getWhatsAppMediaBuffer(msg.image.id, settings.waToken);
        imageBuffer = media.buffer; imageMime = media.mimeType;
      } else if (msg.type === 'audio' && msg.audio?.id && settings.waToken) {
        const media = await getWhatsAppMediaBuffer(msg.audio.id, settings.waToken);
        audioBuffer = media.buffer;
      }

      if (!from || (!text && !imageBuffer && !audioBuffer)) continue;

      await handleIncomingMessage({ platform: 'whatsapp', platformId: from, text, name, phone: from, imageBuffer, imageMime, audioBuffer });
    } catch (err) {
      console.error('WhatsApp webhook error (একটা মেসেজ প্রসেস করতে ব্যর্থ):', err.response?.data ? JSON.stringify(err.response.data) : err.message);
    }
  }
});

/* =============== SHARED HANDLER =============== */

async function handleIncomingMessage({ platform, platformId, text, name, phone, imageBuffer, imageMime, audioBuffer }) {
  const settings = await store.getSettings();
  const customer = store.findOrCreateCustomer({ platform, platformId, name, phone });

  // Facebook থেকে নাম ও প্রোফাইল ছবি টেনে আনি (WhatsApp-এ Meta প্রোফাইল ছবি দেয় না, এটা তাদের সীমাবদ্ধতা)
  if (platform === 'facebook' && settings.fbToken && (!customer.name || customer.name === 'অজানা কাস্টমার' || !customer.photoUrl)) {
    const profile = await getFacebookProfile(platformId, settings.fbToken);
    if (profile.name || profile.photoUrl) {
      store.updateCustomerContact(customer.id, { name: profile.name, photoUrl: profile.photoUrl });
    }
  }

  if (!customer.ai) return; // মানুষ নিজে হাতে চ্যাট করছেন (Customers ট্যাব থেকে AI বন্ধ করা)
  if (!settings.aiKey) {
    console.warn('AI API key সেট করা নেই — Settings থেকে বসান।');
    return;
  }

  const send = async (replyText, imgUrl) => {
    if (platform === 'facebook' && settings.fbToken) {
      await withRetry(() => sendFacebookMessage(platformId, replyText, settings.fbToken));
      if (imgUrl) {
        try { await withRetry(() => sendFacebookImage(platformId, imgUrl, settings.fbToken)); }
        catch (err) { console.error('ছবি পাঠাতে ব্যর্থ (Facebook):', err.message); }
      }
    } else if (platform === 'whatsapp' && settings.waToken && settings.waPhoneNumberId) {
      await withRetry(() => sendWhatsAppMessage(platformId, replyText, settings.waPhoneNumberId, settings.waToken));
      if (imgUrl) {
        try { await withRetry(() => sendWhatsAppImage(platformId, imgUrl, settings.waPhoneNumberId, settings.waToken)); }
        catch (err) { console.error('ছবি পাঠাতে ব্যর্থ (WhatsApp):', err.message); }
      }
    }
  };

  /* ---- ভয়েস মেসেজ হলে আগে টেক্সটে রূপান্তর করি ---- */
  if (!text && audioBuffer) {
    const whisperKey = pickCapableKey(settings, isWhisperCapable);
    if (!whisperKey) {
      await send('দুঃখিত, এই মুহূর্তে ভয়েস মেসেজ শোনা সম্ভব হচ্ছে না। একটু কষ্ট করে লিখে জানাবেন 🙏');
      return;
    }
    try {
      text = await transcribeAudio({ apiKey: whisperKey.apiKey, provider: whisperKey.provider, audioBuffer });
    } catch (err) {
      console.error('ভয়েস মেসেজ শোনা যায়নি:', err.message);
      await send('দুঃখিত, ভয়েস মেসেজটা বুঝতে সমস্যা হচ্ছে। একটু লিখে পাঠাবেন?');
      return;
    }
    if (!text || !text.trim()) {
      await send('দুঃখিত, ভয়েস মেসেজটা স্পষ্ট শোনা যায়নি। আরেকবার বলবেন বা লিখে পাঠাবেন?');
      return;
    }
  }

  /* ---- ছবি এলে (আর সাথে কোনো টেক্সট প্রশ্ন না থাকলে) প্রোডাক্ট মেলানোর চেষ্টা করি ---- */
  if (imageBuffer && !text) {
    await store.appendMessage(customer.id, 'user', '[ছবি পাঠিয়েছে]');

    const visionKey = pickCapableKey(settings, isVisionCapable);
    if (!visionKey) {
      const msgTxt = 'দুঃখিত, এই মুহূর্তে ছবি দেখে বলা সম্ভব হচ্ছে না। প্রোডাক্টের নাম লিখে জানালে সাহায্য করতে পারব 🙏';
      await store.appendMessage(customer.id, 'assistant', msgTxt);
      await send(msgTxt);
      return;
    }

    const sheetContext = await getCombinedSheetContext(settings.sheetLink, settings.faqSheetLink, '');
    try {
      const { reply } = await getVisionReply({
        apiKey: visionKey.apiKey, provider: visionKey.provider,
        imageBase64: imageBuffer.toString('base64'), mimeType: imageMime || 'image/jpeg',
        sheetContext, businessInfo
      });
      await store.appendMessage(customer.id, 'assistant', reply);
      await send(reply);
    } catch (err) {
      console.error('ছবি প্রসেস করতে ব্যর্থ:', err.message);
      const msgTxt = 'দুঃখিত, ছবিটা এই মুহূর্তে দেখা যাচ্ছে না। প্রোডাক্টের নাম লিখে জানাবেন?';
      await store.appendMessage(customer.id, 'assistant', msgTxt);
      await send(msgTxt);
    }
    return;
  }

  if (!text) return;

  await store.appendMessage(customer.id, 'user', text);

  const sheetContext = await getCombinedSheetContext(settings.sheetLink, settings.faqSheetLink, text);
  const fullHistory = await store.getConversation(customer.id);
  const history = fullHistory.slice(0, -1);

  const { reply, imageUrl, order } = await getAIReplyWithFallback({
    settings, customerMessage: text, history, sheetContext, businessInfo
  });

  await store.appendMessage(customer.id, 'assistant', reply);
  await send(reply, imageUrl);

  // কাস্টমার আগে অর্ডার কনফার্ম করে ফেলার পর, এখন শুধু একটা ইমেইল ঠিকানা পাঠিয়েছে —
  // সেটা সবচেয়ে সাম্প্রতিক (এখনো ইমেইলবিহীন) অর্ডারে জুড়ে দিয়ে কনফার্মেশন মেইল পাঠাই
  if (order && order.emailOnly && order.email) {
    const updatedOrder = store.attachEmailToLatestOrder(customer.id, order.email);
    if (updatedOrder) {
      const result = await sendOrderConfirmationEmail({ to: order.email, order: updatedOrder });
      store.addEmailLog({
        to: order.email,
        orderId: updatedOrder.id,
        customerName: updatedOrder.name,
        sent: result.sent,
        reason: result.reason || '',
        date: new Date().toLocaleString('bn-BD')
      });
    }
    return;
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
      email: order.email || '',
      product: order.product,
      qty: order.qty || 1,
      price: order.price || 0,
      source: platform === 'facebook' ? 'Messenger' : 'WhatsApp'
    });

    // দেদিকেটেড অর্ডার কনফার্মেশন মেসেজ — AI-এর রিপ্লাই ছাড়াও আলাদাভাবে পাঠানো হয়
    await send(buildConfirmationText(savedOrder));

    // কাস্টমার ইমেইল দিয়ে থাকলে (এবং Render-এ EMAIL_USER/EMAIL_PASS সেট থাকলে) ইমেইলেও কনফার্মেশন
    if (savedOrder.email) {
      const result = await sendOrderConfirmationEmail({ to: savedOrder.email, order: savedOrder });
      store.addEmailLog({
        to: savedOrder.email,
        orderId: savedOrder.id,
        customerName: savedOrder.name,
        sent: result.sent,
        reason: result.reason || '',
        date: new Date().toLocaleString('bn-BD')
      });
    }

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

    const sheetContext = await getCombinedSheetContext(settings.sheetLink, settings.faqSheetLink, message);
    const { reply } = await getAIReplyWithFallback({
      settings, customerMessage: message, history: [], sheetContext, businessInfo
    });

    res.json({ reply });
  } catch (err) {
    console.error('AI-reply webhook error:', err.message);
    res.status(500).json({ error: 'AI রিপ্লাই তৈরি করা যায়নি' });
  }
});

module.exports = router;
