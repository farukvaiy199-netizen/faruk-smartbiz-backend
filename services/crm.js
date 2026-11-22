// কাস্টমার ম্যানেজমেন্ট সহায়ক: স্প্যাম/আবোলতাবোল মেসেজ চেনা, মালিকের কমা (,) দিয়ে AI থামানো/চালানো,
// "পরে মেসেজ দিন" বললে সময় বুঝে ফলো-আপ, "নিব না" বললে বিকল্প/অফার দেখানোর শনাক্তকরণ।
const store = require('./store');

const BN = '০১২৩৪৫৬৭৮৯';
const en = t => String(t || '').replace(/[০-৯]/g, d => BN.indexOf(d));

/* ---------------- স্প্যাম / আবোলতাবোল ---------------- */
const EMOJI_RE = /[\p{Extended_Pictographic}\p{Emoji_Presentation}️‍\u{1F3FB}-\u{1F3FF}]/gu;
// ফেরত: '' (ঠিক আছে) অথবা কারণ-লেখা (উত্তর দেওয়া হবে না)
function junkReason(text) {
  const raw = String(text || '');
  const t = raw.replace(EMOJI_RE, '').replace(/[\s\p{P}\p{S}]+/gu, '');
  if (!t) return 'শুধু ইমোজি/চিহ্ন';
  if (/^(.)\1{5,}$/u.test(t)) return 'একই অক্ষর বারবার';
  if (/^[a-z]{9,}$/i.test(t) && !/[aeiou]/i.test(t)) return 'এলোমেলো অক্ষর';
  return '';
}

// একই জনের খুব দ্রুত বা বারবার একই মেসেজ (বট) চেনা — মেমরিতে, ২ মিনিটের হিসাব
const hits = new Map();
function floodReason(key, text) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(h => now - h.t < 120000);
  const norm = String(text || '').trim().toLowerCase();
  arr.push({ t: now, n: norm });
  hits.set(key, arr);
  if (hits.size > 5000) { for (const [k, v] of hits) if (!v.length || now - v[v.length - 1].t > 120000) hits.delete(k); }
  const same = arr.filter(h => h.n === norm).length;
  if (norm && same >= 4) return 'একই মেসেজ বারবার';
  if (arr.filter(h => now - h.t < 60000).length > 14) return 'এক মিনিটে অনেক মেসেজ';
  return '';
}

/* ---------------- মালিকের কমা-কমান্ড ---------------- */
// মালিক নিজে পেজ-ইনবক্স থেকে কাস্টমারকে মেসেজ দিলে (ইকো হিসেবে আসে):
//   শুধু ","            → AI-র অবস্থা উল্টে যায় (চালু থাকলে বন্ধ, বন্ধ থাকলে চালু)
//   ", কথা..." (শুরুতে) → AI বন্ধ (মালিক কথা বলছেন)
//   "...কথা ,"  (শেষে)  → AI আবার চালু
function ownerToggle(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const C = /^[,，،]$/;
  if (C.test(t)) return 'toggle';
  if (/^[,，،]/.test(t)) return 'pause';
  if (/[,，،]$/.test(t)) return 'resume';
  return null;
}

/* ---------------- "নিব না" শনাক্ত ---------------- */
const DECLINE_RE = /(নিব\s*না|নেব\s*না|নিবো\s*না|নিবনা|নেবনা|লাগবে\s*না|লাগবেনা|লাগবে\s*নাহ|দরকার\s*(নেই|নাই)|কিনব\s*না|কিনবো\s*না|কিনবনা|চাই\s*না|চাইনা|চাইনি|পছন্দ\s*(হয়নি|হয় নাই|না)|দাম\s*(অনেক\s*)?বেশি|বাজেটের\s*বাইরে|বাজেট\s*(নেই|নাই)|অন্য\s*(কিছু|পণ্য|প্রোডাক্ট)|আর\s*(কিছু|কী|কি)\s*আছে|আরও\s*(কিছু|কী|কি)\s*আছে|no\s*thanks|not\s*interested)/i;
function isDecline(text) { return DECLINE_RE.test(en(text)); }

/* ---------------- "পরে মেসেজ দিন" ---------------- */
const LATER_RE = /(^|[\s,।.!?])(পরে|পরবর্তীতে|পরেই)(\s|$|[,।.!?])|সময়\s*(নেই|নাই)|এখন\s*(ব্যস্ত|পারছি\s*না|পারব\s*না|পারবো\s*না|না)|ব্যস্ত\s*আছি|later|busy/i;
const PAY_RE = /টাকা|পেমেন্ট|বিকাশ|নগদ|ক্যাশ|ডেলিভারির\s*সময়|ডেলিভারি\s*(এর\s*)?পর/;
const BD_OFFSET = 6 * 3600e3;
function bdParts(ms) { const d = new Date(ms + BD_OFFSET); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours() }; }
const bdMake = (y, m, d, h, min) => Date.UTC(y, m, d, h, min || 0) - BD_OFFSET;
// ফেরত: { at: ms, label } অথবা null
function parseFollowUp(text, now) {
  const raw = en(text);
  if (!LATER_RE.test(raw) || PAY_RE.test(raw)) return null;
  now = now || Date.now();
  let at = null, label = '';
  const mH = /(\d+(?:\.\d+)?)\s*(ঘণ্টা|ঘন্টা|ঘণ্টায়|hour|hr)/i.exec(raw);
  const mM = /(\d+)\s*(মিনিট|মিনিটে|min)/i.exec(raw);
  const p = bdParts(now);
  const atHour = (dayAdd, h) => bdMake(p.y, p.m, p.d + dayAdd, h);
  if (/আধা\s*ঘ[ণন]্?[টত]া|আধ\s*ঘ/.test(raw)) { at = now + 30 * 60e3; label = 'আধা ঘণ্টা পর'; }
  else if (mH) { at = now + Number(mH[1]) * 3600e3; label = mH[1] + ' ঘণ্টা পর'; }
  else if (mM) { at = now + Number(mM[1]) * 60e3; label = mM[1] + ' মিনিট পর'; }
  else if (/পরশু/.test(raw)) { at = atHour(2, 10); label = 'পরশু'; }
  else if (/সপ্তাহ|হপ্তা/.test(raw)) { at = atHour(7, 10); label = 'এক সপ্তাহ পর'; }
  else {
    const tomorrow = /কাল|আগামীকাল|আগামী\s*কাল|কালকে/.test(raw);
    const slot = /সকাল/.test(raw) ? 9 : /দুপুর/.test(raw) ? 13 : /বিকাল|বিকেল/.test(raw) ? 16 : /সন্ধ্যা|সন্ধ্যায়/.test(raw) ? 18 : /রাত/.test(raw) ? 21 : null;
    if (tomorrow) { at = atHour(1, slot == null ? 10 : slot); label = 'কাল'; }
    else if (slot != null) { at = atHour(0, slot); if (at <= now + 10 * 60e3) at = atHour(1, slot); label = 'ঠিক সময়ে'; }
    else { at = now + 3 * 3600e3; label = 'কিছুক্ষণ পর'; }
  }
  // রাত ১০টা–সকাল ৯টায় কাউকে বিরক্ত নয় — সকাল ৯টায় সরিয়ে দিই
  const q = bdParts(at);
  if (q.h < 9) at = bdMake(q.y, q.m, q.d, 9);
  else if (q.h >= 22) at = bdMake(q.y, q.m, q.d + 1, 9);
  if (at < now + 2 * 60e3) at = now + 2 * 60e3;
  return { at, label };
}

/* ---------------- ফলো-আপ পাঠানো ---------------- */
async function sendPlain(c, text, settings) {
  const pf = c.platform, id = c.platformId;
  if (pf === 'facebook' && settings.fbToken) return require('./facebook').sendFacebookMessage(id, text, settings.fbToken);
  if (pf === 'instagram' && settings.fbToken) return require('./instagram').sendInstagramMessage(id, text, settings.fbToken);
  if (pf === 'whatsapp' && settings.waToken && settings.waPhoneNumberId) return require('./whatsapp').sendWhatsAppMessage(id, text, settings.waPhoneNumberId, settings.waToken);
  if (pf === 'telegram' && settings.tgToken) return require('./telegram').sendMessage(settings.tgToken, id, text);
  if (pf === 'tiktok') return require('./tiktok').sendMessage(id, text);
  if (pf === 'email') return require('./email').sendReply(id, text);
  throw new Error('এই প্ল্যাটফর্মে মেসেজ পাঠানো যায় না (' + pf + ')');
}

let running = false;
// শিডিউলার (প্রতি মিনিট) থেকে ডাকা হয়। সময় হয়েছে এমন ফলো-আপ পাঠায়; কখনো এরর ছোঁড়ে না।
async function runFollowUps() {
  if (running) return 0;
  running = true;
  let n = 0;
  try {
    const list = await store.claimDueFollowUps(5);
    if (!list.length) return 0;
    const settings = await store.getSettings();
    const shop = require('./shop');
    for (const c of list) {
      try {
        if (c.ai === false) continue; // মালিক নিজে কথা বলছেন — AI পাঠাবে না
        const real = c.name && c.name !== 'অজানা কাস্টমার';
        let msg = `আসসালামু আলাইকুম${real ? ' ' + String(c.name).split(/\s+/)[0] + ' স্যার/ম্যাম' : ''}! 😊 আপনি পরে কথা বলবেন বলেছিলেন — এখন কি একটু সময় হবে?`;
        if (c.interest && c.interest.product && (!c.lastOrderAt || c.interest.at > c.lastOrderAt)) {
          msg += `\n"${c.interest.product}" নিয়ে কিছু জানার থাকলে বা অর্ডার করতে চাইলে এখানেই জানাতে পারেন।`;
          const card = await shop.getProductCard(c.interest.productId).catch(() => null);
          if (card && card.url) msg += `\n🔗 ${card.url}`;
        } else msg += '\nকিছু জানার থাকলে বা অর্ডার করতে চাইলে এখানেই জানাতে পারেন।';
        const alt = await shop.getAlternatives({ excludeIds: [], max: 0 }).catch(() => ({ offers: [] }));
        if (alt.offers && alt.offers.length) msg += '\n\nচলমান অফার:\n' + alt.offers.slice(0, 3).join('\n');
        await sendPlain(c, msg, settings);
        await store.appendMessage(c.id, 'assistant', msg);
        n++;
        console.log(`⏰ ফলো-আপ পাঠানো হলো: ${c.platform}/${c.platformId}`);
      } catch (err) {
        console.error('ফলো-আপ পাঠানো যায়নি:', c.platform, err.response && err.response.data ? JSON.stringify(err.response.data) : err.message);
        try { await require('./notify').notifyOwner({ type: 'followup', title: '⏰ ফলো-আপ পাঠানো যায়নি', body: `${c.name || 'কাস্টমার'} (${c.platform}) — হয়তো প্ল্যাটফর্মের সময়সীমা পার হয়ে গেছে` }); } catch (e) { /* গুরুত্বপূর্ণ নয় */ }
      }
    }
  } catch (err) {
    console.error('ফলো-আপ শিডিউলার:', err.message);
  } finally { running = false; }
  return n;
}

module.exports = { sendPlain, junkReason, floodReason, ownerToggle, isDecline, parseFollowUp, runFollowUps };
