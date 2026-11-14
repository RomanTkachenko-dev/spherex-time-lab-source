import test from "node:test";
import assert from "node:assert/strict";
import { CLIP_HIGH, CLIP_LOW, checkerGray, decodeDisplay, differenceSummary, displayStretch, divergingColor, grayToValue, medianFrame, renderDifference, robustSigma, sampleIndices, subtractFrames, valueToGray, type DecodedFrame, type Stretch } from "../lib/difference.ts";

const stretch: Stretch = { low: 0.2, high: 24, parameter: 18, checkerboard: true };
const W = 16, H = 16;
function png(gray: (x: number, row: number) => number) {
  const out = new Uint8ClampedArray(W * H * 4);
  for (let row = 0; row < H; row++) for (let x = 0; x < W; x++) { const i = (row * W + x) * 4, g = gray(x, row); out.set([g, g, g, 255], i); }
  return out;
}
function maskPng(masked: (x: number, row: number) => boolean) {
  const out = new Uint8ClampedArray(W * H * 4);
  for (let row = 0; row < H; row++) for (let x = 0; x < W; x++) if (masked(x, row)) out.set([255, 153, 88, 160], (row * W + x) * 4);
  return out;
}
const frame = (values: number[], clipped = new Uint8Array(values.length)): DecodedFrame => ({ values: Float32Array.from(values), clipped, width: values.length, height: 1 });

test("display stretch is read only from asinh series metadata", () => {
  assert.deepEqual(displayStretch({ stretch: "asinh", stretch_parameter: 18, low_MJy_sr: 0.2, high_MJy_sr: 24, missing_data_style: "8-pixel checkerboard, grayscale 32/56; not measured signal" }), stretch);
  assert.equal(displayStretch({ stretch: "asinh", stretch_parameter: 18, low_MJy_sr: 0.2, high_MJy_sr: 24 })?.checkerboard, false);
  assert.equal(displayStretch({ stretch: "linear", stretch_parameter: 18, low_MJy_sr: 0, high_MJy_sr: 1 }), null);
  assert.equal(displayStretch({ stretch: "asinh", stretch_parameter: 18, low_MJy_sr: 1, high_MJy_sr: 1 }), null);
});

test("inverse stretch recovers MJy/sr within one gray step and marks the display limits", () => {
  for (let v = 0.25; v < 24; v *= 1.07) {
    const g = valueToGray(v, stretch), recovered = grayToValue(g, stretch);
    const step = grayToValue(Math.min(254, g + 1), stretch) - grayToValue(Math.max(1, g), stretch);
    assert.ok(g > 0 && g < 255 ? Math.abs(recovered - v) <= step : true, `${v} -> ${g} -> ${recovered}`);
    if (g > 0 && g < 255) assert.equal(valueToGray(recovered, stretch), g, "midpoint maps back to the same gray");
  }
  assert.equal(valueToGray(-5, stretch), 0); assert.equal(grayToValue(0, stretch), stretch.low);
  assert.equal(valueToGray(99, stretch), 255); assert.equal(grayToValue(255, stretch), stretch.high);
});

test("missing-data checkerboard is decoded as NaN only where the quality mask is set", () => {
  // Python draws the checkerboard before flipud: PNG row 0 is array row H-1.
  assert.equal(checkerGray(0, H - 1, H), 56); assert.equal(checkerGray(8, H - 1, H), 32); assert.equal(checkerGray(0, 0, H), 32);
  const image = png((x, row) => x < 8 ? checkerGray(x, row, H) : 100);
  const decoded = decodeDisplay(image, maskPng((x, row) => x < 4 || (x >= 8 && row < 2)), W, H, stretch);
  assert.ok(Number.isNaN(decoded.values[0]), "masked checkerboard pixel is missing data");
  assert.ok(Number.isFinite(decoded.values[5]), "unmasked pixel with checkerboard gray is real signal");
  assert.ok(Number.isFinite(decoded.values[8]), "masked (flagged) pixel with signal keeps its value");
  assert.ok(decodeDisplay(image, null, W, H, stretch).values.every(Number.isFinite), "no mask: nothing is guessed missing");
  assert.ok(decodeDisplay(image, maskPng(() => true), W, H, { ...stretch, checkerboard: false }).values.every(Number.isFinite), "legacy series have no checkerboard");
  const limits = decodeDisplay(png(x => x === 0 ? 0 : x === 1 ? 255 : 120), null, W, H, stretch);
  assert.deepEqual([limits.clipped[0], limits.clipped[1], limits.clipped[2]], [CLIP_LOW, CLIP_HIGH, 0]);
  assert.throws(() => decodeDisplay(image, new Uint8ClampedArray(4), W, H, stretch));
});

test("differences, series median and robust sigma follow the definitions", () => {
  const diff = subtractFrames(frame([5, 2, NaN, 1], Uint8Array.from([0, CLIP_LOW, 0, 0])), frame([1, 1, 1, NaN]));
  assert.deepEqual([...diff.values].map(v => Number.isNaN(v) ? "nan" : v), [4, 1, "nan", "nan"]);
  assert.deepEqual([...diff.clipped], [0, CLIP_LOW, 0, 0]);
  const median = medianFrame([frame([1, 9, NaN]), frame([3, NaN, NaN]), frame([100, 7, 4]), frame([2, 8, NaN])]);
  assert.deepEqual([...median.values].map(v => Number.isNaN(v) ? "nan" : v), [2.5, 8, "nan"], "moving source (100) does not enter the median");
  assert.throws(() => medianFrame([frame([1])]));
  assert.deepEqual(sampleIndices(5, 31), [0, 1, 2, 3, 4]);
  const sampled = sampleIndices(1000, 31);
  assert.equal(sampled.length, 31); assert.equal(sampled[0], 0); assert.equal(sampled.at(-1), 999);
  // Gaussian-like noise with a few strong outliers: MAD sigma stays near the core width.
  const noise = Array.from({ length: 4000 }, (_, i) => Math.sqrt(-2 * Math.log((i + 0.5) / 4000)) * Math.cos(2 * Math.PI * ((i * 0.618034) % 1)) * 0.3);
  const sigma = robustSigma({ ...frame([...noise, 50, 60, -70]), height: 1 })!;
  assert.ok(Math.abs(sigma.sigma - 0.3) < 0.03, String(sigma.sigma));
  assert.equal(robustSigma(frame([1, 1, 1])), null);
  assert.equal(robustSigma(frame(Array(32).fill(2))), null, "zero MAD is not a usable scale");
});

test("diverging rendering is symmetric around zero and keeps missing data visible", () => {
  assert.deepEqual(divergingColor(0), [20, 24, 29]);
  assert.deepEqual(divergingColor(-3), [78, 168, 255]); assert.deepEqual(divergingColor(1), [255, 162, 76]);
  const half = divergingColor(0.5), negHalf = divergingColor(-0.5);
  assert.ok(half[0] > negHalf[0] && negHalf[2] > half[2]);
  const result = { values: Float32Array.from([0, 2, -2, NaN]), clipped: Uint8Array.from([0, 0, CLIP_HIGH, 0]), width: 4, height: 1 };
  const rgba = renderDifference(result, 1, 2);
  assert.deepEqual([...rgba.slice(4, 7)], [255, 162, 76]); assert.deepEqual([...rgba.slice(8, 11)], [78, 168, 255]);
  assert.equal(rgba[12], rgba[13]); assert.ok([32, 56].includes(rgba[12]));
  assert.deepEqual(differenceSummary(result), { finite: 3, clipped_fraction: 1 / 3 });
  const shifted = renderDifference({ ...result, values: Float32Array.from([5, 7, 3, NaN]) }, 1, 2, 5);
  assert.deepEqual([...shifted.slice(0, 12)], [...rgba.slice(0, 12)], "a uniform offset is centred out");
});
