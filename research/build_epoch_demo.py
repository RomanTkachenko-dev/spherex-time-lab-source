"""Rebuild the four-exposure DR1 long-baseline display example."""
import json
from pathlib import Path
from validate_dr1_controls import catalogue, get
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'public/science'))
from field_pipeline import process_fits, finalize_series

root = Path(__file__).resolve().parents[1]
ra, dec, detector = 60.8109955, 51.3404038, 2
rows, source = catalogue(ra, dec, detector, 'hips-tutorial')
query = dict(ra=ra, dec=dec, detector=detector, release='dr1', survey='wide',
             fov=0.10, max_frames=4, start='2025-04-24', end='2026-05-14',
             wavelength_min=None, wavelength_max=None)
items = []
for i, row in enumerate(rows):
    url = row['access_url']
    cutout = f'{url}?center={ra},{dec}&size=0.16'
    raw, evidence = get(cutout, f'hips-tutorial-{i}.fits')
    record = dict(id=row['obs_id']+'D2', observation=row['obs_id'], detector=detector,
                  release='spherex_dr1', url=url, cutout_url=cutout, retrieved_at=evidence["retrieved_at"])
    item, reason = process_fits(raw, record, query)
    if item is None:
        raise ValueError(reason)
    items.append(item)
meta = dict(query=query, records=rows, matched_count=len(rows), candidate_count=len(rows),
            catalogue_truncated=False, source_url=source['url'], source_sha256=source['sha256'], retrieved_at=source['retrieved_at'],
            selection='Four evenly indexed D2 exposures from the chronological SIA result, selected for demonstration.')
manifest = finalize_series(items, meta, [], {})
manifest['title'] = 'Поле DR1 · різні епохи'
manifest.pop('processed_at', None)
for frame in manifest['frames']:
    frame.pop('retrieved_at', None)
out = root / 'public/data/epochs/manifest.json'
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')), encoding='utf8')
print([f['date'] for f in manifest['frames']])
