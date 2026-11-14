"""Package verified IRSA calibration arrays, without resampling pixel maps.

Run once with the research Python environment. Downloads remain in ignored cache.
"""
from pathlib import Path
from io import BytesIO
import csv
import json
import tarfile
from hashlib import sha256
from datetime import datetime, timezone
import requests
import numpy as np
from astropy.io import fits

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT/'.science-cache/lab-calibration'
OUT = ROOT/'public/science/calibration'
SPECTRAL = 'https://irsa.ipac.caltech.edu/data/SPHEREx/docs/spectral_files_20260812/SPHERExSpectralFiles_202607.tar'
EPSF_BASE = 'https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/qr3/epsf/'

def download(url, path, expected_size=None):
    if path.exists() and (expected_size is None or path.stat().st_size == expected_size): return
    part = path.with_suffix(path.suffix+'.part')
    with requests.get(url, stream=True, timeout=180) as r:
        r.raise_for_status()
        with part.open('wb') as f:
            for block in r.iter_content(1024*1024): f.write(block)
    if expected_size is not None and part.stat().st_size != expected_size: raise ValueError('Incomplete calibration download')
    part.replace(path)

def build():
    CACHE.mkdir(parents=True, exist_ok=True); OUT.mkdir(parents=True, exist_ok=True)
    tarpath = CACHE/'spectral.tar'
    download(SPECTRAL, tarpath, 436705280)
    manifest = {'schema_version': 1, 'created_at': datetime.now(timezone.utc).isoformat(),
        'spectral_source': SPECTRAL, 'spectral_sha256': sha256(tarpath.read_bytes()).hexdigest(),
        'spectral_version': 'SSDC R7, 202607; detector coordinates flipped in x for D4-D6',
        'response_preprocessing': 'negative laboratory transmission samples clipped to zero for nonnegative normalized response distance; original CSV hashes retained',
        'detectors': {}}
    with tarfile.open(tarpath) as t:
        def read(name):
            f = t.extractfile(name)
            if f is None: raise ValueError(name)
            return f.read()
        channel_raw = read('ChannelMaps/spectral_channels_17ch_2040.fits')
        with fits.open(BytesIO(channel_raw)) as h: channel = h[1].data.copy()
        for d in range(1, 7):
            version = 2 if d == 3 else 1
            folder = f'cal-epsf-v{version}-2026-191'
            url = EPSF_BASE+f'{folder}/{d}/epsf_D{d}_spx_{folder}.fits'
            path = CACHE/f'epsf-{d}.fits'; download(url, path)
            epsf_raw = path.read_bytes()
            with fits.open(BytesIO(epsf_raw)) as h:
                e = h['EPSF']; data = e.data
                if e.header['DETCOORD'].strip() != 'sky' or int(e.header['DETECTOR']) != d: raise ValueError('ePSF coordinates')
                arrays = {'epsf': data['EPSF'].copy(), 'xc': data['XCENTER'].copy(), 'yc': data['YCENTER'].copy(),
                          'oversampling': np.array([e.header['OVSMPY'], e.header['OVSMPX']])}
            sources = {'channel_map': sha256(channel_raw).hexdigest()}
            for key, name in [('wave', 'BC'), ('width', 'BW')]:
                raw = read(f'ParameterFiles/20260604_SSDC_{name}_Band{d}.fits')
                with fits.open(BytesIO(raw)) as h:
                    values = next(x.data.copy() for x in h if x.data is not None)
                if values.shape != (2040, 2040): raise ValueError('Spectral map shape')
                arrays[key] = values[:, ::-1] if d >= 4 else values
                sources[key] = sha256(raw).hexdigest()
            arrays['channel'] = channel[:, ::-1] if d >= 4 else channel
            summary_raw = read(f'FidSpecSummary/SubChannel17/Band{d}/FidSpecSummary_Band{d}_SpecCh17.csv')
            sources['summary'] = sha256(summary_raw).hexdigest()
            summary = list(csv.DictReader(summary_raw.decode('utf-8-sig').splitlines()))
            for ch in range(1, 18):
                raw = read(f'MiddlePixel/SubChannel17/Band{d}/FiducialSpec_Band{d}_SubCh{ch:02d}_17_Cent.csv')
                data = np.genfromtxt(BytesIO(raw), delimiter=',', names=True)
                order = np.argsort(data['Wavelength_um'])
                arrays[f'lambda_{ch}'] = data['Wavelength_um'][order]
                arrays[f'response_{ch}'] = np.maximum(0, data['NormTransmission'][order])
                arrays[f'centre_{ch}'] = np.array(float(next(r for r in summary if int(r['SpecCh']) == ch)['BandCenter_um']))
                if not np.isfinite(arrays[f'response_{ch}']).all() or np.any(np.diff(arrays[f'lambda_{ch}']) <= 0): raise ValueError('Invalid response samples')
                sources[f'response_{ch}'] = sha256(raw).hexdigest()
            tiles={}
            for ty in range(4):
                for tx in range(4):
                    tile=OUT/f'map-{d}-{tx}-{ty}.npz'
                    np.savez_compressed(tile, **{k:arrays[k][ty*512:(ty+1)*512,tx*512:(tx+1)*512] for k in ['wave','width','channel']})
                    tiles[f'{tx}-{ty}']={'file':tile.name,'sha256':sha256(tile.read_bytes()).hexdigest(),'bytes':tile.stat().st_size}
            for key in ['wave','width','channel']:del arrays[key]
            output = OUT/f'detector-{d}.npz'; np.savez_compressed(output, **arrays)
            manifest['detectors'][str(d)] = {'file': output.name, 'sha256': sha256(output.read_bytes()).hexdigest(),
                'bytes': output.stat().st_size, 'tiles':tiles, 'epsf_url': url, 'epsf_sha256': sha256(epsf_raw).hexdigest(), 'source_hashes': sources}
            print(d, output.stat().st_size, flush=True)
    (OUT/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n', encoding='utf-8')

if __name__ == '__main__': build()
