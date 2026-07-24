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

module.exports = { sendWhatsAppMessage };
