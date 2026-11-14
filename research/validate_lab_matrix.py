"""Exercise official calibration packs on the previously fixed QR3 pilot.

Forced photometry at the original field centre; it need not contain a source.
This validates product compatibility, not photometric accuracy or completeness.
"""
from pathlib import Path
from hashlib import sha256
from datetime import datetime, timezone
import importlib.util
import json
import numpy, scipy, astropy

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('lab', ROOT/'public/science/lab_pipeline.py')
lab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lab)


def main():
    pilot = ROOT/'research/results/qr3_release_matrix_v2'
    original = json.loads((pilot/'summary.json').read_text())
    calibration = json.loads((ROOT/'public/science/calibration/manifest.json').read_text())
    results = []
    for case in original['cases']:
        result = {'name': case['name'], 'query': case['query']}
        if case['status'] != 'measured':
            result.update(status='no_cached_product', original_status=case['status'])
            results.append(result)
            continue
        try:
            provenance = json.loads((pilot/case['name']/'provenance.json').read_text())
            record = {**provenance['record'], 'id': provenance['verified_frame']['id'],
                      'ra': case['query']['ra'], 'dec': case['query']['dec'],
                      'expected_sha256': provenance['fits_sha256']}
            d = record['detector']
            raw = (ROOT/'.science-cache/qr3_release_matrix'/f"{case['name']}_{record['observation']}.fits").read_bytes()
            assert sha256(raw).hexdigest() == record['expected_sha256']
            c = calibration['detectors'][str(d)]
            data = (ROOT/'public/science/calibration'/c['file']).read_bytes()
            assert sha256(data).hexdigest() == c['sha256']
            lab.load_calibration(d, data)
            lab.TILES.clear()
            for key in lab.required_tiles(raw):
                tile = c['tiles'][key]
                data = (ROOT/'public/science/calibration'/tile['file']).read_bytes()
                assert sha256(data).hexdigest() == tile['sha256']
                lab.load_tile(f'{d}:{key}', data)
            options = {'fit_position': False, 'detect': False}
            frame = lab.analyze_fits(raw, record, options)
            result.update(status='processed', frame=frame)
        except Exception as error:
            result.update(status='failed', error=f'{type(error).__name__}: {error}')
        results.append(result)
        print(case['name'], result['status'], flush=True)
    report = {'created_at': datetime.now(timezone.utc).isoformat(), 'cases': results,
              'selection': 'Original predeclared QR3 pilot, earliest exposure; forced flux at field centre, no replacements.',
              'limitations': 'Field centres are not guaranteed sources. This is a compatibility test, not calibrated photometric truth.',
              'code_sha256': sha256((ROOT/'public/science/lab_pipeline.py').read_bytes()).hexdigest(),
              'calibration_manifest_sha256': sha256((ROOT/'public/science/calibration/manifest.json').read_bytes()).hexdigest(),
              'software': {'numpy': numpy.__version__, 'scipy': scipy.__version__, 'astropy': astropy.__version__}}
    (ROOT/'research/results/laboratory/real-qr3-matrix.json').write_text(json.dumps(report, indent=2, allow_nan=False)+'\n', encoding='utf-8')


if __name__ == '__main__':
    main()
