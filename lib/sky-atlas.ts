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
