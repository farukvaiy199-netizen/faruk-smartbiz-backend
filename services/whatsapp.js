const axios = require('axios');

async function sendWhatsAppMessage(to, text, phoneNumberId, token) {
  const url = `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`;
  await axios.post(url, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text }
  }, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 10000
  });
}

// প্রোডাক্টের ছবি পাঠানোর জন্য
async function sendWhatsAppImage(to, imageUrl, phoneNumberId, token, caption) {
  const url = `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`;
  await axios.post(url, {
    messaging_product: 'whatsapp',
    to,
    type: 'image',
    image: { link: imageUrl, caption: caption || '' }
  }, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15000
  });
}

// WhatsApp-এ কাস্টমারের পাঠানো ছবি/ভয়েস মেসেজ সরাসরি লিংক আকারে আসে না, শুধু একটা media ID আসে।
// প্রথমে সেই ID দিয়ে আসল (সাময়িক) ডাউনলোড লিংক আনতে হয়, তারপর টোকেন দিয়ে সেই লিংক থেকে ফাইল আনতে হয়।
async function getWhatsAppMediaBuffer(mediaId, token) {
  const metaRes = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 10000
  });
  const mediaUrl = metaRes.data.url;
  const mimeType = metaRes.data.mime_type;

  const fileRes = await axios.get(mediaUrl, {
    headers: { Authorization: `Bearer ${token}` },
    responseType: 'arraybuffer',
    timeout: 20000
  });

  return { buffer: Buffer.from(fileRes.data), mimeType };
}

module.exports = { sendWhatsAppMessage, sendWhatsAppImage, getWhatsAppMediaBuffer };
