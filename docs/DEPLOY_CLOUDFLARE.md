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

## One command

With `FLY_API_TOKEN`, `CLOUDFLARE_API_TOKEN` (the "Edit Cloudflare Workers" template) and
`CLOUDFLARE_ACCOUNT_ID` in the environment:

```bash
scripts/deploy-cloud.sh            # DRY_RUN=1 prints the steps instead
```

It creates the Fly app and volume when missing, sets `RP_ID`/`ORIGIN` to the Worker's
`workers.dev` host (or `APP_HOST`), shares a fresh `PROXY_SECRET` between both sides, deploys the
API, builds the app and deploys the Worker. The manual steps below do the same by hand.

## Deploying from GitHub (recommended)

Both halves deploy on push, with no tokens on your own machine:

- **API → Fly.io:** `.github/workflows/deploy-api.yml`. Add the repository secret `FLY_API_TOKEN`
  (a Fly.io *org* token; GitHub → Settings → Secrets and variables → Actions) and set `APP_HOST`
  to the Worker's hostname (repository variable, or the default in the workflow). The first run
  creates the Fly app (`gplan-api-lolpopach` unless the `FLY_APP` variable says otherwise) and its
  volume. Run it by hand for `wipe-probe` (remove an `e2e-probe` test profile while it is the
  only one) and `lock-signups` (make an account admin and turn on `INVITE_ONLY`).
- **App + /api proxy → Cloudflare:** the Worker's Git integration, below. Set the Worker's
  runtime variable `API_ORIGIN` to `https://<fly app>.fly.dev`.

## Deploying on every push (Cloudflare Git builds)

The Worker can be connected to this repository (Workers & Pages → the Worker → Settings → Build).
Workers Builds does not run the `build` block of `wrangler.jsonc`, so set it there by hand:

- **Build command:** `cd frontend && npm ci && npm run build:cloudflare`
- **Deploy command:** `npx wrangler deploy` (the default)

Without the build command the deploy fails with *The directory specified by the "assets.directory"
field … does not exist*. Runtime values (`API_ORIGIN`, `PROXY_SECRET`) live under the Worker's
Settings → Variables and Secrets and survive these deploys (`keep_vars`). The deploy tokens
(`FLY_API_TOKEN`, `CLOUDFLARE_API_TOKEN`) do not belong there: the Worker never uses them.

## 1. API on Fly.io

```bash
curl -L https://fly.io/install.sh | sh && fly auth login
cd api
fly launch --no-deploy --copy-config --name <your-api-app>   # keeps api/fly.toml
fly volumes create gym_data --size 1 --region nrt
fly secrets set PROXY_SECRET=$(openssl rand -hex 32)         # remember this value
```

Set `RP_ID` and `ORIGIN` to the **final public hostname** of the Worker (e.g. `gym.example.com`,
or `<name>.<account>.workers.dev`): `fly secrets set RP_ID=<host> ORIGIN=https://<host>`. Passkeys are bound to this host, so
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
