import { GameRoom } from "./game-room";
import { ROOM_CODE } from "./protocol";

export { GameRoom };

const API_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const requestPath = url.pathname;
      const apiPath = requestPath.replace(/^\/api\/cribbage(?=\/|$)/, "") || "/";
      const normalizedApiPath = apiPath === "/" ? "/" : apiPath.replace(/\/+$/, "");
      if (normalizedApiPath === "/health" && request.method === "GET") {
        return json({ ok: true, service: "cribbage-room", protocolVersion: 1 });
      }
      if (normalizedApiPath === "/rooms" && request.method === "POST") {
        if ((Number(request.headers.get("content-length")) || 0) > 1024) {
          return json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request exceeds 1 KiB." } }, 413);
        }
        const roomId = await createUniqueRoom(env);
        return json({ roomId }, 201);
      }
      const match = /^\/rooms\/([^/]+)\/ws\/?$/.exec(normalizedApiPath);
      if (match) {
        if (request.method !== "GET") return json({ error: { code: "METHOD_NOT_ALLOWED" } }, 405);
        const roomId = match[1]?.toUpperCase() ?? "";
        if (!ROOM_CODE.test(roomId)) return json({ error: { code: "INVALID_ROOM_CODE", message: "Use a six-character room code." } }, 400);
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
          return json({ error: { code: "UPGRADE_REQUIRED", message: "WebSocket upgrade required." } }, 426);
        }
        return env.GAME_ROOMS.getByName(roomId).fetch(request);
      }
      if (requestPath === "/api/cribbage" || requestPath.startsWith("/api/cribbage/")) {
        return json({ error: { code: "NOT_FOUND" } }, 404);
      }
      if (/^\/cribbage\/room\/[A-HJ-NP-Z2-9]{6}\/?$/.test(requestPath)) {
        return env.ASSETS.fetch(new Request(new URL("/cribbage/", url), request));
      }
      return env.ASSETS.fetch(request);
    } catch (error: unknown) {
      console.error(JSON.stringify({ event: "request_failed", error: error instanceof Error ? error.name : "unknown" }));
      return json({ error: { code: "INTERNAL", message: "Unexpected server error." } }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function createUniqueRoom(env: Env): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const roomId = randomRoomCode();
    if (await env.GAME_ROOMS.getByName(roomId).initialize(roomId)) return roomId;
  }
  throw new Error("Unable to allocate room code");
}

function randomRoomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const random = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(random, (byte) => alphabet[byte % alphabet.length]).join("");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: API_HEADERS });
}
