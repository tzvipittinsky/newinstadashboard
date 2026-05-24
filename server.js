const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8080;

const IG_USER_ID = process.env.IG_USER_ID;
const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;

app.use(express.static(__dirname));

app.get("/api/posts", async (req, res) => {
  try {
    if (!IG_USER_ID || !INSTAGRAM_ACCESS_TOKEN) {
      return res.status(500).json({ error: "Missing Instagram environment variables" });
    }

    const fields = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp";
    const url = `https://graph.facebook.com/v25.0/${IG_USER_ID}/media?fields=${fields}&access_token=${INSTAGRAM_ACCESS_TOKEN}`;

    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Frisch Instagram dashboard running on port ${PORT}`);
});
