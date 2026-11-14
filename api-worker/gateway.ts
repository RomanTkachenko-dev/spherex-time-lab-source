/**
 * Cloudflare Worker gateway for the archive proxy routes: origin check, CORS, edge cache and
 * per-IP rate limits. Kept free of route imports so it can be tested under Node.
 */
type Handler = (request: Request) => Promise<Response>;
export type Routes = Record<string, Partial<Record<string, Handler>>>;
/** Cloudflare `ratelimits` binding (wrangler.api.jsonc). */
export type Limiter = { limit(options: { key: string }): Promise<{ success: boolean }> };
/** Subset of the Workers Cache API (`caches.default`). */
export type EdgeCache = { match(request: Request): Promise<Response | undefined>; put(request: Request, response: Response): Promise<void> };
export type ApiEnv = { SITE_ORIGIN: string; SITE_LIMITER?: Limiter; OTHER_LIMITER?: Limiter };
export type Context = { waitUntil(promise: Promise<unknown>): void };

/** POST bodies are hashed into a cache key; larger bodies are passed through uncached. */
const MAX_CACHED_BODY_BYTES = 1_000_000;
const CACHE_HOST = "https://api-cache.spherex-time-lab.invalid";

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Cache only what a route itself declares public and fresh. */
export function cacheable(response: Response) {
  const control = response.headers.get("Cache-Control") ?? "";
  const maxAge = Number(/max-age=(\d+)/.exec(control)?.[1] ?? 0);
  return response.status === 200 && /\bpublic\b/.test(control) && !/no-store|private/.test(control) && maxAge > 0;
}

export function createGateway(routes: Routes, getCache: () => EdgeCache | undefined) {
  return {
    async fetch(request: Request, env: ApiEnv, context?: Context): Promise<Response> {
      const origin = request.headers.get("Origin");
      if (origin && origin !== env.SITE_ORIGIN) return new Response(null, { status: 403 });
      const url = new URL(request.url);
      const methods = routes[url.pathname];
      if (!methods) return new Response(null, { status: 404 });

      const cors = new Headers({
        "Access-Control-Allow-Origin": env.SITE_ORIGIN,
        "Access-Control-Allow-Methods": [...Object.keys(methods), "OPTIONS"].join(", "),
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Expose-Headers": "X-Source-URL, X-Retrieved-At, X-Cache",
        "Vary": "Origin",
      });
      const withCors = (response: Response, cache?: "HIT" | "MISS") => {
        const headers = new Headers(response.headers);
        cors.forEach((value, name) => headers.set(name, value));
        if (cache) headers.set("X-Cache", cache);
        return new Response(response.body, { status: response.status, headers });
      };
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      const handle = methods[request.method];
      if (!handle) return new Response(null, { status: 405, headers: cors });

      // Cache key: the GET URL itself, or the path plus SHA-256 of a bounded POST body.
      let forward = request, key: Request | null = null;
      if (request.method === "GET") key = new Request(url.toString(), { method: "GET" });
      else if (request.method === "POST") {
        const body = await request.text();
        forward = new Request(request.url, { method: "POST", headers: request.headers, body });
        if (new TextEncoder().encode(body).length <= MAX_CACHED_BODY_BYTES) key = new Request(`${CACHE_HOST}${url.pathname}?body=${await sha256(body)}`, { method: "GET" });
      }
      const cache = key ? getCache() : undefined;
      if (cache && key) {
        const hit = await cache.match(key);
        if (hit) return withCors(hit, "HIT");
      }

      // Only cache misses reach IRSA, so only they count against the per-IP limits.
      const limiter = origin === env.SITE_ORIGIN ? env.SITE_LIMITER : env.OTHER_LIMITER;
      if (limiter) {
        const client = request.headers.get("CF-Connecting-IP") ?? "unknown";
        const { success } = await limiter.limit({ key: client });
        if (!success) return withCors(Response.json(
          { error: "Забагато запитів до архіву з цієї адреси. Зачекайте хвилину й повторіть.", code: "RATE_LIMITED", retryable: true },
          { status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store" } }));
      }

      const response = await handle(forward);
      if (cache && key && cacheable(response)) {
        const stored = cache.put(key, response.clone()).catch(() => undefined);
        if (context) context.waitUntil(stored); else await stored;
      }
      return withCors(response, cache && key ? "MISS" : undefined);
    },
  };
}
