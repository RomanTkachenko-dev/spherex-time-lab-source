export type GaiaSource = {
  source_id: string;
  ra: number;
  dec: number;
  ra_error: number | null;
  dec_error: number | null;
  pmra: number | null;
  pmdec: number | null;
  pmra_error: number | null;
  pmdec_error: number | null;
  ref_epoch: number;
  phot_g_mean_mag: number | null;
};

export type GaiaReference = {
  service: "IRSA TAP · Gaia DR3";
  table: "gaia_dr3_source";
  source_url: string;
  source_sha256: string;
  retrieved_at: string;
  center_ra: number;
  center_dec: number;
  radius_deg: number;
  record_count: number;
  truncated: boolean;
  sources: GaiaSource[];
};

const columns = ["source_id", "ra", "dec", "ra_error", "dec_error", "pmra", "pmdec", "pmra_error", "pmdec_error", "ref_epoch", "phot_g_mean_mag"];

function csvRows(text: string) {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === "") quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += char;
  }
  if (quoted) throw new Error("Відповідь Gaia містить незакритане CSV-поле.");
  if (cell.length || row.length) { row.push(cell.replace(/\r$/, "")); rows.push(row); }
  return rows.filter(value => value.some(part => part !== ""));
}

function numberOrNull(value: string | undefined) {
  if (value === undefined || value.trim() === "" || value.trim().toLowerCase() === "null") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseGaiaCsv(csv: string): GaiaSource[] {
  const rows = csvRows(csv);
  if (!rows.length || columns.some(name => !rows[0].includes(name))) throw new Error("IRSA TAP повернув CSV без очікуваних колонок Gaia DR3.");
  const positions = columns.map(name => rows[0].indexOf(name));
  return rows.slice(1).flatMap(row => {
    const value = (column: string) => row[positions[columns.indexOf(column)]];
    const ra = numberOrNull(value("ra")), dec = numberOrNull(value("dec")), refEpoch = numberOrNull(value("ref_epoch"));
    const sourceId = value("source_id")?.trim();
    if (!sourceId || ra === null || ra < 0 || ra >= 360 || dec === null || dec < -90 || dec > 90 || refEpoch === null) return [];
    return [{ source_id: sourceId, ra, dec,
      ra_error: numberOrNull(value("ra_error")), dec_error: numberOrNull(value("dec_error")),
      pmra: numberOrNull(value("pmra")), pmdec: numberOrNull(value("pmdec")),
      pmra_error: numberOrNull(value("pmra_error")), pmdec_error: numberOrNull(value("pmdec_error")),
      ref_epoch: refEpoch, phot_g_mean_mag: numberOrNull(value("phot_g_mean_mag")) }];
  });
}

const MAS_TO_RAD = Math.PI / (180 * 3600 * 1000);

/** Constant proper-motion propagation on the local tangent vector; parallax and radial velocity are not applied. */
export function propagateGaia(source: GaiaSource, mjd: number) {
  if (source.pmra === null || source.pmdec === null) return { ra: source.ra, dec: source.dec, motion_applied: false };
  const targetYear = 2000 + (mjd - 51544.5) / 365.25;
  const years = targetYear - source.ref_epoch;
  const ra = source.ra * Math.PI / 180, dec = source.dec * Math.PI / 180;
  const p: [number, number, number] = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
  const east: [number, number, number] = [-Math.sin(ra), Math.cos(ra), 0];
  const north: [number, number, number] = [-Math.sin(dec) * Math.cos(ra), -Math.sin(dec) * Math.sin(ra), Math.cos(dec)];
  const e = source.pmra * years * MAS_TO_RAD, n = source.pmdec * years * MAS_TO_RAD;
  const angle = Math.hypot(e, n);
  const scale = angle < 1e-15 ? 1 : Math.sin(angle) / angle;
  const moved = p.map((value, i) => value * Math.cos(angle) + (east[i] * e + north[i] * n) * scale) as [number, number, number];
  return { ra: (Math.atan2(moved[1], moved[0]) * 180 / Math.PI + 360) % 360, dec: Math.asin(Math.max(-1, Math.min(1, moved[2]))) * 180 / Math.PI, motion_applied: true };
}

/** Project ICRS coordinates to the app's north-up, east-left TAN display grid. */
export function projectGaia(source: GaiaSource, centerRa: number, centerDec: number, fovDeg: number, mjd: number) {
  const position = propagateGaia(source, mjd);
  const ra = position.ra * Math.PI / 180, dec = position.dec * Math.PI / 180;
  const ra0 = centerRa * Math.PI / 180, dec0 = centerDec * Math.PI / 180;
  let deltaRa = ra - ra0;
  deltaRa = Math.atan2(Math.sin(deltaRa), Math.cos(deltaRa));
  const cosc = Math.sin(dec0) * Math.sin(dec) + Math.cos(dec0) * Math.cos(dec) * Math.cos(deltaRa);
  if (cosc <= 0) return null;
  const xi = Math.cos(dec) * Math.sin(deltaRa) / cosc;
  const eta = (Math.cos(dec0) * Math.sin(dec) - Math.sin(dec0) * Math.cos(dec) * Math.cos(deltaRa)) / cosc;
  const scaleDeg = fovDeg / 256, x = 127.5 - xi * 180 / Math.PI / scaleDeg, y = 127.5 - eta * 180 / Math.PI / scaleDeg;
  if (x < -5 || x > 261 || y < -5 || y > 261) return null;
  return { x, y, ...position };
}
