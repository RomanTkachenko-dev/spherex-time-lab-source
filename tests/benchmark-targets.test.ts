import test from "node:test";
import assert from "node:assert/strict";
import { BENCHMARK_TARGETS, positionAt, benchmarkSearch, annualMotion } from "../lib/benchmark-targets.ts";
import { validateFieldQuery } from "../lib/field-query.ts";

const byId = (id: string) => BENCHMARK_TARGETS.find(t => t.id === id)!;
const sep = (a: {ra:number;dec:number}, b: {ra:number;dec:number}) =>
  Math.hypot((a.ra - b.ra) * Math.cos(a.dec * Math.PI / 180), a.dec - b.dec) * 3600;

test("all five challenge targets are present", () => {
  assert.deepEqual(BENCHMARK_TARGETS.map(t => t.id), ["barnard", "eps-indi-b", "wise-0855", "rw-aur", "r-dra"]);
});

test("Barnard's Star propagated to 2016.0 matches its Gaia DR3 position", () => {
  const p = positionAt(byId("barnard"), 2016.0);
  assert.ok(sep(p, { ra: 269.4485025, dec: 4.7394201 }) < 1, `offset ${sep(p, { ra: 269.4485025, dec: 4.7394201 })}″`);
});

test("challenge coordinates for WISE 0855 are converted exactly", () => {
  const w = byId("wise-0855");
  assert.ok(Math.abs(w.ra - 133.79513) < 1e-5 && Math.abs(w.dec + 7.245147) < 1e-5);
  assert.ok(Math.abs(annualMotion(w).arcsec - 8.15) < 0.01);
});

test("every preset is a valid archive query and stays inside the default 0.12° field", () => {
  for (const target of BENCHMARK_TARGETS) {
    const search = benchmarkSearch(target);
    validateFieldQuery({ ...search, fov: 0.12, max_frames: 12 });
    for (const date of [search.start, search.end]) {
      const year = 2000 + (Date.parse(date) - Date.UTC(2000, 0, 1, 12)) / (365.25 * 86400000);
      assert.ok(sep(positionAt(target, year), search) < 0.06 * 3600 / 2, `${target.id} leaves the field on ${date}`);
    }
  }
});
