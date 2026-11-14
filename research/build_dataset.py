"""Build a reproducible, explicitly non-photometric SPHEREx temporal viewer.

Uses official QR2 3I/ATLAS metadata and actual calibrated IBE FITS cutouts.
Ephemeris markers are predictions supplied by IRSA, NOT measured detections.
Native samples and quality masks are preserved. Reprojection is for display.
"""
from __future__ import annotations
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
import json, re, time, warnings
import numpy as np
import requests
from astropy import units as u, log
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.table import Table
from astropy.wcs import WCS
from PIL import Image
from scipy.ndimage import map_coordinates

log.setLevel('ERROR')
ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.science-cache'
OUT = ROOT / 'public/data/atlas'
TABLE_URL = 'https://irsa.ipac.caltech.edu/data/SPHEREx/docs/comet3iatlas/obscore_3I_Atlas.vot'
SCRIPT_URL = 'https://irsa.ipac.caltech.edu/data/SPHEREx/docs/comet3iatlas/3IATLASImages-curl.sh'
SOURCE_PAGE = 'https://irsa.ipac.caltech.edu/data/SPHEREx/docs/comet3iatlas/index.html'
SOURCE_BIT, FULLSAMPLE_BIT = 21, 12  # IRSA FLAGS documentation; informational.
INFO_MASK = (1 << SOURCE_BIT) | (1 << FULLSAMPLE_BIT)
BAD_MASK = np.uint32(0xffffffff ^ INFO_MASK)

def download(url: str, path: Path, params=None) -> Path:
    if path.exists():
        return path
    for attempt in range(3):
        try:
            r = requests.get(url, params=params, timeout=(15, 55))
            r.raise_for_status()
            temp = path.with_suffix(path.suffix + '.part')
            temp.write_bytes(r.content)
            temp.replace(path)
            return path
        except requests.RequestException:
            if attempt == 2:
                raise
            time.sleep(1 + attempt)
    raise RuntimeError('unreachable')

def display_wcs(ra: float, dec: float, width_deg: float, n=256) -> WCS:
    w = WCS(naxis=2)
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    w.wcs.cdelt = [-width_deg / n, width_deg / n]
    w.wcs.crval = [ra, dec]
    w.wcs.ctype = ['RA---TAN', 'DEC--TAN']
    w.wcs.radesys = 'ICRS'
    return w

def project(a, flags, native_wcs, out_wcs, n=256):
    y, x = np.indices((n, n), dtype=float)
    ra, dec = out_wcs.all_pix2world(x, y, 0)
    sx, sy = native_wcs.all_world2pix(ra, dec, 0, quiet=True)
    bad = ~np.isfinite(a) | ((flags.astype(np.uint32) & BAD_MASK) != 0)
    coords = [sy, sx]
    sampled = map_coordinates(np.nan_to_num(a), coords, order=1, mode='constant', cval=0, prefilter=False)
    invalid = map_coordinates(bad.astype(float), coords, order=1, mode='constant', cval=1, prefilter=False) > 0
    missing = map_coordinates((~np.isfinite(a)).astype(float), coords, order=1, mode='constant', cval=1, prefilter=False) > 0
    sampled[missing] = np.nan
    return sampled, invalid

def save_display(a, invalid, path, low, high):
    scaled = np.clip((np.nan_to_num(a, nan=low) - low) / (high - low), 0, 1)
    gray = np.uint8(np.arcsinh(scaled * 18) / np.arcsinh(18) * 255)
    Image.fromarray(np.flipud(gray)).save(path)
    overlay = np.zeros((*invalid.shape, 4), dtype=np.uint8)
    overlay[invalid] = (255, 153, 88, 160)
    Image.fromarray(np.flipud(overlay)).save(path.with_name(path.stem + '-mask.png'))

def spectral_at(h, x, y):
    # The alternate WCS reports wavelength AND bandwidth, in the documented units.
    w = WCS(h['IMAGE'].header, fobj=h, key='W')
    w.sip = None
    wavelength, bandwidth = w.all_pix2world(x, y, 0)
    return (float((float(wavelength) * u.Unit(w.world_axis_units[0])).to_value(u.um)),
            float((float(bandwidth) * u.Unit(w.world_axis_units[1])).to_value(u.um)))

def main():
    CACHE.mkdir(exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    table_path = download(TABLE_URL, CACHE / 'observations.vot')
    script_path = download(SCRIPT_URL, CACHE / 'official-download.sh')
    table = Table.read(table_path, format='votable')
    all_urls = re.findall(r"https://[^'\s]+\.fits", script_path.read_text())
    rows = table[(table['t_min'] > 61023.18) & (table['t_min'] < 61023.33) & (table['spherex_detector'] == 'D5')]
    rows.sort('t_min')
    if len(rows) < 2:
        raise ValueError('Official table does not contain the required time series')
    center = (float(np.mean(rows['comet_ra'])), float(np.mean(rows['comet_dec'])))
    grid = display_wcs(*center, width_deg=0.26)
    tasks=[]
    for row in rows:
        identity=str(row['obs_id']) + 'D5'
        matches=[url for url in all_urls if f'_{identity}_' in url]
        if len(matches) != 1:
            raise ValueError(f'Ambiguous official URL for {identity}')
        tasks.append((row, identity, matches[0]))

    def fetch(task):
        row, identity, url=task
        params={'center':f'{center[0]:.9f},{center[1]:.9f}', 'size':'0.48'}
        path=download(url, CACHE / f'{identity}.fits', params=params)
        print(f'Fetched {identity}: {path.stat().st_size} bytes', flush=True)
        return row, identity, url, path, requests.Request('GET',url,params=params).prepare().url

    # Two archive requests at a time, with a reusable on-disk cache.
    with ThreadPoolExecutor(max_workers=2) as pool:
        downloaded=list(pool.map(fetch,tasks))
    frames=[]
    arrays=[]
    checks=[]
    for row, identity, url, path, cutout_url in downloaded:
        with fits.open(path) as h:
            header=h['IMAGE'].header
            if header['OBSID'] != str(row['obs_id']) or int(header['DETECTOR']) != 5:
                raise ValueError('Observation identity mismatch')
            a=h['IMAGE'].data.astype(float)
            flags=h['FLAGS'].data.astype(np.uint32)
            native=WCS(header)
            ra,dec=float(row['comet_ra']),float(row['comet_dec'])
            x,y=native.all_world2pix(ra,dec,0)
            rx,ry=native.all_pix2world(x,y,0)
            residual=SkyCoord(rx*u.deg,ry*u.deg).separation(SkyCoord(ra*u.deg,dec*u.deg)).arcsec
            if residual > 1e-3:
                raise ValueError('Coordinate roundtrip failed')
            wavelength,bandwidth=spectral_at(h,x,y)
            sky,skybad=project(a,flags,native,grid)
            objectgrid=display_wcs(ra,dec,width_deg=0.1)
            obj,objbad=project(a,flags,native,objectgrid)
            gx,gy=grid.all_world2pix(ra,dec,0)
            rounded=(int(round(float(y))), int(round(float(x))))
            native_flags=int(flags[rounded])
            arrays.append((sky,skybad,obj,objbad))
            i=len(frames)
            frames.append({
                'id':identity,'observation_id':str(row['obs_id']),'date':header['DATE-AVG'],
                'date_start':header['DATE-BEG'],'date_end':header['DATE-END'],
                'mjd':float(header['MJD-AVG']), 'table_mjd_start':float(row['t_min']),
                'time_scale':header['TIMESYS'],'exposure_s':float(header['XPOSURE']),
                'detector':'D5','release':str(row['obs_collection']),
                'ra':ra,'dec':dec,'position_kind':'IRSA-predicted-per-exposure',
                'ephemeris_reference_instant':'Not specified by the official observation table',
                'wavelength_um':wavelength,'bandwidth_um':bandwidth,
                'spectral_calibration':'Approximate WCS-WAVE lookup from this FITS',
                'image':f'/data/atlas/sky-{i:02d}.png','object_image':f'/data/atlas/object-{i:02d}.png',
                'marker_sky':{'x':float(gx),'y':float(255-gy)},'marker_object':{'x':127.5,'y':127.5},
                'quality':{'level1':header.get('L1DQAFLG'),'level2':header.get('L2DQAFLG'),
                  'flagged_display_fraction':float(skybad.mean()),'flags_at_predicted_position':native_flags,
                  'bad_at_predicted_position':bool(native_flags & int(BAD_MASK)),
                  'median_psf_fwhm_arcsec':header.get('PSF_FWHM'),
                  'coordinate_roundtrip_arcsec':float(residual)},
                'native_pixel':{'x':float(x),'y':float(y)},'native_shape':list(a.shape),
                'source_url':url,'cutout_url':cutout_url,'datalink_url':str(row['access_url']),
                'sha256_cutout':sha256(path.read_bytes()).hexdigest(),
                'brightness_unit':header['BUNIT'],'measurement':None
            })
            checks.append({'id':identity,'wcs_roundtrip_arcsec':float(residual),'finite_fraction':float(np.isfinite(sky).mean())})
    finite=np.concatenate([item[0][np.isfinite(item[0])] for item in arrays])
    low,high=(float(v) for v in np.percentile(finite,[12,99.7]))
    if high <= low:
        raise ValueError('Invalid common display scale')
    for i,(sky,skybad,obj,objbad) in enumerate(arrays):
        save_display(sky,skybad,OUT/f'sky-{i:02d}.png',low,high)
        save_display(obj,objbad,OUT/f'object-{i:02d}.png',low,high)
    manifest={
      'schema_version':1,'title':'3I / ATLAS','description':'SPHEREx QR2 · D5 · 14 грудня 2025',
      'source':SOURCE_PAGE,'observation_table_url':TABLE_URL,
      'observation_table_sha256':sha256(table_path.read_bytes()).hexdigest(),
      'retrieved_at':datetime.now(timezone.utc).isoformat(),'frames':frames,
      'display':{'width':256,'height':256,'sky_fov_deg':0.26,'object_fov_deg':0.1,
        'sky_center_ra':center[0],'sky_center_dec':center[1],
        'orientation':'North up, East left','projection':'ICRS TAN','resampling':'bilinear, display only',
        'stretch':'asinh','stretch_parameter':18,'low_MJy_sr':low,'high_MJy_sr':high,
        'scale_scope':'same scale for every frame and both views','bad_pixel_policy':'The signal is retained for visual inspection. The optional orange overlay marks all FLAGS except SOURCE (21) and FULLSAMPLE (12), expanded to cover interpolation support. Flagged pixels are not independently verified and are not used for quantitative measurements.',
        'noise_covariance_propagated':False,'psf_matched':False},
      'limits':['Predicted markers are not independent detections.',
        'No calibrated motion fit, centroid uncertainty or photometry is claimed.',
        'Wavelength and bandwidth are approximate values at the predicted position; values vary across each image.',
        'The frames are not PSF-matched or matched by full spectral response; brightness differences are not evidence of temporal variability.',
        'A preliminary Gaia DR3 centroid crossmatch covers 12 QR2 D5 exposures in this field; it is not a WCS-only or mission-wide accuracy estimate.'],
      'attribution':'This publication makes use of data products from the Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer (SPHEREx), which is a joint project of the Jet Propulsion Laboratory and the California Institute of Technology, and is funded by the National Aeronautics and Space Administration.',
      'dataset_doi':'10.26131/IRSA652',
      'method_version':'viewer-0.1.0'
    }
    (OUT/'manifest.json').write_text(json.dumps(manifest,indent=2,ensure_ascii=False,allow_nan=False),encoding='utf8')
    (OUT/'validation.json').write_text(json.dumps({'checks':checks,'scope':'Coordinate consistency and archive identities only; not scientific detection validation.'},indent=2),encoding='utf8')
    print(json.dumps({'frames':len(frames),'display_limits':[low,high],'wavelengths':[round(f['wavelength_um'],5) for f in frames]},indent=2),flush=True)

if __name__ == '__main__':
    main()
