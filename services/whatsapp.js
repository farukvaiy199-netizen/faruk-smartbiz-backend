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

// প্রোডাক্টের ছবি পাঠানোর জন্য (নতুন ফিচার)
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

module.exports = { sendWhatsAppMessage, sendWhatsAppImage };
