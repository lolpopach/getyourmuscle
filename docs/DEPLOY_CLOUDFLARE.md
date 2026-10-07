# Deploying on Cloudflare + Fly.io

```
Browser ──► Cloudflare Worker (one hostname) ──┬─ static app (frontend/dist, Workers Static Assets)
                                               └─ /api/*  ──proxy──►  Fly.io: api/ (Node + /data volume)
```

The API stores everything as files in `DATA_DIR`, so it runs on Fly.io with a volume. The Worker
serves the app and proxies `/api/*`, keeping everything on one origin (required for passkeys).
No local Docker is needed: Fly builds the image remotely.

Exercise images/GIFs come from the jsDelivr CDN (`npm run build:cloudflare`), so they are not
bundled or hosted by you.

## 1. API on Fly.io

```bash
curl -L https://fly.io/install.sh | sh && fly auth login
cd api
fly launch --no-deploy --copy-config --name <your-api-app>   # keeps api/fly.toml
fly volumes create gym_data --size 1 --region nrt
fly secrets set PROXY_SECRET=$(openssl rand -hex 32)         # remember this value
```

Edit `api/fly.toml`: set `RP_ID` and `ORIGIN` to the **final public hostname** of the Worker
(e.g. `gym.example.com`, or `<name>.<account>.workers.dev`). Passkeys are bound to this host, so
changing it later invalidates registered passkeys. Then:

```bash
fly deploy --remote-only
curl https://<your-api-app>.fly.dev/api/health
```

Keep a single machine (`fly scale count 1`): the volume belongs to one machine. Back up `/data`
with `fly volumes snapshots`.

## 2. Frontend + Worker on Cloudflare

Set `API_ORIGIN` in `wrangler.jsonc` to `https://<your-api-app>.fly.dev`, then:

```bash
cd frontend && npm ci && npm run build:cloudflare && cd ..
npx wrangler login
npx wrangler secret put PROXY_SECRET        # same value as on Fly
npx wrangler deploy
```

For a custom domain, add it under Workers & Pages → your Worker → Settings → Domains, and use
that host for `RP_ID` / `ORIGIN` on Fly.

## Notes

- `PROXY_SECRET` lets the API trust the visitor IP forwarded by the Worker (used for the sign-in
  throttle and audit log). Without it the API would see Fly's proxy address instead.
- Optional settings (`INVITE_ONLY`, `PASSWORD_LOGIN`, `ADMIN_UIDS`, `DEFAULT_LANG`, …) are in
  `.env.example`; set them with `fly secrets set` or under `[env]` in `fly.toml`.
- Web push and the AI coach work as in the Docker setup; the coach is not enabled by default.
