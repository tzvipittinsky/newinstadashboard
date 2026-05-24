import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.static('.'));

const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v25.0';
const IG_USER_ID = process.env.IG_USER_ID;
const ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const PORT = process.env.PORT || 3000;

const mediaFields = [
  'id',
  'caption',
  'media_type',
  'media_url',
  'thumbnail_url',
  'permalink',
  'timestamp',
  'like_count',
  'comments_count'
].join(',');

app.get('/api/instagram', async (req, res) => {
  try {
    if (!IG_USER_ID || !ACCESS_TOKEN) {
      return res.status(503).json({
        error: 'Missing Instagram credentials. Set IG_USER_ID and INSTAGRAM_ACCESS_TOKEN.'
      });
    }

    const days = Number(req.query.days || 30);
    const since = Date.now() - days * 864e5;
    const media = await fetchAllMedia(days);
    const recent = media.filter(post => new Date(post.timestamp).getTime() >= since);
    const enriched = await Promise.all(recent.map(enrichPost));

    res.json(enriched);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Instagram API request failed' });
  }
});

async function fetchAllMedia(days) {
  const media = [];
  const sinceUnix = Math.floor((Date.now() - days * 864e5) / 1000);
  let url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${IG_USER_ID}/media`);
  url.searchParams.set('fields', mediaFields);
  url.searchParams.set('limit', '100');
  url.searchParams.set('since', String(sinceUnix));
  url.searchParams.set('access_token', ACCESS_TOKEN);

  while (url && media.length < 300) {
    const json = await graph(url.toString());
    media.push(...(json.data || []));
    url = json.paging?.next ? new URL(json.paging.next) : null;
  }

  return media;
}

async function enrichPost(post) {
  const insights = await getInsights(post.id);
  return {
    id: post.id,
    caption: post.caption || '',
    media_type: post.media_type,
    media_url: post.media_url,
    thumbnail_url: post.thumbnail_url || post.media_url,
    permalink: post.permalink,
    timestamp: post.timestamp,
    likes: post.like_count || 0,
    comments: post.comments_count || 0,
    saves: insights.saved || 0,
    shares: insights.shares || 0,
    reach: insights.reach || 0,
    views: insights.views || insights.plays || 0,
    total_interactions: insights.total_interactions || 0,
    goal: inferGoal(post.caption || '')
  };
}

async function getInsights(mediaId) {
  const metrics = ['reach', 'saved', 'shares', 'total_interactions', 'views'];
  const insights = {};

  for (const metric of metrics) {
    try {
      const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}/insights`);
      url.searchParams.set('metric', metric);
      url.searchParams.set('access_token', ACCESS_TOKEN);
      const json = await graph(url.toString());
      for (const item of json.data || []) {
        insights[item.name] = item.values?.[0]?.value ?? 0;
      }
    } catch (error) {
      // Some metrics are not available for every media type. Keep the dashboard usable.
    }
  }

  return insights;
}

async function graph(url) {
  const response = await fetch(url);
  const json = await response.json();
  if (!response.ok || json.error) {
    throw new Error(json.error?.message || `Graph API error ${response.status}`);
  }
  return json;
}

function inferGoal(caption) {
  const c = caption.toLowerCase();
  if (/admission|apply|visit|open house|shadow|tour/.test(c)) return 'admissions';
  if (/alumni|graduate|reunion/.test(c)) return 'alumni';
  if (/torah|shiur|tefillah|shabbat|shabbos|israel|chag|chagim|jewish|yeshiva/.test(c)) return 'torah';
  if (/team|game|championship|athletic|varsity|basketball|hockey|soccer|tennis|baseball/.test(c)) return 'athletics';
  return 'student-life';
}

app.listen(PORT, () => console.log(`Frisch Instagram dashboard running on port ${PORT}`));
