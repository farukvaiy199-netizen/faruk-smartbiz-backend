'use strict';
// অর্ডারের দাম, কুপন, ডেলিভারি চার্জ ও স্টকের হিসাব — ইউজার সাইটের নিয়মের হুবহু সার্ভার সংস্করণ (সাইজ/ওজন অপশনসহ)।

class UserError extends Error { constructor(msg){ super(msg); this.userMessage = msg; } }

function num(v, d){ const n = parseFloat(v); return (v === undefined || v === null || v === '' || isNaN(n)) ? d : n; }

function isValidName(name){
  const c = String(name || '').trim();
  if(c.length < 3 || c.length > 60) return false;
  if(!/^[A-Za-z\u0980-\u09FF\s.'-]+$/.test(c)) return false;
  const letters = c.match(/[A-Za-z\u0980-\u09FF]/g);
  if(!letters || letters.length < 3) return false;
  return c.split(/\s+/).filter(Boolean).length >= 2;
}
function isValidPhone(p){ return /^01[3-9]\d{8}$/.test(String(p || '').replace(/[\s-]/g, '')); }
function isValidAddress(a){
  const c = String(a || '').trim();
  if(c.length < 10 || c.length > 400) return false;
  if(c.split(/\s+/).filter(Boolean).length < 2) return false;
  return !/^(.)\1+$/.test(c.replace(/\s/g, ''));
}
function isValidTrx(t){ const c = String(t || '').trim(); return /^[A-Za-z0-9]{8,15}$/.test(c) && /[A-Za-z]/.test(c) && /[0-9]/.test(c); }

function geoCfg(st){
  return {
    inside: num(st.shipInsideDhaka, 60), outside: num(st.shipOutsideDhaka, 120), prepay: num(st.prepayDiscount, 30),
    cod: Array.isArray(st.codDistricts) ? st.codDistricts : ['ঢাকা']
  };
}
function calcShipping(st, subtotal, district, payment){
  const c = geoCfg(st);
  let base = (!district || district === 'ঢাকা') ? c.inside : c.outside;
  const freeMin = num(st.freeShip, 0);
  if(freeMin > 0 && subtotal >= freeMin) base = 0;
  const prepaid = (payment === 'bkash' || payment === 'nagad');
  const off = prepaid ? Math.min(c.prepay, base) : 0;
  return { base, off, final: base - off };
}
const variantsOf = p=>Array.isArray(p.variants) ? p.variants.filter(v=>v && v.id) : [];

// st: সেটিংস, products: { pid: productData }, input: গ্রাহকের পাঠানো তথ্য
function computeOrder(st, products, input){
  const name = String(input.name || '').trim(), phone = String(input.phone || '').replace(/[\s-]/g, '');
  const address = String(input.address || '').trim(), district = String(input.district || '').trim(), upazila = String(input.upazila || '').trim();
  if(!isValidName(name)) throw new UserError('সঠিক পুরো নাম দিন');
  if(!isValidPhone(phone)) throw new UserError('সঠিক মোবাইল নম্বর দিন');
  if(!isValidAddress(address)) throw new UserError('সম্পূর্ণ ও সঠিক ঠিকানা দিন');
  if(!district || district.length > 40) throw new UserError('জেলা বেছে নিন');
  if(!upazila || upazila.length > 60) throw new UserError('উপজেলা / থানা বেছে নিন');

  const payment = String(input.payment || '');
  if(!['cod', 'bkash', 'nagad'].includes(payment)) throw new UserError('পেমেন্ট পদ্ধতি সঠিক নয়');
  const cfg = geoCfg(st);
  if(payment === 'cod' && !cfg.cod.includes(district)) throw new UserError('আপনার জেলায় ক্যাশ অন ডেলিভারি নেই — অগ্রিম পেমেন্ট করুন');
  let transactionId = '';
  if(payment === 'bkash' || payment === 'nagad'){
    transactionId = String(input.transactionId || '').trim();
    if(!isValidTrx(transactionId)) throw new UserError('সঠিক ট্রানজেকশন আইডি দিন');
  }

  const raw = Array.isArray(input.items) ? input.items : [];
  if(!raw.length || raw.length > 30) throw new UserError('কার্ট খালি বা অনেক বড়');
  // একই পণ্য ও একই অপশন একসাথে যোগ হয়
  const merged = new Map();
  raw.forEach(it=>{
    const pid = String((it && it.pid) || ''), vid = String((it && it.vid) || ''), qty = Number(it && it.qty);
    if(!pid || pid.indexOf('/') >= 0 || !Number.isInteger(qty) || qty < 1 || qty > 50) throw new UserError('কার্টের তথ্য সঠিক নয়');
    const key = pid + '|' + vid;
    const cur = merged.get(key) || { pid, vid, qty: 0 }; cur.qty += qty; merged.set(key, cur);
  });

  let subtotal = 0; const items = [];
  const work = new Map(); // pid -> { p, vs (কপি), ordinaryQty }
  for(const { pid, vid, qty } of merged.values()){
    const p = products[pid];
    if(!p || p.status !== 'active') throw new UserError('দুঃখিত, কার্টের একটি পণ্য আর পাওয়া যাচ্ছে না');
    if(!work.has(pid)) work.set(pid, { p, vs: variantsOf(p).map(v=>Object.assign({}, v)), plain: 0 });
    const w = work.get(pid);
    if(w.vs.length){
      const v = w.vs.find(x=>x.id === vid);
      if(!v) throw new UserError('দুঃখিত, "' + p.name + '" এর বাছাই করা অপশন (সাইজ/ওজন) পাওয়া যাচ্ছে না');
      if(qty > (v.stock || 0)) throw new UserError('দুঃখিত, "' + p.name + ' (' + v.name + ')" স্টকে মাত্র ' + (v.stock || 0) + 'টি আছে');
      v.stock = (v.stock || 0) - qty;
      subtotal += v.price * qty;
      items.push({ pid, vid: v.id, variant: v.name, name: p.name + ' (' + v.name + ')', qty, price: v.price });
    }else{
      w.plain += qty;
      if(w.plain > (p.stock || 0)) throw new UserError('দুঃখিত, "' + p.name + '" স্টকে মাত্র ' + (p.stock || 0) + 'টি আছে');
      subtotal += p.price * qty;
      items.push({ pid, name: p.name, qty, price: p.price });
    }
  }
  const stockUpdates = [];
  for(const [pid, w] of work){
    if(w.vs.length) stockUpdates.push({ pid, variants: w.vs, newStock: w.vs.reduce((s, v)=>s + (v.stock || 0), 0) });
    else stockUpdates.push({ pid, newStock: Math.max((w.p.stock || 0) - w.plain, 0) });
  }

  let discount = 0;
  const code = String(input.couponCode || '').trim().toUpperCase();
  if(code && st.coupons && st.coupons[code]) discount = num(st.coupons[code], 0);
  const taxable = Math.max(subtotal - discount, 0);
  const taxRate = num(st.tax, 0);
  const tax = taxRate > 0 ? Math.round(taxable * taxRate / 100) : 0;
  const ship = calcShipping(st, subtotal, district, payment);
  const total = taxable + tax + ship.final;

  let advanceAmount = 0, dueAmount = 0, planPercent = null;
  if(payment === 'bkash' || payment === 'nagad'){
    const plans = Array.isArray(st.paymentPlans) ? st.paymentPlans : [];
    if(plans.length > 0){
      const want = Number(input.paymentPlanPercent);
      if(!want || !plans.includes(want)) throw new UserError('পেমেন্ট প্ল্যান বেছে নিন');
      planPercent = want;
      advanceAmount = Math.round(total * want / 100);
      dueAmount = Math.max(total - advanceAmount, 0);
    }
  }
  return { name, phone, address, district, upazila, payment, transactionId, items, subtotal, discount, tax,
    shipping: ship.final, shippingBase: ship.base, prepayDiscount: ship.off, total, advanceAmount, dueAmount, paymentPlanPercent: planPercent, stockUpdates };
}

module.exports = { UserError, computeOrder, calcShipping, isValidPhone, num };
