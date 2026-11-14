export type MostMatch = {
  observation: string;
  detector: number;
  mjd_start: number;
  mjd_end: number;
  exposure_s: number;
  target_ra: number;
  target_dec: number;
  url: string;
  release: "spherex_qr2" | "spherex_qr3" | "spherex_dr1";
  product: string;
};

function finite(value: string | undefined) {
  if (!value || value.toLowerCase() === "null") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeFitsUrl(value: string) {
  const normalized = value.startsWith("/") ? value : `/${value}`;
  const url = new URL(normalized, "https://irsa.ipac.caltech.edu");
  if (url.origin !== "https://irsa.ipac.caltech.edu" || url.search || url.hash || url.username || url.password || url.pathname.includes("..") || !/^\/ibe\/data\/spherex\/(qr2|qr3|dr1)\/level2\/[A-Za-z0-9_./-]+\.fits$/.test(url.pathname)) return null;
  return url.toString();
}

/** Parse MOST's documented Brief (fixed-width IPAC) output without scraping its HTML UI. */
export function parseMostBrief(text: string): MostMatch[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const headerIndex = lines.findIndex(line => line.startsWith("|") && line.includes("ra_obj") && line.includes("dec_obj") && line.includes("mjd_start") && line.includes("observationid") && line.includes("uri"));
  if (headerIndex < 0) {
    const detail = lines.filter(line => /^MOST:|Unable to|No matched|No image|ERROR/i.test(line.trim())).join(" ").slice(0, 500);
    throw new Error(detail || "MOST не повернув таблицю розпізнаного формату.");
  }
  const header = lines[headerIndex];
  const pipes = [...header.matchAll(/\|/g)].map(match => match.index!);
  const names = pipes.slice(0, -1).map((position, i) => header.slice(position + 1, pipes[i + 1]).trim());
  const index = Object.fromEntries(names.map((name, i) => [name, i]));
  const required = ["ra_obj", "dec_obj", "observationid", "productid", "mjd_start", "mjd_end", "exposure_time", "uri"];
  if (required.some(name => index[name] === undefined)) throw new Error("У таблиці MOST немає обов’язкових координат або метаданих зображення.");
  const typeRow = headerIndex + 1;
  const rows: MostMatch[] = [];
  for (const line of lines.slice(typeRow + 1)) {
    if (!line.trim() || line.startsWith("\\") || line.startsWith("|")) continue;
    const cells = pipes.slice(0, -1).map((position, i) => line.slice(position, pipes[i + 1]).trim());
    const value = (name: string) => cells[index[name]] ?? "";
    const ra = finite(value("ra_obj")), dec = finite(value("dec_obj"));
    const mjdStart = finite(value("mjd_start")), mjdEnd = finite(value("mjd_end"));
    const exposure = finite(value("exposure_time"));
    const observation = value("observationid");
    const product = value("productid");
    const url = safeFitsUrl(value("uri"));
    const detector = Number(product.match(/^D([1-6])$/)?.[1] ?? url?.match(/_1D([1-6])_spx_l2b-/)?.[1]);
    const release = url?.match(/\/spherex\/(qr[23]|dr1)\/level2\//)?.[1];
    if (ra === null || ra < 0 || ra >= 360 || dec === null || dec < -90 || dec > 90 || mjdStart === null || mjdEnd === null || mjdEnd < mjdStart || exposure === null || exposure <= 0 || !observation || !url || !Number.isInteger(detector) || !release) continue;
    rows.push({ observation, detector, mjd_start: mjdStart, mjd_end: mjdEnd, exposure_s: exposure, target_ra: ra, target_dec: dec, url, release: `spherex_${release}` as MostMatch["release"], product });
  }
  return rows;
}
