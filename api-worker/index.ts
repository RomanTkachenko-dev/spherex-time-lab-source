import * as field from "../app/api/field/route";
import * as archive from "../app/api/archive/route";
import * as cutout from "../app/api/cutout/route";
import * as gaia from "../app/api/gaia/route";
import * as resolve from "../app/api/resolve/route";
import * as most from "../app/api/most/route";
import { createGateway, type EdgeCache } from "./gateway";

export default createGateway({
  "/api/field": { GET: field.GET, POST: field.POST },
  "/api/archive": { GET: archive.GET },
  "/api/cutout": { GET: cutout.GET },
  "/api/gaia": { GET: gaia.GET },
  "/api/resolve": { GET: resolve.GET },
  "/api/most": { POST: most.POST },
}, () => (globalThis as { caches?: { default?: EdgeCache } }).caches?.default);
