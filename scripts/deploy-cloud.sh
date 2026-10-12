#!/usr/bin/env bash
# Deploy GetYourMuscle: the API to Fly.io, the app + /api proxy to a Cloudflare Worker.
# No local Docker: Fly builds the image remotely. Safe to run again; each run redeploys both.
#
# Needs, as environment variables:
#   FLY_API_TOKEN          Fly.io token that can create and deploy apps in FLY_ORG
#   CLOUDFLARE_API_TOKEN   Cloudflare token from the "Edit Cloudflare Workers" template
#   CLOUDFLARE_ACCOUNT_ID  the Cloudflare account to deploy into
# Optional:
#   FLY_APP     Fly app name, globally unique   (default gplan-api-lolpopach)
#   FLY_ORG     Fly organisation                (default personal)
#   FLY_REGION  Fly region                      (default nrt, Tokyo)
#   APP_HOST    public hostname of the app, for a custom domain. Default: the Worker's own
#               <worker>.<account-subdomain>.workers.dev. Passkeys are bound to this host, so
#               changing it later means registering passkeys again.
#   DRY_RUN=1   print the commands instead of running them
set -euo pipefail

FLY_APP=${FLY_APP:-gplan-api-lolpopach}
FLY_ORG=${FLY_ORG:-personal}
FLY_REGION=${FLY_REGION:-nrt}
WORKER=getyourmuscle
ROOT=$(cd "$(dirname "$0")/.." && pwd)
CF_API=https://api.cloudflare.com/client/v4

run() { if [ "${DRY_RUN:-}" = 1 ]; then echo "+ $*"; else "$@"; fi; }
die() { echo "error: $*" >&2; exit 1; }

[ "${DRY_RUN:-}" = 1 ] || for v in FLY_API_TOKEN CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; do
  [ -n "${!v:-}" ] || die "$v is not set"
done

# flyctl, installed into ~/.fly when missing.
FLY=$(command -v flyctl || command -v fly || true)
if [ -z "$FLY" ]; then
  if [ "${DRY_RUN:-}" = 1 ]; then FLY=flyctl
  else curl -fsSL https://fly.io/install.sh | sh >/dev/null; FLY="$HOME/.fly/bin/flyctl"; fi
fi

# The public hostname: the Worker's workers.dev address unless APP_HOST says otherwise.
if [ -z "${APP_HOST:-}" ]; then
  if [ "${DRY_RUN:-}" = 1 ]; then APP_HOST="$WORKER.example.workers.dev"
  else
    sub=$(curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);process.stdout.write(r.result?.subdomain||"")})') \
      || die "could not read the account's workers.dev subdomain (check the Cloudflare token and account id)"
    [ -n "$sub" ] || die "this Cloudflare account has no workers.dev subdomain yet — open Workers & Pages in the dashboard once, or set APP_HOST"
    APP_HOST="$WORKER.$sub.workers.dev"
  fi
fi
echo "App: https://$APP_HOST   API: https://$FLY_APP.fly.dev"

# One shared secret, so the API believes the visitor address only from this Worker.
PROXY_SECRET=$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')

# ---- API on Fly.io ----
cd "$ROOT/api"
if [ "${DRY_RUN:-}" = 1 ] || ! "$FLY" status --app "$FLY_APP" >/dev/null 2>&1; then
  run "$FLY" apps create "$FLY_APP" --org "$FLY_ORG"
fi
if [ "${DRY_RUN:-}" = 1 ] || ! "$FLY" volumes list --app "$FLY_APP" 2>/dev/null | grep -q gym_data; then
  run "$FLY" volumes create gym_data --app "$FLY_APP" --region "$FLY_REGION" --size 1 --yes
fi
run "$FLY" secrets set --app "$FLY_APP" --stage \
  RP_ID="$APP_HOST" ORIGIN="https://$APP_HOST" PROXY_SECRET="$PROXY_SECRET"
run "$FLY" deploy --app "$FLY_APP" --primary-region "$FLY_REGION" --remote-only --ha=false
run curl -fsS "https://$FLY_APP.fly.dev/api/health"; echo

# ---- app + proxy on Cloudflare ----
cd "$ROOT/frontend"
run npm ci --no-audit --no-fund
run npm run build:cloudflare
cd "$ROOT"
run npx --yes wrangler@4 deploy --var "API_ORIGIN:https://$FLY_APP.fly.dev"
if [ "${DRY_RUN:-}" = 1 ]; then echo "+ wrangler secret put PROXY_SECRET"
else printf '%s' "$PROXY_SECRET" | npx --yes wrangler@4 secret put PROXY_SECRET >/dev/null; fi

run curl -fsS "https://$APP_HOST/api/health"; echo
echo "Done: https://$APP_HOST"
