// Link between the sky globe and the exposure viewer (UI only).
// The viewer's "fixed sky" panels share one gnomonic (TAN) grid of 256 × 256 pixels centred on
// manifest.display.sky_center_ra/dec with width sky_fov_deg, north up and east left. Pixel
// coordinates follow the pipeline's marker_sky convention: the grid centre is (127.5, 127.5) and
// the panel is drawn with pixel i covering [i, i + 1) in SVG units, so markers are drawn at +0.5.

const DEG = Math.PI / 180;
export const GRID = 256;
const CENTRE = 127.5;

export type SkyGrid = { centerRa: number; centerDec: number; fovDeg: number };

/** RA/Dec (deg) → panel pixel {x, y}; null when the point is on the far hemisphere. */
export function skyToPixel(ra: number, dec: number, grid: SkyGrid) {
  const a = ra * DEG, d = dec * DEG, a0 = grid.centerRa * DEG, d0 = grid.centerDec * DEG;
  const dra = Math.atan2(Math.sin(a - a0), Math.cos(a - a0));
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(dra);
  if (cosc <= 0) return null;
  const xi = Math.cos(d) * Math.sin(dra) / cosc;
  const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(dra)) / cosc;
  const scale = grid.fovDeg / GRID;
  return { x: CENTRE - xi / DEG / scale, y: CENTRE - eta / DEG / scale };
}

/** Panel pixel {x, y} → RA/Dec (deg), inverse of skyToPixel. */
export function pixelToSky(x: number, y: number, grid: SkyGrid) {
  const scale = grid.fovDeg / GRID;
  const xi = (CENTRE - x) * scale * DEG, eta = (CENTRE - y) * scale * DEG;
  const a0 = grid.centerRa * DEG, d0 = grid.centerDec * DEG;
  const rho = Math.hypot(xi, eta);
  if (rho === 0) return { ra: grid.centerRa, dec: grid.centerDec };
  const c = Math.atan(rho);
  const dec = Math.asin(Math.cos(c) * Math.sin(d0) + eta * Math.sin(c) * Math.cos(d0) / rho);
  const ra = a0 + Math.atan2(xi * Math.sin(c), rho * Math.cos(d0) * Math.cos(c) - eta * Math.sin(d0) * Math.sin(c));
  return { ra: ((ra / DEG) % 360 + 360) % 360, dec: dec / DEG };
}

/** Whether a projected point lies inside the panel. */
export const inPanel = (p: { x: number; y: number } | null) => !!p && p.x >= 0 && p.x <= GRID && p.y >= 0 && p.y <= GRID;

/** Angular distance (arcmin) between two sky positions. */
export function separationArcmin(ra1: number, dec1: number, ra2: number, dec2: number) {
  const a = Math.sin((dec2 - dec1) * DEG / 2) ** 2 + Math.cos(dec1 * DEG) * Math.cos(dec2 * DEG) * Math.sin((ra2 - ra1) * DEG / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(a))) / DEG * 60;
}
