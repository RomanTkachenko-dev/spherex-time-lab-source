export type EphemerisPoint = { mjd: number; ra: number; dec: number };
export type ImportedEphemeris = {
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

const MONTHS: Record<string, number> = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
const MAX_POINTS = 5000;

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
