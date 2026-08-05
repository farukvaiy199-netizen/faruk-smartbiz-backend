const axios = require('axios');

async function sendFacebookMessage(recipientId, text, pageAccessToken) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${pageAccessToken}`;
  await axios.post(url, {
    recipient: { id: recipientId },
    message: { text }
  }, { timeout: 10000 });
}

// কাস্টমারের PSID দিয়ে তার নাম আনে (Messenger প্রোফাইল লিংক দেয় না, শুধু নাম/ছবি দেয়)
async function getFacebookProfile(psid, pageAccessToken) {
  try {
    const url = `https://graph.facebook.com/v19.0/${psid}?fields=first_name,last_name&access_token=${pageAccessToken}`;
    const res = await axios.get(url, { timeout: 8000 });
    const name = [res.data.first_name, res.data.last_name].filter(Boolean).join(' ');
    return name || null;
  } catch (err) {
    console.error('Facebook প্রোফাইল আনতে ব্যর্থ:', err.message);
    return null;
  }
}

module.exports = { sendFacebookMessage, getFacebookProfile };
