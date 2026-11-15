import { SESAME_MIRRORS, sesameUrl } from "./sesame.ts";
import { propagateGaia } from "./gaia.ts";
export type EphemerisPoint = { mjd: number; ra: number; dec: number };
export type HorizonsEphemeris = {
  source: "JPL Horizons";
  source_url: "https://ssd.jpl.nasa.gov/horizons/app.html";
  target_name: string;
  source_file_name: string;
  source_sha256: string;
  observer: "Earth geocenter";
  frame: "ICRF";
  time_scale: "UTC";
  points: EphemerisPoint[];
};
/** Catalogue position at `epoch_jyear` with proper motion in mas/yr (pm_ra includes cos Dec). */
export type ProperMotionReference = { ra: number; dec: number; pm_ra_masyr: number; pm_dec_masyr: number; epoch_jyear: number };
export type ProperMotionEphemeris = {
  source: "Proper motion (CDS Sesame)" | "Proper motion (user-supplied)";
  /** Sesame query URL derived from `query_name`; null for values typed by the user. */
  source_url: string | null;
  target_name: string;
  query_name: string | null;
  resolver: string | null;
  motion_reference: string | null;
  retrieved_at: string | null;
  reference: ProperMotionReference;
  model: "linear-proper-motion-v1";
  frame: "ICRS";
  time_scale: "UTC";
  points: EphemerisPoint[];
};
export type ImportedEphemeris = HorizonsEphemeris | ProperMotionEphemeris;
export const isProperMotion = (e: { source?: unknown } | null | undefined): e is ProperMotionEphemeris =>
  e?.source === "Proper motion (CDS Sesame)" || e?.source === "Proper motion (user-supplied)";

export const julianYearToMjd = (year: number) => 51544.5 + (year - 2000) * 365.25;

/** Same constant proper-motion model as the Gaia overlay (`propagateGaia`); no parallax or radial velocity. */
export function propagateProperMotion(reference: ProperMotionReference, mjd: number): { ra: number; dec: number } {
  const { ra, dec } = propagateGaia({ source_id: "0", ra: reference.ra, dec: reference.dec, ra_error: null, dec_error: null, pmra: reference.pm_ra_masyr, pmdec: reference.pm_dec_masyr, pmra_error: null, pmdec_error: null, ref_epoch: reference.epoch_jyear, phot_g_mean_mag: null }, mjd);
  return { ra, dec };
}

const dateMjd = (date: string) => Date.parse(date + "T00:00:00Z") / 86400000 + 40587;
/** Daily track from 00:00 UTC of `start` to the end of `end` (inclusive calendar days). */
export function properMotionTrack(reference: ProperMotionReference, start: string, end: string): EphemerisPoint[] {
  const first = dateMjd(start), last = dateMjd(end) + 1;
  if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first) throw Error("Некоректний інтервал дат для траєкторії власного руху.");
  const days = Math.round(last - first), step = Math.max(1, Math.ceil(days / (MAX_TRACK_POINTS - 1)));
  const points: EphemerisPoint[] = [];
  for (let day = 0; day < days; day += step) points.push({ mjd: first + day, ...propagateProperMotion(reference, first + day) });
  points.push({ mjd: last, ...propagateProperMotion(reference, last) });
  return points;
}

/** Checks provenance and that every supplied point follows the declared linear model. */
export function validateProperMotionEphemeris(input: Record<string, unknown>, points: EphemerisPoint[]): ProperMotionEphemeris {
  const r = input.reference as Record<string, unknown> | null;
  if (!r || typeof r !== "object") throw Error("Не вказано опорну позицію та власний рух.");
  const reference: ProperMotionReference = { ra: Number(r.ra), dec: Number(r.dec), pm_ra_masyr: Number(r.pm_ra_masyr), pm_dec_masyr: Number(r.pm_dec_masyr), epoch_jyear: Number(r.epoch_jyear) };
  const typed = (key: string) => typeof r[key] === "number" || (typeof r[key] === "string" && (r[key] as string).trim() !== "");
  if (!["ra", "dec", "pm_ra_masyr", "pm_dec_masyr", "epoch_jyear"].every(typed) || !Object.values(reference).every(Number.isFinite) || reference.ra < 0 || reference.ra >= 360 || Math.abs(reference.dec) > 90) throw Error("Опорна позиція власного руху має некоректні координати.");
  if (Math.abs(reference.pm_ra_masyr) > MAX_PROPER_MOTION_MASYR || Math.abs(reference.pm_dec_masyr) > MAX_PROPER_MOTION_MASYR || Math.hypot(reference.pm_ra_masyr, reference.pm_dec_masyr) === 0) throw Error(`Власний рух має бути ненульовим і не більшим за ${MAX_PROPER_MOTION_MASYR} мас/рік за компонентою.`);
  if (reference.epoch_jyear < 1900 || reference.epoch_jyear > 2100) throw Error("Епоха опорної позиції має бути між 1900 і 2100 роками.");
  const text = (key: string, limit: number) => typeof input[key] === "string" ? (input[key] as string).trim().slice(0, limit) : "";
  const target_name = text("target_name", 129);
  if (!target_name || target_name.length > 128 || /[\u0000-\u001f\u007f]/.test(target_name)) throw Error("Не вказано назву цілі з власним рухом.");
  if (input.model !== "linear-proper-motion-v1" || input.frame !== "ICRS" || input.time_scale !== "UTC") throw Error("Невідома модель власного руху.");
  for (const [i, point] of points.entries()) {
    const expected = propagateProperMotion(reference, point.mjd);
    // Chord length: acos() cannot resolve separations below about 1e-6 degrees.
    const a = vector(expected), b = vector(point);
    if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 180 / Math.PI > 1e-7) throw Error(`Позиція ${i + 1} не відповідає заявленому власному руху.`);
  }
  const model = { reference, model: "linear-proper-motion-v1", frame: "ICRS", time_scale: "UTC", points } as const;
  if (input.source === "Proper motion (user-supplied)") return { source: input.source, source_url: null, target_name, query_name: null, resolver: null, motion_reference: null, retrieved_at: null, ...model };
  const query_name = text("query_name", 129), resolver = text("resolver", 129), retrieved = text("retrieved_at", 40);
  if (input.source !== "Proper motion (CDS Sesame)" || !query_name || query_name.length > 128 || /[\u0000-\u001f\u007f]/.test(query_name) || !resolver || resolver.length > 128 || !Number.isFinite(Date.parse(retrieved))) throw Error("Не вистачає метаданих походження власного руху з CDS Sesame.");
  // Provenance must be the Sesame mirror that answered, derived from the query name.
  const source_url = SESAME_MIRRORS.map((_, mirror) => sesameUrl(query_name, mirror)).find(url => url === input.source_url);
  if (!source_url) throw Error("Джерело власного руху має бути запитом до CDS Sesame або його дзеркала.");
  return { source: input.source, source_url, target_name, query_name, resolver, motion_reference: text("motion_reference", 64) || null, retrieved_at: new Date(Date.parse(retrieved)).toISOString(), ...model };
}

const MONTHS: Record<string, number> = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
const MAX_POINTS = 5000;
const MAX_TRACK_POINTS = 1000;
/** Operational bound; the fastest known star (Barnard) moves about 10 400 mas/yr. */
const MAX_PROPER_MOTION_MASYR = 30000;

function dateToMjd(date: string, time: string) {
  const match = /^(\d{4})-([A-Za-z]{3})-(\d{2})$/.exec(date);
  const clock = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/.exec(time);
  const month = match ? MONTHS[match[2].toLowerCase()] : undefined;
  if (!match || month === undefined || !clock) return NaN;
  const year = Number(match[1]), day = Number(match[3]);
  const hour = Number(clock[1]), minute = Number(clock[2]);
  const second = Number(clock[3] ?? 0) + Number(`0.${clock[4] ?? "0"}`);
  const ms = Date.UTC(year, month, day, hour, minute, Math.floor(second), Math.round((second % 1) * 1000));
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month || check.getUTCDate() !== day || hour > 23 || minute > 59 || second >= 60) return NaN;
  return ms / 86400000 + 40587;
}

function sexagesimalRa(hours: string, minutes: string, seconds: string) {
  const h = Number(hours), m = Number(minutes), s = Number(seconds);
  if (h > 24 || m > 59 || s >= 60 || (h === 24 && (m !== 0 || s !== 0))) return NaN;
  return (h * 15 + m / 4 + s / 240) % 360;
}

function sexagesimalDec(degrees: string, minutes: string, seconds: string) {
  const d = Number(degrees), m = Number(minutes), s = Number(seconds);
  if (Math.abs(d) > 90 || m > 59 || s >= 60 || (Math.abs(d) === 90 && (m !== 0 || s !== 0))) return NaN;
  const sign = degrees.startsWith("-") ? -1 : 1;
  return sign * (Math.abs(d) + m / 60 + s / 3600);
}

/** Parse a plain-text Observer Table downloaded from the JPL Horizons browser. */
export function parseHorizonsText(text: string): { target_name: string; points: EphemerisPoint[] } {
  if (text.length > 2_000_000 || text.includes("\0")) throw Error("Файл ефемериди завеликий або пошкоджений.");
  const start = text.indexOf("$$SOE"), end = text.indexOf("$$EOE", start + 5);
  if (start < 0 || end < 0) throw Error("Не знайдено таблицю $$SOE…$$EOE. Завантажте текстовий результат Observer Table із Horizons.");
  const header = text.slice(0, start);
  if (!/^\s*Center body name:\s*Earth\s*\(399\)/im.test(header) || !/^\s*Center-site name:\s*(?:Geocentric|Geocenter|Earth(?:\s+geocenter|\s+center)?)\s*$/im.test(header)) throw Error("Для цього інструмента Horizons має бути налаштований на Earth geocenter (код 500), а не на наземну обсерваторію.");
  if (!/^\s*RA format\s*:\s*HMS\s*$/im.test(header) || !/^\s*Time format\s*:\s*CAL\s*$/im.test(header) || !/^\s*Start time\s*:.+\bUT\s*$/im.test(header) || !/^\s*Stop\s+time\s*:.+\bUT\s*$/im.test(header)) throw Error("Потрібні координати RA/Dec у форматі HMS/DMS та календарні часи UT (UTC для сучасних дат).");
  const columnHeader = header.split(/\r?\n/).some(line => /Date__\(UT\).*R\.A\..*\(ICRF\).*DEC/i.test(line));
  if (!columnHeader) throw Error("Таблиця має містити RA/Dec у системі ICRF. Увімкніть Observer Table з координатами ICRF.");
  const target_name = header.match(/^\s*Target body name:\s*(.+?)(?:\s+\{source:.*)?\s*$/im)?.[1]?.trim();
  if (!target_name) throw Error("У файлі не знайдено назву цілі Horizons.");
  const rowPattern = /^\s*(\d{4}-[A-Za-z]{3}-\d{2})\s+(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s+(?:[*A-Za-z]{1,2}\s+)?(\d{1,2})\s+(\d{1,2})\s+(\d+(?:\.\d*)?)\s+([+-]?\d{1,2})\s+(\d{1,2})\s+(\d+(?:\.\d*)?)(?:\s|$)/;
  const points: EphemerisPoint[] = [];
  for (const line of text.slice(start + 5, end).split(/\r?\n/)) {
    const row = rowPattern.exec(line);
    if (!row) continue;
    const mjd = dateToMjd(row[1], row[2]), ra = sexagesimalRa(row[3], row[4], row[5]), dec = sexagesimalDec(row[6], row[7], row[8]);
    if (![mjd,ra,dec].every(Number.isFinite)) throw Error("У таблиці є некоректний час або координати RA/Dec.");
    points.push({ mjd, ra, dec });
    if (points.length > MAX_POINTS) throw Error(`Ефемерида містить понад ${MAX_POINTS} позицій. Збільште крок часу у Horizons.`);
  }
  if (points.length < 2) throw Error("У таблиці не знайдено щонайменше двох рядків RA/Dec. Перевірте Observer Table і вимкніть фільтри видимості.");
  for (let i = 1; i < points.length; i++) if (points[i].mjd <= points[i - 1].mjd) throw Error("Часи в ефемериді мають строго зростати без повторів.");
  return { target_name, points };
}

function vector(point: Pick<EphemerisPoint,"ra"|"dec">): [number,number,number] {
  const ra=point.ra*Math.PI/180, dec=point.dec*Math.PI/180, cos=Math.cos(dec);
  return [cos*Math.cos(ra),cos*Math.sin(ra),Math.sin(dec)];
}
function fromVector(v: [number,number,number]) {
  const norm=Math.hypot(...v), x=v[0]/norm, y=v[1]/norm, z=v[2]/norm;
  return { ra:(Math.atan2(y,x)*180/Math.PI+360)%360, dec:Math.asin(Math.max(-1,Math.min(1,z)))*180/Math.PI };
}
export function angularSeparationDeg(a: Pick<EphemerisPoint,"ra"|"dec">, b: Pick<EphemerisPoint,"ra"|"dec">) {
  const av=vector(a), bv=vector(b);
  return Math.acos(Math.max(-1,Math.min(1,av[0]*bv[0]+av[1]*bv[1]+av[2]*bv[2])))*180/Math.PI;
}
export function containsSRegion(region: string | undefined, ra: number, dec: number) {
  if (!region) return false;
  const match=/^\s*POLYGON\s+ICRS\s+(.+)$/i.exec(region.trim());
  if (!match) return false;
  const values=match[1].trim().split(/\s+/).map(Number);
  if (values.length<6 || values.length%2!==0 || values.some(v=>!Number.isFinite(v))) return false;
  const vertices: [number,number,number][]=[];
  for(let i=0;i<values.length;i+=2) {
    if(values[i]<0||values[i]>=360||values[i+1]<-90||values[i+1]>90)return false;
    vertices.push(vector({ra:values[i],dec:values[i+1]}));
  }
  const center=vector({ra,dec}), angle=ra*Math.PI/180, latitude=dec*Math.PI/180;
  const east:[number,number,number]=[-Math.sin(angle),Math.cos(angle),0];
  const north:[number,number,number]=[-Math.sin(latitude)*Math.cos(angle),-Math.sin(latitude)*Math.sin(angle),Math.cos(latitude)];
  const projected=vertices.map(v=>{
    const denominator=v[0]*center[0]+v[1]*center[1]+v[2]*center[2];
    if(denominator<=0)return null;
    return [(v[0]*east[0]+v[1]*east[1]+v[2]*east[2])/denominator,(v[0]*north[0]+v[1]*north[1]+v[2]*north[2])/denominator] as [number,number];
  });
  if(projected.some(v=>v===null))return false;
  let inside=false;
  for(let i=0,j=projected.length-1;i<projected.length;j=i++) {
    const a=projected[i]!, b=projected[j]!;
    if((a[1]>0)!==(b[1]>0) && 0 < (b[0]-a[0])*(-a[1])/(b[1]-a[1])+a[0])inside=!inside;
  }
  return inside;
}
export function summarizeTrack(points: EphemerisPoint[]) {
  if (!points.length) throw Error("Ефемерида порожня.");
  const sum=points.reduce<[number,number,number]>((v,p)=>{const q=vector(p);return [v[0]+q[0],v[1]+q[1],v[2]+q[2]];},[0,0,0]);
  const center=fromVector(sum);
  return { ...center, radius_deg: Math.max(...points.map(p=>angularSeparationDeg(center,p))) };
}
export function interpolateEphemeris(points: EphemerisPoint[], mjd: number): { ra: number; dec: number } | null {
  if (!Number.isFinite(mjd) || points.length < 2 || mjd < points[0].mjd || mjd > points.at(-1)!.mjd) return null;
  let lo=0, hi=points.length-1;
  while (lo+1<hi) { const mid=(lo+hi)>>1; if (points[mid].mjd<mjd) lo=mid; else hi=mid; }
  if (mjd===points[hi].mjd) return {ra:points[hi].ra,dec:points[hi].dec};
  const a=points[lo], b=points[hi], fraction=(mjd-a.mjd)/(b.mjd-a.mjd), av=vector(a), bv=vector(b);
  const dot=Math.max(-1,Math.min(1,av[0]*bv[0]+av[1]*bv[1]+av[2]*bv[2])), angle=Math.acos(dot);
  if (angle<1e-12) return fromVector([av[0]+fraction*(bv[0]-av[0]),av[1]+fraction*(bv[1]-av[1]),av[2]+fraction*(bv[2]-av[2])]);
  const scaleA=Math.sin((1-fraction)*angle)/Math.sin(angle), scaleB=Math.sin(fraction*angle)/Math.sin(angle);
  return fromVector([scaleA*av[0]+scaleB*bv[0],scaleA*av[1]+scaleB*bv[1],scaleA*av[2]+scaleB*bv[2]]);
}
