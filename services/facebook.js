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

/* ---------- পেজে পোস্ট (ছবিসহ) — এখনই অথবা ফেসবুকের নিজস্ব শিডিউলে ---------- */
const FormData = require('form-data');
const GRAPH = 'https://graph.facebook.com/v19.0';

function friendlyFbError(err) {
  const e = err.response && err.response.data && err.response.data.error;
  if (!e) return new Error(err.message);
  let msg = e.message || err.message;
  if (e.code === 190) msg = 'Facebook টোকেনের মেয়াদ শেষ — Settings থেকে Facebook আবার কানেক্ট করুন';
  else if (e.code === 200 || e.code === 10 || e.code === 299) msg = 'পোস্ট করার অনুমতি (pages_manage_posts) নেই — Settings থেকে Facebook আবার কানেক্ট করুন';
  const out = new Error(msg);
  out.fbError = e;
  return out;
}

async function uploadUnpublishedOrLivePhoto(token, buffer, fields) {
  const form = new FormData();
  form.append('source', buffer, { filename: 'post.jpg', contentType: 'image/jpeg' });
  form.append('access_token', token);
  Object.keys(fields).forEach(k => form.append(k, String(fields[k])));
  const res = await axios.post(`${GRAPH}/me/photos`, form, {
    headers: form.getHeaders(), timeout: 60000, maxBodyLength: Infinity, maxContentLength: Infinity
  });
  return res.data;
}

// scheduledAtMs না দিলে এখনই পোস্ট হয়। দিলে ফেসবুক নিজেই ঠিক সময়ে পোস্ট করে
// (আমাদের সার্ভার ঘুমিয়ে থাকলেও সমস্যা নেই)। ফেসবুকের নিয়ম: এখন থেকে ১০ মিনিট থেকে ৩০ দিনের মধ্যে।
async function publishPagePhoto({ token, caption, buffer, scheduledAtMs }) {
  try {
    if (!scheduledAtMs) {
      const r = await uploadUnpublishedOrLivePhoto(token, buffer, { caption });
      return { fbPostId: r.post_id || r.id, fbPhotoId: r.id };
    }
    const photo = await uploadUnpublishedOrLivePhoto(token, buffer, { published: 'false' });
    const params = new URLSearchParams();
    params.append('message', caption);
    params.append('attached_media[0]', JSON.stringify({ media_fbid: photo.id }));
    params.append('published', 'false');
    params.append('scheduled_publish_time', String(Math.floor(scheduledAtMs / 1000)));
    params.append('access_token', token);
    const res = await axios.post(`${GRAPH}/me/feed`, params, { timeout: 30000 });
    return { fbPostId: res.data.id, fbPhotoId: photo.id };
  } catch (err) {
    throw friendlyFbError(err);
  }
}

async function deleteFbPost({ token, id }) {
  try {
    await axios.delete(`${GRAPH}/${id}`, { params: { access_token: token }, timeout: 15000 });
  } catch (err) {
    throw friendlyFbError(err);
  }
}

module.exports = { sendFacebookMessage, sendFacebookImage, getFacebookProfile, downloadMedia, publishPagePhoto, deleteFbPost };
