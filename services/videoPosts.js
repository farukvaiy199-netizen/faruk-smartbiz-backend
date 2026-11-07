// ভিডিও পোস্ট: Facebook পেজে ভিডিও আপলোড/শিডিউল, Instagram রিল, আর MongoDB GridFS-এ ভিডিও রাখা।
// ভিডিও বড় ফাইল, তাই সার্ভারের ডিস্কে নয় MongoDB-তে (GridFS) রাখা হয় — redeploy হলেও হারায় না।
// শুধু Instagram-এর জন্য রাখা হয় (Instagram পাবলিক লিংক থেকে ভিডিও টেনে নেয়); পাবলিশ বা ব্যর্থ হলে মুছে ফেলা হয়।
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const { GridFSBucket } = require('mongodb');
const store = require('./store');
const { notifyOwner } = require('./notify');

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

/* ---------- পুরো কাজ (রিকোয়েস্টের জবাব দেওয়ার পর পেছনে চলে) ---------- */
async function processVideoPost({ post, filePath, mime, settings, whenMs, wantFb, wantIg }) {
  try {
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
    fs.unlink(filePath, () => {});
  }
}

module.exports = {
  processVideoPost, publishInstagramReel, uploadFacebookVideo,
  saveVideo, deleteVideo, streamVideo, parseRange
};
