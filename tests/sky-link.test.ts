import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {skyToPixel, pixelToSky, inPanel, separationArcmin} from '../lib/sky-link.ts';
import {projectGaia} from '../lib/gaia.ts';

type Demo = {display: {sky_center_ra: number; sky_center_dec: number; sky_fov_deg: number}; frames: {ra: number; dec: number; mjd: number; marker_sky: {x: number; y: number}; marker_sky_visible?: boolean}[]};
const load = (name: string) => JSON.parse(fs.readFileSync(`public/data/${name}/manifest.json`, 'utf8')) as Demo;

test('projection matches the marker positions the pipeline wrote into both demo manifests', () => {
  for (const name of ['atlas', 'epochs']) {
    const m = load(name);
    const grid = {centerRa: m.display.sky_center_ra, centerDec: m.display.sky_center_dec, fovDeg: m.display.sky_fov_deg};
    for (const f of m.frames) {
      if (f.marker_sky_visible === false) continue;
      const p = skyToPixel(f.ra, f.dec, grid)!;
      assert.ok(Math.abs(p.x - f.marker_sky.x) < 0.05 && Math.abs(p.y - f.marker_sky.y) < 0.05, `${name}: ${p.x},${p.y} vs ${f.marker_sky.x},${f.marker_sky.y}`);
    }
  }
});

test('projection agrees with the Gaia overlay for a source without proper motion', () => {
  const grid = {centerRa: 210.8, centerDec: 54.35, fovDeg: 0.1};
  const source = {source_id: '1', ra: 210.81, dec: 54.36, ref_epoch: 2016, pmra: null, pmdec: null, phot_g_mean_mag: 10} as never;
  const gaia = projectGaia(source, grid.centerRa, grid.centerDec, grid.fovDeg, 60000)!;
  const p = skyToPixel(210.81, 54.36, grid)!;
  assert.ok(Math.abs(gaia.x - p.x) < 1e-9 && Math.abs(gaia.y - p.y) < 1e-9);
});

test('pixel → sky → pixel round trip, including across RA = 0 and near the pole', () => {
  for (const grid of [{centerRa: 167.2, centerDec: 5.15, fovDeg: 0.12}, {centerRa: 0.01, centerDec: -30, fovDeg: 0.3}, {centerRa: 90, centerDec: 89.9, fovDeg: 0.3}]) {
    for (const [x, y] of [[0, 0], [127.5, 127.5], [255, 3], [40.25, 200.75]]) {
      const s = pixelToSky(x, y, grid);
      const p = skyToPixel(s.ra, s.dec, grid)!;
      assert.ok(Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6, `${JSON.stringify(grid)} ${x},${y}`);
      assert.ok(s.ra >= 0 && s.ra < 360);
    }
  }
});

test('north is up and east is left', () => {
  const grid = {centerRa: 100, centerDec: 20, fovDeg: 0.2};
  assert.ok(skyToPixel(100, 20.05, grid)!.y < 127.5, 'north up');
  assert.ok(skyToPixel(100.05, 20, grid)!.x < 127.5, 'east left');
  assert.equal(inPanel(skyToPixel(101, 20, grid)), false);
  assert.ok(Math.abs(separationArcmin(0, 0, 0, 1) - 60) < 1e-9);
});
