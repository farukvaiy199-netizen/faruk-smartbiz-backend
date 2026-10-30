const express = require('express');
const router = express.Router();

const config = require('../config');
const store = require('../services/store');
const { getAIReplyWithFallback, getVisionReply, isVisionCapable } = require('../services/ai');
const { transcribeAudio, isWhisperCapable } = require('../services/speech');
const { getCombinedSheetContext, getProductStock, writeOrderToSheet, writeCustomerToSheet } = require('../services/sheets');
const { sendFacebookMessage, sendFacebookImage, getFacebookProfile, downloadMedia } = require('../services/facebook');
const { sendWhatsAppMessage, sendWhatsAppImage, getWhatsAppMediaBuffer } = require('../services/whatsapp');
const { sendOrderConfirmationEmail } = require('../services/email');
const { notifyOwner } = require('../services/notify');
const crypto = require('crypto');

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

function pickCapableKey(settings, capableCheck) {
  if (settings.aiKey && capableCheck(settings.aiProvider)) return { apiKey: settings.aiKey, provider: settings.aiProvider };
  if (settings.aiKey2 && capableCheck(settings.aiProvider2)) return { apiKey: settings.aiKey2, provider: settings.aiProvider2 };
  return null;
}

function buildConfirmationText(order) {
  const total = (order.price || 0) * (order.qty || 1);
  return `✅ আপনার অর্ডারটি কনফার্ম হয়েছে!\n\nঅর্ডার আইডি: ${order.id}\nপ্রোডাক্ট: ${order.product} x${order.qty}\nমোট মূল্য: ৳${total}\nঠিকানা: ${order.address || ''}\n\nধন্যবাদ আমাদের সাথে থাকার জন্য! 🙏`;
}

// নোটিফিকেশনে কাস্টমারের নাম দেখানোর জন্য — নাম জানা না থাকলে প্ল্যাটফর্ম + আইডির শেষ ৪ অক্ষর
function displayName(c) {
  if (c.name && c.name !== 'অজানা কাস্টমার') return c.name;
  const plat = c.platform === 'facebook' ? 'Messenger' : c.platform === 'whatsapp' ? 'WhatsApp' : 'কাস্টমার';
  return plat + ' ···' + String(c.platformId || c.id || '').slice(-4);
}

// Meta প্রতিটা ওয়েবহুক রিকোয়েস্টের সাথে App Secret দিয়ে বানানো একটা সই পাঠায় (X-Hub-Signature-256)।
// সেটা মিলিয়ে দেখলে ভুয়া রিকোয়েস্ট ধরা পড়ে। META_SIGNATURE_ENFORCE=true না থাকলে শুধু লগে সতর্কতা দেয়,
// রিকোয়েস্ট আটকায় না — যাতে App Secret ভুল থাকলে আসল মেসেজ হারিয়ে না যায়।
const signatureOkLogged = {};
function verifyMeta(secret, label) {
  return (req, res, next) => {
    if (!secret) {
      if (!signatureOkLogged[label + ':nosecret']) {
        console.warn(`⚠️ ${label}: App Secret সেট নেই, সই যাচাই বাদ দেওয়া হচ্ছে`);
        signatureOkLogged[label + ':nosecret'] = true;
      }
      return next();
    }
    const sig = req.get('x-hub-signature-256') || '';
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody || Buffer.from('')).digest('hex');
    let ok = false;
    try {
      ok = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch (e) { ok = false; }

    if (ok) {
      if (!signatureOkLogged[label]) {
        console.log(`✅ ${label}: Meta-র সই মিলেছে`);
        signatureOkLogged[label] = true;
      }
      return next();
    }
    if (config.metaSignatureEnforce) {
      console.warn(`🚫 ${label}: সই মেলেনি, রিকোয়েস্ট বাদ দেওয়া হলো`);
      return res.sendStatus(403);
    }
    console.warn(`⚠️ ${label}: সই মেলেনি (এখন শুধু সতর্কতা, রিকোয়েস্ট চলছে) — App Secret ঠিক আছে কিনা দেখুন`);
    return next();
  };
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

router.post('/facebook', verifyMeta(config.fbAppSecret, 'Facebook'), async (req, res) => {
  res.sendStatus(200);
  const entries = req.body.entry || [];
  for (const entry of entries) {
    const events = entry.messaging || [];
    for (const event of events) {
      const senderId = event.sender?.id;
      const msg = event.message;
      if (!senderId || !msg) continue;
      if (msg.is_echo) continue; // পেজ নিজে যে মেসেজ পাঠিয়েছে তার প্রতিধ্বনি — কাস্টমার না
      try {
        const text = msg.text;
        const attachments = msg.attachments || [];
        // স্টিকার/লাইক বাটনও image হিসেবে আসে — এগুলো আসল ছবি না, তাই বাদ
        const imageAttachment = attachments.find(a => a.type === 'image' && !(a.payload && a.payload.sticker_id));
        const audioAttachment = attachments.find(a => a.type === 'audio');

        let imageBuffer = null, imageMime = null, audioBuffer = null;
        if (imageAttachment?.payload?.url) {
          imageBuffer = await downloadMedia(imageAttachment.payload.url);
          imageMime = 'image/jpeg';
        }
        if (audioAttachment?.payload?.url) {
          audioBuffer = await downloadMedia(audioAttachment.payload.url);
        }

        if (!text && !imageBuffer && !audioBuffer) {
          // বোঝার মতো কিছু নেই (স্টিকার, লাইক, ভিডিও ইত্যাদি) — তবু কাস্টমারকে তালিকায় রাখি
          await ensureCustomer({ platform: 'facebook', platformId: senderId });
          continue;
        }

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

router.post('/whatsapp', verifyMeta(config.waAppSecret, 'WhatsApp'), async (req, res) => {
  res.sendStatus(200);
  const value = req.body.entry?.[0]?.changes?.[0]?.value;
  const messages = value?.messages || [];
  if (!messages.length) return;

  const settings = await store.getSettings();

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

      if (!from) continue;
      if (!text && !imageBuffer && !audioBuffer) {
        await ensureCustomer({ platform: 'whatsapp', platformId: from, name, phone: from });
        continue;
      }

      await handleIncomingMessage({ platform: 'whatsapp', platformId: from, text, name, phone: from, imageBuffer, imageMime, audioBuffer });
    } catch (err) {
      console.error('WhatsApp webhook error (একটা মেসেজ প্রসেস করতে ব্যর্থ):', err.response?.data ? JSON.stringify(err.response.data) : err.message);
    }
  }
});

/* =============== SHARED HANDLER =============== */

// যেকোনো ধরনের মেসেজ (স্টিকার, লাইক, ভিডিও ইত্যাদিও) এলে কাস্টমারকে তালিকায় যোগ করি,
// আর Facebook হলে নাম/ছবি আনার চেষ্টা করি
async function ensureCustomer({ platform, platformId, name, phone }) {
  const settings = await store.getSettings();
  const customer = await store.findOrCreateCustomer({ platform, platformId, name, phone });

  if (platform === 'facebook' && settings.fbToken && (!customer.name || customer.name === 'অজানা কাস্টমার' || !customer.photoUrl)) {
    const profile = await getFacebookProfile(platformId, settings.fbToken);
    if (profile.name || profile.photoUrl) {
      await store.updateCustomerContact(customer.id, { name: profile.name, photoUrl: profile.photoUrl });
    }
  }
  return { settings, customer };
}

async function handleIncomingMessage({ platform, platformId, text, name, phone, imageBuffer, imageMime, audioBuffer }) {
  const { settings, customer } = await ensureCustomer({ platform, platformId, name, phone });

  if (!customer.ai) return;
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
  const ownerRules = (await store.getAiRules()).map(r => r.text);
  const ownerImages = await store.getAiImages();
  const stockList = (await store.getStockList()).map(e => ({ name: e.name, qty: e.qty }));

  const { reply, imageUrl, imageId, order, handoff } = await getAIReplyWithFallback({
    settings, customerMessage: text, history, sheetContext, businessInfo, ownerRules, ownerImages, stockList
  });

  // মালিকের আপলোড করা ছবি থাকলে সেটাকেই অগ্রাধিকার; না থাকলে শিটের ছবির লিংক
  let finalImageUrl = imageUrl;
  if (imageId && ownerImages.some(i => i.id === imageId)) {
    finalImageUrl = `${config.publicUrl}/media/${imageId}`;
  }

  await store.appendMessage(customer.id, 'assistant', reply);
  await send(reply, finalImageUrl);

  // AI আটকে গেছে বা কাস্টমার রাগ করছে — মালিককে পুশ পাঠাই (AI চালুই থাকে), কাস্টমারের পাশে লাল ট্যাগ বসে
  if (handoff && !customer.needsHuman) {
    await store.setNeedsHuman(customer.id, handoff);
    await notifyOwner({
      type: 'handoff',
      title: `🙋 ${displayName(customer)} আপনার সাথে কথা বলতে চান`,
      body: `${handoff} — "${String(text).slice(0, 80)}"`
    });
  }

  if (order && order.emailOnly && order.email) {
    const updatedOrder = await store.attachEmailToLatestOrder(customer.id, order.email);
    if (updatedOrder) {
      const result = await sendOrderConfirmationEmail({ to: order.email, order: updatedOrder });
      await store.addEmailLog({
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
    const recentOrders = await store.getOrdersByCustomer(customer.id);
    const fifteenMinAgo = Date.now() - 15 * 60 * 1000;
    const duplicate = recentOrders.find(o =>
      o.product === order.product && new Date(o.createdAt).getTime() > fifteenMinAgo
    );
    if (duplicate) {
      console.warn(`ডুপ্লিকেট অর্ডার ঠেকানো হলো: ${customer.id} — ${order.product}`);
      return;
    }

    const wantQty = Number(order.qty) || 1;

    // স্টক: আগে অ্যাপের স্টক পেজের সংখ্যা দেখি; সেখানে না থাকলে শিটের Stock কলাম
    const stockEntry = await store.findStockEntry(order.product);
    let reservedStock = null;
    if (stockEntry) {
      const dec = await store.decrementStock(stockEntry.name, wantQty);
      if (!dec.ok) {
        const outMsg = dec.qty > 0
          ? `দুঃখিত, "${order.product}" এখন মাত্র ${dec.qty}টি আছে। কম পরিমাণে নিতে চাইলে জানান।`
          : `দুঃখিত, "${order.product}" এই মুহূর্তে স্টকে নেই। অন্য কোনো প্রোডাক্ট দেখতে চান?`;
        await store.appendMessage(customer.id, 'assistant', outMsg);
        await send(outMsg);
        return;
      }
      reservedStock = { name: stockEntry.name, qty: dec.qty };
    } else {
      const stock = await getProductStock(settings.sheetLink, order.product);
      if (stock !== null && stock <= 0) {
        const outOfStockMsg = `দুঃখিত, "${order.product}" এই মুহূর্তে স্টকে নেই। অন্য কোনো প্রোডাক্ট দেখতে চান?`;
        await store.appendMessage(customer.id, 'assistant', outOfStockMsg);
        await send(outOfStockMsg);
        return;
      }
    }

    if (order.name || order.phone) {
      await store.updateCustomerContact(customer.id, { name: order.name, phone: order.phone });
    }
    let savedOrder;
    try {
      savedOrder = await store.createOrder({
        customerId: customer.id,
        name: order.name || customer.name,
        phone: order.phone || customer.phone || '',
        address: order.address || '',
        email: order.email || '',
        product: order.product,
        qty: wantQty,
        price: order.price || 0,
        source: platform === 'facebook' ? 'Messenger' : 'WhatsApp',
        stockItem: reservedStock ? reservedStock.name : ''
      });
    } catch (err) {
      // অর্ডার সেভ না হলে আটকে রাখা স্টক ফেরত দিই
      if (reservedStock) await store.incrementStock(reservedStock.name, wantQty);
      throw err;
    }

    // মালিককে জানাই: নতুন অর্ডার, আর স্টক কমে গেলে আলাদা সতর্কতা
    await notifyOwner({
      type: 'order',
      title: `🛒 নতুন অর্ডার ${savedOrder.id}`,
      body: `${savedOrder.name} · ${savedOrder.product} x${savedOrder.qty} · ৳${(savedOrder.price || 0) * (savedOrder.qty || 1)}`
    });
    if (reservedStock && reservedStock.qty <= (settings.lowStockThreshold ?? 5)) {
      await notifyOwner({
        type: 'stock',
        title: reservedStock.qty <= 0 ? `❌ স্টক শেষ: ${reservedStock.name}` : `⚠️ স্টক কম: ${reservedStock.name}`,
        body: reservedStock.qty <= 0 ? 'আর কোনো পিস নেই' : `মাত্র ${reservedStock.qty}টি বাকি`
      });
    }

    const confirmationText = buildConfirmationText(savedOrder);
    await store.appendMessage(customer.id, 'assistant', confirmationText);
    await send(confirmationText);

    if (savedOrder.email) {
      const result = await sendOrderConfirmationEmail({ to: savedOrder.email, order: savedOrder });
      await store.addEmailLog({
        to: savedOrder.email,
        orderId: savedOrder.id,
        customerName: savedOrder.name,
        sent: result.sent,
        reason: result.reason || '',
        date: new Date().toLocaleString('bn-BD')
      });
    }

    if (config.sheetScriptUrl) {
      const customers = await store.getCustomers();
      const updatedCustomer = customers.find(c => c.id === customer.id) || customer;
      writeOrderToSheet({ scriptUrl: config.sheetScriptUrl, scriptToken: config.sheetScriptToken, order: savedOrder });
      writeCustomerToSheet({ scriptUrl: config.sheetScriptUrl, scriptToken: config.sheetScriptToken, customer: updatedCustomer });
    }
  }
}

/* =============== BAZAAR ADMIN (ই-কমার্স ওয়েবসাইট) থেকে আসা ওয়েবহুক =============== */

router.post('/order', async (req, res) => {
  try {
    const order = await store.createWebsiteOrder(req.body || {});
    await notifyOwner({
      type: 'order',
      title: `🛒 ওয়েবসাইটে নতুন অর্ডার ${order.id}`,
      body: `${order.name} · ${order.product} · ৳${order.price || 0}`
    });
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

    if (visitorPhone) {
      const customer = await store.findOrCreateCustomer({
        platform: 'website',
        platformId: visitorPhone,
        name: visitorName || 'ওয়েবসাইট কাস্টমার',
        phone: visitorPhone
      });
      if (visitorName) await store.updateCustomerContact(customer.id, { name: visitorName, phone: visitorPhone });
      if (config.sheetScriptUrl) {
        const customers = await store.getCustomers();
        const updatedCustomer = customers.find(c => c.id === customer.id) || customer;
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

    const rawHistory = Array.isArray(body.history) ? body.history : [];
    let history = rawHistory
      .filter(m => m && (m.from === 'customer' || m.from === 'ai' || m.from === 'admin') && m.text)
      .map(m => ({ role: m.from === 'customer' ? 'user' : 'assistant', text: m.text }))
      .slice(-16);
    if (history.length && history[history.length - 1].role === 'user' && history[history.length - 1].text === message) {
      history = history.slice(0, -1);
    }

    const sheetContext = await getCombinedSheetContext(settings.sheetLink, settings.faqSheetLink, message);
    const ownerRules = (await store.getAiRules()).map(r => r.text);
    const stockList = (await store.getStockList()).map(e => ({ name: e.name, qty: e.qty }));
    const { reply, handoff } = await getAIReplyWithFallback({
      settings, customerMessage: message, history, sheetContext, businessInfo, ownerRules, stockList
    });
    if (handoff) {
      await notifyOwner({
        type: 'handoff',
        title: `🙋 ওয়েবসাইট চ্যাটে ${visitorName || body.customerEmail || 'একজন কাস্টমার'} সাহায্য চান`,
        body: `${handoff} — "${message.slice(0, 80)}"`
      });
    }

    res.json({ reply });
  } catch (err) {
    console.error('AI-reply webhook error:', err.response?.data ? JSON.stringify(err.response.data) : err.message);
    res.status(500).json({ error: 'AI রিপ্লাই তৈরি করা যায়নি' });
  }
});

module.exports = router;
