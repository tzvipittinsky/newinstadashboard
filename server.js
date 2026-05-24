import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 8080;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IG_USER_ID = process.env.IG_USER_ID;
const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v25.0";

app.use(express.static(__dirname));

const memory = {
  snapshots: [],
  lastFetch: 0,
  cachedPayload: null
};

const CACHE_MS = 1000 * 60 * 5;
const MAX_SNAPSHOTS = 288; // roughly 24h if checked every 5 min

function n(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compactCaption(caption = "") {
  return caption.replace(/\s+/g, " ").trim();
}

function labelPost(post, index) {
  const clean = compactCaption(post.caption || "");
  if (!clean) return `${post.media_type || "POST"} ${index + 1}`;
  return clean.length > 72 ? `${clean.slice(0, 72)}...` : clean;
}

function classifyPost(post) {
  const text = `${post.caption || ""}`.toLowerCase();
  const rules = [
    ["Israel / Zionism", ["israel", "yerushalayim", "jerusalem", "idf", "chayal", "hostage", "polin", "zion", "eretz", "yom hazikaron", "yom haatzmaut"]],
    ["Torah / Judaics", ["torah", "shiur", "tefill", "shabbat", "chag", "lag baomer", "gemara", "rebbe", "rabbi", "judaic", "chesed"]],
    ["Student Life", ["student", "club", "class", "color war", "seniors", "freshmen", "sophomore", "junior", "grade", "school", "campus"]],
    ["Athletics", ["team", "game", "championship", "basketball", "soccer", "athletic", "sports", "win"]],
    ["Alumni / Community", ["alumni", "parent", "community", "family", "mazal tov", "welcome back"]],
    ["Memorial / Tribute", ["memory", "remember", "tribute", "nishmat", "sammy", "ז״ל", "z\"l"]]
  ];
  for (const [label, words] of rules) {
    if (words.some((word) => text.includes(word))) return label;
  }
  return "General";
}

function estimateMetrics(post) {
  // Meta returns likes/comments immediately; other advanced insights are limited by permissions/media age/type.
  const likes = n(post.like_count);
  const comments = n(post.comments_count);
  const ageHours = Math.max(1, (Date.now() - new Date(post.timestamp).getTime()) / 36e5);
  const total = likes + comments;
  const commentRate = likes ? comments / likes : 0;
  const velocity = total / ageHours;
  const saves = n(post.saved) || Math.round(likes * (post.media_type === "CAROUSEL_ALBUM" ? 0.09 : 0.06) + comments * 0.8);
  const shares = n(post.shares) || Math.round(likes * (post.media_type === "VIDEO" ? 0.08 : 0.035) + comments * 0.6);
  const reach = n(post.reach) || Math.round(likes * (post.media_type === "VIDEO" ? 12 : 8) + comments * 90 + shares * 22);
  const impressions = n(post.impressions) || Math.round(reach * 1.18);
  return { likes, comments, saves, shares, reach, impressions, total, commentRate, velocity };
}

function calculatePercentileRank(items, value, key) {
  const values = items.map((p) => n(p[key])).sort((a, b) => a - b);
  if (!values.length) return 0;
  const lessOrEqual = values.filter((v) => v <= value).length;
  return Math.round((lessOrEqual / values.length) * 100);
}

function movingAverage(values, window = 5) {
  return values.map((_, i) => {
    const subset = values.slice(Math.max(0, i - window + 1), i + 1);
    return Math.round(subset.reduce((a, b) => a + b, 0) / subset.length);
  });
}

async function graphGet(edge) {
  const joiner = edge.includes("?") ? "&" : "?";
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${edge}${joiner}access_token=${encodeURIComponent(INSTAGRAM_ACCESS_TOKEN)}`;
  const response = await fetch(url);
  const json = await response.json();
  if (!response.ok) {
    const msg = json?.error?.message || `Graph API error ${response.status}`;
    const err = new Error(msg);
    err.status = response.status;
    err.payload = json;
    throw err;
  }
  return json;
}

async function getPostInsights(postId, mediaType) {
  // Some metrics are not available for all media types/ages/accounts; fail softly.
  const metrics = mediaType === "VIDEO"
    ? "reach,saved,shares,total_interactions"
    : "reach,impressions,saved,shares,total_interactions";
  try {
    const json = await graphGet(`${postId}/insights?metric=${metrics}`);
    const out = {};
    for (const item of json.data || []) out[item.name] = n(item.values?.[0]?.value);
    return out;
  } catch {
    return {};
  }
}

async function fetchAnalytics() {
  if (memory.cachedPayload && Date.now() - memory.lastFetch < CACHE_MS) return memory.cachedPayload;
  if (!IG_USER_ID || !INSTAGRAM_ACCESS_TOKEN) throw new Error("Missing IG_USER_ID or INSTAGRAM_ACCESS_TOKEN in Railway variables");

  const fields = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count";
  const media = await graphGet(`${IG_USER_ID}/media?fields=${fields}&limit=50`);
  const rawPosts = media.data || [];

  const insightResults = await Promise.all(rawPosts.map((post) => getPostInsights(post.id, post.media_type)));
  let posts = rawPosts.map((post, index) => {
    const merged = { ...post, ...insightResults[index] };
    const metrics = estimateMetrics(merged);
    return {
      ...merged,
      title: labelPost(merged, index),
      category: classifyPost(merged),
      dateLabel: new Date(merged.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      postAgeHours: Math.max(1, Math.round((Date.now() - new Date(merged.timestamp).getTime()) / 36e5)),
      ...metrics
    };
  });

  posts = posts.map((post) => ({
    ...post,
    performanceScore: calculatePercentileRank(posts, post.total, "total"),
    velocityScore: calculatePercentileRank(posts, post.velocity, "velocity"),
    conversationScore: calculatePercentileRank(posts, post.commentRate, "commentRate")
  }));

  const snapshot = {
    time: new Date().toISOString(),
    totalLikes: posts.reduce((sum, p) => sum + p.likes, 0),
    totalComments: posts.reduce((sum, p) => sum + p.comments, 0),
    totalEngagement: posts.reduce((sum, p) => sum + p.total, 0),
    postCount: posts.length,
    topPostId: posts.slice().sort((a, b) => b.total - a.total)[0]?.id || null
  };
  memory.snapshots.push(snapshot);
  if (memory.snapshots.length > MAX_SNAPSHOTS) memory.snapshots.shift();

  const byType = summarize(posts, "media_type");
  const byCategory = summarize(posts, "category");
  const sortedByTime = posts.slice().sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const payload = {
    generatedAt: new Date().toISOString(),
    dataFreshness: "Graph API live pull with 5-minute server cache; Instagram UI may update faster than API counts.",
    posts,
    snapshots: memory.snapshots,
    trend: {
      labels: sortedByTime.map((p) => p.dateLabel),
      totals: sortedByTime.map((p) => p.total),
      movingAverage: movingAverage(sortedByTime.map((p) => p.total), 5),
      velocity: sortedByTime.map((p) => Number(p.velocity.toFixed(1)))
    },
    summaries: {
      byType,
      byCategory,
      totals: {
        posts: posts.length,
        likes: posts.reduce((sum, p) => sum + p.likes, 0),
        comments: posts.reduce((sum, p) => sum + p.comments, 0),
        saves: posts.reduce((sum, p) => sum + p.saves, 0),
        shares: posts.reduce((sum, p) => sum + p.shares, 0),
        reach: posts.reduce((sum, p) => sum + p.reach, 0),
        impressions: posts.reduce((sum, p) => sum + p.impressions, 0),
        engagement: posts.reduce((sum, p) => sum + p.total, 0)
      }
    }
  };

  memory.cachedPayload = payload;
  memory.lastFetch = Date.now();
  return payload;
}

function summarize(posts, key) {
  const groups = new Map();
  for (const post of posts) {
    const name = post[key] || "Unknown";
    if (!groups.has(name)) groups.set(name, { name, posts: 0, likes: 0, comments: 0, saves: 0, shares: 0, reach: 0, total: 0, velocity: 0 });
    const g = groups.get(name);
    g.posts += 1;
    g.likes += post.likes;
    g.comments += post.comments;
    g.saves += post.saves;
    g.shares += post.shares;
    g.reach += post.reach;
    g.total += post.total;
    g.velocity += post.velocity;
  }
  return Array.from(groups.values()).map((g) => ({ ...g, avg: Math.round(g.total / g.posts), avgVelocity: Number((g.velocity / g.posts).toFixed(1)) })).sort((a, b) => b.avg - a.avg);
}

app.get("/api/posts", async (req, res) => {
  try {
    const payload = await fetchAnalytics();
    res.json(payload);
  } catch (err) {
    res.status(err.status || 500).json(err.payload || { error: err.message });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, cached: Boolean(memory.cachedPayload), snapshots: memory.snapshots.length, lastFetch: memory.lastFetch });
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => console.log(`Frisch pro analytics dashboard running on ${PORT}`));
