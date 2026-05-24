# Frisch Instagram Intelligence Dashboard

This version is wired for the real Frisch Instagram Business Account ID:

```env
IG_USER_ID=17841400848700397
```

Do **not** put the access token in `index.html`. Keep it on the server as an environment variable.

## Run locally

```bash
npm install
cp .env.example .env
# Edit .env and paste your regenerated token.
npm start
```

Open:

```text
http://localhost:3000
```

## Environment variables

```env
IG_USER_ID=17841400848700397
INSTAGRAM_ACCESS_TOKEN=your_long_lived_meta_token
GRAPH_VERSION=v25.0
PORT=3000
```

## Deploy

Use Render, Railway, Fly.io, or another Node host. Set the same environment variables in the host dashboard.

The dashboard calls `/api/instagram`, and the server calls the Meta Graph API securely.
