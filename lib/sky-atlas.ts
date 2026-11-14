export type SkySearchTarget = {
  ra: number; dec: number; start: string; end: string;
  detector: number; release: "qr2" | "qr3" | "dr1"; survey: "wide" | "deep";
  comparisonUrls?: [string, string];
};
export type SkyObservation = {
  id: string; observation: string; detector: number; mjd: number;
  url: string; release: string; s_region?: string;
};

/** Decimal ICRS coordinates only. Object names use the existing name resolver. */
export function parseSkyCoordinates(text: string): [number, number] | null {
  const parts = text.trim().split(/[\s,;]+/);
  if (parts.length !== 2 || !parts.every(p => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(p))) return null;
  const [ra, dec] = parts.map(Number);
  return Number.isFinite(ra) && Number.isFinite(dec) && ra >= 0 && ra < 360 && Math.abs(dec) <= 90 ? [ra, dec] : null;
}

/** Do not guess frames or interpret arbitrary STC-S strings as ICRS polygons. */
export function parseSkyFootprint(region?: string): [number, number][] | null {
  if (!region || region.length > 20000) return null;
  const tokens = region.trim().split(/\s+/);
  if (tokens[0].toUpperCase() !== "POLYGON" || tokens[1]?.toUpperCase() !== "ICRS") return null;
  const values = tokens.slice(2).map(Number);
  if (values.length < 6 || values.length % 2 || !values.every(Number.isFinite)) return null;
  const points: [number, number][] = [];
  for (let i = 0; i < values.length; i += 2) {
    if (values[i] < 0 || values[i] > 360 || Math.abs(values[i + 1]) > 90) return null;
    points.push([values[i] % 360, values[i + 1]]);
  }
  return points;
}

export function skyObservationDate(record: Pick<SkyObservation, "mjd">) {
  return new Date((record.mjd - 40587) * 86400000).toISOString();
}

export function readAtlasLink(params: URLSearchParams) {
  const coordinates = parseSkyCoordinates(`${params.get("ra") ?? ""} ${params.get("dec") ?? ""}`);
  const date = (key: string) => {
    const value = params.get(key) ?? "";
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value ? value : undefined;
  };
  const start = date("start"), end = date("end");
  const detector = Number(params.get("detector"));
  const fov = Number(params.get("fov"));
  return {
    coordinates, invalidCoordinates: !coordinates && (params.has("ra") || params.has("dec")),
    start, end: start && end && end < start ? undefined : end,
    detector: Number.isInteger(detector) && detector >= 1 && detector <= 6 ? detector : undefined,
    release: params.get("release") === "qr3" ? "qr3" as const : "dr1" as const,
    survey: params.get("survey") === "deep" ? "deep" as const : "wide" as const,
    fov: fov >= .03 && fov <= 180 ? fov : coordinates ? 8 : 180,
    search: params.get("search") === "1" && !!coordinates && !!start && !!end && end >= start,
    embed: params.get("embed") === "1",
  };
}
