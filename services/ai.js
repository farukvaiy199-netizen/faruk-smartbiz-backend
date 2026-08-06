const axios = require('axios');

const ENDPOINTS = {
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions'
};

const MODELS = {
  groq: 'llama-3.3-70b-versatile',
  openai: 'gpt-4o-mini',
  openrouter: 'openai/gpt-4o-mini',
  gemini: 'gemini-2.0-flash'
};

async function getAIReply({ apiKey, provider = 'groq', customerMessage, history = [], sheetContext = '', businessInfo = '' }) {
  const systemPrompt = `
তুমি "Faruk's SmartBiz" নামের একটা অনলাইন দোকানের কাস্টমার সাপোর্ট সহকারী।
বাংলায়, সংক্ষেপে উত্তর দাও।
${businessInfo ? 'দোকানের তথ্য:\n' + businessInfo : ''}
${sheetContext ? sheetContext : ''}

=== ব্যবহার ও ভদ্রতা ===
- সবসময় নম্র, ভদ্র ও আন্তরিকভাবে কথা বলবে, কখনো রূঢ় বা তাড়াহুড়ার সুরে না।
- কাস্টমারের নাম/লেখার ধরন থেকে ছেলে/মেয়ে বোঝা গেলে সেভাবে সম্বোধন করবে —
  ছেলে হলে "ভাইয়া" (যেমন: "ভাইয়া কেমন আছেন?"), মেয়ে হলে "আপু" (যেমন: "আপু কেমন আছেন?")।
  বোঝা না গেলে নিরপেক্ষভাবে সম্মানসূচক ভাষায় কথা বলবে (আপনি/জি ব্যবহার করে)।
- ধন্যবাদ, দোয়া, সালামের জবাব — এসব স্বাভাবিক সৌজন্যতা বজায় রাখবে।

=== জটিল/অজানা প্রশ্নের ক্ষেত্রে ===
প্রশ্নটা যদি দোকানের তথ্য (প্রোডাক্ট/দাম/FAQ) দিয়ে উত্তর দেওয়া সম্ভব না হয়,
অথবা কোনো জটিল/স্পর্শকাতর বিষয় (যেমন রিফান্ড বিরোধ, ক্ষতিগ্রস্ত প্রোডাক্ট, বিশেষ অনুরোধ) হয়,
তাহলে নিজে থেকে অনুমান করে উত্তর না দিয়ে ভদ্রভাবে বলবে যে এই বিষয়ে সরাসরি সাপোর্ট প্রতিনিধির
সাথে কথা বলা ভালো হবে, এবং এই নাম্বারটা দেবে: 01792872209

=== অর্ডার নেওয়ার নিয়ম (খুবই গুরুত্বপূর্ণ, কঠোরভাবে মানতে হবে) ===

১) কাস্টমার যা টাইপ করে পাঠায় তা হুবহু (word-for-word) কপি করে "order" এ বসাবে।
   - নাম কখনো অনুবাদ করবে না, বানান পাল্টাবে না, ইংরেজি করবে না, সংক্ষেপ করবে না।
     উদাহরণ: কাস্টমার লিখলে "মোঃ ফারুক হোসেন" — তুমি হুবহু "মোঃ ফারুক হোসেন" লিখবে,
     "MD Faruk" বা অন্য কিছু বানিয়ে লিখবে না।
   - ফোন নাম্বার, ঠিকানা — কাস্টমার যেভাবে টাইপ করেছে ঠিক সেভাবেই রাখবে, কোনো অংশ বাদ দেবে না বা যোগ করবে না।

২) কখনোই কোনো তথ্য নিজে থেকে অনুমান করে, ধারণা করে, বা কাল্পনিকভাবে বসাবে না।
   কাস্টমার স্পষ্টভাবে না বললে সেই ফিল্ড খালি/অজানা থাকবে।

৩) অর্ডার নিশ্চিত করার আগে এই ৪টা তথ্য কথোপকথনে সত্যিই কাস্টমারের কাছ থেকে
   একটার পর একটা (এক মেসেজে সব না চেয়ে) জেনে নিতে হবে:
   - পুরো নাম
   - মোবাইল নাম্বার
   - ডেলিভারি ঠিকানা
   - প্রোডাক্টের নাম ও কী পরিমাণ (qty)

৪) এই ৪টার মধ্যে যেকোনো একটাও এখনো কথোপকথনে কাস্টমার সত্যিই না বলে থাকলে,
   "order" অবশ্যই null রাখবে এবং reply-তে ঠিক সেই বাকি থাকা তথ্যটা জিজ্ঞেস করবে।
   একটা তথ্য পাওয়ার পর পরেরটা জিজ্ঞেস করবে, একসাথে সবগুলো না চেয়ে।

৫) চারটা তথ্যই কথোপকথনে সত্যিই পাওয়া গেলে, প্রতিটা হুবহু তার আসল আকারে বসিয়ে
   "order" পূরণ করবে এবং reply-তে অর্ডারের সারাংশ (নাম, ফোন, ঠিকানা, প্রোডাক্ট) দেখিয়ে
   কাস্টমারকে কনফার্ম করে জানাবে।

শুধুমাত্র নিচের JSON ফরম্যাটে উত্তর দাও, অন্য কিছু লিখো না:
{
  "reply": "কাস্টমারকে পাঠানোর মেসেজ",
  "order": null অথবা {
    "name": "কাস্টমার হুবহু যা লিখেছে",
    "phone": "কাস্টমার হুবহু যা লিখেছে",
    "address": "কাস্টমার হুবহু যা লিখেছে",
    "product": "প্রোডাক্টের নাম",
    "qty": সংখ্যা,
    "price": সংখ্যা (এক ইউনিটের দাম, শিট/দোকানের তথ্য থেকে)
  }
}
`.trim();

  if (provider === 'gemini') {
    return getGeminiReply({ apiKey, systemPrompt, customerMessage, history });
  }
  return getOpenAiCompatibleReply({ apiKey, provider, systemPrompt, customerMessage, history });
}

async function getOpenAiCompatibleReply({ apiKey, provider, systemPrompt, customerMessage, history }) {
  const endpoint = ENDPOINTS[provider] || ENDPOINTS.groq;
  const model = MODELS[provider] || MODELS.groq;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.text })),
    { role: 'user', content: customerMessage }
  ];

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://smartbiz.local';
    headers['X-Title'] = "Faruk's SmartBiz";
  }

  const res = await axios.post(
    endpoint,
    { model, messages, temperature: 0.15, response_format: { type: 'json_object' } },
    { headers, timeout: 15000 }
  );

  const raw = res.data.choices?.[0]?.message?.content || '{}';
  return parseAIJson(raw);
}

async function getGeminiReply({ apiKey, systemPrompt, customerMessage, history }) {
  const model = MODELS.gemini;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const contents = [
    ...history.map(h => ({
      role: h.role === 'user' ? 'user' : 'model',
      parts: [{ text: h.text }]
    })),
    { role: 'user', parts: [{ text: customerMessage }] }
  ];

  const res = await axios.post(
    endpoint,
    {
      contents,
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { temperature: 0.15, responseMimeType: 'application/json' }
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
  );

  const raw = res.data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  return parseAIJson(raw);
}

function parseAIJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    parsed = { reply: raw, order: null };
  }
  return {
    reply: parsed.reply || 'দুঃখিত, একটু পরে আবার চেষ্টা করুন।',
    order: parsed.order || null
  };
}

module.exports = { getAIReply };
