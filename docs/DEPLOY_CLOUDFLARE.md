# Deploying on Cloudflare

Everything runs in one Cloudflare Worker, on the Workers Free plan, with no other provider:

```
Browser ──► Cloudflare Worker (one hostname)
              ├─ static app            frontend/dist (Workers Static Assets)
              └─ /api/*  ─────────────► GymStore Durable Object (SQLite) — cloudflare/api.js
```

The API (`cloudflare/api.js`) is the app's core of `api/server.js` — passkey sign-up and sign-in,
sessions, the state document with its revision and conflict rule, Apple Health sync — on a
SQLite-backed Durable Object, which the first deploy creates by itself. Push notifications,
photo/video uploads, the AI Coach, admin, pairing, passwords and extra passkeys are not there,
and the app hides them: `/api/config` says `push: false`, `pairing: false`, `device_link: false`
(and `signup: false` once the owner exists; `frontend/src/lib/server-features.js`), and the rest
the app already leaves out on any server that does not offer it.

- **One owner.** The first profile created can sign up; after it, sign-up is closed. Set the
  Worker variable `OPEN_SIGNUP=1` to keep it open.
- **No address to configure.** The passkey relying party (RP_ID) and ORIGIN are the address
  the app is served on. `RP_ID` / `ORIGIN` variables override them.
- `DEFAULT_LANG` (default `ko`).

## G-PLAN: school lunch, and Claude working out meals

- **School lunch.** The lunch sheet reads the day's menu off the school's homepage
  (`api/school-lunch.js`; by default `http://kshcm.net/?menu_no=34`, the 식단표 board) and
  shows how to eat it. The Worker keeps each month for six hours, and an older copy while the
  school's site is down. `LUNCH_URL` points it at another withschool.co.kr school's 식단표
  page; `LUNCH_URL` set to an empty value turns the card off.
- **Meals Claude works out.** A meal is counted from the app's food table the moment it is
  written. What the table cannot settle, and any photo, waits in an inbox in the Worker's
  storage for a Claude Code session scheduled on the owner's Claude account, which answers with
  the numbers and grows a dataset of foods. No AI binding, no API key, nothing billed: the
  owner issues a token in Settings → *Claude works out meals* and adds it to the Claude
  environment as `GPLAN_CLAUDE_TOKEN`. The whole procedure: [docs/dev/CLAUDE_MEALS.md](dev/CLAUDE_MEALS.md).

## Deploy on every push (Cloudflare Git builds)

Workers & Pages → the Worker → Settings → Build, connected to this repository:

- **Build command:** `cd frontend && npm ci && npm run build:cloudflare` (also installs the
  Worker's own dependency, `@simplewebauthn/server`, in `cloudflare/`)
- **Deploy command:** `npx wrangler deploy`

Workers Builds does not run the `build` block of `wrangler.jsonc`, so the build command must
be set there. Turn **Cloudflare Access off** for the workers.dev address: behind Access the iOS
Shortcut cannot post Apple Health data and the installed app is sent to a login page.

## Local run

```bash
cd frontend && npm ci && npm run build:cloudflare && cd ..
npx wrangler dev            # app and API on http://localhost:8787
cd cloudflare && npm test   # the API on node:sqlite
```

---

# Alternative: the full Node server on Fly.io

For push notifications, uploads and the Coach, the Worker can pass `/api` to `api/server.js`
instead: set the Worker variables `API_MODE=proxy` and `API_ORIGIN=https://<fly app>.fly.dev`
(and `PROXY_SECRET`). The Fly side deploys with `.github/workflows/deploy-api.yml` (run by hand)
or the command below; Fly needs a card on file.

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
