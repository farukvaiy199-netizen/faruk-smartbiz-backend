const axios = require('axios');

async function sendFacebookMessage(recipientId, text, pageAccessToken) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${pageAccessToken}`;
  await axios.post(url, {
    recipient: { id: recipientId },
    message: { text }
  }, { timeout: 10000 });
}

// প্রোডাক্টের ছবি পাঠানোর জন্য
async function sendFacebookImage(recipientId, imageUrl, pageAccessToken) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${pageAccessToken}`;
  await axios.post(url, {
    recipient: { id: recipientId },
    message: {
      attachment: {
        type: 'image',
        payload: { url: imageUrl, is_reusable: true }
      }
    }
  }, { timeout: 15000 });
}

// কাস্টমারের PSID দিয়ে তার নাম ও প্রোফাইল ছবি আনে (নতুন: profile_pic যোগ হয়েছে)
async function getFacebookProfile(psid, pageAccessToken) {
  try {
    const url = `https://graph.facebook.com/v19.0/${psid}?fields=first_name,last_name,profile_pic&access_token=${pageAccessToken}`;
    const res = await axios.get(url, { timeout: 8000 });
    const name = [res.data.first_name, res.data.last_name].filter(Boolean).join(' ');
    return { name: name || null, photoUrl: res.data.profile_pic || null };
  } catch (err) {
    console.error('Facebook প্রোফাইল আনতে ব্যর্থ:', err.message);
    return { name: null, photoUrl: null };
  }
}

// Messenger-এ পাঠানো ছবি/ভয়েস মেসেজের attachment URL সরাসরি পাবলিক CDN লিংক —
// টোকেন ছাড়াই ডাউনলোড করা যায় (WhatsApp-এর মতো আলাদা মিডিয়া-আইডি এক্সচেঞ্জ লাগে না)
async function downloadMedia(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
  return Buffer.from(res.data);
}

module.exports = { sendFacebookMessage, sendFacebookImage, getFacebookProfile, downloadMedia };
