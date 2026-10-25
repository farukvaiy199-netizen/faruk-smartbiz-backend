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

// কাস্টমারের PSID দিয়ে তার নাম ও প্রোফাইল ছবি আনে।
// প্রথমে সরাসরি প্রোফাইল চেষ্টা করে; না পেলে কথোপকথনের তালিকা থেকে নাম খুঁজে দেখে।
// Meta অনেক সময় (বিশেষ করে অ্যাপ Live না থাকলে) সবার প্রোফাইল দেয় না — কারণটা লগে স্পষ্ট লেখা থাকবে।
async function getFacebookProfile(psid, pageAccessToken) {
  try {
    const url = `https://graph.facebook.com/v19.0/${psid}?fields=first_name,last_name,profile_pic&access_token=${pageAccessToken}`;
    const res = await axios.get(url, { timeout: 8000 });
    const name = [res.data.first_name, res.data.last_name].filter(Boolean).join(' ');
    if (name || res.data.profile_pic) return { name: name || null, photoUrl: res.data.profile_pic || null };
  } catch (err) {
    console.error('Facebook প্রোফাইল আনতে ব্যর্থ:', err.response && err.response.data ? JSON.stringify(err.response.data) : err.message);
  }

  try {
    const url = `https://graph.facebook.com/v19.0/me/conversations?fields=participants&user_id=${psid}&access_token=${pageAccessToken}`;
    const res = await axios.get(url, { timeout: 8000 });
    const participants = (res.data && res.data.data && res.data.data[0] && res.data.data[0].participants && res.data.data[0].participants.data) || [];
    const person = participants.find(p => p.id === psid);
    if (person && person.name) return { name: person.name, photoUrl: null };
  } catch (err) {
    console.error('Facebook কথোপকথন থেকে নাম আনতে ব্যর্থ:', err.response && err.response.data ? JSON.stringify(err.response.data) : err.message);
  }
  return { name: null, photoUrl: null };
}

// Messenger-এ পাঠানো ছবি/ভয়েস মেসেজের attachment URL সরাসরি পাবলিক CDN লিংক —
// টোকেন ছাড়াই ডাউনলোড করা যায় (WhatsApp-এর মতো আলাদা মিডিয়া-আইডি এক্সচেঞ্জ লাগে না)
async function downloadMedia(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
  return Buffer.from(res.data);
}

module.exports = { sendFacebookMessage, sendFacebookImage, getFacebookProfile, downloadMedia };
