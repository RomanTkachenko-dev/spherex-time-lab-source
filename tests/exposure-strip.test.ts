import test from 'node:test';
import assert from 'node:assert/strict';
import {stripLayout, visibleTiles, centredScroll, STRIP_TILE, STRIP_GAP, STRIP_PAUSE_GAP} from '../lib/exposure-strip.ts';

const minute = 1 / 1440;

test('layout places every exposure, with an extra gap after long pauses', () => {
  const mjds = [0, 2 * minute, 4 * minute, 100 * minute, 102 * minute];
  const layout = stripLayout(mjds);
  assert.equal(layout.offsets.length, 5);
  assert.deepEqual(layout.pauses, [false, false, false, true, false]);
  assert.equal(layout.offsets[1], STRIP_TILE + STRIP_GAP);
  assert.equal(layout.offsets[3] - layout.offsets[2], STRIP_TILE + STRIP_GAP + STRIP_PAUSE_GAP);
  assert.equal(layout.width, layout.offsets[4] + STRIP_TILE);
  assert.deepEqual(stripLayout([]), {offsets: [], pauses: [], width: 0});
});

test('a small series is fully rendered; a huge one renders only the visible window', () => {
  const small = stripLayout(Array.from({length: 12}, (_, i) => i * minute));
  assert.deepEqual(visibleTiles(small, 0, 2000), [0, 12]);
  const huge = stripLayout(Array.from({length: 15360}, (_, i) => i * minute));
  const [start, end] = visibleTiles(huge, centredScroll(huge, 9000, 700), 700);
  assert.ok(start <= 9000 && 9000 < end, 'selected tile is rendered');
  assert.ok(end - start < 30, `only a window is rendered (${end - start})`);
});

test('every index is reachable: scrolling to any tile renders it', () => {
  const layout = stripLayout(Array.from({length: 300}, (_, i) => i * (i % 7 ? minute : 30 * minute)));
  for (let i = 0; i < 300; i++) {
    const [start, end] = visibleTiles(layout, centredScroll(layout, i, 375), 375);
    assert.ok(start <= i && i < end, `tile ${i} rendered`);
  }
});

test('centred scroll is clamped to the strip', () => {
  const layout = stripLayout(Array.from({length: 4}, (_, i) => i * minute));
  assert.equal(centredScroll(layout, 0, 2000), 0);
  assert.equal(centredScroll(layout, 3, 100), layout.width - 100);
});
