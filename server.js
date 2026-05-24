import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 8080;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IG_USER_ID = process.env.IG_USER_ID;
const TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const GRAPH = "https://graph.facebook.com/v25.0";

app.use(express.static(__dirname));

async function graphGet(pathname, params = {}) {
  const url = new URL(`${GRAPH}${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }
  url.searchParams.set("access_token", TOKEN);
  const response = await fetch(url);
  const json = await response.json();
  if (!response.ok) {
    const message = json?.error?.message || `Graph API error ${response.status}`;
    const err = new Error(message);
    err.status = response.status;
    err.payload = json;
    throw err;
  }
  return json;
}

async function getMetric(mediaId, metric) {
  try {
    const json = await graphGet(`/${mediaId}/insights`, { metric });
    const item = json?.data?.[0];
    const raw = item?.values?.[0]?.value;
    return typeof raw === "number" ? raw : Number(raw || 0);
  } catch {
    return null;
  }
}

async function enrichPost(post) {
  const insightNames = ["reach", "saved", "shares", "total_interactions", "views", "plays", "impressions"];
  const insightEntries = await Promise.all(insightNames.map(async (name) => [name, await getMetric(post.id, name)]));
  const insights = Object.fromEntries(insightEntries.filter(([, value]) => value !== null));

  const likes = Number(post.like_count || 0);
  const comments = Number(post.comments_count || 0);
  const saved = Number(insights.saved || 0);
  const shares = Number(insights.shares || 0);
  const views = Number(insights.views || insights.plays || 0);
  const reach = Number(insights.reach || 0);
  const totalInteractions = Number(insights.total_interactions || likes + comments + saved + shares);
  const engagementRate = reach > 0 ? totalInteractions / reach : null;

  return {
    ...post,
    metrics: {
      likes,
      comments,
      saved,
      shares,
      views,
      reach,
      impressions: Number(insights.impressions || 0),
      total_interactions: totalInteractions,
      engagement_rate: engagementRate
    }
  };
}

function summarize(posts) {
  const totals = posts.reduce((acc, post) => {
    const m = post.metrics || {};
    acc.likes += m.likes || 0;
    acc.comments += m.comments || 0;
    acc.saved += m.saved || 0;
    acc.shares += m.shares || 0;
    acc.views += m.views || 0;
    acc.reach += m.reach || 0;
    acc.interactions += m.total_interactions || 0;
    return acc;
  }, { likes: 0, comments: 0, saved: 0, shares: 0, views: 0, reach: 0, interactions: 0 });

  const byType = {};
  for (const post of posts) {
    const type = post.media_type || "POST";
    if (!byType[type]) byType[type] = { type, posts: 0, interactions: 0, likes: 0, comments: 0, saved: 0, shares: 0, views: 0, reach: 0 };
    const bucket = byType[type];
    const m = post.metrics || {};
    bucket.posts += 1;
    bucket.interactions += m.total_interactions || 0;
    bucket.likes += m.likes || 0;
    bucket.comments += m.comments || 0;
    bucket.saved += m.saved || 0;
    bucket.shares += m.shares || 0;
    bucket.views += m.views || 0;
    bucket.reach += m.reach || 0;
  }

  for (const bucket of Object.values(byType)) {
    bucket.avg_interactions = bucket.posts ? Math.round(bucket.interactions / bucket.posts) : 0;
    bucket.avg_likes = bucket.posts ? Math.round(bucket.likes / bucket.posts) : 0;
  }

  const sorted = [...posts].sort((a, b) => (b.metrics?.total_interactions || 0) - (a.metrics?.total_interactions || 0));
  const bestType = Object.values(byType).sort((a, b) => b.avg_interactions - a.avg_interactions)[0] || null;

  const chronological = [...posts].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const midpoint = Math.floor(chronological.length / 2);
  const early = chronological.slice(0, midpoint);
  const late = chronological.slice(midpoint);
  const avg = (arr) => arr.length ? Math.round(arr.reduce((s, p) => s + (p.metrics?.total_interactions || 0), 0) / arr.length) : 0;
  const earlyAvg = avg(early);
  const lateAvg = avg(late);
  const trendPct = earlyAvg ? Math.round(((lateAvg - earlyAvg) / earlyAvg) * 100) : null;

  return { totals, byType: Object.values(byType), topPosts: sorted.slice(0, 8), bestType, trend: { earlyAvg, lateAvg, trendPct } };
}

app.get("/api/dashboard", async (req, res) => {
  try {
    if (!IG_USER_ID || !TOKEN) return res.status(500).json({ error: "Missing IG_USER_ID or INSTAGRAM_ACCESS_TOKEN" });

    const days = Math.max(1, Math.min(365, Number(req.query.days || 90)));
    const limit = Math.max(5, Math.min(100, Number(req.query.limit || 50)));
    const since = Date.now() - days * 24 * 60 * 60 * 1000;

    const fields = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count";
    const media = await graphGet(`/${IG_USER_ID}/media`, { fields, limit });

    const rawPosts = (media.data || []).filter((p) => new Date(p.timestamp).getTime() >= since);
    const posts = await Promise.all(rawPosts.map(enrichPost));

    res.json({ generated_at: new Date().toISOString(), days, posts, summary: summarize(posts) });
  } catch (err) {
    res.status(err.status || 500).json(err.payload || { error: err.message });
  }
});

app.get("/api/posts", async (req, res) => {
  try {
    if (!IG_USER_ID || !TOKEN) return res.status(500).json({ error: "Missing IG_USER_ID or INSTAGRAM_ACCESS_TOKEN" });
    const fields = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count";
    const media = await graphGet(`/${IG_USER_ID}/media`, { fields, limit: 25 });
    const posts = await Promise.all((media.data || []).map(enrichPost));
    res.json({ data: posts });
  } catch (err) {
    res.status(err.status || 500).json(err.payload || { error: err.message });
  }
});

app.use((req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.listen(PORT, () => console.log(`Frisch analytics dashboard running on ${PORT}`));
