// Instagram: পোস্ট করা, মেসেজ পাঠানো, কাস্টমারের প্রোফাইল আনা।
// আপনার Instagram অ্যাকাউন্ট Facebook পেজের সাথে যুক্ত, তাই পেজের একই টোকেন দিয়ে এগুলো চলে।
const axios = require('axios');
const GRAPH = 'https://graph.facebook.com/v19.0';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function igError(err) {
  const e = err.response && err.response.data && err.response.data.error;
  if (!e) return new Error(err.message);
  let msg = e.error_user_msg || e.message || err.message;
  if (e.code === 190) msg = 'Facebook টোকেনের মেয়াদ শেষ — Settings থেকে Facebook আবার কানেক্ট করুন';
  else if (e.code === 10 || e.code === 200 || e.code === 299) msg = 'Instagram-এর অনুমতি নেই — পোস্ট ট্যাবের "Instagram অনুমতি দিন" বাটন চাপুন';
  else if (e.code === 9004 || e.code === 9007) msg = 'Instagram ছবিটা ডাউনলোড বা গ্রহণ করতে পারেনি (' + (e.error_user_msg || e.message) + ')';
  const out = new Error(msg);
  out.igError = e;
  return out;
}

// পেজের সাথে যুক্ত Instagram অ্যাকাউন্টের আইডি ও ইউজারনেম খুঁজে বের করে
async function detectInstagramAccount(token, pageId) {
  try {
    const res = await axios.get(`${GRAPH}/${pageId || 'me'}`, {
      params: { fields: 'instagram_business_account{id,username}', access_token: token }, timeout: 15000
    });
    const ig = res.data && res.data.instagram_business_account;
    return ig && ig.id ? { igUserId: ig.id, igUsername: ig.username || '' } : null;
  } catch (err) {
    throw igError(err);
  }
}

// পেজ এই অ্যাপের মেসেজ-ওয়েবহুকে সাবস্ক্রাইব করা আছে কিনা দেখে; "messages" না থাকলে যোগ করে (আগের ফিল্ডগুলো রেখেই)।
// ফলাফল: { fields: [...], changed: bool, error: string|null } — কখনো এরর ছোঁড়ে না
async function ensurePageSubscription(token, pageId) {
  const target = pageId || 'me';
  try {
    const cur = await axios.get(`${GRAPH}/${target}/subscribed_apps`, { params: { access_token: token }, timeout: 15000 });
    const apps = (cur.data && cur.data.data) || [];
    const fields = apps.length ? (apps[0].subscribed_fields || []) : [];
    if (fields.includes('messages')) return { fields, changed: false, error: null };
    const merged = Array.from(new Set(fields.concat(['messages', 'messaging_postbacks'])));
    await axios.post(`${GRAPH}/${target}/subscribed_apps`,
      new URLSearchParams({ subscribed_fields: merged.join(','), access_token: token }), { timeout: 15000 });
    return { fields: merged, changed: true, error: null };
  } catch (err) {
    const e = err.response && err.response.data && err.response.data.error;
    return { fields: [], changed: false, error: (e && e.message) || err.message };
  }
}

// ছবি (JPEG, পাবলিক লিংক) → মিডিয়া কনটেইনার → পাবলিশ
async function publishInstagramPhoto({ token, igUserId, imageUrl, caption }) {
  try {
    const body = new URLSearchParams({ image_url: imageUrl, caption: String(caption || '').slice(0, 2200), access_token: token });
    const c = await axios.post(`${GRAPH}/${igUserId}/media`, body, { timeout: 30000 });
    const creationId = c.data.id;

    for (let i = 0; i < 10; i++) {
      let code = 'FINISHED';
      try {
        const st = await axios.get(`${GRAPH}/${creationId}`, { params: { fields: 'status_code', access_token: token }, timeout: 15000 });
        code = st.data.status_code || 'FINISHED';
      } catch (e) { break; } // স্ট্যাটাস না পেলেও সরাসরি পাবলিশ চেষ্টা করি
      if (code === 'FINISHED') break;
      if (code === 'ERROR' || code === 'EXPIRED') throw new Error('Instagram ছবিটা গ্রহণ করেনি (' + code + ')');
      await sleep(2000);
    }

    const p = await axios.post(`${GRAPH}/${igUserId}/media_publish`,
      new URLSearchParams({ creation_id: creationId, access_token: token }), { timeout: 30000 });
    return { igMediaId: p.data.id };
  } catch (err) {
    throw err.igError ? err : (err.response ? igError(err) : err);
  }
}

// Instagram মেসেজের টেক্সট সীমা ১০০০ বাইট (বাংলা অক্ষর ৩ বাইট) — তাই লম্বা উত্তর ভেঙে পাঠাতে হয়
function chunkByBytes(text, max = 900) {
  const out = [];
  let cur = '';
  const flush = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  const addPiece = (piece, sep) => {
    const cand = cur ? cur + sep + piece : piece;
    if (Buffer.byteLength(cand) <= max) { cur = cand; return; }
    flush();
    if (Buffer.byteLength(piece) <= max) { cur = piece; return; }
    let rest = piece;
    while (rest.length) {
      let n = rest.length;
      while (n > 1 && Buffer.byteLength(rest.slice(0, n)) > max) n--;
      out.push(rest.slice(0, n));
      rest = rest.slice(n);
    }
  };
  String(text).split('\n').forEach(line => {
    if (Buffer.byteLength(line) <= max) addPiece(line, '\n');
    else line.split(' ').forEach(w => addPiece(w, ' '));
  });
  flush();
  return out;
}

async function sendInstagramMessage(igsid, text, token) {
  const parts = chunkByBytes(text);
  for (const part of parts) {
    await axios.post(`${GRAPH}/me/messages`, {
      recipient: { id: igsid }, message: { text: part }, messaging_type: 'RESPONSE'
    }, { params: { access_token: token }, timeout: 15000 });
  }
}

async function sendInstagramImage(igsid, imageUrl, token) {
  await axios.post(`${GRAPH}/me/messages`, {
    recipient: { id: igsid },
    message: { attachment: { type: 'image', payload: { url: imageUrl } } },
    messaging_type: 'RESPONSE'
  }, { params: { access_token: token }, timeout: 20000 });
}

async function getInstagramProfile(igsid, token) {
  try {
    const res = await axios.get(`${GRAPH}/${igsid}`, {
      params: { fields: 'name,username,profile_pic', access_token: token }, timeout: 8000
    });
    return { name: res.data.name || res.data.username || null, username: res.data.username || '', photoUrl: res.data.profile_pic || null };
  } catch (err) {
    console.error('Instagram প্রোফাইল আনতে ব্যর্থ:', err.response && err.response.data ? JSON.stringify(err.response.data) : err.message);
    return { name: null, username: '', photoUrl: null };
  }
}

module.exports = { ensurePageSubscription, detectInstagramAccount, publishInstagramPhoto, sendInstagramMessage, sendInstagramImage, getInstagramProfile, chunkByBytes, igError };
