const axios = require('axios');

async function sendFacebookMessage(recipientId, text, pageAccessToken) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${pageAccessToken}`;
  await axios.post(url, {
    recipient: { id: recipientId },
    message: { text }
  }, { timeout: 10000 });
}

module.exports = { sendFacebookMessage };
