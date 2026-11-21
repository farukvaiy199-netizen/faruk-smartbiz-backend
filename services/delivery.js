'use strict';
// ওয়েবসাইটের ডেলিভারি/ক্যাশ-অন-ডেলিভারি নিয়ম — অ্যাডমিন প্যানেলের লাইভ সেটিংস থেকে পড়ে, তাই নিয়ম বদলালে AI নিজে থেকেই নতুন নিয়ম মানে।
const { calcShipping, num } = require('./pricing');

// [বাংলা নাম (ওয়েবসাইটের তালিকার হুবহু), ...ইংরেজি/বিকল্প বানান]
const D = [
  ['ঢাকা', 'dhaka'], ['গাজীপুর', 'gazipur'], ['নারায়ণগঞ্জ', 'narayanganj'], ['নরসিংদী', 'narsingdi'], ['মানিকগঞ্জ', 'manikganj'],
  ['মুন্সিগঞ্জ', 'munshiganj'], ['টাঙ্গাইল', 'tangail'], ['কিশোরগঞ্জ', 'kishoreganj'], ['ফরিদপুর', 'faridpur'], ['রাজবাড়ী', 'rajbari'],
  ['মাদারীপুর', 'madaripur'], ['শরীয়তপুর', 'shariatpur'], ['গোপালগঞ্জ', 'gopalganj'], ['চট্টগ্রাম', 'chattogram', 'chittagong', 'চিটাগাং', 'চিটাগং'],
  ['কক্সবাজার', "cox's bazar", 'coxs bazar', 'coxsbazar', 'coxbazar', "cox bazar"], ['কুমিল্লা', 'cumilla', 'comilla'], ['ফেনী', 'feni'],
  ['ব্রাহ্মণবাড়িয়া', 'brahmanbaria', 'b.baria'], ['রাঙ্গামাটি', 'rangamati'], ['নোয়াখালী', 'noakhali'], ['চাঁদপুর', 'chandpur'],
  ['লক্ষ্মীপুর', 'lakshmipur', 'laxmipur'], ['বান্দরবান', 'bandarban'], ['খাগড়াছড়ি', 'khagrachhari', 'khagrachari'], ['রাজশাহী', 'rajshahi'],
  ['চাঁপাইনবাবগঞ্জ', 'chapainawabganj', 'nawabganj'], ['নওগাঁ', 'naogaon'], ['নাটোর', 'natore'], ['পাবনা', 'pabna'], ['সিরাজগঞ্জ', 'sirajganj'],
  ['বগুড়া', 'bogura', 'bogra'], ['জয়পুরহাট', 'joypurhat'], ['খুলনা', 'khulna'], ['বাগেরহাট', 'bagerhat'], ['সাতক্ষীরা', 'satkhira'],
  ['যশোর', 'jashore', 'jessore', 'যশোহর'], ['ঝিনাইদহ', 'jhenaidah', 'jhenidah'], ['মাগুরা', 'magura'], ['নড়াইল', 'narail'], ['কুষ্টিয়া', 'kushtia'],
  ['চুয়াডাঙ্গা', 'chuadanga'], ['মেহেরপুর', 'meherpur'], ['বরিশাল', 'barishal', 'barisal'], ['ভোলা', 'bhola'], ['পটুয়াখালী', 'patuakhali'],
  ['পিরোজপুর', 'pirojpur'], ['ঝালকাঠি', 'jhalokati', 'jhalakathi', 'jhalokathi'], ['বরগুনা', 'barguna'], ['সিলেট', 'sylhet'],
  ['মৌলভীবাজার', 'moulvibazar', 'maulvibazar', 'moulvi bazar'], ['হবিগঞ্জ', 'habiganj'], ['সুনামগঞ্জ', 'sunamganj'], ['রংপুর', 'rangpur'],
  ['গাইবান্ধা', 'gaibandha'], ['কুড়িগ্রাম', 'kurigram'], ['লালমনিরহাট', 'lalmonirhat', 'lalmonirhat'], ['নীলফামারী', 'nilphamari'],
  ['ঠাকুরগাঁও', 'thakurgaon'], ['পঞ্চগড়', 'panchagarh'], ['দিনাজপুর', 'dinajpur'], ['ময়মনসিংহ', 'mymensingh'], ['জামালপুর', 'jamalpur'],
  ['নেত্রকোণা', 'netrokona', 'netrakona'], ['শেরপুর', 'sherpur']
];
const DISTRICTS = D.map(r => r[0]);

const norm = s => String(s || '').toLowerCase().replace(/[​-‍﻿]/g, '').replace(/[’‘`´]/g, "'");
function hit(text, alias) {
  if (/[^\x00-\x7f]/.test(alias)) return text.includes(alias);                    // বাংলা: অংশ মিললেই
  const esc = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^a-z])' + esc + '([^a-z]|$)', 'i').test(text);          // ইংরেজি: পুরো শব্দ
}
// কোনো লেখায় যতগুলো আলাদা জেলার নাম আছে (বাংলা নামে)
function districtsIn(text) {
  const t = norm(text);
  return D.filter(r => r.some(a => hit(t, norm(a)))).map(r => r[0]);
}
// শুধু জেলার নাম দেওয়া থাকলে সেটা চেনে ("dhaka", "ঢাকা জেলা")
function canon(text) {
  const t = norm(text).replace(/জেলা|district|zila/g, '').trim();
  if (!t) return '';
  const row = D.find(r => r.some(a => norm(a) === t));
  if (row) return row[0];
  const list = districtsIn(t);
  return list.length === 1 ? list[0] : '';
}

function fromSettings(st) {
  st = st || {};
  return {
    cod: Array.isArray(st.codDistricts) ? st.codDistricts : ['ঢাকা'],
    inside: num(st.shipInsideDhaka, 60), outside: num(st.shipOutsideDhaka, 120), prepay: num(st.prepayDiscount, 30),
    freeShip: num(st.freeShip, 0),
    plans: Array.isArray(st.paymentPlans) ? st.paymentPlans.filter(p => Number(p) > 0) : [],
    bkash: String(st.bkashNumber || '').trim(), nagad: String(st.nagadNumber || '').trim(),
    raw: st
  };
}

// AI-র সিস্টেম-প্রম্পটে বসার লেখা (প্রতি মেসেজে লাইভ সেটিংস থেকে বানানো হয়)
function promptText(r, site) {
  const codList = r.cod.length ? r.cod.join(', ') : '(কোনো জেলায় নেই)';
  const pay = [r.bkash ? `বিকাশ: ${r.bkash}` : '', r.nagad ? `নগদ: ${r.nagad}` : ''].filter(Boolean).join(' | ') || '(পেমেন্ট নম্বর সেটিংসে দেওয়া নেই — মালিকের সাথে কথা বলতে বলবে)';
  return `
=== ডেলিভারি ও পেমেন্টের নিয়ম (ওয়েবসাইটের লাইভ সেটিংস — এটাই একমাত্র সঠিক নিয়ম, অন্য কোথাও যা-ই লেখা থাকুক) ===
- ক্যাশ অন ডেলিভারি (COD) শুধু এই জেলাগুলোতে: ${codList}
- বাকি সব জেলায় অগ্রিম পেমেন্ট (বিকাশ/নগদ) বাধ্যতামূলক — কাস্টমার যত চাপই দিক, COD দেবে না, "আমি মালিকের সাথে কথা বলে দিচ্ছি" বলে ছাড়ও দেবে না।
- ডেলিভারি চার্জ: ঢাকা জেলার ভেতরে ৳${r.inside}, ঢাকার বাইরে ৳${r.outside}${r.freeShip > 0 ? `; ৳${r.freeShip} বা তার বেশি অর্ডারে ডেলিভারি ফ্রি` : ''}।
- অগ্রিম পেমেন্ট (বিকাশ/নগদ) করলে ডেলিভারি চার্জে ৳${r.prepay} পর্যন্ত ছাড় (চার্জের বেশি ছাড় হয় না)।
${r.plans.length ? `- অগ্রিমের অপশন: মোট দামের ${r.plans.join('% / ')}% আগে পাঠাতে পারবে, বাকিটা ডেলিভারির সময়।\n` : ''}- পেমেন্ট নম্বর: ${pay}
অর্ডার নেওয়ার সময় এই ধাপগুলো মানবে:
ক) নাম, ফোন, ঠিকানা ও পণ্যের সাথে কাস্টমারের **জেলা** জেনে নেবে (ঠিকানায় না থাকলে জিজ্ঞেস করবে)।
খ) জেলা COD-এর তালিকায় থাকলে জিজ্ঞেস করবে "ক্যাশ অন ডেলিভারি নেবেন নাকি আগে পেমেন্ট করবেন?"। না থাকলে পরিষ্কার জানাবে এই জেলায় COD নেই, অগ্রিম পেমেন্ট লাগবে — নম্বর ও চার্জ জানিয়ে পেমেন্ট করে ট্রানজেকশন আইডি (TrxID) পাঠাতে বলবে।
গ) অগ্রিম পেমেন্টে (বিকাশ/নগদ) দুটোই লাগবে: (১) ট্রানজেকশন আইডি (TrxID) এবং (২) পেমেন্টের স্ক্রিনশট। কাস্টমার স্ক্রিনশট পাঠালে চ্যাটে "[পেমেন্টের স্ক্রিনশট পাঠানো হয়েছে]" লেখা দেখবে। TrxID ও স্ক্রিনশট — এই দুটোর একটাও না পাওয়া পর্যন্ত "order" null রাখবে এবং যেটা বাকি সেটা ভদ্রভাবে চাইবে।
ঘ) "order"-এ অতিরিক্ত ফিল্ড বসাবে: "district" (কাস্টমারের জেলা, বাংলায়), "payment" ("cod" / "bkash" / "nagad"), "transactionId" (অগ্রিম হলে কাস্টমারের দেওয়া TrxID হুবহু, নইলে null)।
ঙ) সারাংশে পণ্যের দাম, ডেলিভারি চার্জ ও মোট পরিশোধযোগ্য টাকা আলাদা করে দেখাবে। ওয়েবসাইট: ${site}
`;
}

const isValidTrx = t => /^[A-Za-z0-9]{8,15}$/.test(String(t || '').trim()) && /[A-Za-z]/.test(t) && /[0-9]/.test(t);

// চ্যাট-অর্ডার তৈরির আগে সার্ভারের পাহারা (AI ভুল করলেও ফেক/নিয়মবিরুদ্ধ COD অর্ডার ঢুকবে না)
function checkChatOrder(r, order, hasProof) {
  const subtotal = (Number(order.price) || 0) * (Number(order.qty) || 1);
  const fromAi = canon(order.district);
  const inAddr = districtsIn(order.address);
  let district = fromAi;
  if (!district) district = inAddr.length === 1 ? inAddr[0] : '';
  if (fromAi && inAddr.length === 1 && inAddr[0] !== fromAi)
    return { ok: false, message: 'ঠিকানা আর জেলা মিলছে না — আপনার ডেলিভারি ঠিকানাটা কোন জেলায়, নিশ্চিত করে বলবেন?' };
  if (!district)
    return { ok: false, message: 'আপনার জেলার নাম জানাবেন? জেলা অনুযায়ী ডেলিভারি চার্জ ও পেমেন্টের নিয়ম আলাদা।' };
  let payment = String(order.payment || 'cod').toLowerCase();
  if (!['cod', 'bkash', 'nagad'].includes(payment)) payment = 'cod';
  const pay = [r.bkash ? `বিকাশ: ${r.bkash}` : '', r.nagad ? `নগদ: ${r.nagad}` : ''].filter(Boolean).join(' | ');
  const ship = calcShipping(r.raw, subtotal, district, payment === 'cod' ? 'cod' : 'bkash');
  if (payment === 'cod' && !r.cod.includes(district)) {
    const adv = calcShipping(r.raw, subtotal, district, 'bkash');
    return { ok: false, message: `দুঃখিত, ${district} জেলায় এখন ক্যাশ অন ডেলিভারি নেই — অগ্রিম পেমেন্ট করতে হবে।\n` +
      (pay ? pay + '\n' : '') + `ডেলিভারি চার্জ ৳${ship.base}, অগ্রিম পেমেন্টে ৳${adv.final}। পণ্যের দাম ৳${subtotal}।\n` +
      (r.plans.length ? `আগে মোট দামের ${r.plans.join('% / ')}% পাঠাতে পারেন।\n` : '') +
      'পেমেন্ট করে ট্রানজেকশন আইডি (TrxID) পাঠালে অর্ডার কনফার্ম করব।' };
  }
  let transactionId = '';
  if (payment !== 'cod') {
    transactionId = String(order.transactionId || '').trim();
    if (!isValidTrx(transactionId))
      return { ok: false, message: 'পেমেন্টের ট্রানজেকশন আইডি (TrxID) সঠিক মনে হচ্ছে না — বিকাশ/নগদের মেসেজ থেকে আইডিটা (অক্ষর ও সংখ্যা মিশিয়ে ৮-১৫ ঘরের) হুবহু পাঠাবেন?' + (pay ? '\n' + pay : '') };
  }
  if (payment !== 'cod' && !hasProof)
    return { ok: false, message: 'পেমেন্টের স্ক্রিনশটটা (বিকাশ/নগদের মেসেজ বা অ্যাপের ছবি) পাঠিয়ে দেবেন? স্ক্রিনশট পেলেই অর্ডারটা কনফার্ম করে ফেলব। 😊' };
  return { ok: true, district, payment, transactionId, shipping: ship.final, total: subtotal + ship.final };
}

// বাংলাদেশি মোবাইল নম্বর: ১১ সংখ্যা, ০১৩–০১৯ দিয়ে শুরু। +৮৮/৮৮ থাকলে বাদ; ভুল হলে '' ফেরত
function normBdPhone(raw) {
  let t = String(raw || '').replace(/[০-৯]/g, d => '০১২৩৪৫৬৭৮৯'.indexOf(d)).replace(/[\s\-().]/g, '');
  if (/^\+?8801/.test(t)) t = t.replace(/^\+?88/, '');
  return /^01[3-9]\d{8}$/.test(t) ? t : '';
}

module.exports = { normBdPhone, DISTRICTS, canon, districtsIn, fromSettings, promptText, checkChatOrder, isValidTrx };
