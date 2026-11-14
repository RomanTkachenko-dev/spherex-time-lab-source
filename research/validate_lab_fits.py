"""Reproduce local real-FITS laboratory smoke checks; no network downloads."""
import argparse
import importlib.util
from pathlib import Path
from hashlib import sha256
from datetime import datetime, timezone
import json
import numpy, scipy, astropy

ROOT=Path(__file__).resolve().parents[1]
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--ra',type=float);parser.add_argument('--dec',type=float)
    parser.add_argument('--count',type=int,default=3);parser.add_argument('--output',default='real-fits-smoke.json')
    args=parser.parse_args()
    if (args.ra is None)!=(args.dec is None):parser.error('Both RA and Dec are required')
    spec=importlib.util.spec_from_file_location('lab',ROOT/'public/science/lab_pipeline.py')
    lab=importlib.util.module_from_spec(spec);spec.loader.exec_module(lab)
    manifest=json.loads((ROOT/'public/data/atlas/manifest.json').read_text())
    cal=json.loads((ROOT/'public/science/calibration/manifest.json').read_text())
    options={'ra':args.ra if args.ra is not None else manifest['frames'][0]['ra'],
             'dec':args.dec if args.dec is not None else manifest['frames'][0]['dec'],
             'fit_position':args.ra is not None,'detect':True,'snr':5,'max_sources':200,
             'response_tolerance':.05,'radius_arcsec':2,'max_speed_arcsec_day':100,'max_gap_days':2}
    frames=[]
    for f in manifest['frames'][:args.count]:
        raw=(ROOT/'.science-cache'/f"{f['id']}.fits").read_bytes();d=int(f['detector'][1:])
        calibration=cal['detectors'][str(d)]
        data=(ROOT/'public/science/calibration'/calibration['file']).read_bytes()
        assert sha256(data).hexdigest()==calibration['sha256'];lab.load_calibration(d,data)
        lab.TILES.clear()
        for key in lab.required_tiles(raw):
            tile=calibration['tiles'][key];data=(ROOT/'public/science/calibration'/tile['file']).read_bytes()
            assert sha256(data).hexdigest()==tile['sha256'];lab.load_tile(f'{d}:{key}',data)
        record={'id':f['id'],'observation':f['observation_id'],'detector':d,'url':f['source_url'],
                'cutout_url':f['cutout_url'],'release':f['release'],'ra':args.ra if args.ra is not None else f['ra'],
                'dec':args.dec if args.dec is not None else f['dec'],'expected_sha256':f['sha256_cutout']}
        result=lab.analyze_fits(raw,record,options);frames.append(result)
        print(f['id'],len(result['detections']),bool(result['target'] and result['target']['quality_ok']),flush=True)
    report=lab.finish_lab(frames,options)
    report.update(calibration=cal,created_at=datetime.now(timezone.utc).isoformat(),
                  code_sha256=sha256((ROOT/'public/science/lab_pipeline.py').read_bytes()).hexdigest(),
                  software={'numpy':numpy.__version__,'scipy':scipy.__version__,'astropy':astropy.__version__})
    dest=ROOT/'research/results/laboratory';dest.mkdir(parents=True,exist_ok=True)
    (dest/args.output).write_text(json.dumps(report,indent=2,allow_nan=False)+'\n',encoding='utf-8')

if __name__=='__main__':main()
