// Telegram বট: (১) কাস্টমারের সাথে AI চ্যাট ও মালিকের সহকারী (২) পোস্ট করলে চ্যানেলেও যাওয়া।
// টোকেন শুধু অ্যাপের সেটিংস থেকে বসে (ডেটাবেসে থাকে, কখনো অ্যাপে ফেরত যায় না)।
const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');
const store = require('./store');

const API = 'https://api.telegram.org';
const clip = (s, n) => String(s || '').slice(0, n);

function errMsg(err) {
  const d = err && err.response && err.response.data;
  return clip((d && d.description) || (err && err.message) || err, 200);
}

async function call(token, method, body, timeout = 15000) {
  try {
    const r = await axios.post(`${API}/bot${token}/${method}`, body || {}, { timeout });
    return r.data && r.data.result;
  } catch (err) { throw new Error(errMsg(err)); }
}

// ওয়েবহুকের গোপন কী — টোকেন থেকে নিজে বানানো, তাই আলাদা কিছু মনে রাখতে হয় না
function secretFor(token) {
  return crypto.createHmac('sha256', String(token)).update('smartbiz-telegram').digest('hex').slice(0, 40);
}
function checkSecret(token, header) {
  if (!token || !header) return false;
  const a = Buffer.from(secretFor(token)), b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normChannel(c) {
  let s = String(c || '').trim().replace(/^https?:\/\/t\.me\//i, '');
  if (!s) return '';
  if (/^-?\d+$/.test(s)) return s;
  return s.startsWith('@') ? s : '@' + s;
}

/* ---------- পাঠানো ---------- */
async function sendMessage(token, chatId, text) {
  const t = String(text || '');
  for (let i = 0; i < t.length || i === 0; i += 4000) {
    await call(token, 'sendMessage', { chat_id: chatId, text: t.slice(i, i + 4000), disable_web_page_preview: false });
  }
}
async function sendPhoto(token, chatId, url, caption) {
  await call(token, 'sendPhoto', { chat_id: chatId, photo: url, caption: clip(caption, 1000) }, 25000);
}
function typing(token, chatId) {
  call(token, 'sendChatAction', { chat_id: chatId, action: 'typing' }, 5000).catch(() => {});
}
// Telegram থেকে আসা ফাইল (ছবি/ভয়েস) নামানো
async function downloadFile(token, fileId) {
  const f = await call(token, 'getFile', { file_id: fileId });
  const r = await axios.get(`${API}/file/bot${token}/${f.file_path}`, { responseType: 'arraybuffer', timeout: 20000, maxContentLength: 15 * 1024 * 1024 });
  return Buffer.from(r.data);
}

/* ---------- সংযোগ ---------- */
async function connect({ token, channel }) {
  token = String(token || '').trim();
  if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token)) throw new Error('টোকেনটা সঠিক মনে হচ্ছে না — @BotFather-এর দেওয়া পুরো টোকেন পেস্ট করুন');
  if (!config.publicUrl) throw new Error('সার্ভারের পাবলিক ঠিকানা (PUBLIC_URL) সেট করা নেই');
  const me = await call(token, 'getMe');
  await call(token, 'setWebhook', {
    url: `${config.publicUrl}/webhook/telegram`,
    secret_token: secretFor(token),
    allowed_updates: ['message'],
    drop_pending_updates: true
  });
  const patch = { tgToken: token, tgBotUsername: me.username || '', tgBotId: me.id };
  let note = '';
  const ch = normChannel(channel);
  if (ch) {
    try {
      const chat = await call(token, 'getChat', { chat_id: ch });
      const mem = await call(token, 'getChatMember', { chat_id: chat.id, user_id: me.id });
      if (mem.status !== 'administrator' && mem.status !== 'creator') note = 'চ্যানেলে বটকে Admin বানাতে হবে (পোস্ট করার অনুমতিসহ)।';
      else if (mem.can_post_messages === false) note = 'বটকে চ্যানেলে "Post messages" অনুমতি দিন।';
      patch.tgChannel = String(chat.id);
      patch.tgChannelTitle = chat.title || ch;
    } catch (e) {
      patch.tgChannel = ch; patch.tgChannelTitle = ch;
      note = 'চ্যানেলটা পাওয়া যায়নি (' + e.message + ') — নাম ঠিক আছে কিনা আর বট Admin কিনা দেখুন।';
    }
  } else { patch.tgChannel = ''; patch.tgChannelTitle = ''; }
  await store.saveSettings(patch);
  return { bot: me.username, channel: patch.tgChannelTitle || '', note };
}

async function disconnect() {
  const s = await store.getSettings();
  if (s.tgToken) await call(s.tgToken, 'deleteWebhook', { drop_pending_updates: true }).catch(() => {});
  await store.saveSettings({ tgToken: '', tgBotUsername: '', tgBotId: 0, tgChannel: '', tgChannelTitle: '' });
}

async function status() {
  const s = await store.getSettings();
  const out = { connected: !!s.tgToken, bot: s.tgBotUsername || '', channel: s.tgChannelTitle || '', autoPost: s.tgAutoPost !== false, checks: [] };
  if (!s.tgToken) return out;
  try {
    const w = await call(s.tgToken, 'getWebhookInfo');
    const want = `${config.publicUrl}/webhook/telegram`;
    out.checks.push({ ok: w.url === want, msg: w.url === want ? 'বট সার্ভারের সাথে যুক্ত' : 'ওয়েবহুক ঠিক নেই — আবার "সংযুক্ত করুন" চাপুন' });
    if (w.last_error_message) out.checks.push({ ok: false, msg: 'সর্বশেষ ত্রুটি: ' + clip(w.last_error_message, 120) });
  } catch (e) { out.checks.push({ ok: false, msg: 'টোকেন কাজ করছে না: ' + e.message }); }
  if (s.tgChannel) {
    try {
      const mem = await call(s.tgToken, 'getChatMember', { chat_id: s.tgChannel, user_id: s.tgBotId });
      const ok = (mem.status === 'administrator' || mem.status === 'creator') && mem.can_post_messages !== false;
      out.checks.push({ ok, msg: ok ? 'চ্যানেলে পোস্ট করার অনুমতি আছে' : 'বটকে চ্যানেলে Admin (Post messages) বানান' });
    } catch (e) { out.checks.push({ ok: false, msg: 'চ্যানেল দেখা যাচ্ছে না: ' + e.message }); }
  }
  return out;
}

/* ---------- চ্যানেলে পোস্ট ---------- */
async function sendToChannel(settings, caption, photoUrl) {
  const token = settings.tgToken, chat = settings.tgChannel;
  if (photoUrl) {
    if (String(caption).length <= 1000) { await sendPhoto(token, chat, photoUrl, caption); return; }
    await sendPhoto(token, chat, photoUrl, '');
  }
  await sendMessage(token, chat, caption);
}

// পোস্টের রেকর্ডে বসানোর ক্ষেত্র। চ্যানেল সংযুক্ত না থাকলে {} — কিছুই বদলায় না।
async function postFields(settings, { buffer, whenMs } = {}) {
  if (!settings.tgToken || !settings.tgChannel || settings.tgAutoPost === false) return {};
  let tgMediaId = '';
  if (buffer) tgMediaId = await store.addPostMedia({ mime: 'image/jpeg', b64: buffer.toString('base64') });
  return { tgStatus: whenMs ? 'pending' : 'publishing', tgDueAt: new Date(whenMs || Date.now()).toISOString(), tgMediaId };
}

// কখনো এরর ছোঁড়ে না — ফলাফল পোস্টের রেকর্ডে লেখে
async function publishTgJob(job, settings) {
  try {
    if (!settings.tgToken || !settings.tgChannel) throw new Error('Telegram চ্যানেল সংযুক্ত নেই');
    const url = job.tgMediaId ? `${config.publicUrl}/pmedia/${job.tgMediaId}.jpg` : '';
    await sendToChannel(settings, job.caption, url);
    await store.updatePost(job.id, { tgStatus: 'published', tgError: '' });
    if (job.tgMediaId) await store.deletePostMedia(job.tgMediaId);
    return { ok: true };
  } catch (err) {
    const msg = clip(err.message || err, 200);
    await store.updatePost(job.id, { tgStatus: 'failed', tgError: msg }).catch(() => {});
    if (job.tgMediaId) await store.deletePostMedia(job.tgMediaId).catch(() => {});
    return { ok: false, error: msg };
  }
}

async function runDue() {
  let done = 0;
  for (let i = 0; i < 5; i++) {
    const job = await store.claimDueTgPost();
    if (!job) break;
    done++;
    await publishTgJob(job, await store.getSettings());
  }
  return done;
}

async function sendTest() {
  const s = await store.getSettings();
  if (!s.tgToken) throw new Error('আগে বট সংযুক্ত করুন');
  if (!s.tgChannel) throw new Error('চ্যানেলের নাম দেওয়া নেই');
  await sendMessage(s.tgToken, s.tgChannel, '✅ টেস্ট: Faruk\'s SmartBiz থেকে এই চ্যানেলে পোস্ট যাচ্ছে।');
}

module.exports = {
  call, secretFor, checkSecret, normChannel, sendMessage, sendPhoto, typing, downloadFile,
  connect, disconnect, status, postFields, publishTgJob, runDue, sendTest
};
