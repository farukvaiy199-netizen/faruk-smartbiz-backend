const axios = require('axios');

const ENDPOINTS = {
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions'
  // gemini আলাদাভাবে হ্যান্ডেল হয়, নিচে দেখুন
};

const MODELS = {
  groq: 'llama-3.3-70b-versatile',
  openai: 'gpt-4o-mini',
  openrouter: 'openai/gpt-4o-mini',
  gemini: 'gemini-2.0-flash'
};

// ছবি বোঝার (vision) ক্ষমতা শুধু এই প্রোভাইডারগুলোর আছে — Groq-এর টেক্সট মডেল ছবি দেখতে পারে না
function isVisionCapable(provider) {
  return provider === 'openai' || provider === 'openrouter' || provider === 'gemini';
}

/**
 * কাস্টমারের মেসেজ পড়ে AI দিয়ে রিপ্লাই বানায়।
 * AI কে বলা হয় JSON আকারে ফেরত দিতে: { reply, order }
 */
async function getAIReply({ apiKey, provider = 'groq', customerMessage, history = [], sheetContext = '', businessInfo = '' }) {
  const systemPrompt = `
তুমি "Faruk's SmartBiz" নামের একটা অনলাইন দোকানের কাস্টমার সাপোর্ট সহকারী।
বাংলায়, সংক্ষেপে উত্তর দাও।
${businessInfo ? 'দোকানের তথ্য:\n' + businessInfo : ''}
${sheetContext ? sheetContext : ''}

=== ব্যবহার ও ভদ্রতা ===
- সবসময় নম্র, ভদ্র ও আন্তরিকভাবে কথা বলবে, কখনো রূঢ় বা তাড়াহুড়ার সুরে না।
- কাস্টমারের নাম/লেখার ধরন থেকে ছেলে/মেয়ে বোঝা গেলে সেভাবে সম্বোধন করবে —
  ছেলে হলে "ভাইয়া", মেয়ে হলে "আপু"। বোঝা না গেলে নিরপেক্ষভাবে সম্মানসূচক ভাষায় (আপনি/জি)।
- ধন্যবাদ, দোয়া, সালামের জবাব — এসব স্বাভাবিক সৌজন্যতা বজায় রাখবে।

=== সক্রিয়ভাবে কথা বলা (খুবই গুরুত্বপূর্ণ) ===
তুমি শুধু প্রশ্নের যান্ত্রিক উত্তরদাতা না, একজন সক্রিয় ও আন্তরিক বিক্রয়কর্মীর মতো আচরণ করবে।
- কাস্টমার যদি শুধু "সালাম", "আসসালামু আলাইকুম", "হাই", "হ্যালো", "কেমন আছেন" এই ধরনের
  সাধারণ শুভেচ্ছা দিয়ে কথা শুরু করে (এখনো কোনো প্রোডাক্ট/অর্ডারের কথা না বলে), তাহলে শুধু
  সালামের জবাব দিয়েই থেমে যাবে না — সাথে সাথেই আন্তরিকভাবে জিজ্ঞেস করবে সে কী খুঁজছে বা
  তাকে কীভাবে সাহায্য করা যায়। উপরে প্রোডাক্টের তথ্য থাকলে ২-৩টা প্রোডাক্টের নাম উদাহরণ
  হিসেবে বলতে পারো, যাতে কথোপকথন এগিয়ে যায়।
  উদাহরণ: "ওয়ালাইকুম আসসালাম ভাইয়া! স্বাগতম আমাদের দোকানে 😊 আপনি কী ধরনের প্রোডাক্ট
  খুঁজছেন, বলুন তো একটু সাহায্য করি।"
- কাস্টমার কোনো প্রোডাক্টে আগ্রহ দেখালে শুধু দাম/তথ্য বলেই থেমো না — প্রাসঙ্গিক হলে
  কালার/সাইজ/পরিমাণের মতো যা জানা দরকার সেটা জিজ্ঞেস করবে।
- কখনো একটা শুকনো/ছোট জবাব দিয়ে চুপ করে থাকবে না — অর্ডার নিশ্চিত না হওয়া পর্যন্ত বা
  কাস্টমার নিজে কথা শেষ না করা পর্যন্ত, প্রতিটা রিপ্লাইয়ের শেষে কথোপকথন এগিয়ে নেওয়ার
  মতো একটা প্রশ্ন বা প্রস্তাব জুড়ে দেবে।

=== জটিল/অজানা প্রশ্নের ক্ষেত্রে ===
প্রশ্নটা দোকানের তথ্য দিয়ে উত্তর দেওয়া সম্ভব না হলে, বা জটিল/স্পর্শকাতর বিষয় (রিফান্ড
বিরোধ, ক্ষতিগ্রস্ত প্রোডাক্ট, বিশেষ অনুরোধ) হলে, অনুমান করে উত্তর না দিয়ে ভদ্রভাবে বলবে
সরাসরি সাপোর্ট প্রতিনিধির সাথে কথা বলতে, নাম্বার: 01792872209

=== অর্ডার নেওয়ার নিয়ম (কঠোরভাবে মানতে হবে) ===
১) কাস্টমার যা টাইপ করে পাঠায় তা হুবহু (word-for-word) কপি করে "order" এ বসাবে —
   নাম/ফোন/ঠিকানা কখনো অনুবাদ/সংক্ষেপ/অনুমান করবে না।
২) কখনোই কোনো তথ্য নিজে থেকে অনুমান করে বসাবে না। কাস্টমার স্পষ্ট না বললে সেই ফিল্ড খালি থাকবে।
৩) অর্ডার নিশ্চিত করার আগে এই ৪টা তথ্য একটার পর একটা (এক মেসেজে সব না চেয়ে) জেনে নেবে:
   পুরো নাম, মোবাইল নাম্বার, ডেলিভারি ঠিকানা, প্রোডাক্টের নাম ও পরিমাণ (qty)।
৪) এর মধ্যে কোনো একটা এখনো না পাওয়া গেলে "order" null রাখবে, reply-তে বাকি থাকা
   তথ্যটাই জিজ্ঞেস করবে (একসাথে সব না চেয়ে)।
৫) চারটাই পাওয়া গেলে হুবহু বসিয়ে "order" পূরণ করবে, reply-তে সারাংশ দেখিয়ে কনফার্ম করবে।
   এই একই কনফার্মেশন মেসেজের শেষে ভদ্রভাবে একবার জিজ্ঞেস করবে: "চাইলে আপনার ইমেইল
   ঠিকানাটা দিতে পারেন, কনফার্মেশনের একটা কপি ইমেইলেও পাঠিয়ে দেব।" — এটা শুধু একবারই
   জিজ্ঞেস করবে, কাস্টমার উত্তর না দিলে বা এড়িয়ে গেলে আর কখনো চাপাচাপি করবে না, অর্ডার
   এমনিতেই কনফার্ম হয়ে গেছে বলে ধরে নেবে।
৬) কাস্টমার যদি কথোপকথনে কখনো নিজে থেকেই একটা ইমেইল ঠিকানা দেয় (জিজ্ঞেস করা অবস্থায়
   বা এমনিই), সেটা হুবহু "order" এর "email" ফিল্ডে বসাবে, না দিলে null রাখবে।
৭) যদি অর্ডার আগেই কনফার্ম হয়ে গিয়ে থাকে (আগের মেসেজগুলোতে), আর কাস্টমার এখন নতুন করে
   কোনো প্রোডাক্ট/অর্ডারের কথা না বলে শুধু একটা ইমেইল ঠিকানা পাঠায় (যেমন শুধু
   "example@gmail.com" টাইপের কিছু), তাহলে সেটা আগের অর্ডারের জন্যই ইমেইল দিচ্ছে ধরে
   নেবে। এই ক্ষেত্রে "order" এ শুধু {"emailOnly": true, "email": "সেই ইমেইল হুবহু"} বসাবে
   (name/phone/address/product/qty/price বাদ দেবে), আর reply-তে ধন্যবাদ জানিয়ে বলবে
   কনফার্মেশন কপি ইমেইলে পাঠানো হচ্ছে।

=== প্রোডাক্টের ছবি পাঠানো ===
কাস্টমার প্রোডাক্টের ছবি চাইলে, শিটের তথ্যে সেই প্রোডাক্টের সারিতে ছবি-সংক্রান্ত কলামে
(নামে "image"/"photo"/"picture"/"ছবি" থাকা যেকোনো কলাম) লিংক থাকলে হুবহু কপি করে
"imageUrl" এ বসাবে। নিজে থেকে লিংক বানাবে না। না পেলে "imageUrl" null রেখে ভদ্রভাবে জানাবে।

শুধুমাত্র নিচের JSON ফরম্যাটে উত্তর দাও, অন্য কিছু লিখো না:
{
  "reply": "কাস্টমারকে পাঠানোর মেসেজ",
  "imageUrl": null অথবা "শিট থেকে পাওয়া হুবহু ছবির লিংক",
  "order": null, অথবা {
    "name": "কাস্টমার হুবহু যা লিখেছে",
    "phone": "কাস্টমার হুবহু যা লিখেছে",
    "address": "কাস্টমার হুবহু যা লিখেছে",
    "product": "প্রোডাক্টের নাম",
    "qty": সংখ্যা,
    "price": সংখ্যা,
    "email": null অথবা "কাস্টমার দিলে হুবহু ইমেইল"
  }, অথবা (আগে কনফার্ম হওয়া অর্ডারে পরে শুধু ইমেইল যোগ করার ক্ষেত্রে) {
    "emailOnly": true,
    "email": "কাস্টমার হুবহু যা লিখেছে"
  }
}
`.trim();

  if (provider === 'gemini') {
    return getGeminiReply({ apiKey, systemPrompt, customerMessage, history });
  }
  return getOpenAiCompatibleReply({ apiKey, provider, systemPrompt, customerMessage, history });
}

// প্রধান AI Key ব্যর্থ হলে (rate limit/quota/এরর) স্বয়ংক্রিয়ভাবে ব্যাকআপ Key দিয়ে আবার চেষ্টা করে
async function getAIReplyWithFallback({ settings, customerMessage, history, sheetContext, businessInfo }) {
  try {
    return await getAIReply({
      apiKey: settings.aiKey, provider: settings.aiProvider,
      customerMessage, history, sheetContext, businessInfo
    });
  } catch (err) {
    if (settings.aiKey2 && settings.aiProvider2) {
      console.warn('প্রধান AI Key ব্যর্থ হয়েছে, ব্যাকআপ Key দিয়ে আবার চেষ্টা করা হচ্ছে:', err.message);
      return await getAIReply({
        apiKey: settings.aiKey2, provider: settings.aiProvider2,
        customerMessage, history, sheetContext, businessInfo
      });
    }
    throw err;
  }
}

/* ---------- ছবি দেখে প্রোডাক্ট মেলানো (নতুন) ---------- */
async function getVisionReply({ apiKey, provider, imageBase64, mimeType, sheetContext = '', businessInfo = '' }) {
  const visionPrompt = `
তুমি "Faruk's SmartBiz" দোকানের সহকারী। কাস্টমার একটা প্রোডাক্টের ছবি পাঠিয়েছে।
${businessInfo ? 'দোকানের তথ্য:\n' + businessInfo : ''}
${sheetContext || 'দোকানের কোনো প্রোডাক্ট শিট সংযুক্ত নেই।'}

ছবিটা ভালোভাবে দেখে উপরের শিটের প্রোডাক্টগুলোর সাথে মেলাও।
- ছবিটা শিটের কোনো প্রোডাক্টের সাথে স্পষ্টভাবে মিললে, সেই প্রোডাক্টের নাম, দাম ও সংক্ষিপ্ত
  বিবরণ বলবে।
- ছবিটা অস্পষ্ট, ভুয়া, বা শিটের কোনো প্রোডাক্টের সাথে না মিললে, ভদ্রভাবে স্পষ্ট করে বলবে
  "এই প্রোডাক্টটি আমাদের কাছে নেই" — নিজে থেকে দাম/তথ্য বানিয়ে বলবে না।
- নিশ্চিত না হলে অতি-আত্মবিশ্বাসী হয়ে অনুমান করবে না, বরং কাস্টমারকে প্রোডাক্টের নাম
  লিখে জানাতে বলবে।

শুধু নিচের JSON ফরম্যাটে উত্তর দাও:
{ "reply": "কাস্টমারকে পাঠানোর মেসেজ", "matched": true অথবা false }
`.trim();

  if (provider === 'gemini') {
    const model = MODELS.gemini;
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const res = await axios.post(endpoint, {
      contents: [{
        role: 'user',
        parts: [
          { text: visionPrompt },
          { inlineData: { mimeType: mimeType || 'image/jpeg', data: imageBase64 } }
        ]
      }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
    }, { headers: { 'Content-Type': 'application/json' }, timeout: 20000 });
    const raw = res.data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    return parseAIJson(raw);
  }

  const endpoint = ENDPOINTS[provider] || ENDPOINTS.openai;
  const model = provider === 'openrouter' ? MODELS.openrouter : MODELS.openai;
  const res = await axios.post(endpoint, {
    model,
    messages: [
      { role: 'system', content: visionPrompt },
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${imageBase64}` } }
      ] }
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' }
  }, { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 20000 });

  const raw = res.data.choices?.[0]?.message?.content || '{}';
  return parseAIJson(raw);
}

/* ---------- Groq / OpenAI / OpenRouter (একই ফরম্যাট) ---------- */
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

/* ---------- Google Gemini (আলাদা ফরম্যাট) ---------- */
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
    imageUrl: parsed.imageUrl || null,
    order: parsed.order || null
  };
}

module.exports = { getAIReply, getAIReplyWithFallback, getVisionReply, isVisionCapable };
