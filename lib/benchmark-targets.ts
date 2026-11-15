/**
 * Test targets named in the NASA Space Apps 2026 challenge "Planet X and SPHEREx".
 *
 * Catalogue positions are propagated with constant proper motion to the middle of
 * the search window, so high proper-motion objects stay near the field centre.
 * Parallax (up to ~0.55″ for these objects) is not applied: it is far below the
 * 6.15″ SPHEREx pixel.
 */
import type { SkySearchTarget } from "./sky-atlas.ts";

export type BenchmarkTarget = {
  id: string;
  name: string;
  kind: "proper-motion" | "variable";
  /** ICRS position (degrees) at `epoch` (Julian year). */
  ra: number; dec: number; epoch: number;
  /** Proper motion: μα* = μα·cos δ and μδ, in mas/yr. */
  pmra: number; pmdec: number;
  detector: number;
  reference: string;
};

const hms = (h: number, m: number, s: number) => 15 * (h + m / 60 + s / 3600);
const dms = (sign: 1 | -1, d: number, m: number, s: number) => sign * (d + m / 60 + s / 3600);

export const BENCHMARK_TARGETS: BenchmarkTarget[] = [
  { id: "barnard", name: "Barnard's Star", kind: "proper-motion",
    ra: hms(17, 57, 48.4997), dec: dms(1, 4, 41, 36.113), epoch: 2000.0, pmra: -801.551, pmdec: 10362.394,
    detector: 2, reference: "SIMBAD (Gaia DR3 astrometry, ICRS J2000)" },
  { id: "eps-indi-b", name: "Epsilon Indi B", kind: "proper-motion",
    ra: hms(22, 4, 10.52), dec: dms(-1, 56, 46, 57.7), epoch: 1999.855, pmra: 3981.977, pmdec: -2466.832,
    detector: 6, reference: "2MASS position (epoch 1999.855); proper motion of ε Ind Ba/Bb" },
  { id: "wise-0855", name: "WISE 0855−0714", kind: "proper-motion",
    ra: hms(8, 55, 10.831), dec: dms(-1, 7, 14, 42.53), epoch: 2010.5, pmra: -8123.7, pmdec: 673.2,
    detector: 6, reference: "Challenge position (WISE 2010 designation); proper motion −8123.7, +673.2 mas/yr (literature value)" },
  { id: "rw-aur", name: "RW Aurigae", kind: "variable",
    ra: hms(5, 7, 49.54), dec: dms(1, 30, 24, 5.1), epoch: 2000.0, pmra: 0, pmdec: 0,
    detector: 3, reference: "SIMBAD (ICRS J2000); proper motion negligible at SPHEREx resolution" },
  { id: "r-dra", name: "R Draconis", kind: "variable",
    ra: hms(16, 32, 40.18), dec: dms(1, 66, 45, 18.0), epoch: 2000.0, pmra: 0, pmdec: 0,
    detector: 1, reference: "SIMBAD (ICRS J2000); proper motion negligible at SPHEREx resolution" },
];

/** Search window covering the first SPHEREx all-sky surveys (calendar days, UTC). */
export const BENCHMARK_WINDOW = { start: "2025-05-01", end: "2026-11-14" } as const;

const julianYear = (iso: string) => 2000 + (Date.parse(iso + "T00:00:00Z") - Date.UTC(2000, 0, 1, 12)) / (365.25 * 86400000);

/** Linear tangent-plane propagation; adequate for offsets of a few arcminutes. */
export function positionAt(target: BenchmarkTarget, year: number) {
  const dt = year - target.epoch;
  const dec = target.dec + (target.pmdec * dt) / 3.6e6;
  const ra = target.ra + (target.pmra * dt) / 3.6e6 / Math.cos(((target.dec + dec) / 2) * Math.PI / 180);
  return { ra: ((ra % 360) + 360) % 360, dec };
}

/** Annual motion in arcseconds and in SPHEREx pixels (6.15″). */
export function annualMotion(target: BenchmarkTarget) {
  const arcsec = Math.hypot(target.pmra, target.pmdec) / 1000;
  return { arcsec, pixels: arcsec / 6.15 };
}

export function benchmarkSearch(target: BenchmarkTarget): SkySearchTarget {
  const middle = (julianYear(BENCHMARK_WINDOW.start) + julianYear(BENCHMARK_WINDOW.end)) / 2;
  const { ra, dec } = positionAt(target, middle);
  return { ra: Number(ra.toFixed(6)), dec: Number(dec.toFixed(6)), start: BENCHMARK_WINDOW.start, end: BENCHMARK_WINDOW.end,
    detector: target.detector, release: "dr1", survey: "wide" };
}
