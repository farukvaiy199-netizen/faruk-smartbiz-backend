// বিকাশ/নগদ পেমেন্ট নিজে-নিজে যাচাই (বিনা খরচে, NID/ট্রেড লাইসেন্স/মার্চেন্ট অ্যাকাউন্ট ছাড়া):
// মালিকের ফোনে বিকাশ/নগদের "টাকা পেয়েছেন" SMS আসে → একটা ফ্রি SMS-ফরওয়ার্ডার অ্যাপ সেটা এই সার্ভারে পাঠায় →
// সার্ভার SMS থেকে TrxID + টাকার অঙ্ক রেখে দেয় → কাস্টমার TrxID দিলে এখানে মিলিয়ে দেখা হয়।
const store = require('./store');

const BN = '০১২৩৪৫৬৭৮৯';
const en = t => String(t || '').replace(/[০-৯]/g, d => BN.indexOf(d));
const hookKey = () => String(process.env.SMS_HOOK_KEY || '').trim();
const enabled = () => !!hookKey();
const up = t => String(t || '').trim().toUpperCase();

async function col() { return (await store.getDb()).collection('payments'); }
let indexed = false;
async function ready() {
  const c = await col();
  if (!indexed) { indexed = true; await c.createIndex({ trxId: 1 }, { unique: true }).catch(() => {}); }
  return c;
}

// SMS-এর লেখা থেকে পেমেন্ট বের করা। শুধু "টাকা পেয়েছেন" ধরনের মেসেজ নেয় (পাঠানো/ক্যাশআউট/রিচার্জ বাদ)
function parseSms(from, textRaw) {
  const text = en(textRaw).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const hay = (String(from || '') + ' ' + text).toLowerCase();
  const provider = /nagad|নগদ/.test(hay) ? 'nagad' : /bkash|বিকাশ/.test(hay) ? 'bkash' : /rocket/.test(hay) ? 'rocket' : /upay/.test(hay) ? 'upay' : '';
  if (!/(received|পেয়েছেন|money\s*in|cash\s*in|payment\s*received)/i.test(text)) return null;
  if (/(sent|cash\s*out|send\s*money|payment\s*to|recharge|bill|paid)/i.test(text) && !/received/i.test(text)) return null;
  const tm = /(?:trx\s*id|txn\s*id|transaction\s*id|trxid|txnid)\s*[:\-]?\s*([A-Z0-9]{6,20})/i.exec(text);
  if (!tm) return null;
  const am = /(?:amount|received)[^0-9]{0,25}(?:tk|৳|bdt)\.?\s*([\d,]+(?:\.\d+)?)/i.exec(text) || /(?:tk|৳|bdt)\.?\s*([\d,]+(?:\.\d+)?)/i.exec(text);
  const bm = /([\d,]+(?:\.\d+)?)\s*(?:টাকা|taka)/i.exec(text);
  const amount = am ? Number(am[1].replace(/,/g, '')) : bm ? Number(bm[1].replace(/,/g, '')) : 0;
  const sm = /(?:from|sender)[^0-9]{0,15}(01[3-9]\d{8})/i.exec(text);
  return { provider: provider || 'mobile', trxId: up(tm[1]), amount, sender: sm ? sm[1] : '' };
}

// ফরওয়ার্ডার অ্যাপ থেকে আসা বডি (JSON/ফর্ম/সাধারণ লেখা) → সংরক্ষণ
async function ingest(body, hintFrom) {
  let from = String(hintFrom || ''), text = '';
  if (typeof body === 'string') text = body;
  else if (body && typeof body === 'object') {
    from = body.from || body.sender || body.address || body.number || body.title || from;
    text = body.text || body.message || body.body || body.content || body.sms || body.msg || '';
  }
  const p = parseSms(from, text);
  if (!p) return { ok: false, reason: 'পেমেন্ট-SMS চেনা যায়নি' };
  const c = await ready();
  try {
    await c.insertOne({ ...p, rawLen: String(text).length, receivedAt: new Date().toISOString(), usedBy: '' });
    console.log(`💰 পেমেন্ট SMS: ${p.provider} ${p.trxId} ৳${p.amount}`);
    return { ok: true, payment: p };
  } catch (e) {
    if (e && e.code === 11000) return { ok: true, duplicate: true, payment: p };
    throw e;
  }
}

// state: ok | notfound | low | used
async function check(trxId, minAmount) {
  const c = await ready();
  const doc = await c.findOne({ trxId: up(trxId) });
  if (!doc) return { state: 'notfound' };
  if (doc.usedBy) return { state: 'used', payment: doc };
  if (Number(minAmount) > 0 && Number(doc.amount) + 1 < Number(minAmount)) return { state: 'low', payment: doc };
  return { state: 'ok', payment: doc };
}
// SMS ফরওয়ার্ড হতে ২-১০ সেকেন্ড লাগতে পারে — একটু অপেক্ষা করে আবার দেখি
async function verify(trxId, minAmount, waitMs = 12000) {
  const end = Date.now() + waitMs;
  let r = await check(trxId, minAmount);
  while (r.state === 'notfound' && Date.now() < end) { await new Promise(s => setTimeout(s, 3000)); r = await check(trxId, minAmount); }
  return r;
}
// একই TrxID দিয়ে দুইবার অর্ডার ঠেকাতে — একবারই দাবি করা যায়
async function claim(trxId, ref) {
  const c = await ready();
  const r = await c.updateOne({ trxId: up(trxId), usedBy: '' }, { $set: { usedBy: String(ref), usedAt: new Date().toISOString() } });
  return r.modifiedCount === 1;
}
async function release(trxId, ref) {
  const c = await ready();
  await c.updateOne({ trxId: up(trxId), usedBy: String(ref) }, { $set: { usedBy: '' } }).catch(() => {});
}
async function setRef(trxId, ref) {
  const c = await ready();
  await c.updateOne({ trxId: up(trxId) }, { $set: { usedBy: String(ref) } }).catch(() => {});
}

// ভুল TrxID বারবার দিলে (ফরওয়ার্ডার বন্ধ থাকলেও আসল কাস্টমার আটকে না যায়) — ২য় চেষ্টায় "যাচাই-বাকি" হিসেবে অর্ডার যেতে দিই
const tries = new Map();
function bumpTry(key) {
  const now = Date.now();
  const e = tries.get(key);
  const n = (e && now - e.t < 3600e3 ? e.n : 0) + 1;
  tries.set(key, { n, t: now });
  if (tries.size > 3000) for (const [k, v] of tries) if (now - v.t > 3600e3) tries.delete(k);
  return n;
}
const clearTry = key => tries.delete(key);

module.exports = { enabled, hookKey, parseSms, ingest, check, verify, claim, release, setRef, bumpTry, clearTry };
