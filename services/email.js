// ইমেইল: (১) অর্ডারের রশিদ পাঠানো (২) কাস্টমারের ইমেইলের উত্তর দেওয়া।
// প্রধান পথ: মালিকের নিজের Gmail-এ বসানো ছোট Google Apps Script ("ব্রিজ") — বিনামূল্যে, নিজের ঠিকানা থেকে যায়।
// ব্রিজ না থাকলে আগের মতো Resend (config.resendApiKey) চেষ্টা করে।
const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');
const store = require('./store');

const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rand = n => crypto.randomBytes(n).toString('hex');

async function metaGet(id) { const db = await store.getDb(); const d = await db.collection('meta').findOne({ _id: id }); if (!d) return null; const { _id, ...r } = d; return r; }
async function metaSet(id, patch) { const db = await store.getDb(); await db.collection('meta').updateOne({ _id: id }, { $set: patch }, { upsert: true }); }

function isEmail(s) { return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(String(s || '').trim()); }

function isEmailConfigured(settings) {
  return !!((settings && settings.emailBridgeUrl) || config.resendApiKey);
}

/* ---------- সেটআপ: গোপন মান ও স্ক্রিপ্ট ---------- */
async function ensureSecrets() {
  const s = await store.getSettings();
  const patch = {};
  if (!s.emailBridgeSecret) patch.emailBridgeSecret = rand(16);
  if (!s.emailHookKey) patch.emailHookKey = rand(20);
  if (Object.keys(patch).length) Object.assign(s, await store.saveSettings(patch));
  return { secret: s.emailBridgeSecret || patch.emailBridgeSecret, hookKey: s.emailHookKey || patch.emailHookKey };
}

function checkHookKey(settings, key) {
  if (!settings || !settings.emailHookKey || !key) return false;
  const a = Buffer.from(String(settings.emailHookKey)), b = Buffer.from(String(key));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hookUrl(hookKey) { return `${config.publicUrl}/webhook/email/${hookKey}`; }

// মালিক এই কোড Google Apps Script-এ পেস্ট করবেন
function scriptSource({ secret, hookKey }) {
  return `// Faruk's SmartBiz — Gmail ব্রিজ (এটা আপনার Gmail থেকে ইমেইল পাঠায় ও নতুন ইমেইল অ্যাপে জানায়)
var SERVER = '${hookUrl(hookKey)}';
var SECRET = '${secret}';

function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function doPost(e) {
  var d;
  try { d = JSON.parse(e.postData.contents); } catch (x) { return out_({ ok: false, error: 'bad json' }); }
  if (d.secret !== SECRET) return out_({ ok: false, error: 'secret মিলছে না' });
  if (d.action === 'ping') return out_({ ok: true, email: Session.getEffectiveUser().getEmail() });
  if (d.action === 'send') {
    try {
      var opts = { htmlBody: d.html || undefined, name: d.fromName || "Faruk's SmartBiz" };
      if (d.threadId) {
        var t = GmailApp.getThreadById(d.threadId);
        if (t) { t.reply(d.text || '', opts); return out_({ ok: true }); }
      }
      GmailApp.sendEmail(d.to, d.subject || 'বার্তা', d.text || '', opts);
      return out_({ ok: true });
    } catch (err) { return out_({ ok: false, error: String(err) }); }
  }
  return out_({ ok: false, error: 'unknown action' });
}

// প্রতি ৫ মিনিটে চলে (Triggers থেকে সেট করুন): নতুন অপঠিত ইমেইল অ্যাপে পাঠায়
function checkInbox() {
  var me = Session.getEffectiveUser().getEmail().toLowerCase();
  var threads = GmailApp.search('in:inbox is:unread category:primary newer_than:2d', 0, 10);
  threads.forEach(function (t) {
    var msgs = t.getMessages();
    var m = msgs[msgs.length - 1];
    if (!m.isUnread()) return;
    var from = m.getFrom();
    var addr = ((from.match(/<([^>]+)>/) || [0, from])[1] || '').toLowerCase().trim();
    var raw = m.getRawContent().slice(0, 6000).toLowerCase();
    var auto = /list-unsubscribe:|precedence: *(bulk|list|junk)|auto-submitted: *auto/.test(raw);
    if (!addr || addr === me || auto || /no-?reply|mailer-daemon|postmaster/.test(addr)) { m.markRead(); return; }
    var name = from.replace(/<.*>/, '').replace(/"/g, '').trim();
    var body = m.getPlainBody().split(/\\r?\\n(On .* wrote:|Le .* a écrit|>)/)[0].trim().slice(0, 3000);
    var res = UrlFetchApp.fetch(SERVER, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ from: addr, name: name, subject: m.getSubject(), text: body, threadId: t.getId(), messageId: m.getId() })
    });
    if (res.getResponseCode() === 200) m.markRead();
  });
}
`;
}

/* ---------- পাঠানো ---------- */
async function bridgeCall(settings, payload) {
  const r = await axios.post(settings.emailBridgeUrl, { secret: settings.emailBridgeSecret, ...payload },
    { timeout: 30000, maxRedirects: 5, headers: { 'Content-Type': 'application/json' }, validateStatus: s => s < 500 });
  const d = r.data;
  if (!d || typeof d !== 'object') throw new Error('ব্রিজ থেকে সঠিক উত্তর আসেনি — Web app-এর "Who has access" = Anyone কিনা দেখুন');
  if (!d.ok) throw new Error(clip(d.error || 'ব্রিজ ব্যর্থ', 160));
  return d;
}

async function resendSend({ to, subject, html, text }) {
  const from = config.emailFrom || 'Faruk SmartBiz <onboarding@resend.dev>';
  try {
    await axios.post('https://api.resend.com/emails', { from, to: [to], subject, html, text },
      { headers: { Authorization: 'Bearer ' + config.resendApiKey }, timeout: 15000 });
  } catch (err) {
    const d = err.response && err.response.data;
    throw new Error(clip((d && (d.message || d.error)) || err.message, 200));
  }
}

// কখনো এরর ছোঁড়ে না — {sent, reason} ফেরত দেয়
async function sendMail({ to, subject, html, text, threadId }) {
  try {
    if (!isEmail(to)) return { sent: false, reason: 'ইমেইল ঠিকানা সঠিক নয়' };
    const s = await store.getSettings();
    if (s.emailBridgeUrl) {
      await bridgeCall(s, { action: 'send', to, subject, html, text, threadId: threadId || '', fromName: s.shopName || s.businessName || "Faruk's SmartBiz" });
      return { sent: true };
    }
    if (config.resendApiKey) {
      await resendSend({ to, subject, html, text });
      return { sent: true };
    }
    return { sent: false, reason: 'ইমেইল সংযুক্ত নেই (Gmail ব্রিজ বা Resend)' };
  } catch (err) {
    return { sent: false, reason: clip(err.message || err, 200) };
  }
}

/* ---------- অর্ডারের রশিদ ---------- */
async function sendOrderConfirmationEmail({ to, order }) {
  const s = await store.getSettings().catch(() => ({}));
  const shop = s.shopName || s.businessName || "Faruk's SmartBiz";
  const o = order || {};
  const rows = [
    ['অর্ডার নং', o.id], ['নাম', o.name], ['পণ্য', o.product], ['পরিমাণ', o.qty],
    ['ফোন', o.phone], ['ঠিকানা', o.address], ['মোট', o.total != null && o.total !== '' ? o.total + ' ৳' : '']
  ].filter(r => r[1] !== undefined && r[1] !== null && String(r[1]) !== '');
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;border:1px solid #eee;border-radius:12px;padding:20px">
<h2 style="margin:0 0 6px">ধন্যবাদ! আপনার অর্ডার পেয়েছি ✅</h2>
<p style="color:#555;margin:0 0 14px">${esc(shop)}</p>
<table style="width:100%;border-collapse:collapse">${rows.map(r => `<tr><td style="padding:7px 0;color:#777;width:35%">${esc(r[0])}</td><td style="padding:7px 0"><b>${esc(r[1])}</b></td></tr>`).join('')}</table>
<p style="color:#555;margin-top:16px">অর্ডার সম্পর্কে কিছু জানতে এই ইমেইলের উত্তরে লিখুন।</p></div>`;
  const text = `ধন্যবাদ! আপনার অর্ডার পেয়েছি।\n` + rows.map(r => `${r[0]}: ${r[1]}`).join('\n') + `\n— ${shop}`;
  return sendMail({ to, subject: `অর্ডার নিশ্চিত${o.id ? ' — ' + o.id : ''} | ${shop}`, html, text });
}

/* ---------- কাস্টমারের ইমেইলের উত্তর ---------- */
async function rememberThread(addr, { threadId, subject }) {
  await metaSet('emailthread:' + String(addr).toLowerCase(), { threadId: threadId || '', subject: clip(subject, 200), at: Date.now() });
}

async function sendReply(addr, text) {
  const t = await metaGet('emailthread:' + String(addr).toLowerCase());
  const subject = t && t.subject ? (/^re:/i.test(t.subject) ? t.subject : 'Re: ' + t.subject) : 'আপনার মেসেজের উত্তর';
  const html = `<div style="font-family:Arial,sans-serif;line-height:1.6;white-space:pre-wrap">${esc(text)}</div>`;
  const r = await sendMail({ to: addr, subject, html, text: String(text), threadId: t && t.threadId });
  if (!r.sent) throw new Error(r.reason);
}

/* ---------- অবস্থা / সংযোগ ---------- */
async function status() {
  const s = await store.getSettings();
  const { secret, hookKey } = await ensureSecrets();
  return {
    bridge: !!s.emailBridgeUrl, bridgeEmail: s.emailBridgeAddress || '', resend: !!config.resendApiKey,
    aiReply: s.emailAiReply === 'on', hookUrl: hookUrl(hookKey), hasSecret: !!secret
  };
}

async function getScript() {
  return scriptSource(await ensureSecrets());
}

async function connect(url) {
  url = String(url || '').trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) throw new Error('লিংকটা https://script.google.com/macros/s/…/exec ধরনের হতে হবে');
  await ensureSecrets();
  const s = await store.getSettings();
  const d = await bridgeCall({ ...s, emailBridgeUrl: url }, { action: 'ping' });
  await store.saveSettings({ emailBridgeUrl: url, emailBridgeAddress: d.email || '' });
  return { email: d.email || '' };
}

async function disconnect() {
  await store.saveSettings({ emailBridgeUrl: '', emailBridgeAddress: '' });
}

module.exports = {
  isEmail, isEmailConfigured, ensureSecrets, checkHookKey, hookUrl, scriptSource,
  sendMail, sendOrderConfirmationEmail, rememberThread, sendReply, status, getScript, connect, disconnect
};
