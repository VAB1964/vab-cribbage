# VAB Cribbage

Cribbage game for [VABGames.com](https://vabgames.com), including the web application and Cloudflare multiplayer service.

This repository is being populated from the original `Word-Puzzle-Project` as part of a staged migration. The existing production deployment remains unchanged until the new build is verified.

## Repository layout

- `app/` contains the React/Vite game.
- `worker/` contains the multiplayer Durable Object service.
- Root build files provide the combined Cloudflare staging deployment.

Cloudflare staging builds use `app/` as the configured build root and deploy the Worker from `worker/`.
