# Cribbage room service

Self-contained Cloudflare Worker and SQLite-backed Durable Object room authority.

## Endpoints

- `POST /rooms` creates an empty six-character room and returns `{ "roomId": "ABC234" }`.
- `GET /rooms/:roomId/ws` upgrades to a Hibernation WebSocket.
- `GET /health` returns service and protocol status.

After connecting, the creator sends `CREATE_ROOM`; other clients send `JOIN_ROOM`. Every command uses this envelope:

```json
{
  "protocolVersion": 1,
  "roomId": "ABC234",
  "playerId": null,
  "commandId": "00000000-0000-4000-8000-000000000001",
  "expectedRevision": 0,
  "type": "CREATE_ROOM",
  "payload": { "name": "Vince", "avatarId": "avatar-1", "seatCount": 2 }
}
```

The service persists a snapshot and command result before sending revisioned private views. Store the returned reconnect token securely on the client; only its SHA-256 hash is persisted.

## Commands

`CREATE_ROOM`, `JOIN_ROOM`, `SET_READY`, `UPDATE_SETUP`, `ADD_AI`, `REMOVE_AI`,
`REPLACE_WITH_AI`, `START_GAME`, `DISCARD`, `PLAY_CARD`, `SAY_GO`, `ACK_COUNT`,
`NEXT_DEAL`, `REMATCH`, and `LEAVE_ROOM`.

The current gameplay layer is a protocol and authority foundation: secure dealing, hand ownership,
discard membership, turn order, 31-limit, and Go legality are enforced. Full Cribbage scoring,
count-phase progression, AI strategy execution, stakes ledger, expiry, and turn reminders require
the future pure rules engine and are not guessed or duplicated here.

## Local validation

```sh
npm install
npm run types
npm test
npm run typecheck
npm run check
```

No account IDs, secrets, or deployment configuration are included.
