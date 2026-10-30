// আগে অর্ডার/কাস্টমার/কথোপকথন লোকাল db.json ফাইলে রাখা হতো — কিন্তু Render ফ্রি প্ল্যানে
// প্রতিটা নতুন deploy-তে সেই ফাইল মুছে যায় (ephemeral disk), ফলে ডেটা হারিয়ে যাচ্ছিল।
// এখন সবকিছু MongoDB-তে স্থায়ীভাবে সেভ হয় — redeploy হলেও আর হারাবে না।

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
  return {
    fbToken: '', fbPageId: '', fbAppId: '',
    waToken: '', waPhoneNumberId: '', waBusinessId: '', waConfigId: '', waAppId: '',
    sheetLink: '', faqSheetLink: '',
    aiKey: '', aiProvider: 'groq', aiAutoReply: true,
    // ব্যাকআপ AI Key — প্রধানটা কোটা/রেট-লিমিটে আটকে গেলে এটা ব্যবহার হবে
    aiKey2: '', aiProvider2: 'groq',
    // প্রতিটা প্রোভাইডারের দৈনিক টোকেন সীমা (আপনার প্ল্যান অনুযায়ী বদলানো যাবে) — Groq ফ্রি = ১,০০,০০০
    aiLimits: { groq: 100000 },
    // স্টক এই সংখ্যা বা এর নিচে নামলে মালিকের কাছে অ্যালার্ট যায়
    lowStockThreshold: 5
  };
}

function computeConnected(s) {
  return {
    fb: !!s.fbToken,
    wa: !!(s.waToken && s.waPhoneNumberId),
    sheet: !!s.sheetLink,
    ai: !!s.aiKey,
    ai2: !!s.aiKey2
  };
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
  return list.map(stripId);
}

async function setCustomerAI(id, aiOn) {
  const db = await getDb();
  const col = db.collection('customers');
  await col.updateOne({ id }, { $set: { ai: aiOn } });
  return stripId(await col.findOne({ id }));
}

async function updateCustomerContact(id, { name, phone, photoUrl }) {
  const db = await getDb();
  const col = db.collection('customers');
  const set = {};
  if (name && name.trim()) set.name = name.trim();
  if (phone && phone.trim()) set.phone = phone.trim();
  if (photoUrl) set.photoUrl = photoUrl;
  if (Object.keys(set).length) await col.updateOne({ id }, { $set: set });
  return stripId(await col.findOne({ id }));
}

/* ---------- Conversations ---------- */
async function getConversation(customerId) {
  const db = await getDb();
  const doc = await db.collection('conversations').findOne({ customerId });
  return (doc && doc.messages) || [];
}

async function appendMessage(customerId, role, text) {
  const db = await getDb();
  const current = await getConversation(customerId);
  // সাম্প্রতিক ১৬টা মেসেজ রাখি — এতে প্রতিটা AI রিকোয়েস্টে কম টোকেন লাগে
  const updated = [...current, { role, text, ts: new Date().toISOString() }].slice(-16);
  await db.collection('conversations').updateOne(
    { customerId },
    { $set: { messages: updated } },
    { upsert: true }
  );
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

async function nextOrderId() {
  return nextOrderIdFrom(await getDb());
}

async function createOrder({ customerId, name, phone, address, product, qty, price, email, source, stockItem }) {
  const db = await getDb();
  const id = await nextOrderId();
  const order = {
    id, customerId, name,
    phone: phone || '',
    address: address || '',
    email: email || '',
    product, qty: qty || 1, price: price || 0,
    status: 'Pending', source,
    stockItem: stockItem || '', stockRestored: false,
    createdAt: new Date().toISOString()
  };
  await db.collection('orders').insertOne(order);
  await db.collection('customers').updateOne({ id: customerId }, { $inc: { orders: 1 } });
  return stripId(order);
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
    product: productSummary, qty, price,
    status: 'Pending', source: 'Bazaar Admin',
    address: payload.address || '', email: payload.email || '',
    payment: payload.payment || '', transactionId: payload.transactionId || '',
    createdAt: payload.date ? new Date(payload.date).toISOString() : new Date().toISOString()
  };
  await db.collection('orders').insertOne(order);
  return stripId(order);
}

async function updateOrderStatus(id, status) {
  const db = await getDb();
  const col = db.collection('orders');
  await col.updateOne({ id }, { $set: { status } });
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

module.exports = {
  getSettings, saveSettings,
  findOrCreateCustomer, getCustomers, setCustomerAI, updateCustomerContact,
  appendMessage, getConversation,
  createOrder, createWebsiteOrder, getOrders, getOrdersByCustomer, updateOrderStatus, attachEmailToLatestOrder,
  addBroadcast, getBroadcasts,
  addEmailLog, getEmailLogs,
  getAiRules, addAiRule, deleteAiRule,
  addAiUsage, setAiRateInfo, setAiLastError, getAiUsage,
  getAiImages, addAiImage, getAiImageData, deleteAiImage,
  getOrderById, setOrderFields, getCustomerById,
  setNeedsHuman, clearNeedsHuman,
  addNotification, getNotifications, countUnreadNotifications, markNotificationsRead,
  savePushSub, getPushSubs, deletePushSub, getVapidKeys,
  getStockList, setStock, findStockEntry, decrementStock, incrementStock
};
