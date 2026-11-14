/**
 * Frame differences reconstructed from the 8-bit display PNGs.
 *
 * `field_pipeline.display_gray` writes gray = floor(asinh(18·s)/asinh(18)·255) with
 * s = clip((v − low)/(high − low), 0, 1), then flips rows (north up). Inverting that
 * stretch recovers MJy/sr to within one gray step; values at gray 0 or 255 are only
 * bounds (clipped at the series display limits). This is a display product, not photometry.
 */
export type Stretch = { low: number; high: number; parameter: number; checkerboard: boolean };
export type DecodedFrame = { values: Float32Array; clipped: Uint8Array; width: number; height: number };
export type DifferenceResult = { values: Float32Array; clipped: Uint8Array; width: number; height: number };

export const CLIP_LOW = 1, CLIP_HIGH = 2;

export function displayStretch(display: { stretch?: unknown; stretch_parameter?: unknown; low_MJy_sr: number; high_MJy_sr: number; missing_data_style?: unknown }): Stretch | null {
  const parameter = Number(display.stretch_parameter);
  if (display.stretch !== "asinh" || !Number.isFinite(parameter) || parameter <= 0 || !Number.isFinite(display.low_MJy_sr) || !Number.isFinite(display.high_MJy_sr) || !(display.high_MJy_sr > display.low_MJy_sr)) return null;
  return { low: display.low_MJy_sr, high: display.high_MJy_sr, parameter, checkerboard: typeof display.missing_data_style === "string" && display.missing_data_style.startsWith("8-pixel checkerboard") };
}

/** Forward display stretch, identical to the Python kernel (used for tests and round-trip checks). */
export function valueToGray(value: number, s: Stretch): number {
  const scaled = Math.min(1, Math.max(0, (value - s.low) / (s.high - s.low)));
  return Math.floor(Math.asinh(scaled * s.parameter) / Math.asinh(s.parameter) * 255);
}

/** Centre of the value interval that maps to `gray`; clipped grays return the display limit they bound. */
export function grayToValue(gray: number, s: Stretch): number {
  if (gray <= 0) return s.low;
  if (gray >= 255) return s.high;
  const scaled = Math.sinh((gray + 0.5) / 255 * Math.asinh(s.parameter)) / s.parameter;
  return s.low + scaled * (s.high - s.low);
}

/** Gray value of the missing-data checkerboard at PNG column x and row r (rows are flipped to north up). */
export function checkerGray(x: number, row: number, height: number) {
  const y = height - 1 - row;
  return ((x >> 3) + (y >> 3)) % 2 ? 32 : 56;
}

/**
 * RGBA pixels of a display PNG and, optionally, its quality-mask PNG (alpha > 0 marks masked pixels).
 * Missing data are NaN: masked pixels that carry exactly the checkerboard gray of their position.
 */
export function decodeDisplay(image: Uint8ClampedArray, mask: Uint8ClampedArray | null, width: number, height: number, s: Stretch): DecodedFrame {
  if (image.length !== width * height * 4 || (mask && mask.length !== image.length)) throw Error("Розміри PNG кадру і маски не узгоджені.");
  const lookup = new Float32Array(256);
  for (let g = 0; g < 256; g++) lookup[g] = grayToValue(g, s);
  const values = new Float32Array(width * height), clipped = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) for (let x = 0; x < width; x++) {
    const i = row * width + x, gray = image[i * 4];
    if (s.checkerboard && mask && mask[i * 4 + 3] > 0 && gray === checkerGray(x, row, height)) { values[i] = NaN; continue; }
    values[i] = lookup[gray];
    clipped[i] = gray === 0 ? CLIP_LOW : gray === 255 ? CLIP_HIGH : 0;
  }
  return { values, clipped, width, height };
}

export function subtractFrames(current: DecodedFrame, reference: DecodedFrame): DifferenceResult {
  if (current.width !== reference.width || current.height !== reference.height) throw Error("Кадри для різниці мають різні розміри.");
  const values = new Float32Array(current.values.length), clipped = new Uint8Array(current.values.length);
  for (let i = 0; i < values.length; i++) {
    values[i] = current.values[i] - reference.values[i];
    clipped[i] = current.clipped[i] | reference.clipped[i];
  }
  return { values, clipped, width: current.width, height: current.height };
}

/** Per-pixel median of finite values; NaN where fewer than two frames have data. Clipped if the median sample was. */
export function medianFrame(frames: DecodedFrame[]): DecodedFrame {
  if (frames.length < 2) throw Error("Для медіани серії потрібно щонайменше два кадри.");
  const { width, height } = frames[0];
  if (frames.some(f => f.width !== width || f.height !== height)) throw Error("Кадри для медіани мають різні розміри.");
  const values = new Float32Array(width * height), clipped = new Uint8Array(width * height);
  const order = new Array<number>(frames.length);
  for (let i = 0; i < values.length; i++) {
    let n = 0;
    for (let k = 0; k < frames.length; k++) if (Number.isFinite(frames[k].values[i])) order[n++] = k;
    if (n < 2) { values[i] = NaN; continue; }
    const ranked = order.slice(0, n).sort((a, b) => frames[a].values[i] - frames[b].values[i]);
    const mid = n >> 1;
    if (n % 2) { values[i] = frames[ranked[mid]].values[i]; clipped[i] = frames[ranked[mid]].clipped[i]; }
    else { values[i] = (frames[ranked[mid - 1]].values[i] + frames[ranked[mid]].values[i]) / 2; clipped[i] = frames[ranked[mid - 1]].clipped[i] | frames[ranked[mid]].clipped[i]; }
  }
  return { values, clipped, width, height };
}

/** σ = 1.4826·MAD of finite, unclipped difference values; null when undefined or zero. */
export function robustSigma(result: DifferenceResult): { sigma: number; median: number; used: number } | null {
  const sample: number[] = [];
  for (let i = 0; i < result.values.length; i++) if (Number.isFinite(result.values[i]) && !result.clipped[i]) sample.push(result.values[i]);
  if (sample.length < 16) return null;
  const median = quantileSorted(sample.sort((a, b) => a - b));
  const deviations = sample.map(v => Math.abs(v - median)).sort((a, b) => a - b);
  const sigma = 1.4826 * quantileSorted(deviations);
  return Number.isFinite(sigma) && sigma > 0 ? { sigma, median, used: sample.length } : null;
}
function quantileSorted(sorted: number[]) {
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const NEUTRAL = [20, 24, 29], NEGATIVE = [78, 168, 255], POSITIVE = [255, 162, 76];
/** Symmetric diverging colour for d/(k·σ) in [−1, 1]: blue (fainter now), dark (no change), orange (brighter now). */
export function divergingColor(t: number): [number, number, number] {
  const a = Math.min(1, Math.abs(t)), end = t < 0 ? NEGATIVE : POSITIVE;
  return [0, 1, 2].map(c => Math.round(NEUTRAL[c] + (end[c] - NEUTRAL[c]) * a)) as [number, number, number];
}

/**
 * RGBA rendering with a ±k·σ symmetric scale around `offset` (the median difference, so a uniform
 * level change does not swamp local changes); missing data keep the pipeline's checkerboard.
 */
export function renderDifference(result: DifferenceResult, sigma: number, k: number, offset = 0): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(result.values.length * 4), limit = k * sigma;
  for (let row = 0; row < result.height; row++) for (let x = 0; x < result.width; x++) {
    const i = row * result.width + x, v = result.values[i];
    const [r, g, b] = Number.isFinite(v) ? divergingColor((v - offset) / limit) : (() => { const c = checkerGray(x, row, result.height); return [c, c, c]; })();
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 255;
  }
  return out;
}

export function differenceSummary(result: DifferenceResult) {
  let finite = 0, clipped = 0;
  for (let i = 0; i < result.values.length; i++) if (Number.isFinite(result.values[i])) { finite++; if (result.clipped[i]) clipped++; }
  return { finite, clipped_fraction: finite ? clipped / finite : 0 };
}
