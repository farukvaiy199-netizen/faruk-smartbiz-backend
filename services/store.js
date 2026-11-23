// আগে অর্ডার/কাস্টমার/কথোপকথন লোকাল db.json ফাইলে রাখা হতো — কিন্তু Render ফ্রি প্ল্যানে
// প্রতিটা নতুন deploy-তে সেই ফাইল মুছে যায় (ephemeral disk), ফলে ডেটা হারিয়ে যাচ্ছিল।
// এখন সবকিছু MongoDB-তে স্থায়ীভাবে সেভ হয় — redeploy হলেও আর হারাবে না।

const orderSheet = require('./orderSheet');
const { MongoClient } = require('mongodb');
const config = require('../config');

let clientPromise = null;
async function getDb() {
  if (!config.mongoUri) {
    throw new Error('সার্ভারে MONGO_URI সেট করা নেই — Render Environment-এ যোগ করুন');
  }
  if (!clientPromise) {
    const client = new MongoClient(config.mongoUri);
    clientPromise = client.connect().then(async (c) => {
      const db = c.db();
      await prepareDb(db);
      return db;
    });
  }
  return clientPromise;
}

// সার্ভার চালুর সময় একবার: একই কাস্টমার দুইবার তৈরি হওয়া ঠেকানোর ইনডেক্স, আর আগের ভুলে
// একই আইডি (ORD-001001) পাওয়া অর্ডারগুলোকে আলাদা আইডি দেওয়া
async function prepareDb(db) {
  try {
    await db.collection('customers').createIndex({ platform: 1, platformId: 1 }, { unique: true });
  } catch (err) {
    console.error('কাস্টমার ইনডেক্স তৈরি করা যায়নি (আগের ডুপ্লিকেট কাস্টমার থাকতে পারে):', err.message);
  }
  try {
    const dupGroups = await db.collection('orders').aggregate([
      { $group: { _id: '$id', n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } }
    ]).toArray();
    for (const g of dupGroups) {
      const docs = await db.collection('orders').find({ id: g._id }).sort({ createdAt: 1 }).toArray();
      for (const d of docs.slice(1)) {
        const newId = await nextOrderIdFrom(db);
        await db.collection('orders').updateOne({ _id: d._id }, { $set: { id: newId } });
        console.log(`ডুপ্লিকেট অর্ডার আইডি ঠিক করা হলো: ${g._id} → ${newId}`);
      }
    }
  } catch (err) {
    console.error('অর্ডার আইডি মেরামত করা যায়নি:', err.message);
  }
}

function stripId(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return rest;
}

function defaultSettings() {
  const d = {
    fbToken: '', fbPageId: '', fbAppId: '',
    waToken: '', waPhoneNumberId: '', waBusinessId: '', waConfigId: '', waAppId: '',
    sheetLink: '', faqSheetLink: '',
    aiKey: '', aiProvider: 'groq', aiAutoReply: true,
    // ব্যাকআপ AI Key — প্রধানটা কোটা/রেট-লিমিটে আটকে গেলে এটা ব্যবহার হবে
    aiKey2: '', aiProvider2: 'groq',
    aiKey3: '', aiProvider3: 'groq',
    // প্রতিটা ঘরের ঐচ্ছিক মডেলের নাম ও (custom প্রোভাইডারের জন্য) Base URL — খালি থাকলে ডিফল্ট ব্যবহার হয়
    aiModel: '', aiModel2: '', aiModel3: '',
    aiBaseUrl: '', aiBaseUrl2: '', aiBaseUrl3: '',
    // প্রতিটা প্রোভাইডারের দৈনিক টোকেন সীমা (আপনার প্ল্যান অনুযায়ী বদলানো যাবে) — Groq ফ্রি = ১,০০,০০০
    aiLimits: { groq: 100000 },
    // স্টক এই সংখ্যা বা এর নিচে নামলে মালিকের কাছে অ্যালার্ট যায়
    lowStockThreshold: 5,
    // মালিকের নোট: আসন্ন উপলক্ষ, অফার, কোন দিকে জোর দেবেন — পোস্টের খসড়া বানানোর সময় AI এটা দেখে
    postNotes: '',
    // পেজের সাথে যুক্ত Instagram অ্যাকাউন্ট (Facebook কানেক্টের সময় নিজে থেকে খুঁজে বের হয়)
    igUserId: '', igUsername: ''
  };
  // বাড়তি AI Key-র ঘর (৪ থেকে ৮) — একই Key-তে আলাদা মডেল দিয়েও ঘর বানানো যায়
  for (let n = 4; n <= 8; n++) { d['aiKey' + n] = ''; d['aiProvider' + n] = 'groq'; d['aiModel' + n] = ''; d['aiBaseUrl' + n] = ''; }
  return d;
}

function computeConnected(s) {
  const c = {
    fb: !!s.fbToken,
    wa: !!(s.waToken && s.waPhoneNumberId),
    sheet: !!s.sheetLink,
    ai: !!s.aiKey,
    ai2: !!s.aiKey2,
    ai3: !!s.aiKey3,
    ig: !!s.igUserId,
    tg: !!s.tgToken,
    tk: !!s.tkAccessToken
  };
  for (let n = 4; n <= 8; n++) c['ai' + n] = !!s['aiKey' + n];
  return c;
}

/* ---------- Settings ---------- */
async function getSettings() {
  const db = await getDb();
  const doc = await db.collection('meta').findOne({ _id: 'settings' });
  const merged = { ...defaultSettings(), ...stripId(doc) };
  return { ...merged, connected: computeConnected(merged) };
}

async function saveSettings(partial) {
  const db = await getDb();
  const current = await getSettings();
  delete current.connected;
  const merged = { ...current, ...partial };
  await db.collection('meta').updateOne({ _id: 'settings' }, { $set: merged }, { upsert: true });
  return { ...merged, connected: computeConnected(merged), sheetSaved: true, sheetError: null };
}

/* ---------- Customers ---------- */
function newCustomerId() {
  return 'C-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
}

async function findOrCreateCustomer({ platform, platformId, name, phone, photoUrl }) {
  const db = await getDb();
  const col = db.collection('customers');
  // একসাথে দুইটা মেসেজ এলেও যেন একজন কাস্টমারের দুইটা রেকর্ড না হয়, তাই এক ধাপে (atomic) খুঁজে/তৈরি করি
  const result = await col.findOneAndUpdate(
    { platform, platformId },
    {
      $setOnInsert: {
        id: newCustomerId(),
        platform, platformId,
        name: name || 'অজানা কাস্টমার',
        phone: phone || '',
        photoUrl: photoUrl || '',
        orders: 0,
        ai: true,
        createdAt: new Date().toISOString()
      }
    },
    { upsert: true, returnDocument: 'after' }
  );
  const customer = (result && result.platformId !== undefined) ? result : (result && result.value) || await col.findOne({ platform, platformId });
  return stripId(customer);
}

async function getCustomers() {
  const db = await getDb();
  const list = await db.collection('customers').find().sort({ createdAt: -1 }).toArray();
  // যে কাস্টমার সবশেষ মেসেজ দিয়েছে সে সবার আগে — পুরনো কাস্টমারদের জন্য কথোপকথন থেকে সময় বের করি
  const convs = await db.collection('conversations').find({}, { projection: { customerId: 1, messages: { $slice: -6 } } }).toArray();
  const lastUser = {};
  convs.forEach(cv => {
    const m = (cv.messages || []).filter(x => x.role === 'user' && x.ts).pop();
    if (m) lastUser[cv.customerId] = m.ts;
  });
  const key = c => new Date(c.lastMessageAt || lastUser[c.id] || c.createdAt || 0).getTime() || 0;
  list.sort((a, b) => key(b) - key(a));
  return list.map(stripId);
}

// কাস্টমারের দীর্ঘমেয়াদি স্মৃতি (নাম, ঠিকানা, পছন্দ, আগের আলোচনার সারাংশ) — পুরনো মেসেজ বাদ গেলেও মনে থাকে
async function getCustomerMemory(id) {
  const db = await getDb();
  const c = await db.collection('customers').findOne({ id }, { projection: { memory: 1 } });
  return (c && c.memory) || '';
}
async function setCustomerMemory(id, memory) {
  const db = await getDb();
  await db.collection('customers').updateOne({ id }, { $set: { memory: String(memory || '').slice(0, 900), memoryAt: new Date().toISOString() } });
}

async function setCustomerAI(id, aiOn) {
  const db = await getDb();
  const col = db.collection('customers');
  await col.updateOne({ id }, { $set: { ai: aiOn } });
  return stripId(await col.findOne({ id }));
}

async function updateCustomerContact(id, { name, phone, photoUrl, username, email, orderName, nameSource }) {
  const db = await getDb();
  const col = db.collection('customers');
  const set = {};
  if (name && name.trim()) set.name = name.trim();
  if (phone && phone.trim()) set.phone = phone.trim();
  if (photoUrl) set.photoUrl = photoUrl;
  if (username) set.username = username;
  if (email) set.email = email;
  if (orderName && orderName.trim()) set.orderName = orderName.trim();
  if (nameSource) set.nameSource = nameSource;
  if (Object.keys(set).length) await col.updateOne({ id }, { $set: set });
  return stripId(await col.findOne({ id }));
}

/* ---------- Conversations ---------- */
async function getConversation(customerId) {
  const db = await getDb();
  const doc = await db.collection('conversations').findOne({ customerId });
  return (doc && doc.messages) || [];
}

async function appendMessage(customerId, role, text, meta) {
  const db = await getDb();
  const current = await getConversation(customerId);
  // সাম্প্রতিক ১৬টা মেসেজ রাখি — এতে প্রতিটা AI রিকোয়েস্টে কম টোকেন লাগে
  const updated = [...current, Object.assign({ role, text, ts: new Date().toISOString() }, meta || {})].slice(-80);
  await db.collection('conversations').updateOne(
    { customerId },
    { $set: { messages: updated } },
    { upsert: true }
  );
  if (role === 'user') {
    await db.collection('customers').updateOne({ id: customerId }, { $set: { lastMessageAt: new Date().toISOString() } }).catch(() => {});
  }
}

/* ---------- Orders ---------- */
async function nextOrderIdFrom(db) {
  const result = await db.collection('counters').findOneAndUpdate(
    { _id: 'orderSeq' },
    { $inc: { value: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  // MongoDB driver-এর নতুন ভার্সন সরাসরি ডকুমেন্ট ফেরত দেয়, পুরনো ভার্সন { value: ডকুমেন্ট } দেয় —
  // দুটো ক্ষেত্রেই যেন সঠিক সংখ্যা পাওয়া যায়
  const doc = (result && typeof result.value === 'object' && result.value !== null) ? result.value : result;
  const seq = (doc && Number(doc.value)) || 1;
  return 'ORD-' + String(1000 + seq).padStart(6, '0');
}

async function nextSeq(db) {
  const r = await db.collection('counters').findOneAndUpdate({ _id: 'orderSeq' }, { $inc: { value: 1 } }, { upsert: true, returnDocument: 'after' });
  const doc = (r && typeof r.value === 'object' && r.value !== null) ? r.value : r;
  return (doc && Number(doc.value)) || 1;
}

async function nextOrderId() {
  return nextOrderIdFrom(await getDb());
}

async function createOrder({ customerId, name, phone, address, product, qty, price, email, source, stockItem, district, payment, transactionId, shipping, paymentProof, paymentVerified, paidAmount, extra }) {
  const db = await getDb();
  // আইডি আসে মালিকের অর্ডার-শিট থেকে (প্রথম ফাঁকা ঘর); শিট চালু না থাকলে আগের নিয়মে
  let id = null;
  if (orderSheet.enabled()) {
    const q = Number(qty) || 1, pr = Number(price) || 0, sh = Number(shipping) || 0;
    id = await orderSheet.claim({ name, phone, address, district, product, qty: q, price: pr, shipping: sh, total: (extra && Number(extra.total)) || (pr * q + sh), payment, transactionId, source: source || 'Chat', status: 'Pending' });
    if (!id) id = 'ORD-E' + (1000 + (await nextSeq(db))); // শিট না পেলে আলাদা চিহ্নের আইডি — যাতে শিটের আইডির সাথে না মেশে
  } else id = await nextOrderId();
  const order = {
    id, customerId, name,
    phone: phone || '',
    address: address || '',
    email: email || '',
    product, qty: qty || 1, price: price || 0,
    status: 'Pending', source,
    callStatus: '', callNote: '', callAt: '', remindAt: '', callAttempts: 0, fsSynced: false,
    stockItem: stockItem || '', stockRestored: false,
    district: district || '', payment: payment || '', transactionId: transactionId || '', shipping: Number(shipping) || 0, paymentProof: paymentProof || '',
    paymentVerified: paymentVerified === undefined ? null : !!paymentVerified, paidAmount: Number(paidAmount) || 0,
    createdAt: new Date().toISOString()
  };
  if (extra && typeof extra === 'object') Object.assign(order, extra); // অর্ডার-কার্ড: items, subtotal, discount, couponCode, total, paymentStatus ইত্যাদি
  await db.collection('orders').insertOne(order);
  await db.collection('customers').updateOne({ id: customerId }, { $inc: { orders: 1 }, $set: { lastOrderAt: order.createdAt } });
  return stripId(order);
}


// বিকাশ/নগদ পেমেন্টের স্ক্রিনশট — গোপন (অনুমান-অযোগ্য) আইডিতে রাখা হয়
async function saveProof(customerId, { mime, b64 }) {
  const db = await getDb();
  const id = require('crypto').randomBytes(12).toString('hex');
  await db.collection('proofs').insertOne({ id, customerId, mime: mime || 'image/jpeg', b64, createdAt: new Date().toISOString() });
  const old = await db.collection('proofs').find({}, { projection: { _id: 1 } }).sort({ createdAt: -1 }).skip(300).toArray();
  if (old.length) await db.collection('proofs').deleteMany({ _id: { $in: old.map(o => o._id) } });
  return id;
}
async function getLatestProof(customerId, maxAgeMs) {
  const db = await getDb();
  const d = await db.collection('proofs').find({ customerId }, { projection: { id: 1, createdAt: 1 } }).sort({ createdAt: -1 }).limit(1).toArray();
  return d[0] && (Date.now() - new Date(d[0].createdAt).getTime() < (maxAgeMs || 86400000)) ? d[0].id : '';
}
async function getProof(id) {
  const db = await getDb();
  return db.collection('proofs').findOne({ id: String(id) });
}

async function getOrders() {
  const db = await getDb();
  const list = await db.collection('orders').find().sort({ createdAt: -1 }).toArray();
  return list.map(stripId);
}

async function getOrdersByCustomer(customerId) {
  const db = await getDb();
  const list = await db.collection('orders').find({ customerId }).sort({ createdAt: -1 }).toArray();
  return list.map(stripId);
}

async function attachEmailToLatestOrder(customerId, email) {
  const db = await getDb();
  const col = db.collection('orders');
  const order = await col.find({ customerId, $or: [{ email: '' }, { email: { $exists: false } }] })
    .sort({ createdAt: -1 }).limit(1).next();
  if (!order) return null;
  await col.updateOne({ id: order.id }, { $set: { email } });
  return stripId(await col.findOne({ id: order.id }));
}

/* ---------- বাইরের ওয়েবসাইট (Bazaar Admin) থেকে ওয়েবহুকের মাধ্যমে আসা অর্ডার ---------- */
async function createWebsiteOrder(payload = {}) {
  const db = await getDb();
  const id = payload.orderId ? String(payload.orderId) : await nextOrderId();

  const items = Array.isArray(payload.items) ? payload.items : [];
  const productSummary = items.length
    ? items.map(it => `${it.name || it.product || 'পণ্য'}${it.qty ? ' x' + it.qty : ''}`).join(', ')
    : (payload.product || 'ওয়েবসাইট অর্ডার');
  const qty = items.length ? items.reduce((sum, it) => sum + (Number(it.qty) || 1), 0) : (Number(payload.qty) || 1);
  const price = Number(payload.total) || Number(payload.subtotal) || 0;

  let customer = null;
  if (payload.phone) {
    const col = db.collection('customers');
    customer = await col.findOne({ phone: payload.phone, platform: 'website' });
    if (!customer) {
      customer = {
        id: newCustomerId(),
        platform: 'website',
        platformId: payload.phone,
        name: payload.customer || 'ওয়েবসাইট কাস্টমার',
        phone: payload.phone,
        photoUrl: '',
        orders: 0, ai: true,
        createdAt: new Date().toISOString()
      };
      await col.insertOne(customer);
    }
    await col.updateOne({ id: customer.id }, { $inc: { orders: 1 } });
  }

  const order = {
    id,
    customerId: customer ? customer.id : null,
    name: payload.customer || (customer ? customer.name : 'ওয়েবসাইট কাস্টমার'),
    phone: payload.phone || (customer ? customer.phone : '') || '',
    product: productSummary, qty, price,
    status: 'Pending', source: 'Bazaar Admin',
    address: payload.address || '', email: payload.email || '',
    payment: payload.payment || '', transactionId: payload.transactionId || '',
    district: payload.district || '', shipping: Number(payload.shipping) || 0, discount: Number(payload.discount) || 0, subtotal: Number(payload.subtotal) || 0, total: Number(payload.total) || 0,
    couponCode: payload.couponCode || '', paymentStatus: payload.paymentStatus || '', paidAmount: Number(payload.paidAmount) || 0,
    paymentVerified: payload.paymentVerified === undefined ? null : payload.paymentVerified,
    callStatus: '', callNote: '', callAt: '', remindAt: '', callAttempts: 0,
    fsSynced: true, // ওয়েবসাইটের অর্ডার আগে থেকেই অ্যাডমিন প্যানেলে (Firestore-এ) থাকে
    createdAt: payload.date ? new Date(payload.date).toISOString() : new Date().toISOString()
  };
  await db.collection('orders').insertOne(order);
  return stripId(order);
}

async function updateOrderStatus(id, status) {
  const db = await getDb();
  const col = db.collection('orders');
  await col.updateOne({ id }, { $set: { status } });
  orderSheet.setStatus(id, status);
  return stripId(await col.findOne({ id }));
}

/* ---------- Broadcasts ---------- */
async function addBroadcast(record) {
  const db = await getDb();
  const withDate = { ...record, createdAt: new Date().toISOString() };
  await db.collection('broadcasts').insertOne(withDate);
  return stripId(withDate);
}

async function getBroadcasts() {
  const db = await getDb();
  const list = await db.collection('broadcasts').find().sort({ createdAt: -1 }).toArray();
  return list.map(stripId);
}

/* ---------- Email Logs ---------- */
async function addEmailLog(entry) {
  const db = await getDb();
  const withDate = { ...entry, createdAt: new Date().toISOString() };
  await db.collection('emailLogs').insertOne(withDate);
  return stripId(withDate);
}

async function getEmailLogs() {
  const db = await getDb();
  const list = await db.collection('emailLogs').find().sort({ createdAt: -1 }).limit(200).toArray();
  return list.map(stripId);
}

/* ---------- মালিকের AI নির্দেশনা (নতুন) ---------- */
async function getAiRules() {
  const db = await getDb();
  const list = await db.collection('aiRules').find().sort({ createdAt: 1 }).toArray();
  return list.map(stripId);
}

async function addAiRule(text) {
  const db = await getDb();
  const rule = {
    id: 'R-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text,
    createdAt: new Date().toISOString()
  };
  await db.collection('aiRules').insertOne(rule);
  return stripId(rule);
}

async function deleteAiRule(id) {
  const db = await getDb();
  const r = await db.collection('aiRules').deleteOne({ id });
  return r.deletedCount > 0;
}

/* ---------- AI ব্যবহার ট্র্যাকিং (নতুন) ---------- */
function bdDay(offsetDays = 0) {
  return new Date(Date.now() - offsetDays * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
}

async function addAiUsage(provider, tokens) {
  const db = await getDb();
  const date = bdDay();
  await db.collection('aiUsage').updateOne(
    { _id: `${date}|${provider}` },
    { $inc: { tokens: Number(tokens) || 0, requests: 1 }, $set: { date, provider } },
    { upsert: true }
  );
}

async function setAiRateInfo(provider, info) {
  const db = await getDb();
  await db.collection('meta').updateOne(
    { _id: 'aiRate:' + provider },
    { $set: { ...info, at: new Date().toISOString() } },
    { upsert: true }
  );
}

async function setAiLastError(provider, message) {
  const db = await getDb();
  await db.collection('meta').updateOne(
    { _id: 'aiError:' + provider },
    { $set: { message: String(message).slice(0, 300), at: new Date().toISOString() } },
    { upsert: true }
  );
}

async function getAiUsage() {
  const db = await getDb();
  const dates = [0, 1, 2, 3, 4, 5, 6].map(bdDay);
  const rows = await db.collection('aiUsage').find({ date: { $in: dates } }).toArray();
  const today = rows.filter(r => r.date === dates[0]).map(r => ({ provider: r.provider, tokens: r.tokens || 0, requests: r.requests || 0 }));
  const week = {};
  rows.forEach(r => { week[r.provider] = (week[r.provider] || 0) + (r.tokens || 0); });

  const metaDocs = await db.collection('meta').find({ _id: { $regex: '^ai(Rate|Error):' } }).toArray();
  const rate = {}, lastErrors = {};
  metaDocs.forEach(d => {
    const { _id, ...rest } = d;
    if (_id.startsWith('aiRate:')) rate[_id.slice(7)] = rest;
    else lastErrors[_id.slice(8)] = rest;
  });
  return { today, week, rate, lastErrors };
}

/* ---------- মালিকের আপলোড করা প্রোডাক্ট ছবি (নতুন) ---------- */
async function getAiImages() {
  const db = await getDb();
  const list = await db.collection('aiImages').find({}, { projection: { b64: 0 } }).sort({ createdAt: 1 }).toArray();
  return list.map(stripId);
}

async function addAiImage({ label, mime, b64 }) {
  const db = await getDb();
  const id = 'IMG' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const doc = { id, label, mime, b64, createdAt: new Date().toISOString() };
  await db.collection('aiImages').insertOne(doc);
  return { id, label, createdAt: doc.createdAt };
}

async function getAiImageData(id) {
  const db = await getDb();
  return db.collection('aiImages').findOne({ id });
}

async function deleteAiImage(id) {
  const db = await getDb();
  const r = await db.collection('aiImages').deleteOne({ id });
  return r.deletedCount > 0;
}

/* ---------- একটা সাধারণ সাহায্যকারী: findOneAndUpdate-এর ফল (নতুন/পুরনো driver দুই ভার্সনেই) ---------- */
function docOf(result) {
  if (!result) return null;
  if (typeof result.value === 'object' && result.value !== null) return result.value;
  if (result._id !== undefined) return result;
  return null;
}

/* ---------- অর্ডারের স্ট্যাটাস/নোটিফাই তথ্য, স্টক ফেরত (নতুন) ---------- */
async function getOrderById(id) {
  const db = await getDb();
  return stripId(await db.collection('orders').findOne({ id }));
}

async function setOrderFields(id, fields) {
  const db = await getDb();
  await db.collection('orders').updateOne({ id }, { $set: fields });
  return stripId(await db.collection('orders').findOne({ id }));
}

async function getCustomerById(id) {
  const db = await getDb();
  return stripId(await db.collection('customers').findOne({ id }));
}


// অ্যাপের সার্চ: নাম, ইউজারনেম, ফোন, আইডি, অর্ডারে দেওয়া নাম/ফোন/ঠিকানা, কেনা পণ্যের নাম, চ্যাটের যেকোনো লেখা — মিললে সেই কাস্টমার সবার উপরে
async function searchCustomers(q) {
  const norm = t => String(t || '').normalize('NFC').toLowerCase().replace(/[\u0981\s]+/g, '');
  const digits = t => String(t || '').replace(/[০-৯]/g, d => '০১২৩৪৫৬৭৮৯'.indexOf(d)).replace(/\D/g, '');
  const nq = norm(q), dq = digits(q);
  if (!nq) return [];
  const db = await getDb();
  const [customers, convs, orders] = await Promise.all([
    db.collection('customers').find().toArray(),
    db.collection('conversations').find().toArray(),
    db.collection('orders').find({}, { projection: { customerId: 1, product: 1, name: 1, phone: 1, address: 1, id: 1 } }).toArray()
  ]);
  const best = {};
  const hit = (id, score, why, snip) => { if (!best[id] || best[id].score < score) best[id] = { id, score, why, snippet: snip || '' }; };
  customers.forEach(c => {
    const f = (v, sc, why) => { if (v && norm(v).includes(nq)) hit(c.id, sc + (norm(v) === nq || norm(v).startsWith(nq) ? 5 : 0), why, String(v)); };
    f(c.name, 100, 'নাম'); f(c.username, 95, 'ইউজারনেম'); f(c.orderName, 90, 'অর্ডারের নাম'); f(c.platformId, 85, 'আইডি');
    if (dq.length >= 3) { const ph = digits(c.phone); if (ph && ph.includes(dq)) hit(c.id, 98, 'ফোন', c.phone); }
    f(c.note, 70, 'নোট'); f(c.email, 80, 'ইমেইল');
    if (c.interest && c.interest.product && norm(c.interest.product).includes(nq)) hit(c.id, 75, 'আগ্রহী পণ্য', c.interest.product);
  });
  orders.forEach(o => {
    if (o.product && norm(o.product).includes(nq)) hit(o.customerId, 72, 'কেনা পণ্য', o.product);
    if (o.name && norm(o.name).includes(nq)) hit(o.customerId, 88, 'অর্ডারের নাম', o.name);
    if (dq.length >= 3 && digits(o.phone).includes(dq)) hit(o.customerId, 96, 'অর্ডারের ফোন', o.phone);
    if (o.address && norm(o.address).includes(nq)) hit(o.customerId, 60, 'ঠিকানা', o.address);
    if (o.id && norm(o.id).includes(nq)) hit(o.customerId, 97, 'অর্ডার নম্বর', o.id);
  });
  convs.forEach(cv => {
    const ms = cv.messages || [];
    for (let i = ms.length - 1; i >= 0; i--) {
      const t = String(ms[i].text || '');
      if (norm(t).includes(nq)) { hit(cv.customerId, 50, 'চ্যাট', t.slice(0, 90)); break; }
    }
  });
  const known = new Set(customers.map(c => c.id));
  return Object.values(best).filter(h => known.has(h.id)).sort((a, b) => b.score - a.score);
}

/* ---------- কাস্টমার ম্যানেজমেন্ট (CRM): পরিসংখ্যান, নোট, আগ্রহী তালিকা, ফলো-আপ ---------- */
// প্রতিটা কাস্টমারের অর্ডারের হিসাব: মোট অর্ডার, ডেলিভারড, বাতিল/ফেরত, পেন্ডিং, মোট কেনা টাকা (ডেলিভারড)
function statsFromOrders(list) {
  const st = { total: 0, delivered: 0, cancelled: 0, pending: 0, spent: 0, placedValue: 0, lastOrderAt: '' };
  (list || []).forEach(o => {
    const val = (Number(o.price) || 0) * (Number(o.qty) || 1) + (Number(o.shipping) || 0);
    st.total++;
    if (o.status === 'Delivered') { st.delivered++; st.spent += val; }
    else if (o.status === 'Cancelled' || o.status === 'Returned') st.cancelled++;
    else st.pending++;
    if (o.status !== 'Cancelled' && o.status !== 'Returned') st.placedValue += val;
    if (!st.lastOrderAt || o.createdAt > st.lastOrderAt) st.lastOrderAt = o.createdAt;
  });
  return st;
}
async function getCustomerStatsMap() {
  const db = await getDb();
  const orders = await db.collection('orders').find({}, { projection: { customerId: 1, status: 1, price: 1, qty: 1, shipping: 1, createdAt: 1 } }).toArray();
  const by = {};
  orders.forEach(o => { (by[o.customerId] = by[o.customerId] || []).push(o); });
  const map = {};
  Object.keys(by).forEach(k => { map[k] = statsFromOrders(by[k]); });
  return map;
}
async function setCustomerNote(id, note) {
  const db = await getDb();
  await db.collection('customers').updateOne({ id }, { $set: { note: String(note || '').slice(0, 1000), noteAt: new Date().toISOString() } });
  return stripId(await db.collection('customers').findOne({ id }));
}
// কাস্টমার কোন পণ্যে আগ্রহ দেখিয়েছে (কার্ড/আলোচনা) — অর্ডার না করলে "আগ্রহী তালিকা"-য় থাকে
async function setInterest(id, { productId, product }) {
  const db = await getDb();
  await db.collection('customers').updateOne({ id }, { $set: { interest: { productId: String(productId || ''), product: String(product || '').slice(0, 120), at: new Date().toISOString() } } });
}
async function getInterestedCustomers() {
  const db = await getDb();
  const list = await db.collection('customers').find({ 'interest.at': { $exists: true } }).toArray();
  return list.filter(c => !c.lastOrderAt || c.interest.at > c.lastOrderAt).map(stripId)
    .sort((a, b) => String(b.interest.at).localeCompare(String(a.interest.at)));
}
// "পরে মেসেজ দিন" — ঠিক সময়ে AI নিজে ফলো-আপ পাঠায়
async function setFollowUp(id, { at, reason }) {
  const db = await getDb();
  await db.collection('customers').updateOne({ id }, { $set: { followUp: { at: new Date(at).toISOString(), reason: String(reason || '').slice(0, 160), done: false, createdAt: new Date().toISOString() } } });
}
async function clearFollowUp(id) {
  const db = await getDb();
  await db.collection('customers').updateOne({ id, 'followUp.done': false }, { $set: { 'followUp.done': true, 'followUp.doneAt': new Date().toISOString() } });
}
async function claimDueFollowUps(limit) {
  const db = await getDb();
  const out = [];
  for (let i = 0; i < (limit || 5); i++) {
    const r = await db.collection('customers').findOneAndUpdate(
      { 'followUp.done': false, 'followUp.at': { $lte: new Date().toISOString() } },
      { $set: { 'followUp.done': true, 'followUp.doneAt': new Date().toISOString(), 'followUp.sent': true } },
      { returnDocument: 'after' }
    );
    const doc = (r && r.platformId !== undefined) ? r : (r && r.value) || null;
    if (!doc) break;
    out.push(stripId(doc));
  }
  return out;
}

/* ---------- "মানুষের অপেক্ষায়" ফ্ল্যাগ (নতুন) ---------- */
async function setNeedsHuman(id, reason) {
  const db = await getDb();
  await db.collection('customers').updateOne(
    { id },
    { $set: { needsHuman: true, needsHumanReason: String(reason || '').slice(0, 200), needsHumanAt: new Date().toISOString() } }
  );
}

async function clearNeedsHuman(id) {
  const db = await getDb();
  await db.collection('customers').updateOne(
    { id },
    { $set: { needsHuman: false }, $unset: { needsHumanReason: '', needsHumanAt: '' } }
  );
  return stripId(await db.collection('customers').findOne({ id }));
}

/* ---------- নোটিফিকেশন ও পুশ সাবস্ক্রিপশন (নতুন) ---------- */
async function addNotification({ type, title, body }) {
  const db = await getDb();
  const col = db.collection('notifications');
  const doc = {
    id: 'N' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    type, title, body: body || '', read: false, createdAt: new Date().toISOString()
  };
  await col.insertOne(doc);
  // সর্বশেষ ১০০টা রাখি, পুরনোগুলো মুছে ফেলি
  const old = await col.find({}, { projection: { _id: 1 } }).sort({ createdAt: -1 }).skip(100).toArray();
  if (old.length) await col.deleteMany({ _id: { $in: old.map(o => o._id) } });
  return stripId(doc);
}

async function getNotifications(limit = 30) {
  const db = await getDb();
  const col = db.collection('notifications');
  const items = (await col.find().sort({ createdAt: -1 }).limit(limit).toArray()).map(stripId);
  const unread = await col.countDocuments({ read: false });
  return { items, unread };
}

async function countUnreadNotifications() {
  const db = await getDb();
  return db.collection('notifications').countDocuments({ read: false });
}

async function markNotificationsRead() {
  const db = await getDb();
  await db.collection('notifications').updateMany({ read: false }, { $set: { read: true } });
}

async function savePushSub(subscription) {
  const db = await getDb();
  await db.collection('pushSubs').updateOne(
    { endpoint: subscription.endpoint },
    { $set: { endpoint: subscription.endpoint, subscription, createdAt: new Date().toISOString() } },
    { upsert: true }
  );
}

async function getPushSubs() {
  const db = await getDb();
  return (await db.collection('pushSubs').find().toArray()).map(stripId);
}

async function deletePushSub(endpoint) {
  const db = await getDb();
  await db.collection('pushSubs').deleteOne({ endpoint });
}

// VAPID কী — প্রথমবার নিজে থেকে তৈরি হয়ে ডেটাবেসে সেভ হয়, আলাদা কিছু বসাতে হয় না
async function getVapidKeys(generate) {
  const db = await getDb();
  const col = db.collection('meta');
  let doc = await col.findOne({ _id: 'vapid' });
  if (!doc) {
    const keys = generate();
    await col.updateOne({ _id: 'vapid' }, { $setOnInsert: { publicKey: keys.publicKey, privateKey: keys.privateKey } }, { upsert: true });
    doc = await col.findOne({ _id: 'vapid' });
  }
  return { publicKey: doc.publicKey, privateKey: doc.privateKey };
}

/* ---------- স্টক (অ্যাপের ভেতরে) (নতুন) ---------- */
function normName(str) {
  return String(str || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

async function getStockList() {
  const db = await getDb();
  return (await db.collection('stock').find().sort({ name: 1 }).toArray()).map(stripId);
}

async function setStock(name, qty) {
  const db = await getDb();
  const col = db.collection('stock');
  if (qty === null || qty === undefined || qty === '') {
    await col.deleteOne({ name });
    return null;
  }
  const n = Math.max(0, Math.floor(Number(qty)));
  await col.updateOne(
    { name },
    { $set: { name, qty: n, updatedAt: new Date().toISOString() } },
    { upsert: true }
  );
  return { name, qty: n };
}

// AI যে নাম লিখেছে তার সাথে সবচেয়ে মিল থাকা স্টক এন্ট্রি খোঁজে (পুরোপুরি মিল > সবচেয়ে লম্বা আংশিক মিল)
async function findStockEntry(productName) {
  const target = normName(productName);
  if (!target) return null;
  const list = await getStockList();
  const exact = list.find(e => normName(e.name) === target);
  if (exact) return exact;
  let best = null;
  for (const e of list) {
    const n = normName(e.name);
    if (n.length < 3) continue;
    if (n.includes(target) || target.includes(n)) {
      if (!best || n.length > normName(best.name).length) best = e;
    }
  }
  return best;
}

// স্টক থেকে n টা কমায় — যথেষ্ট না থাকলে কমায় না (একসাথে দুই অর্ডার এলেও নেগেটিভ হবে না)
async function decrementStock(name, n) {
  const db = await getDb();
  const result = await db.collection('stock').findOneAndUpdate(
    { name, qty: { $gte: n } },
    { $inc: { qty: -n }, $set: { updatedAt: new Date().toISOString() } },
    { returnDocument: 'after' }
  );
  const doc = docOf(result);
  if (doc) return { ok: true, qty: doc.qty };
  const cur = await db.collection('stock').findOne({ name });
  return { ok: false, qty: cur ? cur.qty : 0 };
}

async function incrementStock(name, n) {
  const db = await getDb();
  const result = await db.collection('stock').findOneAndUpdate(
    { name },
    { $inc: { qty: n }, $set: { updatedAt: new Date().toISOString() } },
    { returnDocument: 'after' }
  );
  const doc = docOf(result);
  return doc ? { ok: true, qty: doc.qty } : { ok: false, qty: 0 };
}

/* ---------- ফেসবুক পোস্টের হিস্টোরি (নতুন) ---------- */
async function addPost(doc) {
  const db = await getDb();
  const post = { id: 'P' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), createdAt: new Date().toISOString(), ...doc };
  await db.collection('posts').insertOne(post);
  // সর্বশেষ ৬০টা রাখি, পুরনো থাম্বনেইলসহ মুছে ফেলি — ডেটাবেসের জায়গা বাঁচাতে
  const col = db.collection('posts');
  const old = await col.find({}, { projection: { _id: 1, mediaId: 1 } }).sort({ createdAt: -1 }).skip(60).toArray();
  if (old.length) {
    await col.deleteMany({ _id: { $in: old.map(o => o._id) } });
    const mediaIds = old.map(o => o.mediaId).filter(Boolean);
    if (mediaIds.length) await db.collection('postMedia').deleteMany({ id: { $in: mediaIds } });
  }
  return stripId(post);
}

async function getPosts(limit = 30) {
  const db = await getDb();
  return (await db.collection('posts').find().sort({ createdAt: -1 }).limit(limit).toArray()).map(stripId);
}

async function getPostById(id) {
  const db = await getDb();
  return stripId(await db.collection('posts').findOne({ id }));
}

async function deletePostRecord(id) {
  const db = await getDb();
  await db.collection('posts').deleteOne({ id });
}

/* ---------- Instagram শিডিউল: পোস্টের ছবি, কাজের তালিকা, গোপন কী (নতুন) ---------- */
async function addPostMedia({ mime, b64 }) {
  const db = await getDb();
  const id = 'PM' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await db.collection('postMedia').insertOne({ id, mime, b64, createdAt: new Date().toISOString() });
  return id;
}
async function getPostMedia(id) {
  const db = await getDb();
  return db.collection('postMedia').findOne({ id });
}
async function deletePostMedia(id) {
  const db = await getDb();
  await db.collection('postMedia').deleteOne({ id });
}
async function updatePost(id, fields) {
  const db = await getDb();
  await db.collection('posts').updateOne({ id }, { $set: fields });
  return stripId(await db.collection('posts').findOne({ id }));
}
// সময় হয়েছে এমন একটা Instagram কাজ আটকে নেয় (একসাথে দুইবার পোস্ট ঠেকাতে atomic)
async function claimDueIgPost() {
  const db = await getDb();
  const now = new Date().toISOString();
  const result = await db.collection('posts').findOneAndUpdate(
    { igStatus: 'pending', igDueAt: { $lte: now } },
    { $set: { igStatus: 'publishing', igClaimedAt: now } },
    { sort: { igDueAt: 1 }, returnDocument: 'after' }
  );
  return stripId(docOf(result));
}
// সময় হয়েছে এমন একটা Telegram চ্যানেল-পোস্ট আটকে নেয় (atomic)
async function claimDueTgPost() {
  const db = await getDb();
  const now = new Date().toISOString();
  const result = await db.collection('posts').findOneAndUpdate(
    { tgStatus: 'pending', tgDueAt: { $lte: now } },
    { $set: { tgStatus: 'publishing', tgClaimedAt: now } },
    { sort: { tgDueAt: 1 }, returnDocument: 'after' }
  );
  return stripId(docOf(result));
}
async function claimDueTkPost() {
  const db = await getDb();
  const now = new Date().toISOString();
  const result = await db.collection('posts').findOneAndUpdate(
    { tkStatus: 'pending', tkDueAt: { $lte: now } },
    { $set: { tkStatus: 'publishing', tkClaimedAt: now } },
    { sort: { tkDueAt: 1 }, returnDocument: 'after' }
  );
  return stripId(docOf(result));
}
async function failStuckTkPosts() {
  const db = await getDb();
  const cutoff = new Date(Date.now() - 10 * 60000).toISOString();
  await db.collection('posts').updateMany(
    { tkStatus: 'publishing', tkClaimedAt: { $lt: cutoff } },
    { $set: { tkStatus: 'failed', tkError: 'অনিশ্চিত অবস্থা — TikTok-এ গিয়ে দেখে নিন' } }
  );
}
async function failStuckTgPosts() {
  const db = await getDb();
  const cutoff = new Date(Date.now() - 10 * 60000).toISOString();
  await db.collection('posts').updateMany(
    { tgStatus: 'publishing', tgClaimedAt: { $lt: cutoff } },
    { $set: { tgStatus: 'failed', tgError: 'অনিশ্চিত অবস্থা — চ্যানেলে গিয়ে দেখে নিন' } }
  );
}
// ১০ মিনিটের বেশি "চলছে" অবস্থায় আটকে থাকা কাজ আবার না চালিয়ে ব্যর্থ ধরি — নইলে দুইবার পোস্ট হয়ে যেতে পারে
async function failStuckIgPosts() {
  const db = await getDb();
  const cutoff = new Date(Date.now() - 10 * 60000).toISOString();
  await db.collection('posts').updateMany(
    { igStatus: 'publishing', igClaimedAt: { $lt: cutoff } },
    { $set: { igStatus: 'failed', igError: 'অনিশ্চিত অবস্থা — Instagram-এ গিয়ে দেখে নিন পোস্ট হয়েছে কিনা' } }
  );
}
// বাইরের পিং (UptimeRobot) যে গোপন লিংকে আসবে তার কী — প্রথমবার নিজে তৈরি হয়
async function getCronKey() {
  const db = await getDb();
  const col = db.collection('meta');
  let doc = await col.findOne({ _id: 'cron' });
  if (!doc) {
    const key = require('crypto').randomBytes(12).toString('hex');
    await col.updateOne({ _id: 'cron' }, { $setOnInsert: { key } }, { upsert: true });
    doc = await col.findOne({ _id: 'cron' });
  }
  return doc.key;
}

// ৪০ মিনিটের বেশি "আপলোড চলছে" অবস্থায় আটকে থাকা ভিডিও পোস্ট ব্যর্থ ধরি (সার্ভার মাঝপথে রিস্টার্ট হলে এমন হতে পারে)
async function failStuckVideoPosts() {
  const db = await getDb();
  const cutoff = new Date(Date.now() - 40 * 60000).toISOString();
  await db.collection('posts').updateMany(
    { status: 'processing', createdAt: { $lt: cutoff } },
    { $set: { status: 'failed', error: 'ভিডিও আপলোড শেষ হয়নি (সার্ভার রিস্টার্ট হতে পারে) — আবার চেষ্টা করুন' } }
  );
}

module.exports = { saveProof, getLatestProof, getProof,
  getDb, failStuckVideoPosts,
  getSettings, saveSettings,
  searchCustomers, statsFromOrders, getCustomerStatsMap, setCustomerNote, setInterest, getInterestedCustomers, setFollowUp, clearFollowUp, claimDueFollowUps,
  findOrCreateCustomer, getCustomers, setCustomerAI, updateCustomerContact,
  appendMessage, getConversation,
  createOrder, createWebsiteOrder, getOrders, getOrdersByCustomer, updateOrderStatus, attachEmailToLatestOrder,
  addBroadcast, getBroadcasts, getCustomerMemory, setCustomerMemory,
  addEmailLog, getEmailLogs,
  getAiRules, addAiRule, deleteAiRule,
  addAiUsage, setAiRateInfo, setAiLastError, getAiUsage,
  getAiImages, addAiImage, getAiImageData, deleteAiImage,
  getOrderById, setOrderFields, getCustomerById,
  setNeedsHuman, clearNeedsHuman,
  addNotification, getNotifications, countUnreadNotifications, markNotificationsRead,
  savePushSub, getPushSubs, deletePushSub, getVapidKeys,
  getStockList, setStock, findStockEntry, decrementStock, incrementStock,
  addPost, getPosts, getPostById, deletePostRecord,
  addPostMedia, getPostMedia, deletePostMedia, updatePost, claimDueIgPost, failStuckIgPosts, claimDueTgPost, failStuckTgPosts, claimDueTkPost, failStuckTkPosts, getCronKey
};
