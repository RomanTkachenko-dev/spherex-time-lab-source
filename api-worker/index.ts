import * as field from "../app/api/field/route";
import * as archive from "../app/api/archive/route";
import * as cutout from "../app/api/cutout/route";
import * as gaia from "../app/api/gaia/route";
import * as resolve from "../app/api/resolve/route";
import * as most from "../app/api/most/route";

type Handler = (request: Request) => Promise<Response>;
const routes: Record<string, Partial<Record<string, Handler>>> = {
  "/api/field": { GET: field.GET, POST: field.POST },
  "/api/archive": { GET: archive.GET },
  "/api/cutout": { GET: cutout.GET },
  "/api/gaia": { GET: gaia.GET },
  "/api/resolve": { GET: resolve.GET },
  "/api/most": { POST: most.POST },
};

export default {
  async fetch(request: Request, env: { SITE_ORIGIN: string }) {
    const origin = request.headers.get("Origin");
    if (origin && origin !== env.SITE_ORIGIN) return new Response(null, { status: 403 });
    const methods = routes[new URL(request.url).pathname];
    if (!methods) return new Response(null, { status: 404 });

    const cors = new Headers({
      "Access-Control-Allow-Origin": env.SITE_ORIGIN,
      "Access-Control-Allow-Methods": [...Object.keys(methods), "OPTIONS"].join(", "),
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Expose-Headers": "X-Source-URL, X-Retrieved-At",
      "Vary": "Origin",
    });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const handle = methods[request.method];
    if (!handle) return new Response(null, { status: 405, headers: cors });
    const response = await handle(request);
    const headers = new Headers(response.headers);
    cors.forEach((value, name) => headers.set(name, value));
    return new Response(response.body, { status: response.status, headers });
  },
};
