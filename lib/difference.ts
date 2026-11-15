/**
 * Difference images between display frames of one series.
 *
 * Every frame of a series is rendered with the same asinh stretch and the same
 * low/high limits (manifest.display), so the 8-bit grey level can be mapped back
 * to surface brightness. The difference is then taken in MJy/sr, not in grey levels.
 *
 * Limits of this method (also shown in the interface):
 * - 8-bit quantisation: one grey step is a larger brightness step near `high`;
 * - grey levels 0 and 255 are excluded because the underlying value may be clipped;
 * - pixels marked in either quality mask (bad FLAGS or missing data) are excluded;
 * - no PSF or spectral-response matching: SPHEREx frames taken on different dates
 *   usually sample different wavelengths, so stars of different colours leave residuals.
 *
 * The reference can be one frame or the per-pixel median of several (a moving source
 * drops out of the median). Two renderings share the same pixels: grey with a range set
 * by a quantile of |Δ|, or a diverging colour scale of ±k·σ (σ from the MAD).
 */

export type DisplayScale = { low: number; high: number; stretch: number };

export type DifferenceResult = {
  /** RGBA pixels: mid grey = no change, white = brighter now, black = brighter in the reference. */
  rgba: Uint8ClampedArray;
  /** Brightness difference (MJy/sr) mapped to pure white / pure black. */
  limit: number;
  validCount: number;
  maskedCount: number;
  clippedCount: number;
};

/** Pixel states: excluded pixels carry NaN values and stay transparent when rendered. */
export const VALID = 0, MASKED = 1, CLIPPED = 2;
export type DecodedFrame = { values: Float64Array; state: Uint8Array };
export type Difference = DecodedFrame & { validCount: number; maskedCount: number; clippedCount: number };

/** Inverse of display_gray(): grey level 0..255 -> surface brightness in MJy/sr. */
export function grayToValue(gray: number, scale: DisplayScale): number {
  const k = scale.stretch;
  const scaled = Math.sinh((gray / 255) * Math.asinh(k)) / k;
  return scale.low + scaled * (scale.high - scale.low);
}

/** Lookup table for all 256 grey levels. */
export function grayLookup(scale: DisplayScale): Float64Array {
  if (!(scale.high > scale.low) || !(scale.stretch > 0)) throw Error("Invalid display scale");
  const table = new Float64Array(256);
  for (let g = 0; g < 256; g++) table[g] = grayToValue(g, scale);
  return table;
}

/** Robust |d| quantile (nearest rank) used for the symmetric display range. */
export function absoluteQuantile(values: Float64Array, count: number, q: number): number {
  if (count === 0) return 0;
  const sorted = Float64Array.from(values.subarray(0, count), Math.abs).sort();
  return sorted[Math.min(count - 1, Math.max(0, Math.ceil(q * count) - 1))];
}

/** Grey RGBA frame + its quality mask (alpha > 0 = flagged or missing; null when absent) -> MJy/sr. */
export function decodeFrame(rgba: Uint8ClampedArray, mask: Uint8ClampedArray | null, scale: DisplayScale): DecodedFrame {
  if (rgba.length % 4 !== 0) throw Error("Frames differ in size");
  if (mask && mask.length !== rgba.length) throw Error("Mask differs in size");
  const lookup = grayLookup(scale), pixels = rgba.length / 4;
  const values = new Float64Array(pixels).fill(NaN), state = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i++) {
    const p = i * 4, g = rgba[p];
    if (mask && mask[p + 3] > 0) state[i] = MASKED;
    else if (g === 0 || g === 255) state[i] = CLIPPED;
    else values[i] = lookup[g];
  }
  return { values, state };
}

/** Per-pixel median over frames; a pixel needs at least two valid frames, otherwise it is excluded. */
export function medianFrame(frames: DecodedFrame[]): DecodedFrame {
  if (frames.length < 2) throw Error("The series median needs at least two frames.");
  const pixels = frames[0].values.length;
  if (frames.some(f => f.values.length !== pixels)) throw Error("Frames differ in size");
  const values = new Float64Array(pixels).fill(NaN), state = new Uint8Array(pixels), sample = new Float64Array(frames.length);
  for (let i = 0; i < pixels; i++) {
    let n = 0, masked = false;
    for (const frame of frames) {
      if (frame.state[i] === VALID) sample[n++] = frame.values[i];
      else if (frame.state[i] === MASKED) masked = true;
    }
    if (n < 2) { state[i] = masked || n === 1 ? MASKED : CLIPPED; continue; }
    const sorted = sample.subarray(0, n).sort(), mid = n >> 1;
    values[i] = n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return { values, state };
}

/** current − reference; a pixel masked in either is masked, otherwise clipped in either is clipped. */
export function subtractFrames(current: DecodedFrame, reference: DecodedFrame): Difference {
  if (current.values.length !== reference.values.length) throw Error("Frames differ in size");
  const pixels = current.values.length;
  const values = new Float64Array(pixels).fill(NaN), state = new Uint8Array(pixels);
  let validCount = 0, maskedCount = 0, clippedCount = 0;
  for (let i = 0; i < pixels; i++) {
    const a = current.state[i], b = reference.state[i];
    if (a === MASKED || b === MASKED) { state[i] = MASKED; maskedCount++; }
    else if (a === CLIPPED || b === CLIPPED) { state[i] = CLIPPED; clippedCount++; }
    else { values[i] = current.values[i] - reference.values[i]; validCount++; }
  }
  return { values, state, validCount, maskedCount, clippedCount };
}

function validValues(difference: Difference) {
  const out = new Float64Array(difference.validCount);
  let n = 0;
  for (let i = 0; i < difference.values.length; i++) if (difference.state[i] === VALID) out[n++] = difference.values[i];
  return out;
}

/** Symmetric grey range: the `quantile` of |Δ| over valid pixels. */
export function greyLimit(difference: Difference, quantile = 0.995) {
  return absoluteQuantile(validValues(difference), difference.validCount, quantile) || Number.EPSILON;
}

/** Grey rendering: 128 = no change, white = brighter now, black = brighter in the reference; excluded pixels transparent. */
export function renderGrey(difference: Difference, limit: number): Uint8ClampedArray<ArrayBuffer> {
  const rgba = new Uint8ClampedArray(difference.values.length * 4);
  for (let i = 0; i < difference.values.length; i++) {
    if (difference.state[i] !== VALID) continue;
    const g = Math.round(127.5 + 127.5 * Math.max(-1, Math.min(1, difference.values[i] / limit)));
    const p = i * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = g; rgba[p + 3] = 255;
  }
  return rgba;
}

/** σ = 1.4826·MAD of valid differences and their median (the common level offset); null when undefined or zero. */
export function robustSigma(difference: Difference): { sigma: number; median: number } | null {
  if (difference.validCount < 16) return null;
  const sorted = validValues(difference).sort();
  const median = middle(sorted);
  const sigma = 1.4826 * middle(sorted.map(v => Math.abs(v - median)).sort());
  return Number.isFinite(sigma) && sigma > 0 ? { sigma, median } : null;
}
function middle(sorted: Float64Array) {
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const NEUTRAL = [20, 24, 29], NEGATIVE = [78, 168, 255], POSITIVE = [255, 162, 76];
/** Symmetric diverging colour for d/(k·σ) in [−1, 1]: blue (fainter now), dark (no change), orange (brighter now). */
export function divergingColor(t: number): [number, number, number] {
  const a = Math.min(1, Math.abs(t)), end = t < 0 ? NEGATIVE : POSITIVE;
  return [0, 1, 2].map(c => Math.round(NEUTRAL[c] + (end[c] - NEUTRAL[c]) * a)) as [number, number, number];
}

/** Colour rendering, ±k·σ around `offset` (the median difference) so a uniform level change does not swamp local ones. */
export function renderDiverging(difference: Difference, sigma: number, k: number, offset = 0): Uint8ClampedArray<ArrayBuffer> {
  const rgba = new Uint8ClampedArray(difference.values.length * 4), limit = k * sigma;
  for (let i = 0; i < difference.values.length; i++) {
    if (difference.state[i] !== VALID) continue;
    const [r, g, b] = divergingColor((difference.values[i] - offset) / limit);
    const p = i * 4; rgba[p] = r; rgba[p + 1] = g; rgba[p + 2] = b; rgba[p + 3] = 255;
  }
  return rgba;
}

/**
 * current − reference for two RGBA greyscale images of identical size.
 * Masks are the RGBA quality overlays (alpha > 0 = flagged or missing); pass null when absent.
 */
export function differenceImage(
  current: Uint8ClampedArray, reference: Uint8ClampedArray,
  currentMask: Uint8ClampedArray | null, referenceMask: Uint8ClampedArray | null,
  scale: DisplayScale, quantile = 0.995,
): DifferenceResult {
  if (current.length !== reference.length || current.length % 4 !== 0) throw Error("Frames differ in size");
  for (const mask of [currentMask, referenceMask]) if (mask && mask.length !== current.length) throw Error("Mask differs in size");
  const difference = subtractFrames(decodeFrame(current, currentMask, scale), decodeFrame(reference, referenceMask, scale));
  const limit = greyLimit(difference, quantile);
  return { rgba: renderGrey(difference, limit), limit, validCount: difference.validCount, maskedCount: difference.maskedCount, clippedCount: difference.clippedCount };
}

/** Display scale of a manifest, or null when the stretch cannot be inverted safely. */
export function manifestScale(display: { low_MJy_sr: number; high_MJy_sr: number; [key: string]: unknown }): DisplayScale | null {
  const stretch = display.stretch === "asinh" ? Number(display.stretch_parameter) : NaN;
  const low = display.low_MJy_sr, high = display.high_MJy_sr;
  return Number.isFinite(low) && Number.isFinite(high) && high > low && Number.isFinite(stretch) && stretch > 0 ? { low, high, stretch } : null;
}
