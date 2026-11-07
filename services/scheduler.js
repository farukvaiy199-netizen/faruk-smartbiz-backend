// Instagram-এর API-তে "পরে পোস্ট" সুবিধা নেই। তাই ফেসবুকে শিডিউল করা পোস্টের জন্য আমরা নিজেরাই ঠিক সময়ে
// Instagram-এ পাবলিশ করি। প্রতি মিনিটে সার্ভার দেখে কোনো পোস্টের সময় হয়েছে কিনা। Render ফ্রি সার্ভার ঘুমিয়ে থাকলে
// UptimeRobot-এর মতো বাইরের পিং (/cron/run) সেটাকে জাগিয়ে এই কাজ চালায়।
const config = require('../config');
const store = require('./store');
const { publishInstagramPhoto } = require('./instagram');
const { publishInstagramReel, deleteVideo } = require('./videoPosts');
const { notifyOwner } = require('./notify');

let running = false;

// কখনো এরর ছোঁড়ে না — সফল বা ব্যর্থ, ফলাফল পোস্টের রেকর্ডে লিখে রাখে
async function publishIgJob(job, settings, notifyOnFail) {
  try {
    if (!settings.fbToken || !settings.igUserId) throw new Error('Instagram সংযুক্ত নেই');
    if (!job.mediaId) throw new Error(job.mediaType === 'video' ? 'পোস্টের ভিডিও পাওয়া যায়নি' : 'পোস্টের ছবি পাওয়া যায়নি');

    if (job.mediaType === 'video') {
      // ভিডিও হলে Instagram রিল হিসেবে যায়; ভিডিও MongoDB থেকে পাবলিক লিংকে (/pvideo) পরিবেশিত হয়
      const r = await publishInstagramReel({
        token: settings.fbToken,
        igUserId: settings.igUserId,
        videoUrl: `${config.publicUrl}/pvideo/${job.mediaId}.mp4`,
        caption: job.caption
      });
      await store.updatePost(job.id, { igStatus: 'published', igMediaId: r.igMediaId, igPublishedAt: new Date().toISOString(), igError: '' });
      await deleteVideo(job.mediaId); // পাবলিশ হয়ে গেছে, ভিডিও আর রাখার দরকার নেই (ডেটাবেসের জায়গা বাঁচে)
      return { ok: true };
    }

    const r = await publishInstagramPhoto({
      token: settings.fbToken,
      igUserId: settings.igUserId,
      imageUrl: `${config.publicUrl}/pmedia/${job.mediaId}.jpg`,
      caption: job.caption
    });
    await store.updatePost(job.id, { igStatus: 'published', igMediaId: r.igMediaId, igPublishedAt: new Date().toISOString(), igError: '' });
    await store.deletePostMedia(job.mediaId); // পাবলিশ হয়ে গেছে, ছবি আর রাখার দরকার নেই (জায়গা বাঁচে)
    return { ok: true };
  } catch (err) {
    const msg = String(err.message || err).slice(0, 200);
    await store.updatePost(job.id, { igStatus: 'failed', igError: msg });
    if (job.mediaType === 'video' && job.mediaId) await deleteVideo(job.mediaId); // ব্যর্থ ভিডিও ফেলে রেখে জায়গা নষ্ট নয়
    if (notifyOnFail) await notifyOwner({ type: 'post', title: '❌ Instagram-এ পোস্ট হয়নি', body: msg });
    return { ok: false, error: msg };
  }
}

async function runDueInstagramPosts() {
  if (running) return 0;
  running = true;
  let done = 0;
  try {
    await store.failStuckIgPosts();
    await store.failStuckVideoPosts();
    for (let i = 0; i < 5; i++) {
      const job = await store.claimDueIgPost();
      if (!job) break;
      done++;
      const settings = await store.getSettings();
      await publishIgJob(job, settings, true);
    }
  } catch (err) {
    console.error('Instagram শিডিউলার এরর:', err.message);
  } finally {
    running = false;
  }
  return done;
}

module.exports = { runDueInstagramPosts, publishIgJob };
