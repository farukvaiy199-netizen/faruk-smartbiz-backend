// ভিডিও পোস্ট: Facebook পেজে ভিডিও আপলোড/শিডিউল, Instagram রিল, আর MongoDB GridFS-এ ভিডিও রাখা।
// ভিডিও বড় ফাইল, তাই সার্ভারের ডিস্কে নয় MongoDB-তে (GridFS) রাখা হয় — redeploy হলেও হারায় না।
// শুধু Instagram-এর জন্য রাখা হয় (Instagram পাবলিক লিংক থেকে ভিডিও টেনে নেয়); পাবলিশ বা ব্যর্থ হলে মুছে ফেলা হয়।
const fs = require('fs');
const { spawn } = require('child_process');
const axios = require('axios');
const FormData = require('form-data');
const { GridFSBucket } = require('mongodb');
const store = require('./store');
const { notifyOwner } = require('./notify');

// ffmpeg-static থাকলে তার বাইনারি, নইলে সিস্টেমের ffmpeg; কোনোটাই না থাকলে রূপান্তর বাদ যায় (ভিডিও যেমন আছে তেমনই যায়)
let FFMPEG = 'ffmpeg';
try { FFMPEG = require('ffmpeg-static') || 'ffmpeg'; } catch (e) { /* নেই */ }

const GRAPH = 'https://graph.facebook.com/v19.0';
const GRAPH_VIDEO = 'https://graph-video.facebook.com/v19.0';
const BUCKET = 'pvideos';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function errMsg(err) {
  const e = err && err.response && err.response.data && err.response.data.error;
  return String((e && e.message) || (err && err.message) || err).slice(0, 200);
}

async function bucketOf() {
  const db = await store.getDb();
  return new GridFSBucket(db, { bucketName: BUCKET });
}

/* ---------- GridFS: ভিডিও রাখা, মোছা, স্ট্রিম করা ---------- */
async function saveVideo(filePath, mime) {
  const bucket = await bucketOf();
  const id = 'PV' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await new Promise((resolve, reject) => {
    const src = fs.createReadStream(filePath);
    const dst = bucket.openUploadStreamWithId(id, id + '.mp4', { metadata: { mime: mime || 'video/mp4', createdAt: new Date().toISOString() } });
    src.on('error', reject);
    dst.on('error', reject);
    dst.on('finish', resolve);
    src.pipe(dst);
  });
  return id;
}

async function deleteVideo(id) {
  if (!id) return;
  try {
    const bucket = await bucketOf();
    await bucket.delete(id);
  } catch (err) { /* আগেই মুছে গেছে বা নেই — সমস্যা নেই */ }
}

// "bytes=0-1023" ধরনের Range হেডার বিশ্লেষণ। null = পুরো ফাইল, 'invalid' = ভুল সীমা
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') {
    start = Math.max(size - Number(m[2]), 0);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

// Instagram এই পাবলিক লিংক থেকে ভিডিও টেনে নেয় (Range সাপোর্ট সহ)
async function streamVideo(id, req, res) {
  const bucket = await bucketOf();
  const files = await bucket.find({ _id: id }).limit(1).toArray();
  if (!files.length) return res.sendStatus(404);
  const size = files[0].length;
  res.set('Content-Type', 'video/mp4');
  res.set('Accept-Ranges', 'bytes');
  res.set('Cache-Control', 'public, max-age=3600');

  const range = parseRange(req.headers.range, size);
  if (range === 'invalid') {
    res.set('Content-Range', `bytes */${size}`);
    return res.sendStatus(416);
  }
  if (range) {
    res.status(206);
    res.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    res.set('Content-Length', String(range.end - range.start + 1));
    bucket.openDownloadStream(id, { start: range.start, end: range.end + 1 }).on('error', () => res.destroy()).pipe(res);
  } else {
    res.set('Content-Length', String(size));
    bucket.openDownloadStream(id).on('error', () => res.destroy()).pipe(res);
  }
}

/* ---------- Facebook পেজে ভিডিও ---------- */
// ফেসবুক নিজেই নির্ধারিত সময়ে পোস্ট করে (published=false + scheduled_publish_time)
async function uploadFacebookVideo({ token, filePath, mime, caption, scheduledAtMs }) {
  const form = new FormData();
  form.append('access_token', token);
  form.append('description', caption);
  if (scheduledAtMs) {
    form.append('published', 'false');
    form.append('scheduled_publish_time', String(Math.floor(scheduledAtMs / 1000)));
  }
  // স্ট্রিমে এরর এলে (যেমন ফাইল আগেই মুছে গেছে) যেন পুরো সার্ভার ক্র্যাশ না করে
  const rs = fs.createReadStream(filePath);
  rs.on('error', () => {});
  form.append('source', rs, { filename: 'video.mp4', contentType: mime || 'video/mp4' });
  const length = await new Promise((resolve, reject) => form.getLength((e, l) => (e ? reject(e) : resolve(l))));
  try {
    const r = await axios.post(`${GRAPH_VIDEO}/me/videos`, form, {
      headers: { ...form.getHeaders(), 'Content-Length': length },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 20 * 60 * 1000
    });
    if (!r.data || !r.data.id) throw new Error('ফেসবুক ভিডিওর আইডি ফেরত দেয়নি');
    return String(r.data.id);
  } catch (err) {
    throw new Error(errMsg(err));
  } finally {
    rs.destroy();
  }
}

/* ---------- Instagram রিল ---------- */
async function waitForContainer(containerId, token) {
  for (let i = 0; i < 48; i++) { // সর্বোচ্চ ~৪ মিনিট
    const r = await axios.get(`${GRAPH}/${containerId}`, { params: { fields: 'status_code,status', access_token: token } });
    const code = r.data && r.data.status_code;
    if (code === 'FINISHED') return;
    if (code === 'ERROR' || code === 'EXPIRED') {
      throw new Error('Instagram ভিডিওটা প্রসেস করতে পারেনি' + (r.data.status ? ' (' + r.data.status + ')' : '') + ' — MP4 (H.264) ফরম্যাটে চেষ্টা করুন');
    }
    await sleep(5000);
  }
  throw new Error('Instagram-এ ভিডিও প্রসেস হতে অনেক সময় লাগছে — একটু পরে Instagram-এ গিয়ে দেখে নিন');
}

async function publishInstagramReel({ token, igUserId, videoUrl, caption }) {
  try {
    const c = await axios.post(`${GRAPH}/${igUserId}/media`, null, {
      params: { media_type: 'REELS', video_url: videoUrl, caption, share_to_feed: true, access_token: token }
    });
    const containerId = c.data.id;
    await waitForContainer(containerId, token);
    const p = await axios.post(`${GRAPH}/${igUserId}/media_publish`, null, {
      params: { creation_id: containerId, access_token: token }
    });
    return { igMediaId: p.data.id };
  } catch (err) {
    throw new Error(errMsg(err));
  }
}


/* ---------- যেকোনো ভিডিও → Facebook/Instagram-এর উপযোগী MP4 (H.264 + AAC) ---------- */
function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve) => {
    let err = '';
    let p;
    try { p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch (e) { return resolve({ code: -1, err: String(e.message || e) }); }
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, timeoutMs);
    p.stderr.on('data', d => { if (err.length < 200000) err += d.toString(); });
    p.on('error', e => { clearTimeout(t); resolve({ code: -1, err: String(e.message || e) }); });
    p.on('close', code => { clearTimeout(t); resolve({ code, err }); });
  });
}

// ফরম্যাট আগেই ঠিক (H.264 + yuv420p, অডিও AAC বা নেই) হলে null; নইলে নতুন MP4 ফাইলের পথ। ffmpeg না থাকলে/ব্যর্থ হলে null।
async function normalizeVideo(filePath) {
  const probe = await runFfmpeg(['-hide_banner', '-i', filePath], 60000);
  if (probe.code === -1) return null; // ffmpeg চালানো যায়নি
  const info = probe.err;
  const v264 = /Video: h264[^\n]*yuv420p/.test(info);
  const hasAudio = /Audio:/.test(info);
  const aac = !hasAudio || /Audio: aac/.test(info);
  if (v264 && aac) return null;

  const out = filePath + '.conv.mp4';
  const r = await runFfmpeg([
    '-y', '-i', filePath,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
    '-vf', "scale='min(1080,iw)':-2",
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-movflags', '+faststart', '-threads', '1',
    out
  ], 25 * 60 * 1000);
  if (r.code !== 0 || !fs.existsSync(out)) {
    fs.unlink(out, () => {});
    console.error('ভিডিও রূপান্তর ব্যর্থ:', String(r.err).slice(-300));
    return null;
  }
  return out;
}

/* ---------- পুরো কাজ (রিকোয়েস্টের জবাব দেওয়ার পর পেছনে চলে) ---------- */
async function processVideoPost({ post, filePath: origPath, mime: origMime, settings, whenMs, wantFb, wantIg }) {
  let filePath = origPath, mime = origMime, convPath = null;
  try {
    // ০) ফরম্যাট ঠিক না থাকলে নিজে থেকেই MP4 (H.264) বানিয়ে নিই — HEVC/MOV/অন্য ফরম্যাট সব চলবে
    try {
      convPath = await normalizeVideo(origPath);
      if (convPath) { filePath = convPath; mime = 'video/mp4'; }
    } catch (e) { console.error('রূপান্তর এরর:', e.message); }

    // ১) Facebook
    let fbVideoId = '';
    if (wantFb) {
      try {
        fbVideoId = await uploadFacebookVideo({ token: settings.fbToken, filePath, mime, caption: post.caption, scheduledAtMs: whenMs });
      } catch (err) {
        const msg = errMsg(err);
        await store.updatePost(post.id, { status: 'failed', error: msg });
        await notifyOwner({ type: 'post', title: '❌ ভিডিও পোস্ট হয়নি', body: msg }).catch(() => {});
        return;
      }
    }
    let updated = await store.updatePost(post.id, {
      status: whenMs ? 'scheduled' : 'published',
      fbPostId: fbVideoId, fbVideoId
    });

    // ২) Instagram (ফেসবুকের ধাপ সফল হওয়ার পর; এখনই হলে সাথে সাথে, নইলে শিডিউলার সময়মতো)
    if (wantIg) {
      try {
        if (!settings.fbToken || !settings.igUserId) throw new Error('Instagram সংযুক্ত নেই');
        const mediaId = await saveVideo(filePath, mime);
        updated = await store.updatePost(post.id, {
          mediaId, mediaType: 'video',
          igStatus: whenMs ? 'pending' : 'publishing',
          igDueAt: new Date(whenMs || Date.now()).toISOString()
        });
        if (!whenMs) {
          const { publishIgJob } = require('./scheduler'); // দেরিতে require — গোলাকার নির্ভরতা এড়াতে
          await publishIgJob(updated, settings, false);
        }
      } catch (err) {
        const msg = errMsg(err);
        const f = { igStatus: 'failed', igError: msg };
        if (!wantFb) { f.status = 'failed'; f.error = msg; }
        await store.updatePost(post.id, f);
      }
    }

    await notifyOwner({
      type: 'post',
      title: whenMs ? '✅ ভিডিও শিডিউল হয়েছে' : '✅ ভিডিও পোস্ট হয়েছে',
      body: post.productName || post.caption.slice(0, 60)
    }).catch(() => {});
  } catch (err) {
    console.error('ভিডিও পোস্ট এরর:', err.message);
    await store.updatePost(post.id, { status: 'failed', error: errMsg(err) }).catch(() => {});
  } finally {
    fs.unlink(origPath, () => {});
    if (convPath) fs.unlink(convPath, () => {});
  }
}

module.exports = {
  processVideoPost, publishInstagramReel, uploadFacebookVideo,
  saveVideo, deleteVideo, streamVideo, parseRange, normalizeVideo
};
