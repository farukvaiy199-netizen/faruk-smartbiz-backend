// ফেসবুক পোস্টের খসড়া বানায়: মালিকের নিজের বিক্রি, স্টক, শিটের প্রোডাক্ট, নোট ও নির্দেশনা দেখে
// আজকের জন্য সবচেয়ে উপযোগী প্রোডাক্ট বেছে ক্যাপশন ও ডিজাইনের লেখা তৈরি করে।
// ইন্টারনেট ঘেঁটে ট্রেন্ড খোঁজে না — শুধু আপনার ডেটা ও মৌসুম/উপলক্ষ দেখে।
const config = require('../config');
const store = require('./store');
const { getJsonReply } = require('./ai');
const { getSheetProducts } = require('./sheets');

function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function clip(s, n) { return String(s || '').trim().slice(0, n); }

function findSheetProduct(sheet, name) {
  const t = norm(name);
  if (!t) return null;
  return sheet.find(p => norm(p.name) === t)
    || sheet.find(p => norm(p.name).includes(t) || t.includes(norm(p.name)))
    || null;
}

async function generatePostDraft(settings, hint) {
  const [orders, stock, images, rules, recentPosts, sheet] = await Promise.all([
    store.getOrders(), store.getStockList(), store.getAiImages(), store.getAiRules(),
    store.getPosts(5), getSheetProducts(settings.sheetLink)
  ]);

  const cutoff = Date.now() - 30 * 86400000;
  const sold = {};
  orders.filter(o => o.status !== 'Cancelled' && new Date(o.createdAt).getTime() >= cutoff)
    .forEach(o => { sold[o.product] = (sold[o.product] || 0) + (Number(o.qty) || 1); });
  const topSold = Object.entries(sold).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const today = new Date().toLocaleDateString('bn-BD', { timeZone: 'Asia/Dhaka', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  const lines = [
    `আজকের তারিখ (বাংলাদেশ): ${today}`,
    `মালিকের নোট / আসন্ন উপলক্ষ: ${settings.postNotes ? settings.postNotes : '(কিছু দেননি)'}`,
    `গত ৩০ দিনে বেশি বিক্রি হয়েছে: ${topSold.length ? topSold.map(([n, q]) => `${n} (${q}টি)`).join(', ') : '(এখনো কোনো অর্ডার নেই)'}`,
    `অ্যাপে বসানো স্টক: ${stock.length ? stock.map(e => `${e.name}: ${e.qty > 0 ? e.qty + 'টি' : 'শেষ'}`).join(', ') : '(বসানো নেই)'}`,
    `শিটের প্রোডাক্ট ও দাম: ${sheet.length ? sheet.slice(0, 40).map(p => `${p.name}${p.price ? ' — ' + p.price : ''}`).join(' | ') : '(শিট সংযুক্ত নেই)'}`,
    `মালিকের ছবি আছে এমন প্রোডাক্ট (imageId → নাম): ${images.length ? images.map(i => `${i.id} → ${i.label}`).join(' | ') : '(কোনো ছবি আপলোড করা নেই)'}`,
    `মালিকের নির্দেশনা (অবশ্যই মানবে): ${rules.length ? rules.map(r => r.text).join(' ; ') : '(নেই)'}`,
    `সাম্প্রতিক পোস্ট (একই জিনিস বারবার এড়াতে): ${recentPosts.length ? recentPosts.map(p => `${p.productName || '—'}: ${clip(p.caption, 50)}`).join(' | ') : '(নেই)'}`
  ];

  const systemPrompt = `
তুমি একটা অনলাইন দোকানের ফেসবুক পেজের কনটেন্ট সহকারী। মালিকের ডেটা দেখে আজকের জন্য একটা ফেসবুক পোস্টের খসড়া বানাও।

${lines.join('\n')}

কাজের নিয়ম:
- এখনকার মৌসুম/উপলক্ষ, বিক্রির অবস্থা আর স্টক দেখে একটা প্রোডাক্ট বেছে নাও। স্টকে শেষ এমন প্রোডাক্ট কখনো বেছো না। সাম্প্রতিক পোস্টের প্রোডাক্ট বারবার না নেওয়াই ভালো।
- ক্যাপশন বাংলায়, ৩-৬ লাইনের, আন্তরিক সুরে, ২-৪টা ইমোজি সহ। শেষে অর্ডারের আহ্বান ("অর্ডার করতে মেসেজ করুন") আর ৩-৫টা হ্যাশট্যাগ।
- দাম লিখলে শুধু উপরের তালিকায় যা আছে হুবহু তাই লিখবে। নিজে থেকে দাম, ছাড় বা অফার বানাবে না।
- কোনো রোগ সারানো বা চিকিৎসার দাবি করবে না। মিথ্যা বা প্রমাণহীন চরম দাবি করবে না।
- "headline" ছবির উপরে বসবে: সর্বোচ্চ ৬ শব্দ। "subline" ছোট লাইন: সর্বোচ্চ ১০ শব্দ।
- "imageId" শুধু উপরের তালিকার ID থেকে, ওই প্রোডাক্টের ছবি থাকলে। না থাকলে null।
- "reason"-এ এক লাইনে বলো কেন এই প্রোডাক্ট এখন বেছেছ।

শুধুমাত্র এই JSON ফরম্যাটে উত্তর দাও:
{"productName": "...", "headline": "...", "subline": "...", "caption": "...", "imageId": null অথবা "...", "reason": "..."}
`.trim();

  const userMessage = hint && hint.trim()
    ? `মালিকের ইচ্ছা: ${clip(hint, 300)}`
    : 'আজকের জন্য সবচেয়ে উপযোগী একটা পোস্ট বানাও।';

  const out = await getJsonReply({ settings, systemPrompt, userMessage });

  const caption = clip(out.caption, 1800);
  if (!caption) throw new Error('AI খসড়া বানাতে পারেনি, আবার চেষ্টা করুন');

  const imageId = images.some(i => i.id === out.imageId) ? out.imageId : null;
  const productName = clip(out.productName, 120);
  const match = findSheetProduct(sheet, productName);

  return {
    productName,
    headline: clip(out.headline, 60),
    subline: clip(out.subline, 90),
    caption,
    imageId,
    imageUrl: imageId ? `${config.publicUrl}/media/${imageId}` : null,
    // দাম শুধু শিট থেকে — AI-র বলা দাম ছবিতে বসানো হয় না
    priceText: match && match.price ? match.price : '',
    reason: clip(out.reason, 200)
  };
}

module.exports = { generatePostDraft };
