// TikTok: (১) ছবির পোস্ট — Content Posting API (অফিসিয়াল ডক অনুযায়ী)
//         (২) ইনবক্স মেসেজের স্বয়ংক্রিয় উত্তর — Business Messaging API
// ⚠️ (২)-এর সঠিক এন্ডপয়েন্ট/ফিল্ডের নাম TikTok-এর পাবলিক ডকে পুরো পাওয়া যায়নি (অনুমোদনের পরে খোলে)।
//    তাই নিচের MSG ব্লকে অনুমানভিত্তিক ডিফল্ট আছে, যা অ্যাপ থেকে বদলানো যায়। অনুমোদন পেলে ডকের সাথে মিলিয়ে নিতে হবে।
const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');
const store = require('./store');

const OPEN = 'https://open.tiktokapis.com';
const clip = (s, n) => String(s || '').slice(0, n);

const MSG = {
  sendUrl: 'https://business-api.tiktok.com/open_api/v1.3/business/message/send/', // অনুমান — অ্যাপ থেকে বদলানো যায়
};

function errMsg(err) {
  const d = err && err.response && err.response.data;
  const e = d && (d.error || d);
  return clip((e && (e.message || e.error_description || e.description)) || (err && err.message) || err, 220);
}

// TikTok-এর ত্রুটির কোড/লেখা বুঝে সহজ বাংলা পরামর্শ
function hint(err) {
  const d = err && err.response && err.response.data;
  const code = (err && err.tkCode) || (d && d.error && d.error.code) || '';
  const raw = errMsg(err);
  if (code === 'unaudited_client_can_only_post_to_private_accounts' || /content-sharing-guidelines/.test(raw))
    return 'TikTok অ্যাকাউন্ট "Private" করুন — অডিট না হওয়া অ্যাপ শুধু প্রাইভেট অ্যাকাউন্টে পোস্ট করতে পারে (Settings and privacy → Privacy → Private account)। [' + (code || 'guidelines') + ']';
  if (code === 'url_ownership_unverified') return 'ছবির ডোমেইন TikTok-এ যাচাই হয়নি — URL properties-এ https://faruk-smartbiz-backend-1.onrender.com/ Verify করুন (Sandbox অ্যাপেও)। [' + code + ']';
  if (code === 'scope_not_authorized' || code === 'access_token_invalid') return 'অনুমতি/টোকেনে সমস্যা — Settings → TikTok থেকে আবার "অ্যাকাউন্ট যুক্ত করুন" চাপুন। [' + code + ']';
  if (code === 'spam_risk_too_many_posts' || code === 'rate_limit_exceeded') return 'TikTok কিছুক্ষণ পোস্ট নিচ্ছে না — একটু পরে চেষ্টা করুন। [' + code + ']';
  return code && !raw.includes(code) ? raw + ' [' + code + ']' : raw;
}

async function getDb() { return store.getDb(); }
async function metaGet(id) { const db = await getDb(); const d = await db.collection('meta').findOne({ _id: id }); if (!d) return null; const { _id, ...r } = d; return r; }
async function metaSet(id, patch) { const db = await getDb(); await db.collection('meta').updateOne({ _id: id }, { $set: patch }, { upsert: true }); }

const redirectUri = () => `${config.publicUrl}/webhook/tiktok/callback`;

// ওয়েবহুকের গোপন অংশ (লিংকে থাকে) — প্রথমবার নিজে তৈরি হয়
async function hookKey() {
  let s = await store.getSettings();
  if (!s.tkHookKey) { const k = crypto.randomBytes(12).toString('hex'); await store.saveSettings({ tkHookKey: k }); return k; }
  return s.tkHookKey;
}
async function checkHookKey(key) {
  const s = await store.getSettings();
  if (!s.tkHookKey || !key) return false;
  const a = Buffer.from(s.tkHookKey), b = Buffer.from(String(key));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------- লগইন (OAuth) ---------- */
async function authUrl() {
  const s = await store.getSettings();
  if (!s.tkClientKey || !s.tkClientSecret) throw new Error('আগে Client Key ও Client Secret সংরক্ষণ করুন');
  const state = crypto.randomBytes(12).toString('hex');
  await metaSet('tkstate', { state, at: Date.now() });
  const q = new URLSearchParams({ client_key: s.tkClientKey, scope: 'user.info.basic,video.publish', response_type: 'code', redirect_uri: redirectUri(), state });
  return 'https://www.tiktok.com/v2/auth/authorize/?' + q.toString();
}

async function tokenCall(form) {
  try {
    const r = await axios.post(`${OPEN}/v2/oauth/token/`, new URLSearchParams(form).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000 });
    const d = r.data || {};
    if (d.error && d.error !== 'ok') throw new Error(d.error_description || d.error);
    if (!d.access_token) throw new Error(d.error_description || 'TikTok টোকেন দেয়নি');
    return d;
  } catch (err) { throw new Error(errMsg(err)); }
}

async function handleCallback({ code, state, error }) {
  if (error) throw new Error('TikTok অনুমতি দেওয়া হয়নি: ' + error);
  const st = await metaGet('tkstate');
  if (!st || !state || st.state !== state || Date.now() - st.at > 15 * 60000) throw new Error('লিংকের মেয়াদ শেষ — অ্যাপ থেকে আবার "TikTok যুক্ত করুন" চাপুন');
  await metaSet('tkstate', { state: '', at: 0 });
  const s = await store.getSettings();
  const d = await tokenCall({ client_key: s.tkClientKey, client_secret: s.tkClientSecret, code: String(code || ''), grant_type: 'authorization_code', redirect_uri: redirectUri() });
  const patch = { tkAccessToken: d.access_token, tkRefreshToken: d.refresh_token || '', tkExpiresAt: Date.now() + (Number(d.expires_in) || 86400) * 1000, tkOpenId: d.open_id || '' };
  await store.saveSettings(patch);
  try {
    const r = await axios.get(`${OPEN}/v2/user/info/`, { params: { fields: 'open_id,display_name' }, headers: { Authorization: 'Bearer ' + d.access_token }, timeout: 15000 });
    const u = r.data && r.data.data && r.data.data.user;
    if (u) await store.saveSettings({ tkDisplayName: u.display_name || '' });
  } catch (e) { /* নাম না এলেও সংযোগ ঠিক */ }
  return true;
}

async function accessToken() {
  const s = await store.getSettings();
  if (!s.tkAccessToken) throw new Error('TikTok অ্যাকাউন্ট যুক্ত নেই');
  if (s.tkExpiresAt && s.tkExpiresAt - Date.now() > 5 * 60000) return s.tkAccessToken;
  if (!s.tkRefreshToken) throw new Error('TikTok-এর মেয়াদ শেষ — আবার যুক্ত করুন');
  const d = await tokenCall({ client_key: s.tkClientKey, client_secret: s.tkClientSecret, grant_type: 'refresh_token', refresh_token: s.tkRefreshToken });
  await store.saveSettings({ tkAccessToken: d.access_token, tkRefreshToken: d.refresh_token || s.tkRefreshToken, tkExpiresAt: Date.now() + (Number(d.expires_in) || 86400) * 1000 });
  return d.access_token;
}

async function api(path, body) {
  const token = await accessToken();
  try {
    const r = await axios.post(OPEN + path, body || {}, { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=UTF-8' }, timeout: 25000 });
    const d = r.data || {};
    if (d.error && d.error.code && d.error.code !== 'ok') { const e = new Error(d.error.message || d.error.code); e.tkCode = d.error.code; throw e; }
    return d.data || {};
  } catch (err) { const e = new Error(hint(err)); throw e; }
}

/* ---------- ছবির পোস্ট ---------- */
const connectedForPost = s => !!(s.tkAccessToken && s.tkAutoPost !== false);

async function pickPrivacy() {
  const info = await api('/v2/post/publish/creator_info/query/', {});
  const opts = info.privacy_level_options || [];
  const s = await store.getSettings();
  // TikTok-এর নিয়ম: অডিট না হওয়া অ্যাপের সব পোস্ট শুধু SELF_ONLY ("শুধু আমি") হতে হবে, নইলে ত্রুটি আসে।
  // অডিট পাস হলে অ্যাপে টিক দিলে তখন PUBLIC_TO_EVERYONE যাবে।
  if (s.tkAudited && opts.includes('PUBLIC_TO_EVERYONE')) return 'PUBLIC_TO_EVERYONE';
  return 'SELF_ONLY';
}

async function postFields(settings, { buffer, whenMs } = {}) {
  if (!connectedForPost(settings)) return {};
  if (!buffer) return { tkStatus: 'skipped', tkError: 'TikTok-এ ছবি লাগে' };
  const tkMediaId = await store.addPostMedia({ mime: 'image/jpeg', b64: buffer.toString('base64') });
  return { tkStatus: whenMs ? 'pending' : 'publishing', tkDueAt: new Date(whenMs || Date.now()).toISOString(), tkMediaId };
}

async function cleanup(job) { if (job.tkMediaId) await store.deletePostMedia(job.tkMediaId).catch(() => {}); }

// কখনো এরর ছোঁড়ে না
async function publishTkJob(job) {
  try {
    if (!job.tkMediaId) throw new Error('ছবি পাওয়া যায়নি');
    const privacy = await pickPrivacy();
    const caption = String(job.caption || '');
    const title = clip(caption.split('\n')[0], 90);
    const d = await api('/v2/post/publish/content/init/', {
      media_type: 'PHOTO', post_mode: 'DIRECT_POST',
      post_info: { title, description: clip(caption, 4000), privacy_level: privacy, disable_comment: false, auto_add_music: true },
      source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: [`${config.publicUrl}/pmedia/${job.tkMediaId}.jpg`] }
    });
    // TikTok ছবিটা পরে নিজে টেনে নেয় — তাই ছবি এখনই মুছি না; অবস্থা যাচাইয়ের সময় মুছব
    await store.updatePost(job.id, { tkStatus: 'submitted', tkPublishId: d.publish_id || '', tkPrivacy: privacy, tkError: '', tkSubmittedAt: Date.now() });
    return { ok: true };
  } catch (err) {
    const msg = clip(err.message || err, 200);
    await store.updatePost(job.id, { tkStatus: 'failed', tkError: msg }).catch(() => {});
    await cleanup(job);
    return { ok: false, error: msg };
  }
}

async function checkSubmitted() {
  const db = await getDb();
  const jobs = await db.collection('posts').find({ tkStatus: 'submitted' }).limit(5).toArray();
  for (const j of jobs) {
    try {
      const d = await api('/v2/post/publish/status/fetch/', { publish_id: j.tkPublishId });
      const st = String(d.status || '');
      if (st === 'PUBLISH_COMPLETE') { await store.updatePost(j.id, { tkStatus: 'published' }); await cleanup(j); }
      else if (st === 'FAILED') { await store.updatePost(j.id, { tkStatus: 'failed', tkError: clip(d.fail_reason || 'TikTok পোস্ট করতে পারেনি', 200) }); await cleanup(j); }
      else if (Date.now() - (j.tkSubmittedAt || 0) > 2 * 3600000) { await store.updatePost(j.id, { tkStatus: 'failed', tkError: 'অনেকক্ষণ অপেক্ষার পরও নিশ্চিত হয়নি — TikTok-এ দেখে নিন' }); await cleanup(j); }
    } catch (e) { /* পরের পিংয়ে আবার */ }
  }
  return jobs.length;
}

async function runDue() {
  const s = await store.getSettings();
  if (!s.tkAccessToken) return 0;
  let done = 0;
  for (let i = 0; i < 3; i++) {
    const job = await store.claimDueTkPost();
    if (!job) break;
    done++;
    await publishTkJob(job);
  }
  await checkSubmitted().catch(() => {});
  return done;
}

/* ---------- মেসেজ ---------- */
// আসা ওয়েবহুক থেকে সম্ভাব্য সব আকারে (গভীরে খুঁজে) টেক্সট, প্রেরক ও কথোপকথনের আইডি বের করা
function walk(o, fn, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 6) return;
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string' && /^[\[{]/.test(v.trim())) { try { walk(JSON.parse(v), fn, depth + 1); } catch (e) { /* স্ট্রিং */ } }
    fn(k, v);
    if (v && typeof v === 'object') walk(v, fn, depth + 1);
  }
}
function parseInbound(body) {
  const out = { text: '', userId: '', conversationId: '', messageId: '', imageUrl: '', fromBusiness: false };
  walk(body, (k, v) => {
    const key = k.toLowerCase();
    if (typeof v === 'string' || typeof v === 'number') {
      const sv = String(v);
      if (!out.text && /^(text|message_text|content_text|body)$/.test(key) && typeof v === 'string') out.text = sv;
      else if (!out.userId && /^(from_user_id|sender_id|user_id|tiktok_unique_identifier|from|sender|open_id)$/.test(key)) out.userId = sv;
      else if (!out.conversationId && /^(conversation_id|conversationid)$/.test(key)) out.conversationId = sv;
      else if (!out.messageId && /^(message_id|messageid|msg_id)$/.test(key)) out.messageId = sv;
      else if (!out.imageUrl && /^(image_url|imageurl|url)$/.test(key) && /^https?:/.test(sv) && /(jpe?g|png|webp|image)/i.test(sv)) out.imageUrl = sv;
    }
  });
  return out;
}

async function rememberConv(userId, conversationId) {
  if (userId && conversationId) await metaSet('tkconv:' + userId, { conversationId, at: Date.now() });
}

// উত্তর পাঠানো — অনুমানভিত্তিক বডি (MSG দেখুন); সফল না হলে স্পষ্ট এরর
async function sendMessage(userId, text) {
  const s = await store.getSettings();
  if (!s.tkMsgToken) throw new Error('TikTok মেসেজ টোকেন বসানো নেই');
  const conv = await metaGet('tkconv:' + userId);
  const url = s.tkSendUrl || MSG.sendUrl;
  try {
    const r = await axios.post(url, {
      business_id: s.tkMsgBusinessId || undefined,
      recipient: userId,
      conversation_id: conv && conv.conversationId,
      message_type: 'TEXT',
      text: { body: clip(text, 1500) }
    }, { headers: { 'Access-Token': s.tkMsgToken, Authorization: 'Bearer ' + s.tkMsgToken, 'Content-Type': 'application/json' }, timeout: 15000 });
    const d = r.data || {};
    if (d.code !== undefined && d.code !== 0 && d.code !== '0' && d.code !== 'ok') throw new Error(d.message || ('কোড ' + d.code));
    return d;
  } catch (err) { throw new Error('TikTok মেসেজ পাঠানো যায়নি: ' + errMsg(err)); }
}

/* ---------- কনফিগ ও অবস্থা ---------- */
async function saveConfig(b) {
  const patch = {};
  for (const k of ['tkClientKey', 'tkClientSecret', 'tkMsgToken', 'tkMsgBusinessId', 'tkSendUrl', 'tkVerifyName', 'tkVerifyBody']) {
    if (typeof b[k] === 'string' && b[k].trim() !== '') patch[k] = b[k].trim();
  }
  if (b.clear && typeof b.clear === 'string') patch[b.clear] = '';
  if (typeof b.autoPost === 'boolean') patch.tkAutoPost = b.autoPost;
  if (typeof b.audited === 'boolean') patch.tkAudited = b.audited;
  if (patch.tkVerifyName && !/^[\w.-]{3,120}$/.test(patch.tkVerifyName)) throw new Error('ভেরিফিকেশন ফাইলের নাম সঠিক না');
  if (patch.tkSendUrl && !/^https:\/\//.test(patch.tkSendUrl)) throw new Error('Send URL https:// দিয়ে শুরু হতে হবে');
  await store.saveSettings(patch);
}

async function status() {
  const s = await store.getSettings();
  const key = await hookKey();
  const out = {
    keysSet: !!(s.tkClientKey && s.tkClientSecret), postConnected: !!s.tkAccessToken, displayName: s.tkDisplayName || '',
    msgTokenSet: !!s.tkMsgToken, autoPost: s.tkAutoPost !== false, audited: !!s.tkAudited,
    verifyName: s.tkVerifyName || '', sendUrl: s.tkSendUrl || '',
    redirectUri: redirectUri(), webhookUrl: `${config.publicUrl}/webhook/tiktok/${key}`,
    verifyUrl: s.tkVerifyName ? `${config.publicUrl}/pmedia/${s.tkVerifyName}` : '', checks: []
  };
  try {
    const db = await getDb();
    const bad = await db.collection('posts').find({ tkStatus: 'failed' }).sort({ createdAt: -1 }).limit(1).toArray();
    if (bad[0] && bad[0].tkError) out.checks.push({ ok: false, msg: 'সর্বশেষ TikTok পোস্টের ত্রুটি: ' + bad[0].tkError });
  } catch (e) { /* থাক */ }
  if (s.tkAccessToken) {
    try { const p = await pickPrivacy(); out.checks.push({ ok: true, msg: 'পোস্টের অনুমতি ঠিক আছে' + (p === 'SELF_ONLY' ? ' (পোস্ট এখন "শুধু আমি" মোডে যাবে — TikTok অডিট পাস হলে সবার জন্য খুলবে)' : '') }); }
    catch (e) { out.checks.push({ ok: false, msg: e.message }); }
  }
  return out;
}

async function disconnect() { await store.saveSettings({ tkAccessToken: '', tkRefreshToken: '', tkExpiresAt: 0, tkOpenId: '', tkDisplayName: '' }); }

module.exports = {
  authUrl, handleCallback, accessToken, postFields, publishTkJob, checkSubmitted, runDue, parseInbound, rememberConv, sendMessage,
  saveConfig, status, disconnect, hookKey, checkHookKey, redirectUri
};
