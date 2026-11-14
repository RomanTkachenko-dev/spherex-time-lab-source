import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSkyCoordinates, parseSkyFootprint, skyObservationDate } from "../lib/sky-atlas.ts";
import { parseVOTable } from "../lib/votable.ts";
import { frameTimeFraction, nearestFrameIndexAtFraction } from "../lib/science.ts";

test("sky input distinguishes decimal ICRS pairs from names and rejects invalid ranges", () => {
  assert.deepEqual(parseSkyCoordinates("210.80227, +54.34895"), [210.80227, 54.34895]);
  assert.deepEqual(parseSkyCoordinates("0 -90"), [0, -90]);
  for (const text of ["M101", "NGC 6822", "360 0", "-1 0", "12 91", "", "12,", "Infinity 0", "12:30 45:00"]) assert.equal(parseSkyCoordinates(text), null);
});
test("IRSA footprint uses actual ICRS vertices, including wrap across RA zero", () => {
  const rows = parseVOTable(readFileSync(new URL("./fixtures/irsa-sia.vot", import.meta.url), "utf8")).rows;
  assert.ok(rows.length);
  for (const row of rows) assert.ok(parseSkyFootprint(row.s_region)?.length);
  assert.deepEqual(parseSkyFootprint("POLYGON ICRS 359 -1 360 1 1 -1"), [[359, -1], [0, 1], [1, -1]]);
  for (const value of [undefined, "POLYGON GALACTIC 1 2 3 4 5 6", "POLYGON ICRS 1 2 3", "POLYGON ICRS 1 2 3 4 5 91", "POLYGON ICRS NaN 2 3 4 5 6"]) assert.equal(parseSkyFootprint(value), null);
});
test("sphere UTC navigation preserves real temporal spacing and exposes each duplicate epoch by index", () => {
  const frames = [{ mjd: 61023 }, { mjd: 61023 }, { mjd: 61024 }, { mjd: 61033 }];
  assert.equal(skyObservationDate(frames[0]), "2025-12-14T00:00:00.000Z");
  assert.equal(frameTimeFraction(frames, 2), 0.1);
  assert.equal(nearestFrameIndexAtFraction(frames, 0.1), 2);
  assert.equal(nearestFrameIndexAtFraction(frames, 0), 0);
});
