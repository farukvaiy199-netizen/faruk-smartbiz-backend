// SmartBiz অর্ডার ↔ বাজার (ই-কমার্স) অ্যাডমিন প্যানেল (Firebase Firestore) এর দুদিকের মেলানো।
// • ফোনে কনফার্ম করা চ্যাট-অর্ডার সাথে সাথে অ্যাডমিন প্যানেলের অর্ডার তালিকায় বিস্তারিতসহ যায়।
// • রিজেক্ট করা অর্ডার অ্যাডমিন প্যানেলে যায় না (ওয়েবসাইটের অর্ডার আগে থেকেই সেখানে থাকে, তাই সেটা "বাতিল" হয়)।
// • অ্যাডমিন প্যানেলে স্ট্যাটাস/কুরিয়ার/ট্র্যাকিং/ফোনের ফলাফল বদলালে সেটা এই অ্যাপে চলে আসে।
// সংযোগ: ই-কমার্স ওয়েবসাইট সংযোগের একই "বট" (Settings → ই-কমার্স ওয়েবসাইট) — আলাদা কোনো চাবি লাগে না,
// শুধু Firestore Rules-এ বটের নতুন নিয়ম বসাতে হয় (অ্যাডমিন → সেটিংস → অটোমেশন API পাতায় কপি করার লেখা আছে)।
const axios = require('axios');
const store = require('./store');

const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
const bdDate = (d = new Date()) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
const bdHour = () => Number(new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', hour12: false }));

const STATUS_FROM_FS = { pending: 'Pending', processing: 'Processing', delivered: 'Delivered', cancelled: 'Cancelled' };
const STATUS_TO_FS = { Pending: 'pending', Processing: 'processing', Delivered: 'delivered', Cancelled: 'cancelled' };
const CALL_FROM_FS = { confirmed: 'confirmed', noanswer: 'noanswer', cancelled: 'rejected', later: 'later' };
const CALL_TO_FS = { confirmed: 'confirmed', noanswer: 'noanswer', rejected: 'cancelled', later: 'later' };
const NO_COURIER = 'নির্ধারণ করা হয়নি';

/* ---------- Firestore REST সহায়ক ---------- */
function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === 'object') {
    if (v.__timestamp) return { timestampValue: v.__timestamp };
    const fields = {};
    Object.keys(v).forEach(k => { fields[k] = toValue(v[k]); });
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}
function fromValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return ((v.arrayValue && v.arrayValue.values) || []).map(fromValue);
  if ('mapValue' in v) return fromFields((v.mapValue && v.mapValue.fields) || {});
  return null;
}
function fromFields(fields) {
  const o = {};
  Object.keys(fields || {}).forEach(k => { o[k] = fromValue(fields[k]); });
  return o;
}
function docOut(d) {
  const name = String(d.name || '');
  return { id: name.slice(name.lastIndexOf('/') + 1), ...fromFields(d.fields) };
}

async function getCfg() {
  const db = await store.getDb();
  const d = (await db.collection('meta').findOne({ _id: 'shop' })) || {};
  return {
    connected: !!d.connected, projectId: d.projectId || '', apiKey: d.apiKey || '',
    root: String(d.root || 'bazaar_store/khanglobalshop_main').replace(/^\/+|\/+$/g, ''),
    botEmail: d.botEmail || '', botPassword: d.botPassword || ''
  };
}
function readiness(cfg) {
  if (!cfg.connected) return { ok: false, reason: 'ই-কমার্স ওয়েবসাইট সংযুক্ত নেই (Settings → ই-কমার্স ওয়েবসাইট)' };
  if (!cfg.botEmail || !cfg.botPassword) return { ok: false, reason: 'বটের ইমেইল/পাসওয়ার্ড দেওয়া নেই (Settings → ই-কমার্স ওয়েবসাইট)' };
  return { ok: true, reason: '' };
}
function alreadyExists(err) {
  const st = err && err.response && err.response.status;
  const d = err && err.response && err.response.data;
  const e = d && (Array.isArray(d) ? d[0] && d[0].error : d.error);
  return st === 409 || /ALREADY_EXISTS|FAILED_PRECONDITION/.test(String((e && (e.status || e.message)) || ''));
}
function explain(err) {
  const d = err && err.response && err.response.data;
  const e = d && (Array.isArray(d) ? d[0] && d[0].error : d.error);
  const msg = String((e && (e.message || e.status)) || (err && err.message) || err);
  if (/INVALID_PASSWORD|INVALID_LOGIN_CREDENTIALS|EMAIL_NOT_FOUND/.test(msg)) return 'বটের ইমেইল বা পাসওয়ার্ড ভুল';
  if (/PERMISSION_DENIED|Missing or insufficient/i.test(msg)) return 'অনুমতি নেই — অ্যাডমিন প্যানেলের অটোমেশন পাতার নতুন Rules Firebase-এ বসান';
  if (/ALREADY_EXISTS/.test(msg)) return 'এই অর্ডার আগেই অ্যাডমিন প্যানেলে আছে';
  if (/NOT_FOUND/.test(msg)) return 'অর্ডার অ্যাডমিন প্যানেলে পাওয়া যায়নি';
  return msg.slice(0, 160);
}

let tokenCache = { id: '', token: '', exp: 0 };
async function botToken(cfg) {
  const id = cfg.botEmail + '|' + cfg.botPassword + '|' + cfg.apiKey;
  if (tokenCache.id === id && tokenCache.token && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const r = await axios.post('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + encodeURIComponent(cfg.apiKey),
    { email: cfg.botEmail, password: cfg.botPassword, returnSecureToken: true }, { timeout: 15000 });
  tokenCache = { id, token: r.data.idToken, exp: Date.now() + Number(r.data.expiresIn || 3600) * 1000 };
  return tokenCache.token;
}
const docsBase = cfg => `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}/databases/(default)/documents`;
const orderUrl = (cfg, id) => `${docsBase(cfg)}/${cfg.root}/orders/${encodeURIComponent(id)}`;

async function fsGetOrder(cfg, id) {
  const token = await botToken(cfg);
  try {
    const r = await axios.get(orderUrl(cfg, id), { params: { key: cfg.apiKey }, headers: { Authorization: 'Bearer ' + token }, timeout: 20000 });
    return docOut(r.data);
  } catch (err) {
    if (err.response && err.response.status === 404) return null;
    throw err;
  }
}
// ঠিক যে ঘরগুলো দেওয়া হয়েছে শুধু সেগুলো বদলায়; অর্ডার না থাকলে নতুন বানায় না
async function fsUpdateOrder(cfg, id, data) {
  const token = await botToken(cfg);
  const fields = {};
  Object.keys(data).forEach(k => { fields[k] = toValue(data[k]); });
  await axios.patch(orderUrl(cfg, id), { fields }, {
    params: { key: cfg.apiKey, 'updateMask.fieldPaths': Object.keys(data), 'currentDocument.exists': true },
    paramsSerializer: { indexes: null }, headers: { Authorization: 'Bearer ' + token }, timeout: 25000
  });
}
// নতুন অর্ডার বানায়; আগে থেকে থাকলে ALREADY_EXISTS (মানে এটা আগেই গেছে — ঠিক আছে)
async function fsCreateOrder(cfg, id, data) {
  const token = await botToken(cfg);
  const fields = {};
  Object.keys(data).forEach(k => { fields[k] = toValue(data[k]); });
  await axios.patch(orderUrl(cfg, id), { fields }, {
    params: { key: cfg.apiKey, 'currentDocument.exists': false }, headers: { Authorization: 'Bearer ' + token }, timeout: 25000
  });
}
async function fsBatchGet(cfg, ids) {
  const token = await botToken(cfg);
  const prefix = `projects/${cfg.projectId}/databases/(default)/documents/${cfg.root}/orders/`;
  const out = {};
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40);
    const r = await axios.post(`${docsBase(cfg)}:batchGet`, { documents: chunk.map(id => prefix + id) },
      { params: { key: cfg.apiKey }, headers: { Authorization: 'Bearer ' + token }, timeout: 30000 });
    (r.data || []).forEach(x => { if (x.found) { const d = docOut(x.found); out[d.id] = d; } });
  }
  return out;
}

/* ---------- চ্যাট-অর্ডার → অ্যাডমিন প্যানেলের অর্ডার ফরম্যাট ---------- */
function buildFsOrder(o, extra = {}) {
  const qty = Number(o.qty) || 1, price = Number(o.price) || 0, total = price * qty;
  const created = o.createdAt ? new Date(o.createdAt) : new Date();
  return {
    id: o.id, ownerUid: '', ownerEmail: o.email || '',
    customer: o.name || 'গ্রাহক', phone: String(o.phone || ''), address: o.address || '',
    items: [{ pid: 'smartbiz-chat', name: o.product || 'পণ্য', qty, price }],
    subtotal: total, discount: 0, tax: 0, shipping: 0, total,
    district: '', upazila: '', shippingBase: 0, prepayDiscount: 0,
    status: 'processing', payment: o.payment || 'cod', paymentStatus: 'unpaid', transactionId: o.transactionId || '',
    advanceAmount: 0, dueAmount: total, courier: NO_COURIER, date: bdDate(created),
    createdAt: { __timestamp: created.toISOString() },
    source: 'smartbiz', sourceChannel: o.source || '', smartbizId: o.id,
    stockRestored: true, // চ্যাট-অর্ডারের স্টক SmartBiz-এ আলাদা, তাই অ্যাডমিন প্যানেল যেন স্টক না ছোঁয়
    ...extra
  };
}

/* ---------- অ্যাপ → অ্যাডমিন প্যানেল ---------- */
// ফোনের ফলাফল পাঠায়। কখনো এরর ছোঁড়ে না — { synced, created, note }
async function pushCall(order, result, { note = '', remindAt = '', callAt = new Date().toISOString(), attempts = 0 } = {}) {
  let cfg;
  try { cfg = await getCfg(); } catch (e) { return { synced: false, note: 'ডেটাবেস সমস্যা' }; }
  const rd = readiness(cfg);
  if (!rd.ok) return { synced: false, note: rd.reason };
  const callFields = { callStatus: CALL_TO_FS[result], callNote: clip(note, 300), callAt, remindAt: remindAt || '', callAttempts: attempts };
  try {
    if (order.fsSynced) {
      const doc = await fsGetOrder(cfg, order.id);
      if (!doc) { // অ্যাডমিন প্যানেল থেকে মুছে গেছে বা কখনো যায়নি
        if (result === 'confirmed') { await fsCreateOrder(cfg, order.id, buildFsOrder(order, callFields)); return { synced: true, created: true, note: '' }; }
        return { synced: false, note: 'অর্ডারটি অ্যাডমিন প্যানেলে পাওয়া যায়নি' };
      }
      const data = { ...callFields };
      if (result === 'confirmed' && doc.status === 'pending') data.status = 'processing';
      if (result === 'rejected' && doc.status !== 'delivered') { data.status = 'cancelled'; data.cancelledBy = 'admin'; data.cancelReason = 'rejected'; }
      await fsUpdateOrder(cfg, order.id, data);
      return { synced: true, created: false, note: '' };
    }
    // চ্যাট-অর্ডার: শুধু কনফার্ম হলেই অ্যাডমিন প্যানেলে যায়; বাকিগুলো (রিজেক্ট/পরে/ধরেনি) যায় না
    if (result !== 'confirmed') return { synced: false, note: '' };
    try { await fsCreateOrder(cfg, order.id, buildFsOrder(order, callFields)); }
    catch (err) { if (!alreadyExists(err)) throw err; }
    return { synced: true, created: true, note: '' };
  } catch (err) {
    return { synced: false, note: explain(err) };
  }
}

// অ্যাপ থেকে হাতে স্ট্যাটাস বদলালে
async function pushStatus(order, status) {
  let cfg;
  try { cfg = await getCfg(); } catch (e) { return { synced: false, note: '' }; }
  const rd = readiness(cfg);
  if (!rd.ok) return { synced: false, note: rd.reason };
  try {
    if (order.fsSynced) {
      const data = { status: STATUS_TO_FS[status] };
      if (status === 'Cancelled') { data.cancelledBy = 'admin'; data.cancelReason = 'app'; }
      await fsUpdateOrder(cfg, order.id, data);
      return { synced: true, created: false, note: '' };
    }
    if (status === 'Processing' || status === 'Delivered') {
      await fsCreateOrder(cfg, order.id, buildFsOrder(order, { status: STATUS_TO_FS[status] }));
      return { synced: true, created: true, note: '' };
    }
    return { synced: false, note: '' };
  } catch (err) { return { synced: false, note: explain(err) }; }
}

/* ---------- অ্যাডমিন প্যানেল → অ্যাপ ---------- */
let notifier = null;
function setNotifier(fn) { notifier = fn; }

function diffFromDoc(o, doc) {
  const patch = {};
  const st = STATUS_FROM_FS[doc.status];
  if (st && st !== o.status) patch.status = st;
  const courier = doc.courier && doc.courier !== NO_COURIER ? String(doc.courier) : '';
  if (courier !== (o.courier || '')) patch.courier = courier;
  const tracking = String(doc.steadfastTrackingId || doc.pathaoConsignmentId || '');
  if (tracking !== (o.tracking || '')) patch.tracking = tracking;
  const notReceived = doc.status === 'cancelled' && doc.cancelReason === 'not_received';
  if (notReceived !== !!o.notReceived) patch.notReceived = notReceived;
  if (doc.paymentStatus && doc.paymentStatus !== (o.paymentStatus || '')) patch.paymentStatus = doc.paymentStatus;
  // ফোনের ফলাফল: যেদিকে পরে বদলেছে সেটাই জেতে
  const docCall = CALL_FROM_FS[doc.callStatus];
  if (docCall && doc.callAt && String(doc.callAt) > String(o.callAt || '')) {
    patch.callStatus = docCall; patch.callNote = doc.callNote || ''; patch.callAt = doc.callAt;
    patch.remindAt = doc.remindAt || ''; patch.callAttempts = Number(doc.callAttempts) || o.callAttempts || 0;
    if (docCall !== 'later') patch.remindNotified = false;
  }
  return patch;
}

let lastPull = 0, pulling = false, lastResult = null;
async function pullAll({ force = false, minGapMs = 20000 } = {}) {
  if (pulling) return lastResult;
  if (!force && Date.now() - lastPull < minGapMs) return lastResult;
  pulling = true;
  try {
    const cfg = await getCfg();
    const rd = readiness(cfg);
    if (!rd.ok) { lastResult = { ok: false, reason: rd.reason, checked: 0, updated: 0 }; return lastResult; }
    const db = await store.getDb();
    const cutoff = new Date(Date.now() - 45 * 86400e3).toISOString();
    const open = await db.collection('orders').find({ fsSynced: true, status: { $in: ['Pending', 'Processing'] }, createdAt: { $gte: cutoff } })
      .sort({ createdAt: -1 }).limit(100).toArray();
    // ডেলিভারড হলেও কয়েকদিন নজরে রাখি (কাস্টমার রিসিভ না করলে অ্যাডমিন প্যানেলে "ফেরত" হতে পারে)
    const recentDelivered = await db.collection('orders').find({ fsSynced: true, status: 'Delivered', createdAt: { $gte: new Date(Date.now() - 14 * 86400e3).toISOString() } })
      .sort({ createdAt: -1 }).limit(40).toArray();
    open.push(...recentDelivered);
    // ফোনে কনফার্ম হয়েও যে চ্যাট-অর্ডার আগে যেতে পারেনি, সেগুলো আবার চেষ্টা
    const retry = await db.collection('orders').find({ fsSynced: { $ne: true }, callStatus: 'confirmed', status: { $ne: 'Cancelled' } }).limit(20).toArray();
    let updated = 0;
    for (const o of retry) {
      const r = await pushCall(o, 'confirmed', { note: o.callNote || '', callAt: o.callAt || new Date().toISOString(), attempts: o.callAttempts || 0 });
      if (r.synced) { await db.collection('orders').updateOne({ id: o.id }, { $set: { fsSynced: true, syncNote: '' } }); updated++; }
    }
    const docs = open.length ? await fsBatchGet(cfg, open.map(o => o.id)) : {};
    for (const o of open) {
      const doc = docs[o.id]; if (!doc) continue;
      const patch = diffFromDoc(o, doc);
      if (!Object.keys(patch).length) continue;
      await db.collection('orders').updateOne({ id: o.id }, { $set: patch });
      updated++;
      if (patch.status && notifier) { try { await notifier({ ...o, ...patch }, patch.status, o.status); } catch (e) { /* জানানো না গেলে সিঙ্ক থামে না */ } }
    }
    lastResult = { ok: true, reason: '', checked: open.length, updated, at: new Date().toISOString() };
    return lastResult;
  } catch (err) {
    lastResult = { ok: false, reason: explain(err), checked: 0, updated: 0 };
    return lastResult;
  } finally { lastPull = Date.now(); pulling = false; }
}

async function status() {
  const cfg = await getCfg();
  const rd = readiness(cfg);
  return { ready: rd.ok, reason: rd.reason, last: lastResult };
}

/* ---------- "কিছুদিন পরে" ফোনের মনে করিয়ে দেওয়া ---------- */
async function runReminders(notifyOwner) {
  if (bdHour() < 9) return 0; // সকাল ৯টার আগে নয়
  const db = await store.getDb();
  const list = await db.collection('orders').find({ callStatus: 'later', remindAt: { $gt: '', $lte: bdDate() }, remindNotified: { $ne: true } }).limit(20).toArray();
  for (const o of list) {
    await db.collection('orders').updateOne({ id: o.id }, { $set: { remindNotified: true } });
    try {
      await notifyOwner({ type: 'order', title: `⏰ আজ ফোন করার কথা — ${o.name}`, body: `${o.id} · ${o.product}${o.callNote ? ' — ' + clip(o.callNote, 80) : ''}` });
    } catch (e) { /* পুশ না গেলেও ঠিক আছে */ }
  }
  return list.length;
}

// প্রতি ১০ মিনিটে খোলা অর্ডারের অবস্থা মেলানো ও মিনিটে-মিনিটে রিমাইন্ডার দেখা (সার্ভার জেগে থাকলে)
let started = false;
function start(notifyOwner) {
  if (started) return; started = true;
  setInterval(() => { pullAll({ force: false, minGapMs: 9 * 60 * 1000 }).catch(() => {}); }, 10 * 60 * 1000).unref();
  setInterval(() => { runReminders(notifyOwner).catch(() => {}); }, 5 * 60 * 1000).unref();
}

module.exports = { pushCall, pushStatus, pullAll, status, setNotifier, runReminders, start, buildFsOrder, diffFromDoc, toValue, fromFields, readiness };
