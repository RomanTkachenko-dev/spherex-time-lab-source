import test from "node:test";
import assert from "node:assert/strict";
import { cacheable, createGateway, type EdgeCache, type Limiter } from "../api-worker/gateway.ts";

const SITE = "https://site.example";
function memoryCache() {
  const store = new Map<string, Response>();
  const cache: EdgeCache = {
    async match(request) { const hit = store.get(request.url); return hit?.clone(); },
    async put(request, response) { store.set(request.url, response); },
  };
  return { cache, store };
}
function limiter(allowed: number) {
  const keys: string[] = [];
  const binding: Limiter = { async limit({ key }) { keys.push(key); return { success: keys.length <= allowed }; } };
  return { binding, keys };
}
function setup(allowedSite = 100, allowedOther = 100) {
  const calls: string[] = [];
  const routes = {
    "/api/resolve": { GET: async (request: Request) => { calls.push(request.url); return Response.json({ ok: true }, { headers: { "Cache-Control": "public, max-age=3600" } }); } },
    "/api/field": { POST: async (request: Request) => { const body = await request.text(); calls.push(body); return Response.json({ body }, { headers: { "Cache-Control": "public, max-age=300" } }); } },
    "/api/gaia": { GET: async () => { calls.push("gaia"); return Response.json({ error: "down" }, { status: 502, headers: { "Cache-Control": "no-store" } }); } },
  };
  const { cache, store } = memoryCache();
  const site = limiter(allowedSite), other = limiter(allowedOther);
  const gateway = createGateway(routes, () => cache);
  const env = { SITE_ORIGIN: SITE, SITE_LIMITER: site.binding, OTHER_LIMITER: other.binding };
  return { gateway, env, calls, store, site, other };
}
const get = (path: string, headers: Record<string, string> = { Origin: SITE, "CF-Connecting-IP": "1.2.3.4" }) => new Request("https://api.example" + path, { headers });

test("public route responses are served from the edge cache without reaching the handler again", async () => {
  const { gateway, env, calls, site } = setup();
  const first = await gateway.fetch(get("/api/resolve?name=M101"), env);
  const second = await gateway.fetch(get("/api/resolve?name=M101"), env);
  assert.deepEqual([first.headers.get("X-Cache"), second.headers.get("X-Cache")], ["MISS", "HIT"]);
  assert.deepEqual(await second.json(), { ok: true });
  assert.equal(calls.length, 1); assert.equal(site.keys.length, 1, "cache hits do not count against the limit");
  assert.equal(second.headers.get("Access-Control-Allow-Origin"), SITE);
  await gateway.fetch(get("/api/resolve?name=M51"), env);
  assert.equal(calls.length, 2, "a different query is a different key");
});

test("POST bodies are cached by their SHA-256 and forwarded intact", async () => {
  const { gateway, env, calls } = setup();
  const post = (body: string) => new Request("https://api.example/api/field", { method: "POST", body, headers: { Origin: SITE, "Content-Type": "application/json" } });
  const a = await gateway.fetch(post('{"ra":1}'), env);
  assert.deepEqual(await a.json(), { body: '{"ra":1}' });
  assert.equal((await gateway.fetch(post('{"ra":1}'), env)).headers.get("X-Cache"), "HIT");
  assert.equal((await gateway.fetch(post('{"ra":2}'), env)).headers.get("X-Cache"), "MISS");
  assert.deepEqual(calls, ['{"ra":1}', '{"ra":2}']);
});

test("errors and private responses are never cached", async () => {
  const { gateway, env, calls, store } = setup();
  await gateway.fetch(get("/api/gaia?ra=1"), env); await gateway.fetch(get("/api/gaia?ra=1"), env);
  assert.equal(calls.length, 2); assert.equal(store.size, 0);
  for (const control of ["no-store", "public, max-age=0", "private, max-age=60", ""]) assert.equal(cacheable(new Response("x", { headers: { "Cache-Control": control } })), false, control);
  assert.equal(cacheable(new Response("x", { status: 404, headers: { "Cache-Control": "public, max-age=60" } })), false);
  assert.equal(cacheable(new Response("x", { headers: { "Cache-Control": "public, max-age=86400" } })), true);
});

test("per-IP limits apply on cache misses, with a stricter limit for clients without an Origin", async () => {
  const { gateway, env, site, other } = setup(100, 1);
  const script = { "CF-Connecting-IP": "9.9.9.9" };
  assert.equal((await gateway.fetch(get("/api/resolve?name=a", script), env)).status, 200);
  const blocked = await gateway.fetch(get("/api/resolve?name=b", script), env);
  assert.equal(blocked.status, 429); assert.equal(blocked.headers.get("Retry-After"), "60");
  assert.equal((await blocked.json() as { code: string }).code, "RATE_LIMITED");
  assert.deepEqual(other.keys, ["9.9.9.9", "9.9.9.9"]); assert.equal(site.keys.length, 0);
  assert.equal((await gateway.fetch(get("/api/resolve?name=a", script), env)).status, 200, "a cached answer is still served");
});

test("origin, route and method checks happen before any upstream work", async () => {
  const { gateway, env, calls } = setup();
  assert.equal((await gateway.fetch(get("/api/resolve?name=a", { Origin: "https://evil.example" }), env)).status, 403);
  assert.equal((await gateway.fetch(get("/api/unknown"), env)).status, 404);
  assert.equal((await gateway.fetch(new Request("https://api.example/api/resolve", { method: "DELETE", headers: { Origin: SITE } }), env)).status, 405);
  const preflight = await gateway.fetch(new Request("https://api.example/api/field", { method: "OPTIONS", headers: { Origin: SITE } }), env);
  assert.equal(preflight.status, 204); assert.match(preflight.headers.get("Access-Control-Allow-Methods")!, /POST/);
  assert.equal(calls.length, 0);
  const { gateway: bare } = setup();
  assert.equal((await bare.fetch(get("/api/resolve?name=a"), { SITE_ORIGIN: SITE })).status, 200, "missing bindings (local dev) disable limiting");
});

test("oversized archive requests stop before reaching the handler", async () => {
  const { gateway, env, calls } = setup();
  const response = await gateway.fetch(new Request("https://api.example/api/field", {
    method: "POST", body: "x".repeat(1_000_001), headers: { Origin: SITE },
  }), env);
  assert.equal(response.status, 413);
  assert.equal(calls.length, 0);
});
