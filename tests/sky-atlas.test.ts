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
test("shareable atlas links round-trip through the URL reader and escape the embed code", async () => {
  const { buildAtlasLink, embedCode, readAtlasLink } = await import("../lib/sky-atlas.ts");
  const state = { ra: 133.8189083, dec: -7.2450104, fov: 0.123456, start: "2025-05-01", end: "2026-04-30", detector: 6, release: "dr1", survey: "wide", language: "en", search: true, series: true } as const;
  const link = buildAtlasLink("https://example.org/spherex-time-lab-source/?old=1#x", state);
  const url = new URL(link);
  assert.equal(url.pathname, "/spherex-time-lab-source/"); assert.equal(url.hash, ""); assert.equal(url.searchParams.get("old"), null);
  const read = readAtlasLink(url.searchParams);
  assert.deepEqual(read.coordinates, [133.818908, -7.24501]);
  assert.deepEqual([read.start, read.end, read.detector, read.release, read.survey, read.fov, read.search, read.series, read.embed], ["2025-05-01", "2026-04-30", 6, "dr1", "wide", 0.1235, true, true, false]);
  assert.equal(new URL(buildAtlasLink(link, { ...state, ra: 359.99999999, search: false, series: false, embed: true })).searchParams.get("ra"), "0");
  assert.equal(readAtlasLink(new URL(buildAtlasLink(link, { ...state, series: false })).searchParams).series, false);
  const code = embedCode(link);
  assert.match(code, /^<iframe title="SPHEREx Time Lab" src="https:\/\/example\.org\/[^"]+&amp;dec=-7\.24501&amp;/);
  assert.ok(!code.includes("&dec") && !/src="[^"]*"[^ ]/.test(code));
  assert.equal(readAtlasLink(new URLSearchParams("ra=10&dec=5&series=1")).series, false, "series needs both dates");
});
