const express = require('express');
const router = express.Router();

const config = require('../config');
const store = require('../services/store');
const { getAIReplyWithFallback, getVisionReply, isVisionCapable, getSlots } = require('../services/ai');
const { transcribeAudio, isWhisperCapable } = require('../services/speech');
const { getCombinedSheetContext, getProductStock, writeOrderToSheet, writeCustomerToSheet } = require('../services/sheets');
const { sendFacebookMessage, sendFacebookImage, getFacebookProfile, downloadMedia } = require('../services/facebook');
const { sendWhatsAppMessage, sendWhatsAppImage, getWhatsAppMediaBuffer } = require('../services/whatsapp');
const emailSvc = require('../services/email');
const { sendOrderConfirmationEmail } = emailSvc;
const { notifyOwner } = require('../services/notify');
const { sendInstagramMessage, sendInstagramImage, getInstagramProfile } = require('../services/instagram');
const crypto = require('crypto');
const axios = require('axios');
const shop = require('../services/shop');
const delivery = require('../services/delivery');
const assistant = require('../services/assistant');
const { summarizeCustomerMemory } = require('../services/ai');
const comments = require('../services/comments');
const telegram = require('../services/telegram');
const tiktok = require('../services/tiktok');
const crm = require('../services/crm');
const payments = require('../services/payments');
const engage = require('../services/engage');
const chatOrder = require('./chatOrder');

// ডেলিভারি চার্জ/COD নিয়ম এখানে লেখা নেই — ওয়েবসাইটের সেটিংস থেকে লাইভ আসে (shop.getAiContext)
const businessInfo = `কাজের সময়: সকাল ৯টা - রাত ১০টা। ডেলিভারি চার্জ ও পেমেন্টের নিয়ম শুধু ওয়েবসাইটের তথ্য অনুযায়ী বলবে।`;

// ওয়েবসাইট সংযুক্ত থাকলে প্রোডাক্টের তালিকা ওয়েবসাইট থেকেই আসে (শিটের পুরনো তালিকা নয়); শিটের FAQ আগের মতোই কাজ করে
async function getSheetCtx(settings, text) {
  const websiteOnly = await shop.usesWebsiteProducts();
  try {
    return await getCombinedSheetContext(websiteOnly ? '' : settings.sheetLink, settings.faqSheetLink, text);
  } catch (err) {
    console.error('শিট তথ্য আনা যায়নি:', err.message);
    return '';
  }
}

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
  const slot = getSlots(settings).find(sl => capableCheck(sl.provider));
  return slot ? { apiKey: slot.apiKey, provider: slot.provider } : null;
}

function buildConfirmationText(order) {
  const sub = (order.price || 0) * (order.qty || 1);
  const ship = Number(order.shipping) || 0;
  const payLabel = order.payment === 'bkash' ? 'বিকাশ (অগ্রিম)' : order.payment === 'nagad' ? 'নগদ (অগ্রিম)' : order.payment === 'cod' ? 'ক্যাশ অন ডেলিভারি' : '';
  const lines = [
    '✅ আপনার অর্ডারটি কনফার্ম হয়েছে!', '',
    `অর্ডার আইডি: ${order.id}`,
    `প্রোডাক্ট: ${order.product} x${order.qty}`,
    `পণ্যের দাম: ৳${sub}`
  ];
  if (ship || order.payment) lines.push(`ডেলিভারি চার্জ: ৳${ship}`, `মোট পরিশোধযোগ্য: ৳${sub + ship}`);
  if (payLabel) lines.push(`পেমেন্ট: ${payLabel}`);
  if (order.district) lines.push(`জেলা: ${order.district}`);
  lines.push(`ঠিকানা: ${order.address || ''}`, '', 'ধন্যবাদ আমাদের সাথে থাকার জন্য! 🙏');
  return lines.join('\n');
}

// নোটিফিকেশনে কাস্টমারের নাম দেখানোর জন্য — নাম জানা না থাকলে প্ল্যাটফর্ম + আইডির শেষ ৪ অক্ষর
function displayName(c) {
  if (c.name && c.name !== 'অজানা কাস্টমার') return c.name;
  const plat = c.platform === 'facebook' ? 'Messenger' : c.platform === 'whatsapp' ? 'WhatsApp' : c.platform === 'instagram' ? 'Instagram' : 'কাস্টমার';
  return plat + ' ···' + String(c.platformId || c.id || '').slice(-4);
}

// Meta প্রতিটা ওয়েবহুক রিকোয়েস্টের সাথে App Secret দিয়ে বানানো একটা সই পাঠায় (X-Hub-Signature-256)।
// সেটা মিলিয়ে দেখলে ভুয়া রিকোয়েস্ট ধরা পড়ে। META_SIGNATURE_ENFORCE=true না থাকলে শুধু লগে সতর্কতা দেয়,
// রিকোয়েস্ট আটকায় না — যাতে App Secret ভুল থাকলে আসল মেসেজ হারিয়ে না যায়।
const signatureOkLogged = {};
function verifyMeta(secretOrList, label) {
  const secrets = (Array.isArray(secretOrList) ? secretOrList : [secretOrList]).filter(Boolean);
  return (req, res, next) => {
    if (!secrets.length) {
      if (!signatureOkLogged[label + ':nosecret']) {
        console.warn(`⚠️ ${label}: App Secret সেট নেই, সই যাচাই বাদ দেওয়া হচ্ছে`);
        signatureOkLogged[label + ':nosecret'] = true;
      }
      return next();
    }
    const sig = req.get('x-hub-signature-256') || '';
    const raw = req.rawBody || Buffer.from('');
    let ok = false;
    for (const secret of secrets) {
      const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
      try {
        if (sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) { ok = true; break; }
      } catch (e) { /* পরের secret চেষ্টা */ }
    }

    if (ok) {
      req.sigOk = true; // মালিক-সহকারী শুধু এমন রিকোয়েস্টেই চালু হয় যার সই সত্যিই মিলেছে
      if (!signatureOkLogged[label]) {
        console.log(`✅ ${label}: Meta-র সই মিলেছে`);
        signatureOkLogged[label] = true;
      }
      return next();
    }
    if (config.metaSignatureEnforce) {
      console.warn(`🚫 ${label}: সই মেলেনি, রিকোয়েস্ট বাদ দেওয়া হলো${label === 'Instagram' ? ' — Render-এ IG_APP_SECRET (Instagram app secret) বসিয়ে দেখুন' : ''}`);
      return res.sendStatus(403);
    }
    console.warn(`⚠️ ${label}: সই মেলেনি (এখন শুধু সতর্কতা, রিকোয়েস্ট চলছে) — App Secret ঠিক আছে কিনা দেখুন`);
    return next();
  };
}


/* =============== প্রোডাক্ট কার্ড (ছবি + "এটি নিতে চাই" / "বিস্তারিত" বাটন) ও বাটন-চাপা (postback) =============== */
const lastCardAt = new Map(); // customerId|productId → সময়; একই পণ্যের কার্ড বারবার না পাঠানোর জন্য
async function sendProductCards(platform, platformId, settings, cards) {
  cards = (cards || []).filter(Boolean);
  if (!cards.length) return false;
  if (platform === 'facebook' || platform === 'instagram') {
    if (!settings.fbToken) return false;
    const elements = cards.map(card => {
      const el = {
        title: String(card.name).slice(0, 80),
        subtitle: ('দাম ৳' + card.price + (card.sku ? ' · কোড ' + card.sku : '')).slice(0, 80),
        buttons: [
          { type: 'postback', title: 'এটি নিতে চাই', payload: 'ORDER:' + card.id },
          { type: 'postback', title: 'বিস্তারিত', payload: 'INFO:' + card.id }
        ]
      };
      if (card.image) el.image_url = card.image;
      return el;
    });
    // Instagram-Login টোকেন (IG…) হলে graph.instagram.com, নইলে পেজ টোকেনে graph.facebook.com
    const host = platform === 'instagram' && /^IG/.test(String(settings.fbToken)) ? 'https://graph.instagram.com/v21.0' : 'https://graph.facebook.com/v21.0';
    await axios.post(host + '/me/messages', {
      recipient: { id: platformId }, messaging_type: 'RESPONSE',
      message: { attachment: { type: 'template', payload: { template_type: 'generic', elements } } }
    }, { params: { access_token: settings.fbToken }, timeout: 15000 });
    return true;
  }
  if (platform === 'telegram') {
    if (!settings.tgToken) return false;
    for (const c of cards) await telegram.sendCard(settings.tgToken, platformId, c);
    return true;
  }
  if (platform === 'whatsapp') {
    if (!settings.waToken || !settings.waPhoneNumberId) return false;
    for (const c of cards) {
      const interactive = {
        type: 'button',
        body: { text: (c.name + '\nদাম ৳' + c.price + (c.sku ? ' · কোড ' + c.sku : '')).slice(0, 1000) },
        action: { buttons: [{ type: 'reply', reply: { id: 'ORDER:' + c.id, title: 'এটি নিতে চাই' } }, { type: 'reply', reply: { id: 'INFO:' + c.id, title: 'বিস্তারিত' } }] }
      };
      if (c.image) interactive.header = { type: 'image', image: { link: c.image } };
      await axios.post(`https://graph.facebook.com/v21.0/${settings.waPhoneNumberId}/messages`, { messaging_product: 'whatsapp', to: platformId, type: 'interactive', interactive },
        { headers: { Authorization: 'Bearer ' + settings.waToken }, timeout: 15000 });
    }
    return true;
  }
  return false;
}

// অর্ডার-কার্ড: কাস্টমারকে সুরক্ষিত অর্ডার-ফর্মের লিংকসহ কার্ড পাঠায় (কুপন, COD/বিকাশ/নগদ, অর্ডার আইডিসহ)
async function sendOrderCard(platform, platformId, settings, card, link) {
  const title = '🛒 ' + String(card.name).slice(0, 70);
  const sub = ('দাম ৳' + card.price + ' · নাম-ঠিকানা-পেমেন্ট সব এক ফর্মে').slice(0, 80);
  if (platform === 'facebook' || platform === 'instagram') {
    if (!settings.fbToken) return false;
    const el = { title, subtitle: sub, default_action: { type: 'web_url', url: link }, buttons: [{ type: 'web_url', url: link, title: '🛒 অর্ডার করুন', webview_height_ratio: 'full' }, { type: 'postback', title: 'বিস্তারিত', payload: 'INFO:' + card.id }] };
    if (card.image) el.image_url = card.image;
    const host = platform === 'instagram' && /^IG/.test(String(settings.fbToken)) ? 'https://graph.instagram.com/v21.0' : 'https://graph.facebook.com/v21.0';
    await axios.post(host + '/me/messages', { recipient: { id: platformId }, messaging_type: 'RESPONSE', message: { attachment: { type: 'template', payload: { template_type: 'generic', elements: [el] } } } }, { params: { access_token: settings.fbToken }, timeout: 15000 });
    return true;
  }
  if (platform === 'whatsapp') {
    if (!settings.waToken || !settings.waPhoneNumberId) return false;
    const interactive = { type: 'cta_url', body: { text: (card.name + '\nদাম ৳' + card.price + '\n\nনিচের বাটনে চেপে নাম-ঠিকানা দিয়ে অর্ডার নিশ্চিত করুন।').slice(0, 1000) }, action: { name: 'cta_url', parameters: { display_text: '🛒 অর্ডার করুন', url: link } } };
    if (card.image) interactive.header = { type: 'image', image: { link: card.image } };
    await axios.post(`https://graph.facebook.com/v21.0/${settings.waPhoneNumberId}/messages`, { messaging_product: 'whatsapp', to: platformId, type: 'interactive', interactive }, { headers: { Authorization: 'Bearer ' + settings.waToken }, timeout: 15000 });
    return true;
  }
  // টেলিগ্রাম, টিকটক ও বাকি: লিংকসহ লেখা (এখানে কার্ড-বাটন নেই)
  const txt = `🛒 ${card.name} — ৳${card.price}\n\nসুরক্ষিত অর্ডার ফর্ম (কুপন, ক্যাশ অন ডেলিভারি/বিকাশ/নগদ সবই আছে) 👇\n${link}`;
  await require('../services/crm').sendPlain({ platform, platformId }, txt, settings);
  return true;
}
engage.setCardSender(sendProductCards);
engage.setOrderCardSender(sendOrderCard);
// কাস্টমার কার্ডের বাটন চাপলে — extra: নাম/ফোন (WhatsApp)
async function handlePostback({ platform, senderId, payload, sigOk, extra }) {
  // রিভিউ-কার্ডের বাটন: 👍 ভালো লেগেছে / 😕 সমস্যা আছে
  const rv = /^(RVG|RVB):([\w-]{1,40})$/.exec(String(payload || ''));
  if (rv) {
    const r = await engage.reviewReply(rv[1], rv[2]);
    if (!r) return;
    const baseRv = Object.assign({ platform, platformId: senderId, sigOk }, extra || {});
    if (r.bad) {
      try {
        const cust = await (await store.getDb()).collection('customers').findOne({ platform, platformId: String(senderId) });
        if (cust) {
          await store.setNeedsHuman(cust.id, 'ডেলিভারির পর সমস্যা জানিয়েছেন — অর্ডার ' + r.order.id);
          await notifyOwner({ type: 'handoff', title: `😕 ${cust.name || 'কাস্টমার'} পণ্য নিয়ে সমস্যা জানিয়েছেন`, body: `অর্ডার ${r.order.id} · ${r.order.product}` });
        }
      } catch (e) { console.error('রিভিউ-সমস্যা নোটিফিকেশন এরর:', e.message); }
    }
    return handleIncomingMessage({ ...baseRv, direct: r.text });
  }
  const m = /^(ORDER|INFO):([\w-]{1,60})$/.exec(String(payload || ''));
  if (!m) return;
  const card = await shop.getProductCard(m[2]);
  const base = Object.assign({ platform, platformId: senderId, sigOk }, extra || {});
  if (!card) return handleIncomingMessage({ ...base, direct: 'দুঃখিত, পণ্যটি এখন পাওয়া যাচ্ছে না। অন্য কোন পণ্য দেখতে চান, জানাবেন? 😊' });
  if (m[1] === 'INFO') {
    const msg = `${card.name} — দাম ৳${card.price}${card.sku ? ' (কোড ' + card.sku + ')' : ''}\n\nছবি, অপশন ও রিভিউসহ পুরো বিস্তারিত দেখুন:\n${card.url}\n\nআপনি চাইলে এখানেই অর্ডার করতে পারেন — কার্ডের "এটি নিতে চাই" চাপুন বা লিখে জানান। 😊`;
    return handleIncomingMessage({ ...base, direct: msg });
  }
  console.log(`🧾 ORDER বাটন: ${platform}/${senderId} → ${card.name}`);
  if (process.env.ORDER_CARD !== 'off') {
    try {
      const cust = await store.findOrCreateCustomer({ platform, platformId: String(senderId), name: (extra && extra.name) || undefined, phone: (extra && extra.phone) || undefined });
      const link = await chatOrder.orderLink(cust.id, card.id);
      const ok = await sendOrderCard(platform, String(senderId), await store.getSettings(), card, link);
      console.log(`🧾 অর্ডার কার্ড পাঠানো (বাটন): ${platform}/${senderId} sent=${ok}`);
      if (ok) { await store.appendMessage(cust.id, 'assistant', `[অর্ডার কার্ড পাঠানো হয়েছে: ${card.name}]`); return; }
    } catch (e) { console.error('অর্ডার কার্ড পাঠানো যায়নি (আগের পদ্ধতিতে চলছে):', e.response && e.response.data ? JSON.stringify(e.response.data) : e.message); }
  }
  const text = `এই পণ্যটি নিতে চাই: ${card.name}${card.sku ? ' (কোড ' + card.sku + ')' : ''} — দাম ৳${card.price}`;
  return handleIncomingMessage({ ...base, text, fromButton: card.id });
}

// পেমেন্টের স্ক্রিনশট দেখার গোপন লিংক (শুধু মালিক জানে — অনুমান-অযোগ্য আইডি)
router.get('/proof/:id', async (req, res) => {
  try {
    const p = /^[a-f0-9]{24}$/.test(req.params.id) ? await store.getProof(req.params.id) : null;
    if (!p) return res.sendStatus(404);
    res.set('Cache-Control', 'private, max-age=3600'); res.set('X-Robots-Tag', 'noindex');
    res.type(p.mime || 'image/jpeg').send(Buffer.from(p.b64, 'base64'));
  } catch (e) { res.sendStatus(500); }
});

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
  console.log(`📩 Facebook ওয়েবহুক এসেছে: object=${req.body.object}, মেসেজ-ইভেন্ট=${entries.reduce((n, e) => n + ((e.messaging || []).length), 0)}`);
  for (const entry of entries) {
    for (const change of (entry.changes || [])) {
      comments.handleFacebookChange(entry, change).catch(err => console.error('FB কমেন্ট এরর:', err.message));
    }
    const events = entry.messaging || [];
    for (const event of events) {
      const senderId = event.sender?.id;
      if (senderId && event.postback && event.postback.payload) { handlePostback({ platform: 'facebook', senderId, payload: event.postback.payload, sigOk: !!req.sigOk }).catch(err => console.error('Facebook বাটন এরর:', err.message)); continue; }
      const msg = event.message;
      if (!senderId || !msg) continue;
      if (msg.is_echo) { handleOwnerEcho('facebook', event.recipient && event.recipient.id, msg.text); continue; } // পেজ নিজে যে মেসেজ পাঠিয়েছে তার প্রতিধ্বনি — কাস্টমার না (মালিকের কমা-কমান্ড থাকলে AI চালু/বন্ধ)
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

        await handleIncomingMessage({ platform: 'facebook', platformId: senderId, text, imageBuffer, imageMime, audioBuffer, sigOk: !!req.sigOk });
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

    if (msg.type === 'interactive' && msg.interactive && msg.interactive.button_reply && msg.interactive.button_reply.id && from) {
      handlePostback({ platform: 'whatsapp', senderId: from, payload: msg.interactive.button_reply.id, sigOk: !!req.sigOk, extra: { name, phone: from } }).catch(err => console.error('WhatsApp বাটন এরর:', err.message));
      continue;
    }

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

      await handleIncomingMessage({ platform: 'whatsapp', platformId: from, msgId: msg.id, text, name, phone: from, imageBuffer, imageMime, audioBuffer, sigOk: !!req.sigOk });
    } catch (err) {
      console.error('WhatsApp webhook error (একটা মেসেজ প্রসেস করতে ব্যর্থ):', err.response?.data ? JSON.stringify(err.response.data) : err.message);
    }
  }
});

/* =============== INSTAGRAM (মেসেজ) =============== */
// Meta অ্যাপের Webhooks → Instagram-এ এই লিংক বসাতে হয়: https://<আপনার-সার্ভার>/webhook/instagram

router.get('/instagram', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === config.webhookVerifyToken) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

router.post('/instagram', verifyMeta([config.fbAppSecret, config.igAppSecret], 'Instagram'), async (req, res) => {
  res.sendStatus(200);
  const entries = req.body.entry || [];
  // Meta আদৌ Instagram ইভেন্ট পাঠাচ্ছে কিনা বোঝার জন্য প্রতিবার একটা লাইন লগে লিখি
  console.log(`📩 Instagram ওয়েবহুক এসেছে: object=${req.body.object}, entry=${entries.length}, মেসেজ-ইভেন্ট=${entries.reduce((n, e) => n + ((e.messaging || []).length), 0)}`);
  for (const entry of entries) {
    for (const change of (entry.changes || [])) {
      comments.handleInstagramChange(entry, change).catch(err => console.error('IG কমেন্ট এরর:', err.message));
    }
    const events = entry.messaging || [];
    for (const event of events) {
      const senderId = event.sender && event.sender.id;
      if (senderId && event.postback && event.postback.payload && String(senderId) !== String(entry.id)) { handlePostback({ platform: 'instagram', senderId, payload: event.postback.payload, sigOk: !!req.sigOk }).catch(err => console.error('Instagram বাটন এরর:', err.message)); continue; }
      const msg = event.message;
      if (!senderId || !msg) continue;
      // নিজের অ্যাকাউন্টের পাঠানো মেসেজের প্রতিধ্বনি বাদ
      if (msg.is_echo || String(senderId) === String(entry.id)) { handleOwnerEcho('instagram', event.recipient && event.recipient.id, msg.text); continue; }
      try {
        const text = msg.text;
        const attachments = msg.attachments || [];
        const imageAttachment = attachments.find(a => a.type === 'image');
        const audioAttachment = attachments.find(a => a.type === 'audio');

        let imageBuffer = null, imageMime = null, audioBuffer = null;
        if (imageAttachment && imageAttachment.payload && imageAttachment.payload.url) {
          imageBuffer = await downloadMedia(imageAttachment.payload.url);
          imageMime = 'image/jpeg';
        }
        if (audioAttachment && audioAttachment.payload && audioAttachment.payload.url) {
          audioBuffer = await downloadMedia(audioAttachment.payload.url);
        }

        if (!text && !imageBuffer && !audioBuffer) {
          // স্টোরি রিপ্লাই/রিল শেয়ার ইত্যাদি — বোঝার মতো কিছু নেই, তবু কাস্টমারকে তালিকায় রাখি
          await ensureCustomer({ platform: 'instagram', platformId: senderId });
          continue;
        }

        await handleIncomingMessage({ platform: 'instagram', platformId: senderId, text, imageBuffer, imageMime, audioBuffer, sigOk: !!req.sigOk });
      } catch (err) {
        console.error('Instagram webhook error (একটা মেসেজ প্রসেস করতে ব্যর্থ):', err.response && err.response.data ? JSON.stringify(err.response.data) : err.message);
      }
    }
  }
});

/* =============== TELEGRAM বট =============== */
const tgSeen = [];
router.post('/telegram', async (req, res) => {
  let settings;
  try { settings = await store.getSettings(); } catch (e) { return res.sendStatus(500); }
  if (!settings.tgToken || !telegram.checkSecret(settings.tgToken, req.get('x-telegram-bot-api-secret-token'))) return res.sendStatus(403);
  res.sendStatus(200); // Telegram দ্রুত "ঠিক আছে" চায়, নইলে একই মেসেজ বারবার পাঠায়
  try {
    const upd = req.body || {};
    if (tgSeen.includes(upd.update_id)) return;
    tgSeen.push(upd.update_id); if (tgSeen.length > 300) tgSeen.shift();
    telegram.ensureCallbacks(settings.tgToken).catch(() => {});
    const cq = upd.callback_query;
    if (cq && cq.data && cq.message && cq.message.chat && cq.message.chat.type === 'private') {
      telegram.answerCallback(settings.tgToken, cq.id);
      const nm = [cq.from && cq.from.first_name, cq.from && cq.from.last_name].filter(Boolean).join(' ') || (cq.from && cq.from.username) || '';
      await handlePostback({ platform: 'telegram', senderId: String(cq.message.chat.id), payload: cq.data, sigOk: true, extra: { name: nm, username: (cq.from && cq.from.username) || '' } });
      return;
    }
    const m = upd.message;
    if (!m || !m.chat || m.chat.type !== 'private' || (m.from && m.from.is_bot)) return;
    const chatId = String(m.chat.id);
    let text = m.text || m.caption || '';
    if (/^\/start\b/i.test(text)) {
      await telegram.sendMessage(settings.tgToken, chatId, 'আসসালামু আলাইকুম! 😊 আমি আপনার অর্ডার ও পণ্যের তথ্যে সাহায্য করব। কী জানতে চান লিখুন।');
      text = '';
      return;
    }
    const name = [m.from && m.from.first_name, m.from && m.from.last_name].filter(Boolean).join(' ') || (m.from && m.from.username) || '';
    let imageBuffer, audioBuffer;
    if (m.photo && m.photo.length) imageBuffer = await telegram.downloadFile(settings.tgToken, m.photo[m.photo.length - 1].file_id).catch(() => undefined);
    else if (m.voice || m.audio) audioBuffer = await telegram.downloadFile(settings.tgToken, (m.voice || m.audio).file_id).catch(() => undefined);
    if (!text && !imageBuffer && !audioBuffer) return;
    await handleIncomingMessage({ platform: 'telegram', platformId: chatId, text, name, username: (m.from && m.from.username) || '', imageBuffer, imageMime: 'image/jpeg', audioBuffer, sigOk: true });
  } catch (err) {
    console.error('Telegram webhook error:', err.message);
  }
});

/* =============== TIKTOK =============== */
// অ্যাকাউন্ট যুক্ত করার পর TikTok এখানে ফেরত পাঠায় (পাবলিক পেজ)
router.get('/tiktok/callback', async (req, res) => {
  const page = (ok, msg) => res.status(ok ? 200 : 400).send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:sans-serif;text-align:center;padding:48px 20px"><h2>${ok ? '✅' : '❌'} ${msg}</h2><p>${ok ? 'এখন অ্যাপে ফিরে যান।' : 'অ্যাপে ফিরে আবার চেষ্টা করুন।'}</p></body>`);
  try {
    await tiktok.handleCallback({ code: req.query.code, state: req.query.state, error: req.query.error_description || req.query.error });
    page(true, 'TikTok যুক্ত হয়েছে');
  } catch (e) { page(false, String(e.message).replace(/[<>&]/g, '')); }
});

// মেসেজ ওয়েবহুক — লিংকের গোপন অংশ মিললে তবেই গ্রহণ। কাঁচা পেলোড শেষ ১০টা রাখি, যাতে ডকের সাথে মেলানো যায়।
const tkSeen = [];
router.post('/tiktok/:key', async (req, res) => {
  if (!(await tiktok.checkHookKey(req.params.key))) return res.sendStatus(403);
  res.sendStatus(200);
  try {
    const db = await store.getDb();
    await db.collection('meta').updateOne({ _id: 'tkraw' }, { $push: { items: { $each: [{ at: new Date().toISOString(), body: JSON.stringify(req.body || {}).slice(0, 3000) }], $slice: -10 } } }, { upsert: true });
    const m = tiktok.parseInbound(req.body || {});
    if (!m.userId || (!m.text && !m.imageUrl)) return;
    if (m.messageId) { if (tkSeen.includes(m.messageId)) return; tkSeen.push(m.messageId); if (tkSeen.length > 300) tkSeen.shift(); }
    const s = await store.getSettings();
    if (s.tkMsgBusinessId && String(m.userId) === String(s.tkMsgBusinessId)) return; // নিজের পাঠানো মেসেজ
    await tiktok.rememberConv(m.userId, m.conversationId);
    let imageBuffer;
    if (m.imageUrl && !m.text) imageBuffer = await require('axios').get(m.imageUrl, { responseType: 'arraybuffer', timeout: 15000, maxContentLength: 8e6 }).then(r => Buffer.from(r.data)).catch(() => undefined);
    if (!m.text && !imageBuffer) return;
    await handleIncomingMessage({ platform: 'tiktok', platformId: String(m.userId), text: m.text, name: m.name, username: m.username, imageBuffer, imageMime: 'image/jpeg', sigOk: false });
  } catch (err) {
    console.error('TikTok webhook error:', err.message);
  }
});

// ইমেইল ওয়েবহুক — Gmail ব্রিজ (Apps Script) নতুন ইমেইল এখানে পাঠায়। লিংকের গোপন অংশ মিললে তবেই গ্রহণ।
const emSeen = [];
const emRate = new Map(); // প্রেরক -> সময়ের তালিকা (লুপ/স্প্যাম ঠেকাতে ঘণ্টায় সর্বোচ্চ ১০টা)
router.post('/email/:key', async (req, res) => {
  const settings = await store.getSettings();
  if (!emailSvc.checkHookKey(settings, req.params.key)) return res.sendStatus(403);
  const b = req.body || {};
  const addr = String(b.from || '').trim().toLowerCase();
  if (!emailSvc.isEmail(addr) || !String(b.text || '').trim()) return res.sendStatus(200);
  res.sendStatus(200);
  try {
    if (settings.emailAiReply !== 'on') return;
    if (b.messageId) { if (emSeen.includes(b.messageId)) return; emSeen.push(b.messageId); if (emSeen.length > 300) emSeen.shift(); }
    const now = Date.now();
    const hits = (emRate.get(addr) || []).filter(t => now - t < 3600e3);
    if (hits.length >= 10) return;
    hits.push(now); emRate.set(addr, hits);
    await emailSvc.rememberThread(addr, { threadId: b.threadId, subject: b.subject });
    const subj = String(b.subject || '').trim();
    const text = (subj && !/^(re|fwd?):/i.test(subj) ? 'বিষয়: ' + subj + '\n' : '') + String(b.text).slice(0, 3000);
    await handleIncomingMessage({ platform: 'email', platformId: addr, text, name: String(b.name || '').slice(0, 80), email: addr, sigOk: false });
  } catch (err) {
    console.error('Email webhook error:', err.message);
  }
});

/* =============== SHARED HANDLER =============== */

// যেকোনো ধরনের মেসেজ (স্টিকার, লাইক, ভিডিও ইত্যাদিও) এলে কাস্টমারকে তালিকায় যোগ করি,
// আর Facebook হলে নাম/ছবি আনার চেষ্টা করি
async function ensureCustomer({ platform, platformId, name, phone, username, email }) {
  const settings = await store.getSettings();
  let customer = await store.findOrCreateCustomer({ platform, platformId, name, phone });
  // প্ল্যাটফর্মের আসল নাম (Telegram/WhatsApp/TikTok মেসেজের সাথে আসে) সবসময় সঠিক ধরা হয় — অর্ডারে লেখা নাম এটা বদলায় না
  const patch = {};
  const placeholder = !customer.name || customer.name === 'অজানা কাস্টমার';
  if (name && ['telegram', 'whatsapp', 'tiktok'].includes(platform)) {
    if (customer.name !== name || customer.nameSource !== 'platform') { patch.name = name; patch.nameSource = 'platform'; }
  } else if (name && placeholder && platform !== 'website') patch.name = name;
  if (username && customer.username !== username) patch.username = username;
  if (email && customer.email !== email) patch.email = email;
  if (Object.keys(patch).length) {
    try { customer = await store.updateCustomerContact(customer.id, patch); } catch (e) { /* নাম না বদলালেও চলবে */ }
  }

  // Messenger/Instagram: প্রোফাইল থেকে আসল নাম আনি (পেছনে চলে, উত্তর আটকায় না)। আগে ভুল নাম বসে থাকলে এখানে ঠিক হয়ে যায়
  const needProfile = placeholder || !customer.photoUrl || customer.nameSource !== 'platform';
  if (platform === 'facebook' && settings.fbToken && needProfile) {
    getFacebookProfile(platformId, settings.fbToken).then(profile => {
      if (profile.name || profile.photoUrl) return store.updateCustomerContact(customer.id, { name: profile.name, photoUrl: profile.photoUrl, nameSource: profile.name ? 'platform' : undefined });
    }).catch(() => {});
  }
  if (platform === 'instagram' && settings.fbToken && needProfile) {
    getInstagramProfile(platformId, settings.fbToken).then(profile => {
      if (profile.name || profile.photoUrl || profile.username) return store.updateCustomerContact(customer.id, { name: profile.name || profile.username, photoUrl: profile.photoUrl, username: profile.username, nameSource: (profile.name || profile.username) ? 'platform' : undefined });
    }).catch(() => {});
  }
  return { settings, customer };
}

// মালিক হলে (নিবন্ধিত নম্বর বা PIN দিয়ে বাঁধা অ্যাকাউন্ট) সহকারী উত্তর দেয়, কাস্টমারের পথে যায় না। true = সামলানো হয়েছে।
async function ownerChannel({ platform, platformId, text, imageBuffer, audioBuffer, sigOk }) {
  if (!sigOk) return false; // সই যাচাই ছাড়া কাউকে মালিক ধরা হয় না (নকল মেসেজ ঠেকাতে)
  let linkReply = null;
  if (text) linkReply = await assistant.tryLink({ platform, platformId, text });
  const owner = linkReply ? true : await assistant.isOwner({ platform, platformId });
  if (!owner) return false;

  const settings = await store.getSettings();
  const reply = async (msg, imgUrl) => {
    if (platform === 'facebook' && settings.fbToken) {
      await withRetry(() => sendFacebookMessage(platformId, msg, settings.fbToken));
      if (imgUrl) await withRetry(() => sendFacebookImage(platformId, imgUrl, settings.fbToken)).catch(() => {});
    } else if (platform === 'whatsapp' && settings.waToken && settings.waPhoneNumberId) {
      await withRetry(() => sendWhatsAppMessage(platformId, msg, settings.waPhoneNumberId, settings.waToken));
      if (imgUrl) await withRetry(() => sendWhatsAppImage(platformId, imgUrl, settings.waPhoneNumberId, settings.waToken)).catch(() => {});
    } else if (platform === 'instagram' && settings.fbToken) {
      await withRetry(() => sendInstagramMessage(platformId, msg, settings.fbToken));
      if (imgUrl) await withRetry(() => sendInstagramImage(platformId, imgUrl, settings.fbToken)).catch(() => {});
    } else if (platform === 'telegram' && settings.tgToken) {
      await withRetry(() => telegram.sendMessage(settings.tgToken, platformId, msg));
      if (imgUrl) await withRetry(() => telegram.sendPhoto(settings.tgToken, platformId, imgUrl, '')).catch(() => {});
    } else if (platform === 'email') {
      await emailSvc.sendReply(platformId, imgUrl ? msg + '\n' + imgUrl : msg);
    }
  };
  try {
    if (linkReply) { await reply(linkReply); return true; }
    if (!text && audioBuffer) {
      const key = pickCapableKey(settings, isWhisperCapable);
      if (!key) { await reply('ভয়েস শোনার মতো AI Key এখন নেই — লিখে বলুন।'); return true; }
      try { text = await transcribeAudio({ apiKey: key.apiKey, provider: key.provider, audioBuffer }); }
      catch (e) { await reply('ভয়েসটা বুঝতে পারিনি, লিখে বলবেন?'); return true; }
    }
    if (!text && !imageBuffer) return true;
    const out = await assistant.handleOwnerMessage({
      key: platform + ':' + platformId, text: text || 'এই ছবিটা দিয়ে পোস্ট বানাও।', settings,
      imageB64: imageBuffer ? imageBuffer.toString('base64') : '', imageMime: 'image/jpeg'
    });
    await reply(out.reply, out.imageUrl);
  } catch (err) {
    console.error('মালিক-সহকারী এরর:', err.message);
    await reply('দুঃখিত, এখন কাজটা করা গেল না। একটু পরে আবার বলুন।').catch(() => {});
  }
  return true;
}

// Messenger/Instagram-এ "লিখছে..." সংকেত (ব্যর্থ হলেও সমস্যা নেই)
function typingOn(platform, platformId, settings) {
  if (platform === 'telegram' && settings.tgToken) return telegram.typing(settings.tgToken, platformId);
  if ((platform === 'facebook' || platform === 'instagram') && settings.fbToken) {
    require('axios').post('https://graph.facebook.com/v19.0/me/messages', { recipient: { id: platformId }, sender_action: 'typing_on' },
      { params: { access_token: settings.fbToken }, timeout: 5000 }).catch(() => {});
  }
}



/* ---------- বিকাশ/নগদ SMS গ্রহণ (ফ্রি SMS-ফরওয়ার্ডার অ্যাপ এখানে পাঠায়) ---------- */
// ঠিকানা: https://<আপনার-সার্ভার>/webhook/payment-sms?key=SMS_HOOK_KEY-এর-মান
router.post('/payment-sms', express.urlencoded({ extended: true, limit: '200kb' }), express.text({ type: ['text/*'], limit: '200kb' }), async (req, res) => {
  try {
    if (!payments.enabled()) return res.status(503).json({ ok: false, error: 'SMS_HOOK_KEY সেট করা নেই' });
    const key = String(req.query.key || req.headers['x-sms-key'] || (req.body && req.body.key) || '');
    const ok = key.length === payments.hookKey().length && require('crypto').timingSafeEqual(Buffer.from(key), Buffer.from(payments.hookKey()));
    if (!ok) return res.status(401).json({ ok: false, error: 'key ভুল' });
    const r = await payments.ingest(req.body, req.query.from);
    res.json(r.ok ? { ok: true, duplicate: !!r.duplicate } : { ok: false, ignored: true, reason: r.reason });
  } catch (err) {
    console.error('payment-sms এরর:', err.message);
    res.status(500).json({ ok: false });
  }
});

/* ---------- মালিকের কমা (,) কমান্ড: পেজ-ইনবক্স থেকে কাস্টমারকে মেসেজ দিলে AI থামে/চালু হয় ---------- */
async function handleOwnerEcho(platform, customerPlatformId, text) {
  try {
    const cmd = crm.ownerToggle(text);
    if (!cmd || !customerPlatformId) return;
    const customer = await store.findOrCreateCustomer({ platform, platformId: String(customerPlatformId) });
    const next = cmd === 'pause' ? false : cmd === 'resume' ? true : !customer.ai;
    if (next === !!customer.ai) return;
    await store.setCustomerAI(customer.id, next);
    console.log(`🔘 মালিকের কমা-কমান্ড: ${platform}/${customerPlatformId} → AI ${next ? 'চালু' : 'বন্ধ'}`);
    if (next) await store.clearNeedsHuman(customer.id).catch(() => {});
  } catch (err) { console.error('কমা-কমান্ড এরর:', err.message); }
}

// "সিন" (দেখেছি) চিহ্ন — Messenger/Instagram/WhatsApp। ব্যর্থ হলেও সমস্যা নেই
function markSeen(platform, platformId, settings, extra) {
  try {
    if ((platform === 'facebook' || platform === 'instagram') && settings.fbToken) {
      axios.post('https://graph.facebook.com/v21.0/me/messages', { recipient: { id: platformId }, sender_action: 'mark_seen' },
        { params: { access_token: settings.fbToken }, timeout: 5000 }).catch(() => {});
    } else if (platform === 'whatsapp' && settings.waToken && settings.waPhoneNumberId && extra && extra.msgId) {
      axios.post(`https://graph.facebook.com/v21.0/${settings.waPhoneNumberId}/messages`, { messaging_product: 'whatsapp', status: 'read', message_id: extra.msgId },
        { headers: { Authorization: 'Bearer ' + settings.waToken }, timeout: 5000 }).catch(() => {});
    }
  } catch (e) { /* গুরুত্বপূর্ণ নয় */ }
}

/* ---------- ঢোকা মেসেজের প্রবেশদ্বার: স্প্যাম ছাঁকনি → "সিন" → একসাথে আসা টেক্সট জমানো → একটানা (সিরিয়াল) প্রসেস ---------- */
const BATCH_MS = process.env.MSG_BATCH_MS !== undefined ? Number(process.env.MSG_BATCH_MS) : 3500;
const batches = new Map();  // key -> { texts, args, timer }
const chains = new Map();   // key -> Promise (একই কাস্টমারের মেসেজ একটার পর একটা)
function runSerial(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  chains.set(key, next);
  next.catch(() => {}).then(() => { if (chains.get(key) === next) chains.delete(key); });
  return next;
}
async function flushBatch(key) {
  const b = batches.get(key);
  if (!b) return;
  batches.delete(key);
  clearTimeout(b.timer);
  const text = b.texts.length > 1 ? b.texts.join('\n') : b.texts[0];
  if (b.texts.length > 1) console.log(`📚 ${b.texts.length}টি মেসেজ একসাথে পড়ে উত্তর দেওয়া হচ্ছে: ${key}`);
  return runSerial(key, () => processIncoming(Object.assign({}, b.args, { text })));
}

async function handleIncomingMessage(args) {
  const { platform, platformId, text, imageBuffer, audioBuffer, fromButton, direct } = args;
  const key = platform + '|' + platformId;
  const textOnly = !!text && !imageBuffer && !audioBuffer;
  const system = !!(fromButton || direct);
  if (textOnly && !system) {
    // আবোলতাবোল/বারবার একই মেসেজ/শুধু ইমোজি — উত্তর দেওয়া হয় না (কাস্টমার তালিকায় থাকে)
    const why = crm.junkReason(text) || crm.floodReason(key, text);
    if (why) {
      console.log(`🚫 উত্তর দেওয়া হয়নি (${why}): ${key}`);
      await ensureCustomer({ platform, platformId, name: args.name, phone: args.phone, username: args.username, email: args.email }).catch(() => {});
      return;
    }
  }
  let settings = null;
  const getSettingsOnce = async () => settings || (settings = await store.getSettings());
  if (!system && platform !== 'email' && platform !== 'tiktok') { getSettingsOnce().then(st => markSeen(platform, platformId, st, args)).catch(() => {}); }
  const batchable = BATCH_MS > 0 && textOnly && !system && platform !== 'email';
  let b = batches.get(key);
  if (batchable) {
    if (!b) { b = { texts: [], args, timer: null }; batches.set(key, b); }
    b.texts.push(text);
    b.args = args;
    clearTimeout(b.timer);
    if (b.texts.length >= 8) return flushBatch(key);
    b.timer = setTimeout(() => flushBatch(key).catch(err => console.error('মেসেজ-ব্যাচ এরর:', err.message)), BATCH_MS);
    return;
  }
  if (b) await flushBatch(key); // ছবি/ভয়েস এলে আগে জমে থাকা টেক্সটের উত্তর যাক
  return runSerial(key, () => processIncoming(args));
}

async function processIncoming({ platform, platformId, text, name, phone, username, email, imageBuffer, imageMime, audioBuffer, sigOk, direct, fromButton }) {
  if (await ownerChannel({ platform, platformId, text, imageBuffer, audioBuffer, sigOk })) return;
  const { settings, customer } = await ensureCustomer({ platform, platformId, name, phone, username, email });
  console.log(`💬 মেসেজ প্রসেস হচ্ছে: ${platform} / ${platformId} (AI ${customer.ai ? 'চালু' : 'বন্ধ'})`);

  // কাস্টমার নিজে আবার মেসেজ দিয়েছে — আগের "পরে মেসেজ দিন" ফলো-আপ আর দরকার নেই
  if (!direct && !fromButton) store.clearFollowUp(customer.id).catch(() => {});
  if (!customer.ai) return;
  if (!getSlots(settings).length) {
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
    } else if (platform === 'instagram' && settings.fbToken) {
      await withRetry(() => sendInstagramMessage(platformId, replyText, settings.fbToken));
      if (imgUrl) {
        try { await withRetry(() => sendInstagramImage(platformId, imgUrl, settings.fbToken)); }
        catch (err) { console.error('ছবি পাঠাতে ব্যর্থ (Instagram):', err.message); }
      }
    } else if (platform === 'tiktok' && settings.tkMsgToken) {
      await withRetry(() => tiktok.sendMessage(platformId, imgUrl ? replyText + '\n' + imgUrl : replyText));
    } else if (platform === 'telegram' && settings.tgToken) {
      await withRetry(() => telegram.sendMessage(settings.tgToken, platformId, replyText));
      if (imgUrl) {
        try { await withRetry(() => telegram.sendPhoto(settings.tgToken, platformId, imgUrl, '')); }
        catch (err) { console.error('ছবি পাঠাতে ব্যর্থ (Telegram):', err.message); }
      }
    }
  };

  if (direct) { // কার্ডের "বিস্তারিত" বাটন — AI ছাড়াই সরাসরি উত্তর
    await store.appendMessage(customer.id, 'assistant', direct);
    await send(direct);
    return;
  }

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

  // পেমেন্টের ধাপে ছবি এলে সেটা স্ক্রিনশট হিসেবে গোপনে রাখি (প্রোডাক্টের ছবি ভেবে বিশ্লেষণ করি না)
  if (imageBuffer) {
    try {
      const recent = (await store.getConversation(customer.id)).slice(-4);
      if (recent.some(h => h.role === 'assistant' && /TrxID|ট্রানজেকশন|স্ক্রিনশট|বিকাশ|নগদ|bkash|nagad|অগ্রিম/i.test(String(h.text || '')))) {
        await store.saveProof(customer.id, { mime: imageMime || 'image/jpeg', b64: imageBuffer.toString('base64') });
        text = (text ? text + ' ' : '') + '[পেমেন্টের স্ক্রিনশট পাঠানো হয়েছে]';
        imageBuffer = null;
      }
    } catch (err) { console.error('পেমেন্টের স্ক্রিনশট রাখা যায়নি:', err.message); }
  }

  if (imageBuffer && !text) {

    const visionKey = pickCapableKey(settings, isVisionCapable);
    if (!visionKey) {
      const msgTxt = 'দুঃখিত, এই মুহূর্তে ছবি দেখে বলা সম্ভব হচ্ছে না। প্রোডাক্টের নাম লিখে জানালে সাহায্য করতে পারব 🙏';
      await store.appendMessage(customer.id, 'assistant', msgTxt);
      await send(msgTxt);
      return;
    }

    const sheetContext = (await getSheetCtx(settings, '')) + (await shop.getAiContext(''));
    try {
      const vr = await getVisionReply({
        apiKey: visionKey.apiKey, provider: visionKey.provider,
        imageBase64: imageBuffer.toString('base64'), mimeType: imageMime || 'image/jpeg',
        sheetContext, businessInfo
      });
      const reply = vr.reply;
      // ছবিতে কী দেখা গেছে সেটা কথোপকথনে লিখে রাখি — পরের মেসেজে AI এটা ধরে কথা বলবে
      await store.appendMessage(customer.id, 'user', '[ছবি পাঠিয়েছে' + (vr.seen ? ': ' + String(vr.seen).slice(0, 150) : '') + ']');
      await store.appendMessage(customer.id, 'assistant', reply);
      await send(reply);
      const vids = vr.matched === false ? [] : await shop.resolveProducts({ reply, text: '', history: [], aiId: vr.productId });
      if (vids.length && ['facebook', 'instagram', 'whatsapp', 'telegram'].includes(platform)) {
        const cards = (await Promise.all(vids.map(id => shop.getProductCard(id).catch(() => null)))).filter(Boolean);
        try { if (await sendProductCards(platform, platformId, settings, cards)) cards.forEach(c => lastCardAt.set(customer.id + '|' + c.id, Date.now())); }
        catch (err) { console.error(`কার্ড পাঠানো যায়নি (${platform}):`, err.response && err.response.data ? JSON.stringify(err.response.data) : err.message); }
      }
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

  typingOn(platform, platformId, settings); // "লিখছে..." দেখালে কাস্টমারের অপেক্ষা ছোট লাগে
  // সবকিছু একসাথে আনি (আগে একটার পর একটা আনা হতো — ধীর ছিল)
  const [sheetContext, fullHistory, rulesRaw, ownerImages, stockRaw, shopContext, memory, pastOrders] = await Promise.all([
    getSheetCtx(settings, text),
    store.getConversation(customer.id),
    store.getAiRules(),
    store.getAiImages(),
    store.getStockList(),
    shop.getAiContext(text), // ই-কমার্স ওয়েবসাইটের লাইভ প্রোডাক্ট/স্টক/অফার (সংযুক্ত না থাকলে ফাঁকা)
    store.getCustomerMemory(customer.id).catch(() => ''),
    store.getOrdersByCustomer(customer.id).catch(() => [])
  ]);
  const history = fullHistory.slice(0, -1).slice(-24);
  const ownerRules = rulesRaw.map(r => r.text);
  const stockList = stockRaw.map(e => ({ name: e.name, qty: e.qty }));
  const orderLine = pastOrders.slice(0, 3).map(o => `অর্ডার আইডি ${o.id}: ${o.product} ×${o.qty} (${o.status})`).join('; ');
  const customerMemory = [memory, orderLine ? 'আগের অর্ডার: ' + orderLine : ''].filter(Boolean).join('\n');

  // "অর্ডার আইডি/নম্বর কত" — AI-কে জিজ্ঞেস না করে সরাসরি আসল তথ্য থেকে উত্তর
  if (/অর্ডার\s*(আইডি|নং|নম্বর|নাম্বার|ID)|order\s*(id|no|number)/i.test(String(text || ''))) {
    const last = pastOrders[0];
    const msg = last
      ? `আপনার সর্বশেষ অর্ডারের আইডি: ${last.id}\nপণ্য: ${last.product} ×${last.qty}\nস্ট্যাটাস: ${last.status}`
      : 'আপনার নামে এখনো কোনো অর্ডার পাইনি। অর্ডার করতে চাইলে পণ্যের নাম জানান 🙏';
    await store.appendMessage(customer.id, 'assistant', msg);
    await send(msg);
    return;
  }

  const { reply, imageUrl, imageId, shopProductId, order, handoff } = await getAIReplyWithFallback({
    settings, customerMessage: text, history, sheetContext, businessInfo, ownerRules, ownerImages, stockList, shopContext, customerMemory,
    customerName: (customer.name && customer.name !== 'অজানা কাস্টমার') ? customer.name : ''
  });

  // AI আইডি না দিলেও (বা ভুল দিলেও) উত্তরে যে পণ্যের নাম আছে সার্ভার নিজে চিনে নেয়
  const resolvedIds = (order || fromButton) ? [] : await shop.resolveProducts({ reply, text, history, aiId: shopProductId });
  // মালিকের আপলোড করা ছবি থাকলে সেটাকেই অগ্রাধিকার; না থাকলে শিটের ছবির লিংক
  let finalImageUrl = imageUrl;
  // কাস্টমার ছবি না চাইলে কখনো ছবি পাঠানো হবে না
  const wantsImage = /ছবি|ফটো|photo|pic|image|দেখি|দেখান|দেখাও|দেখতে চাই/i.test(String(text || ''));
  if (!wantsImage) { finalImageUrl = null; }
  else if (imageId && ownerImages.some(i => i.id === imageId)) {
    finalImageUrl = `${config.publicUrl}/media/${imageId}`;
  }
  // ওয়েবসাইটের প্রোডাক্টের ছবি (পাওয়া না গেলে null — তখন reply-তে থাকা লিংকই কাস্টমার পান)
  if (wantsImage && !finalImageUrl && (resolvedIds[0] || shopProductId)) {
    finalImageUrl = await shop.getProductImage(resolvedIds[0] || shopProductId);
  }

  // অর্ডার নেওয়া হচ্ছে — AI-র নিজের "নিশ্চিত হলো" লেখা পাঠাই না; সার্ভার যাচাই করে নিজে নিশ্চিতকরণ/সমস্যার বার্তা দেবে
  const placingOrder = !!(order && order.product && !order.emailOnly);
  let outReply = reply;
  const recentOrd = pastOrders[0] && (Date.now() - new Date(pastOrders[0].createdAt).getTime() < 10 * 60 * 1000);
  if (!order && !recentOrd && /নিশ্চিত করা হলো|সফলভাবে গ্রহণ করা হয়েছে|অর্ডার কনফার্ম হয়েছে/.test(String(reply || ''))) {
    console.warn('AI অর্ডার ছাড়াই "নিশ্চিত" বলেছিল — বার্তা বদলানো হলো');
    outReply = 'আপনার অর্ডারটি এখনো নিশ্চিত হয়নি। কোন পণ্য কত পরিমাণ নেবেন, সাথে নাম, মোবাইল, ঠিকানা আর পেমেন্ট কীভাবে করবেন — একটু জানাবেন? 🙏';
  }
  if (!placingOrder) {
    // কোনো নির্দিষ্ট পণ্যের কথা হলে ছবি-নাম-দামসহ কার্ড + বাটন পাঠাই (একই পণ্যের কার্ড ১০ মিনিটে একবার; বাটন চাপার পরের অর্ডার-ধাপে নয়)
    let textSent = false;
    if (!resolvedIds.length) console.log(`🃏 কার্ড (${platform}): উত্তরে চেনা-যায় এমন পণ্য নেই`);
    if (resolvedIds.length && ['facebook', 'instagram', 'whatsapp', 'telegram'].includes(platform)) {
      // কাস্টমার নিজে ছবি/দেখতে চাইলে সবসময়, নইলে একই পণ্যের কার্ড ১০ মিনিটে একবার
      const fresh = resolvedIds.filter(id => wantsImage || !lastCardAt.has(customer.id + '|' + id) || Date.now() - lastCardAt.get(customer.id + '|' + id) > 10 * 60 * 1000);
      const cards = (await Promise.all(fresh.map(id => shop.getProductCard(id).catch(() => null)))).filter(Boolean);
      console.log(`🃏 কার্ড (${platform}): চেনা-পণ্য=${resolvedIds.length}, নতুন=${fresh.length}, কার্ড-তৈরি=${cards.length}`);
      if (cards.length) {
        await send(outReply); textSent = true;
        try {
          const okSend = await sendProductCards(platform, platformId, settings, cards);
          console.log(`🃏 কার্ড (${platform}) পাঠানো: ${okSend ? 'সফল' : 'পাঠানো হয়নি (টোকেন/সেটিং নেই?)'}`);
          if (okSend) cards.forEach(c => lastCardAt.set(customer.id + '|' + c.id, Date.now()));
        } catch (err) {
          console.error(`প্রোডাক্ট কার্ড পাঠানো যায়নি (${platform}):`, err.response && err.response.data ? JSON.stringify(err.response.data) : err.message);
          // কার্ড না গেলে অন্তত ছবি + লিংক
          try {
            await send('🔗 ' + cards.map(c => c.name + ' (৳' + c.price + '): ' + c.url).join('\n'));
            const img = cards[0].image;
            if (img) await (platform === 'facebook' ? sendFacebookImage(platformId, img, settings.fbToken) : platform === 'instagram' ? sendInstagramImage(platformId, img, settings.fbToken) : platform === 'whatsapp' ? sendWhatsAppImage(platformId, img, settings.waPhoneNumberId, settings.waToken) : telegram.sendPhoto(settings.tgToken, platformId, img, cards[0].name + ' — ৳' + cards[0].price));
          } catch (e2) { console.error('ছবিও পাঠানো যায়নি:', e2.message); }
        }
      }
    }
    if (!textSent) await send(outReply, finalImageUrl); // আগে কাস্টমারকে পাঠাই, তারপর খাতায় লিখি
    await store.appendMessage(customer.id, 'assistant', outReply);
  }

  // ---- কাস্টমার ম্যানেজমেন্ট: ফলো-আপ, আগ্রহ, "নিব না" হলে বিকল্প ও অফার ----
  try {
    // "এখন সময় নেই, পরে মেসেজ দিন" — সময় বুঝে AI নিজে ফলো-আপ করবে
    const fu = (!placingOrder && !fromButton) ? crm.parseFollowUp(text) : null;
    if (fu) {
      await store.setFollowUp(customer.id, { at: fu.at, reason: String(text).slice(0, 120) });
      console.log(`⏰ ফলো-আপ ঠিক হলো: ${platform}/${platformId} → ${new Date(fu.at).toISOString()} (${fu.label})`);
    }
    // কোন পণ্যে আগ্রহ — অর্ডার না করলে "আগ্রহী তালিকা"-য় দেখা যাবে
    const interestId = resolvedIds[0] || (fromButton ? String(fromButton) : '');
    if (interestId && !placingOrder) {
      const c0 = await shop.getProductCard(interestId).catch(() => null);
      if (c0) await store.setInterest(customer.id, { productId: c0.id, product: c0.name });
    }
    // কাস্টমার পণ্যটা নিতে চান না / দাম বেশি — চলমান অফার + আরও কিছু পণ্যের কার্ড
    if (!placingOrder && !fromButton && !fu && crm.isDecline(text) && ['facebook', 'instagram', 'whatsapp', 'telegram'].includes(platform)) {
      const exclude = [...resolvedIds, ...(customer.interest && customer.interest.productId ? [customer.interest.productId] : [])];
      const alt = await shop.getAlternatives({ excludeIds: exclude, max: 3 });
      const cards = (await Promise.all(alt.ids.map(id => shop.getProductCard(id).catch(() => null)))).filter(Boolean);
      if (cards.length || alt.offers.length) {
        let msg = alt.offers.length ? 'এখন আমাদের ওয়েবসাইটে চলছে 👇\n' + alt.offers.join('\n') : '';
        if (cards.length) msg += (msg ? '\n\n' : '') + 'এগুলোও দেখতে পারেন 😊';
        await send(msg);
        await store.appendMessage(customer.id, 'assistant', msg);
        if (cards.length) await sendProductCards(platform, platformId, settings, cards);
        console.log(`🎁 বিকল্প/অফার দেখানো হলো: ${platform}/${platformId}`);
      }
    }
    // ভিডিও গাইড: "কীভাবে খাব/ব্যবহার করব/ভিডিও" জিজ্ঞেস করলে পণ্যের ভিডিও লিংক
    if (!placingOrder && !fromButton && engage.wantsVideo(text) && resolvedIds.length) {
      const vm = await engage.videoMessage(resolvedIds);
      if (vm) { await send(vm); await store.appendMessage(customer.id, 'assistant', vm); console.log(`🎬 ভিডিও গাইড পাঠানো: ${platform}/${platformId}`); }
    }
    // অর্ডারের ইচ্ছা জানালে (লিখে) — ভুল-তথ্য এড়াতে সুরক্ষিত অর্ডার-কার্ডও পাঠাই (বন্ধ: ORDER_CARD=off)
    if (!placingOrder && !fromButton && process.env.ORDER_CARD !== 'off' && /অর্ডার\s*(করতে|করব|করবো|দিতে|দিব|দিবো|কার্ড|কাড)|কিনতে\s*চাই|নিতে\s*চাই|নিব|নিবো|নেব|নেবো|কিনব|কিনবো|order\s*(korbo|dibo|kora)|i want to (buy|order)/i.test(String(text || '')) && resolvedIds.length) {
      try {
        const oc = await shop.getProductCard(resolvedIds[0]);
        if (oc) {
          const link = await chatOrder.orderLink(customer.id, oc.id);
          const m0 = 'ভুল ছাড়া সহজে অর্ডার করতে নিচের কার্ডের "🛒 অর্ডার করুন" চাপুন 👇';
          await send(m0); await store.appendMessage(customer.id, 'assistant', m0);
          await sendOrderCard(platform, platformId, settings, oc, link);
          console.log(`🧾 অর্ডার কার্ড পাঠানো: ${platform}/${platformId}`);
        }
      } catch (e) { console.error('অর্ডার কার্ড (লেখা থেকে) এরর:', e.message); }
    }
    // ডেলিভারির পর অপেক্ষায় থাকা রিভিউ-কার্ড (২৪ ঘণ্টার সীমার ভেতরে এখন কাস্টমার আছেন)
    if (!placingOrder && customer.reviewPendingOrder) await engage.flushPendingReview(customer, settings);
  } catch (err) { console.error('কাস্টমার-ম্যানেজমেন্ট ধাপ এরর:', err.response && err.response.data ? JSON.stringify(err.response.data) : err.message); }

  // প্রতি ৫টা মেসেজে কাস্টমারের স্মৃতি নতুন করে লেখা (পেছনে — উত্তরের গতি কমায় না)
  const userCount = fullHistory.filter(h => h.role === 'user').length;
  if (userCount > 0 && userCount % 5 === 0) {
    summarizeCustomerMemory({ settings, previous: memory, history: [...fullHistory, { role: 'assistant', text: reply }], orders: orderLine })
      .then(m => m && store.setCustomerMemory(customer.id, m)).catch(() => {});
  }

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
      const dm = `এই অর্ডারটি আগেই নেওয়া হয়েছে — অর্ডার আইডি: ${duplicate.id}। নতুন করে অর্ডার করতে চাইলে জানান 🙏`;
      await store.appendMessage(customer.id, 'assistant', dm);
      await send(dm);
      return;
    }

    // দাম/প্রোডাক্ট/অপশন ওয়েবসাইট থেকে যাচাই — AI ভুল দাম বললেও সার্ভার ওয়েবসাইটের আসল দামই বসায়
    try {
      const item = await shop.resolveOrderItem(order);
      if (item) {
        if (!item.ok) {
          await store.appendMessage(customer.id, 'assistant', item.message);
          await send(item.message);
          return;
        }
        if (Number(order.price) !== item.unitPrice) console.warn(`AI-র দাম ৳${order.price} ছিল, ওয়েবসাইটের দাম ৳${item.unitPrice} — ঠিক করা হলো`);
        order.stockProduct = order.product; // অ্যাপের স্টক পেজে খোঁজার জন্য AI-র দেওয়া নামটা আলাদা রাখি
        order.price = item.unitPrice; order.product = item.label;
      }
    } catch (err) { console.error('ওয়েবসাইট থেকে দাম যাচাই করা যায়নি:', err.message); }

    // ওয়েবসাইটের লাইভ ডেলিভারি/COD নিয়ম মেনে চলছে কিনা সার্ভারে আবার যাচাই (AI ভুল করলেও নিয়মবিরুদ্ধ অর্ডার ঢুকবে না)
    try {
      const rules = await shop.getDeliveryRules();
      if (rules) {
        const proofId = await store.getLatestProof(customer.id, 24 * 3600e3).catch(() => '');
        const chk = delivery.checkChatOrder(rules, order, !!proofId);
        if (!chk.ok) {
          await store.appendMessage(customer.id, 'assistant', chk.message);
          await send(chk.message);
          return;
        }
        // TrxID সত্যিই কাস্টমার নিজে লিখেছে কিনা (AI বানিয়ে বসালে ধরা পড়ে)
        if (chk.payment !== 'cod') {
          const said = fullHistory.some(h => h.role === 'user' && String(h.text || '').toUpperCase().includes(String(chk.transactionId).toUpperCase())) || String(text || '').toUpperCase().includes(String(chk.transactionId).toUpperCase());
          if (!said) {
            const mm = 'পেমেন্টের ট্রানজেকশন আইডি (TrxID) টা আরেকবার নিজের হাতে লিখে পাঠাবেন? (বিকাশ/নগদের মেসেজে থাকে) 😊';
            await store.appendMessage(customer.id, 'assistant', mm); await send(mm); return;
          }
          order.paymentProof = proofId;
        }
        order.district = chk.district; order.payment = chk.payment; order.transactionId = chk.transactionId; order.shipping = chk.shipping; order.minPay = chk.minPay || 0;
      }
    } catch (err) { console.error('ডেলিভারি নিয়ম যাচাই করা যায়নি (অর্ডার আগের মতো চলছে):', err.message); }

    // মোবাইল নম্বর ১১ সংখ্যার ও সঠিক প্রিফিক্সের না হলে অর্ডার নেওয়া হবে না (স্টক আটকানোর আগেই)
    const goodPhone = delivery.normBdPhone(order.phone || customer.phone || '');
    if (!goodPhone) {
      const pm = 'দুঃখিত, আপনার মোবাইল নম্বরটি ঠিক মনে হচ্ছে না। বাংলাদেশি নম্বর ১১ সংখ্যার হয় এবং ০১ দিয়ে শুরু হয় (যেমন 01712345678)। সঠিক নম্বরটি আবার লিখে দেবেন? 🙏';
      await store.appendMessage(customer.id, 'assistant', pm);
      await send(pm);
      return;
    }
    order.phone = goodPhone;

    // বিকাশ/নগদ: কাস্টমারের দেওয়া TrxID আমার ফোনের SMS-এর সাথে মেলে কিনা (SMS_HOOK_KEY সেট থাকলে)
    let payVerified; let paidAmount = 0; let claimedTrx = '';
    if (order.payment && order.payment !== 'cod' && order.transactionId && payments.enabled()) {
      const tkey = 'chat:' + customer.id;
      const v = await payments.verify(order.transactionId, order.minPay || 0);
      let msg = '';
      if (v.state === 'ok') {
        if (await payments.claim(order.transactionId, 'chat:' + customer.id)) { payVerified = true; paidAmount = v.payment.amount; claimedTrx = order.transactionId; payments.clearTry(tkey); }
        else msg = 'এই ট্রানজেকশন আইডি দিয়ে আগেই একটি অর্ডার হয়েছে। নতুন পেমেন্টের আইডি দিলে অর্ডার কনফার্ম করব 🙏';
      } else if (v.state === 'used') {
        msg = 'এই ট্রানজেকশন আইডি দিয়ে আগেই একটি অর্ডার হয়েছে। নতুন পেমেন্টের আইডি দিলে অর্ডার কনফার্ম করব 🙏';
      } else if (v.state === 'low') {
        msg = `আপনার পেমেন্ট ৳${v.payment.amount} এসেছে, কিন্তু অর্ডারের জন্য কমপক্ষে ৳${order.minPay} দরকার। বাকি টাকা পাঠিয়ে নতুন TrxID দিতে পারবেন? 🙏`;
      } else if (payments.bumpTry(tkey) < 2) {
        msg = 'এই ট্রানজেকশন আইডি দিয়ে আমাদের নম্বরে কোনো পেমেন্ট পাইনি 😔 বিকাশ/নগদের মেসেজ থেকে TrxID টা হুবহু (অক্ষর-সংখ্যা মিলিয়ে) আরেকবার লিখে পাঠাবেন? আর টাকা আমাদের নম্বরে পাঠিয়েছেন কিনা দেখে নিন।';
      } else { payVerified = false; } // ২য় বারও না মিললে (SMS আসতে দেরি/ফরওয়ার্ডার বন্ধ হতে পারে) অর্ডার যাবে, কিন্তু "যাচাই-বাকি" চিহ্নসহ
      if (msg) { await store.appendMessage(customer.id, 'assistant', msg); await send(msg); return; }
    }

    const wantQty = Number(order.qty) || 1;

    // স্টক: আগে অ্যাপের স্টক পেজের সংখ্যা দেখি; সেখানে না থাকলে শিটের Stock কলাম
    const stockEntry = await store.findStockEntry(order.stockProduct || order.product);
    let reservedStock = null;
    if (stockEntry) {
      const dec = await store.decrementStock(stockEntry.name, wantQty);
      if (!dec.ok) {
        const outMsg = dec.qty > 0
          ? `দুঃখিত, "${order.product}" এখন মাত্র ${dec.qty}টি আছে। কম পরিমাণে নিতে চাইলে জানান।`
          : `দুঃখিত, "${order.product}" এই মুহূর্তে স্টকে নেই। অন্য কোনো প্রোডাক্ট দেখতে চান?`;
        await store.appendMessage(customer.id, 'assistant', outMsg);
        if (claimedTrx) await payments.release(claimedTrx, 'chat:' + customer.id);
        await send(outMsg);
        return;
      }
      reservedStock = { name: stockEntry.name, qty: dec.qty };
    } else {
      const stock = await getProductStock(settings.sheetLink, order.product);
      if (stock !== null && stock <= 0) {
        const outOfStockMsg = `দুঃখিত, "${order.product}" এই মুহূর্তে স্টকে নেই। অন্য কোনো প্রোডাক্ট দেখতে চান?`;
        await store.appendMessage(customer.id, 'assistant', outOfStockMsg);
        if (claimedTrx) await payments.release(claimedTrx, 'chat:' + customer.id);
        await send(outOfStockMsg);
        return;
      }
    }

    if (order.name || order.phone) {
      await store.updateCustomerContact(customer.id, { orderName: order.name, phone: order.phone });
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
        source: platform === 'email' ? 'Email' : platform === 'facebook' ? 'Messenger' : platform === 'instagram' ? 'Instagram' : platform === 'telegram' ? 'Telegram' : platform === 'tiktok' ? 'TikTok' : 'WhatsApp',
        stockItem: reservedStock ? reservedStock.name : '',
        district: order.district || '', payment: order.payment || '', transactionId: order.transactionId || '', shipping: order.shipping || 0,
        paymentProof: order.paymentProof || '',
        paymentVerified: payVerified, paidAmount
      });
      if (claimedTrx) payments.setRef(claimedTrx, savedOrder.id);
    } catch (err) {
      // অর্ডার সেভ না হলে আটকে রাখা স্টক ফেরত দিই
      if (reservedStock) await store.incrementStock(reservedStock.name, wantQty);
      if (claimedTrx) await payments.release(claimedTrx, 'chat:' + customer.id);
      throw err;
    }

    // মালিককে জানাই: নতুন অর্ডার, আর স্টক কমে গেলে আলাদা সতর্কতা
    await notifyOwner({
      type: 'order',
      title: `🛒 নতুন অর্ডার ${savedOrder.id}`,
      body: `${savedOrder.name} · ${savedOrder.product} x${savedOrder.qty} · ৳${(savedOrder.price || 0) * (savedOrder.qty || 1)}` + (savedOrder.paymentProof ? `\nপেমেন্ট স্ক্রিনশট: ${config.publicUrl}/webhook/proof/${savedOrder.paymentProof}` : '') + (savedOrder.paymentVerified === true ? `\n✅ পেমেন্ট SMS-এর সাথে মিলেছে (৳${savedOrder.paidAmount})` : savedOrder.paymentVerified === false ? '\n⚠️ TrxID আপনার SMS-এ পাওয়া যায়নি — পাঠানোর আগে নিজে মিলিয়ে নিন' : '')
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
    if (!getSlots(settings).length) {
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

    const sheetContext = await getSheetCtx(settings, message);
    const ownerRules = (await store.getAiRules()).map(r => r.text);
    const stockList = (await store.getStockList()).map(e => ({ name: e.name, qty: e.qty }));
    const shopContext = await shop.getAiContext(message);
    const { reply, handoff } = await getAIReplyWithFallback({
      settings, customerMessage: message, history, sheetContext, businessInfo, ownerRules, stockList, shopContext
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
