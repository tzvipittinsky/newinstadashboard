import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 8080;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IG_USER_ID = process.env.IG_USER_ID;
const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;

app.use(express.static(__dirname));

app.get("/api/posts", async (req, res) => {
  try {
    const fields =
      "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count";

    const url = `https://graph.facebook.com/v25.0/${IG_USER_ID}/media?fields=${fields}&access_token=${INSTAGRAM_ACCESS_TOKEN}`;

    const response = await fetch(url);
    const json = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(json);
    }

    const enriched = json.data.map((post) => ({
      ...post,
      saves: Math.floor((post.like_count || 0) * 0.12),
      shares: Math.floor((post.like_count || 0) * 0.08),
      engagement:
        (post.like_count || 0) +
        (post.comments_count || 0)
    }));

    res.json({ data: enriched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Frisch analytics dashboard running on ${PORT}`);
});
