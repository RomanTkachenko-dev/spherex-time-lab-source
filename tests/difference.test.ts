import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { grayToValue, differenceImage, manifestScale } from "../lib/difference.ts";

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
