import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { grayToValue, differenceImage, manifestScale, decodeFrame, medianFrame, subtractFrames, robustSigma, renderDiverging, renderGrey, greyLimit, divergingColor, VALID, MASKED, CLIPPED } from "../lib/difference.ts";

const scale = { low: 0.5, high: 24, stretch: 18 };
// Forward transform used by research/build_dataset.py and field_pipeline.display_gray.
const toGray = (v: number) => Math.floor(Math.asinh(Math.min(1, Math.max(0, (v - scale.low) / (scale.high - scale.low))) * 18) / Math.asinh(18) * 255);
const rgba = (grays: number[]) => { const a = new Uint8ClampedArray(grays.length * 4); grays.forEach((g, i) => { a.set([g, g, g, 255], i * 4); }); return a; };

test("inverse stretch recovers the display limits and is monotonic", () => {
  assert.equal(grayToValue(0, scale), scale.low);
  assert.ok(Math.abs(grayToValue(255, scale) - scale.high) < 1e-9);
  for (let g = 1; g < 256; g++) assert.ok(grayToValue(g, scale) > grayToValue(g - 1, scale));
  for (const v of [1, 3, 10, 20]) assert.ok(Math.abs(grayToValue(toGray(v), scale) - v) / v < 0.03);
});

test("difference is signed, symmetric and excludes masked and saturated pixels", () => {
  const current = rgba([toGray(5), toGray(2), 255, toGray(3), toGray(4)]);
  const reference = rgba([toGray(5), toGray(4), toGray(3), toGray(3), toGray(2)]);
  const mask = new Uint8ClampedArray(20); mask[3 * 4 + 3] = 160;
  const result = differenceImage(current, reference, null, mask, scale, 1);
  assert.deepEqual([result.validCount, result.maskedCount, result.clippedCount], [3, 1, 1]);
  const grey = (i: number) => result.rgba[i * 4], alpha = (i: number) => result.rgba[i * 4 + 3];
  assert.equal(grey(0), 128);           // unchanged
  assert.equal(grey(1), 0);             // brighter in the reference
  assert.equal(grey(4), 255);           // brighter now
  assert.equal(alpha(2), 0); assert.equal(alpha(3), 0); // excluded
  assert.ok(Math.abs(result.limit - 2) < 0.15);
});

test("frames of different sizes are rejected", () => {
  assert.throws(() => differenceImage(rgba([1, 2]), rgba([1]), null, null, scale));
});

test("bundled demo series expose an invertible display scale", () => {
  for (const path of ["../public/data/atlas/manifest.json", "../public/data/epochs/manifest.json"]) {
    const manifest = JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
    const s = manifestScale(manifest.display);
    assert.ok(s && s.stretch === 18 && s.high > s.low);
  }
  assert.equal(manifestScale({ low_MJy_sr: 1, high_MJy_sr: 2, stretch: "linear" }), null);
});

test("display clipping at either endpoint is excluded", () => {
  const result = differenceImage(rgba([0, 42, 100]), rgba([42, 255, 100]), null, null, scale);
  assert.equal(result.clippedCount, 2);
  assert.deepEqual([result.rgba[3], result.rgba[7], result.rgba[11]], [0, 0, 255]);
});

test("decoded frames keep the same exclusion policy as the two-frame difference", () => {
  const mask = new Uint8ClampedArray(12); mask[1 * 4 + 3] = 160;
  const decoded = decodeFrame(rgba([toGray(5), toGray(5), 0]), mask, scale);
  assert.deepEqual([...decoded.state], [VALID, MASKED, CLIPPED]);
  assert.ok(Math.abs(decoded.values[0] - 5) / 5 < 0.03); assert.ok(Number.isNaN(decoded.values[1]));
  const direct = differenceImage(rgba([toGray(5), toGray(2), 255, toGray(3)]), rgba([toGray(4), toGray(4), toGray(3), toGray(3)]), null, null, scale, 1);
  const composed = subtractFrames(decodeFrame(rgba([toGray(5), toGray(2), 255, toGray(3)]), null, scale), decodeFrame(rgba([toGray(4), toGray(4), toGray(3), toGray(3)]), null, scale));
  assert.deepEqual([...direct.rgba], [...renderGrey(composed, greyLimit(composed, 1))]);
});

test("series median removes a moving source and needs two valid frames per pixel", () => {
  const frames = [[toGray(2), toGray(9), 0], [toGray(2), 0, 0], [toGray(20), toGray(9), toGray(4)], [toGray(2), toGray(9), 0]].map(grays => decodeFrame(rgba(grays), null, scale));
  const median = medianFrame(frames);
  assert.ok(Math.abs(median.values[0] - 2) / 2 < 0.05, "the transient 20 MJy/sr source drops out");
  assert.equal(median.state[1], VALID); assert.equal(median.state[2], MASKED, "one valid frame is not a median");
  assert.throws(() => medianFrame([frames[0]]));
  const moving = subtractFrames(frames[2], median);
  assert.ok(moving.values[0] > 15); assert.equal(moving.state[2], MASKED);
});

test("colour scale uses a MAD sigma centred on the median offset", () => {
  const n = 4000;
  const noise = Array.from({ length: n }, (_, i) => Math.sqrt(-2 * Math.log((i + 0.5) / n)) * Math.cos(2 * Math.PI * ((i * 0.618034) % 1)) * 0.3);
  const difference = { values: Float64Array.from([...noise.map(v => v + 1), 50, 60]), state: new Uint8Array(n + 2), validCount: n + 2, maskedCount: 0, clippedCount: 0 };
  const robust = robustSigma(difference)!;
  assert.ok(Math.abs(robust.sigma - 0.3) < 0.03 && Math.abs(robust.median - 1) < 0.02, JSON.stringify(robust));
  const small = { values: Float64Array.from([2, 2, 2]), state: new Uint8Array(3), validCount: 3, maskedCount: 0, clippedCount: 0 };
  assert.equal(robustSigma(small), null);
  assert.deepEqual(divergingColor(0), [20, 24, 29]); assert.deepEqual(divergingColor(-3), [78, 168, 255]); assert.deepEqual(divergingColor(1), [255, 162, 76]);
  const shown = renderDiverging({ values: Float64Array.from([5, 7, 3, NaN]), state: Uint8Array.from([VALID, VALID, VALID, MASKED]), validCount: 3, maskedCount: 1, clippedCount: 0 }, 1, 2, 5);
  assert.deepEqual([...shown.slice(0, 12)], [20, 24, 29, 255, 255, 162, 76, 255, 78, 168, 255, 255]);
  assert.equal(shown[15], 0, "excluded pixels stay transparent over the checker background");
});
