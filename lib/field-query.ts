export type Release = "qr2" | "qr3" | "dr1";
export type Survey = "wide" | "deep" | "most";
export type ArchiveScope = { release: Release; survey: Survey; collection: string };
import { isProperMotion, summarizeTrack, validateProperMotionEphemeris, type EphemerisPoint, type ImportedEphemeris } from "./ephemeris.ts";
import { MAX_SERIES_FRAMES } from "./catalogue-batches.ts";
export type MostProvenance = { source: "IRSA MOST"; source_url: string; source_sha256: string; target_name: string; catalog: "spherex"; retrieved_at: string; match_count: number };
export type FieldQuery = { ra: number; dec: number; start: string; end: string; detector: number; fov: number; max_frames: number; wavelength_min: number | null; wavelength_max: number | null; release: Release; survey: Survey; target?: { query_name: string; canonical_name: string; resolver: string; resolver_url: string; object_type: string | null; reference_position: string | null }; ephemeris?: ImportedEphemeris; most?: MostProvenance };

export function validateArchiveScope(input: unknown): ArchiveScope {
  const p = input as Record<string, unknown>;
  if (!p || typeof p !== "object") throw Error("Не вказано версію архівних даних.");
  const release = p.release == null || p.release === "" ? "qr2" : p.release;
  const survey = p.survey == null || p.survey === "" ? "wide" : p.survey;
  if (release !== "qr2" && release !== "qr3" && release !== "dr1") throw Error("Оберіть реліз QR2, QR3 або DR1.");
  if (survey !== "wide" && survey !== "deep" && survey !== "most") throw Error("Оберіть Wide Survey, Deep Survey або збіги IRSA MOST.");
  return { release, survey, collection: `spherex_${release}${survey === "deep" ? "_deep" : ""}` };
}

export function validateFieldQuery(input: unknown): FieldQuery {
  const p = input as Record<string, unknown>;
  if (!p || typeof p !== "object") throw Error("Не вказано параметри поля.");
  const number = (key: string) => {
    const v = p[key];
    if ((typeof v !== "number" && typeof v !== "string") || String(v).trim() === "" || !Number.isFinite(Number(v))) throw Error(`Некоректне числове поле: ${key}.`);
    return Number(v);
  };
  const detector = number("detector"), fov = number("fov"), max_frames = number("max_frames");
  if (!Number.isInteger(detector) || detector < 1 || detector > 6) throw Error("Оберіть детектор D1–D6.");
  // Operational limits for this browser-based release, not scientific thresholds.
  if (fov < 0.03 || fov > 0.3) throw Error("Ширина поля має бути від 0,03° до 0,30°.");
  if (!Number.isInteger(max_frames) || max_frames < 2 || max_frames > MAX_SERIES_FRAMES) throw Error(`Кількість кадрів: від 2 до ${MAX_SERIES_FRAMES}.`);
  const dates = ["start", "end"].map(key => {
    const v = p[key];
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw Error("Укажіть обидві дати.");
    const ms = Date.parse(v + "T00:00:00Z");
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0,10) !== v) throw Error("Некоректна дата.");
    return { v, ms };
  });
  if (dates[1].ms < dates[0].ms) throw Error("Кінцева дата передує початковій.");
  const ephemerisInput = p.ephemeris;
  const mostInput = p.most;
  let ephemeris: ImportedEphemeris | undefined;
  let most: MostProvenance | undefined;
  let ra: number, dec: number;
  if (ephemerisInput !== undefined && ephemerisInput !== null) {
    if (mostInput !== undefined && mostInput !== null) throw Error("Оберіть одну ефемериду: Horizons або IRSA MOST.");
    if (p.target_name) throw Error("Виберіть або нерухоме поле, або імпортовану ефемериду.");
    if (!ephemerisInput || typeof ephemerisInput !== "object") throw Error("Ефемерида має некоректний формат.");
    const e = ephemerisInput as Record<string, unknown>;
    const rawPoints = e.points;
    if (!Array.isArray(rawPoints) || rawPoints.length < 2 || rawPoints.length > 5000) throw Error("Ефемерида має містити від 2 до 5000 позицій.");
    const points: EphemerisPoint[] = rawPoints.map((point, i) => {
      if (!point || typeof point !== "object") throw Error(`Некоректний рядок ефемериди ${i + 1}.`);
      const row = point as Record<string, unknown>;
      const mjd = Number(row.mjd), pointRa = Number(row.ra), pointDec = Number(row.dec);
      if (![mjd,pointRa,pointDec].every(Number.isFinite) || pointRa < 0 || pointRa >= 360 || pointDec < -90 || pointDec > 90 || (i > 0 && mjd <= Number((rawPoints[i-1] as Record<string, unknown>).mjd))) throw Error(`Некоректний час або координати в рядку ефемериди ${i + 1}.`);
      return { mjd, ra: pointRa, dec: pointDec };
    });
    if (isProperMotion(e)) ephemeris = validateProperMotionEphemeris(e, points);
    else {
      const target_name = typeof e.target_name === "string" ? e.target_name.trim() : "";
      const source_file_name = typeof e.source_file_name === "string" ? e.source_file_name.trim() : "";
      const source_sha256 = typeof e.source_sha256 === "string" ? e.source_sha256.toLowerCase() : "";
      if (e.source !== "JPL Horizons" || e.source_url !== "https://ssd.jpl.nasa.gov/horizons/app.html" || e.observer !== "Earth geocenter" || e.frame !== "ICRF" || e.time_scale !== "UTC" || !target_name || target_name.length > 128 || !source_file_name || source_file_name.length > 128 || /[\\/\u0000-\u001f]/.test(source_file_name) || !/^[a-f0-9]{64}$/.test(source_sha256)) throw Error("Не вистачає метаданих походження таблиці Horizons.");
      ephemeris = { source: "JPL Horizons", source_url: "https://ssd.jpl.nasa.gov/horizons/app.html", target_name, source_file_name, source_sha256, observer: "Earth geocenter", frame: "ICRF", time_scale: "UTC", points };
    }
    const track = summarizeTrack(points);
    const startMjd = dates[0].ms / 86400000 + 40587;
    const endMjdExclusive = dates[1].ms / 86400000 + 40588;
    if (points[0].mjd > startMjd || points.at(-1)!.mjd < endMjdExclusive) throw Error("Ефемерида має покривати весь UTC-інтервал, включно з кінцем останнього дня. Розширте час у Horizons.");
    if (track.radius_deg > fov / 2 + 1e-9) throw Error("Траєкторія виходить за межі вибраного поля. Звузьте дати або збільште поле зору.");
    ra = track.ra; dec = track.dec;
  } else {
    ra = number("ra"); dec = number("dec");
    if (ra < 0 || ra >= 360 || dec < -90 || dec > 90) throw Error("RA: від 0° до 360° виключно; Dec: від −90° до 90°.");
    if (mostInput !== undefined && mostInput !== null) {
      if (!mostInput || typeof mostInput !== "object") throw Error("Метадані IRSA MOST мають некоректний формат.");
      const m = mostInput as Record<string, unknown>;
      const sourceUrl = typeof m.source_url === "string" ? new URL(m.source_url) : null;
      const matchCount = Number(m.match_count);
      const targetName = typeof m.target_name === "string" ? m.target_name.trim() : "";
      const sourceHash = typeof m.source_sha256 === "string" ? m.source_sha256.toLowerCase() : "";
      const retrievedAt = typeof m.retrieved_at === "string" ? m.retrieved_at : "";
      if (m.source !== "IRSA MOST" || m.catalog !== "spherex" || !sourceUrl || sourceUrl.origin !== "https://irsa.ipac.caltech.edu" || sourceUrl.pathname !== "/cgi-bin/MOST/nph-most" || sourceUrl.searchParams.get("catalog") !== "spherex" || !targetName || targetName.length > 128 || !/^[a-f0-9]{64}$/.test(sourceHash) || !Number.isInteger(matchCount) || matchCount < 1 || matchCount > 100_000 || !Number.isFinite(Date.parse(retrievedAt))) throw Error("Метадані походження запиту IRSA MOST неповні або недійсні.");
      most = { source: "IRSA MOST", source_url: sourceUrl.toString(), source_sha256: sourceHash, target_name: targetName, catalog: "spherex", retrieved_at: new Date(retrievedAt).toISOString(), match_count: matchCount };
    }
  }
  const optional = (key: string) => p[key] == null || p[key] === "" ? null : number(key);
  const wavelength_min = optional("wavelength_min"), wavelength_max = optional("wavelength_max");
  if ((wavelength_min === null) !== (wavelength_max === null) || (wavelength_min !== null && wavelength_max !== null && (wavelength_min <= 0 || wavelength_max < wavelength_min))) throw Error("Укажіть обидві межі довжини хвилі у зростаючому порядку або залиште їх порожніми.");
  const { release, survey } = validateArchiveScope(p);
  const targetName = typeof p.target_name === "string" ? p.target_name.trim() : "";
  let target: FieldQuery["target"];
  if (targetName) {
    const canonical_name = typeof p.target_canonical_name === "string" ? p.target_canonical_name.trim() : "";
    const resolver = typeof p.target_resolver === "string" ? p.target_resolver.trim() : "";
    if (targetName.length > 128 || canonical_name.length > 128 || resolver.length > 128 || !canonical_name || !resolver) throw Error("Метадані розпізнаної цілі неповні або завеликі.");
    target = {
      query_name: targetName,
      canonical_name,
      resolver,
      resolver_url: "https://cds.unistra.fr/cgi-bin/nph-sesame/",
      object_type: typeof p.target_type === "string" ? p.target_type.trim().slice(0, 32) || null : null,
      reference_position: typeof p.target_reference === "string" ? p.target_reference.trim().slice(0, 64) || null : null,
    };
  }
  if (survey === "most" && !most) throw Error("Збіги IRSA MOST потребують метаданих походження пошуку.");
  if (survey !== "most" && most) throw Error("Запит IRSA MOST має використовувати тип вибірки MOST.");
  return { ra, dec, start: dates[0].v, end: dates[1].v, detector, fov, max_frames, wavelength_min, wavelength_max, release, survey, ...(target ? { target } : {}), ...(ephemeris ? { ephemeris } : {}), ...(most ? { most } : {}) };
}

export function cutoutRequest(input: unknown) {
  const p = input as Record<string, unknown>;
  if (!p || typeof p.url !== "string") throw Error("Не вказано файл спостереження.");
  const url = new URL(p.url);
  if (url.origin !== "https://irsa.ipac.caltech.edu" || url.username || url.password || url.search || url.hash || !/^\/ibe\/data\/spherex\/(qr2|qr3|dr1)\/level2\/[a-zA-Z0-9_./-]+\.fits$/.test(url.pathname) || url.pathname.includes("..")) throw Error("Дозволені лише калібровані FITS-файли SPHEREx QR2, QR3 або DR1 з IRSA.");
  const querySurvey = p.survey === "most" ? "wide" : p.survey;
  const q = validateFieldQuery({ ...p, survey: querySurvey, most: undefined, detector: 1, max_frames: 2, start: "2025-01-01", end: "2025-01-01", wavelength_min: null, wavelength_max: null, ephemeris: undefined });
  if (!url.pathname.startsWith(`/ibe/data/spherex/${q.release}/level2/`)) throw Error("Реліз URL FITS не збігається з вибраним релізом.");
  // A square in native detector coordinates must cover the rotated output grid.
  const centerRa = p.cutout_ra == null || p.cutout_ra === "" ? q.ra : Number(p.cutout_ra);
  const centerDec = p.cutout_dec == null || p.cutout_dec === "" ? q.dec : Number(p.cutout_dec);
  if (!Number.isFinite(centerRa) || !Number.isFinite(centerDec) || centerRa < 0 || centerRa >= 360 || centerDec < -90 || centerDec > 90) throw Error("Некоректні координати центру FITS-вирізки.");
  url.searchParams.set("center", `${centerRa},${centerDec}`);
  url.searchParams.set("size", String(Number(Math.min(0.6, q.fov * 1.6).toFixed(8))));
  return url.toString();
}

export function selectAcrossTime<T extends { mjd: number }>(sorted: T[], maximum: number): T[] {
  if (maximum <= 0 || sorted.length === 0) return [];
  if (sorted.length <= maximum) return sorted;
  if (maximum === 1) return [sorted[0]];
  const first = sorted[0].mjd, last = sorted[sorted.length - 1].mjd;
  const selected: T[] = [];
  let previous = -1;
  for (let slot = 0; slot < maximum; slot++) {
    const target = first + (last - first) * slot / (maximum - 1);
    const lower = previous + 1;
    const upper = sorted.length - (maximum - slot);
    let lo = lower, hi = upper + 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (sorted[mid].mjd < target) lo = mid + 1;
      else hi = mid;
    }
    const after = Math.min(upper, Math.max(lower, lo));
    const before = Math.max(lower, after - 1);
    const chosen = Math.abs(sorted[before].mjd - target) <= Math.abs(sorted[after].mjd - target) ? before : after;
    selected.push(sorted[chosen]);
    previous = chosen;
  }
  return selected;
}
