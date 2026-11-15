// Layout of the horizontal exposure strip (UI only). Tiles have a fixed width, a regular
// gap, and an extra gap before an exposure that follows a long pause in time. Only the
// tiles inside the viewport (plus overscan) are rendered, so series with thousands of
// exposures stay fast and only visible thumbnails are read from browser storage.

export const STRIP_TILE = 64;
export const STRIP_GAP = 7;
export const STRIP_PAUSE_GAP = 14;
/** A pause longer than this many minutes gets a visible break in the strip. */
export const STRIP_PAUSE_MINUTES = 10;

export type StripLayout = { offsets: number[]; pauses: boolean[]; width: number };

export function stripLayout(mjds: readonly number[]): StripLayout {
  const offsets: number[] = new Array(mjds.length);
  const pauses: boolean[] = new Array(mjds.length);
  let x = 0;
  for (let i = 0; i < mjds.length; i++) {
    const pause = i > 0 && (mjds[i] - mjds[i - 1]) * 1440 > STRIP_PAUSE_MINUTES;
    if (i > 0) x += STRIP_GAP + (pause ? STRIP_PAUSE_GAP : 0);
    offsets[i] = x;
    pauses[i] = pause;
    x += STRIP_TILE;
  }
  return { offsets, pauses, width: mjds.length ? x : 0 };
}

/** First index whose tile ends after `position` (binary search). */
function firstEndingAfter(offsets: readonly number[], position: number) {
  let lo = 0, hi = offsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] + STRIP_TILE <= position) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Half-open range [start, end) of tiles to render for the current scroll position. */
export function visibleTiles(layout: StripLayout, scrollLeft: number, viewport: number, overscan = 6): [number, number] {
  const n = layout.offsets.length;
  if (!n) return [0, 0];
  const first = firstEndingAfter(layout.offsets, scrollLeft);
  const last = firstEndingAfter(layout.offsets, scrollLeft + Math.max(viewport, STRIP_TILE));
  return [Math.max(0, first - overscan), Math.min(n, last + 1 + overscan)];
}

/** Scroll position that centres tile `index` in a viewport of the given width. */
export function centredScroll(layout: StripLayout, index: number, viewport: number) {
  if (!layout.offsets.length) return 0;
  const i = Math.min(Math.max(index, 0), layout.offsets.length - 1);
  const max = Math.max(0, layout.width - viewport);
  return Math.min(max, Math.max(0, layout.offsets[i] + STRIP_TILE / 2 - viewport / 2));
}
