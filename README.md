# VAB Cribbage

Cribbage game for [VABGames.com](https://vabgames.com), including the web application and Cloudflare multiplayer service.

This repository is being populated from the original `Word-Puzzle-Project` as part of a staged migration. The existing production deployment remains unchanged until the new build is verified.

## Repository layout

- `app/` contains the React/Vite game.
- `worker/` contains the multiplayer Durable Object service.
- Root build files provide the combined Cloudflare staging deployment.

Cloudflare staging builds use `app/` as the configured build root and deploy the Worker from `worker/`.

## Wrangler environments

- `wrangler.staging.jsonc` deploys `vab-cribbage-staging` to `workers.dev` only (no zone routes).
- `wrangler.prod.jsonc` deploys `cribbage-room` to the production `vabgames.com` routes.
- `wrangler.jsonc` remains a staging-safe default without production routes.

## CI commands

Use these exact commands in CI when the build root is `app/`:

- **Staging build command:** `npm ci && npm run build && npm ci --prefix ../worker`
- **Staging deploy command:** `cd ../worker && npx wrangler deploy --config ../wrangler.staging.jsonc`
- **Production build command:** `npm ci && npm run build && npm ci --prefix ../worker`
- **Production deploy command:** `cd ../worker && npx wrangler deploy --config ../wrangler.prod.jsonc`
