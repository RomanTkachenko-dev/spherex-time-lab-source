/**
 * Difference images between two display frames of one series.
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
  const lookup = grayLookup(scale);
  const pixels = current.length / 4;
  const diff = new Float64Array(pixels), validIndex = new Int32Array(pixels);
  let valid = 0, masked = 0, clipped = 0;
  for (let i = 0; i < pixels; i++) {
    const p = i * 4;
    if ((currentMask && currentMask[p + 3] > 0) || (referenceMask && referenceMask[p + 3] > 0)) { masked++; continue; }
    const a = current[p], b = reference[p];
    if (a === 0 || b === 0 || a === 255 || b === 255) { clipped++; continue; }
    diff[valid] = lookup[a] - lookup[b];
    validIndex[valid++] = i;
  }
  const limit = absoluteQuantile(diff, valid, quantile) || Number.EPSILON;
  const rgba = new Uint8ClampedArray(current.length); // transparent where excluded
  for (let j = 0; j < valid; j++) {
    const p = validIndex[j] * 4;
    const g = Math.round(127.5 + 127.5 * Math.max(-1, Math.min(1, diff[j] / limit)));
    rgba[p] = rgba[p + 1] = rgba[p + 2] = g; rgba[p + 3] = 255;
  }
  return { rgba, limit, validCount: valid, maskedCount: masked, clippedCount: clipped };
}

/** Display scale of a manifest, or null when the stretch cannot be inverted safely. */
export function manifestScale(display: { low_MJy_sr: number; high_MJy_sr: number; [key: string]: unknown }): DisplayScale | null {
  const stretch = display.stretch === "asinh" ? Number(display.stretch_parameter) : NaN;
  const low = display.low_MJy_sr, high = display.high_MJy_sr;
  return Number.isFinite(low) && Number.isFinite(high) && high > low && Number.isFinite(stretch) && stretch > 0 ? { low, high, stretch } : null;
}
