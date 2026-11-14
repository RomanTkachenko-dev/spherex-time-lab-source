"""Reproduce a targeted QR3 Wide/Deep astrometry pilot across D1-D6.

Cases and selection are declared before measurement. Every case, including
archive failures and zero matches, stays in the summary; no result is replaced
by a more favorable exposure. This is not a mission-wide calibration study.
"""
from __future__ import annotations

import argparse
from datetime import date, datetime, timedelta, timezone
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
from urllib.parse import urlencode
from urllib.error import HTTPError
from urllib.request import urlopen

import astropy
from astropy.io import fits
from astropy.wcs import WCS
import numpy as np
import scipy
import PIL

import validate_gaia_astrometry as astrometry

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('field_pipeline', ROOT/'public/science/field_pipeline.py')
kernel = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kernel)


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False)+'\n', encoding='utf-8')


def cases():
    for survey, ra, dec in [('wide',232.66460339,-10.71949972),('deep',270.0,66.56)]:
        for detector in range(1,7):
            yield {'name':f'qr3_{survey}_d{detector}', 'query':dict(ra=ra,dec=dec,
                start='2026-07-20',end='2026-07-25',detector=detector,fov=0.3,
                max_frames=60,release='qr3',survey=survey)}


def collect_catalogue(base_url: str, query: dict, folder: Path):
    """Split archive capacity errors without changing the declared date range."""
    attempts,parts=[],[]
    def collect(q):
        if len(attempts)>=511:raise ValueError('Catalogue request tree exceeded 511 attempts.')
        url=base_url+'/api/field?'+urlencode(q)
        try:
            with urlopen(url,timeout=65) as response:raw=response.read()
        except HTTPError as error:
            raw=error.read()
            attempts.append({'url':url,'status':error.code,'body_sha256':sha256(raw).hexdigest(),
                'error':raw.decode('utf-8',errors='replace')})
            write_json(folder/'query_attempts.json',attempts)
            if error.code!=413:raise
            start,end=date.fromisoformat(q['start']),date.fromisoformat(q['end'])
            if start==end:raise ValueError('One UTC day exceeds archive capacity; no result has been sampled.') from error
            middle=start+(end-start)//2
            collect({**q,'end':middle.isoformat()})
            collect({**q,'start':(middle+timedelta(days=1)).isoformat()})
            return
        part=json.loads(raw)
        if part.get('catalogue_truncated'):raise ValueError('Truncated archive result cannot establish earliest exposure.')
        attempts.append({'url':url,'status':200,'body_sha256':sha256(raw).hexdigest()})
        (folder/f'catalogue_part_{len(parts)+1:03}.json').write_bytes(raw)
        parts.append(part)
        write_json(folder/'query_attempts.json',attempts)
    collect(query)
    unique={}
    for part in parts:
        for record in part['records']:
            key=(record['observation'],record['detector'])
            if key in unique and unique[key]!=record:raise ValueError('Conflicting duplicate catalogue identity.')
            unique[key]=record
    first=parts[0]
    catalogue={**first,'query':{**first['query'],**query},'records':list(unique.values()),
        'matched_count':len(unique),'candidate_count':len(unique),
        'observation_table_parts':[{key:part[key] for key in
            ['source_url','source_sha256','retrieved_at','matched_count']}|{
                'start':part['query']['start'],'end':part['query']['end']} for part in parts]}
    write_json(folder/'catalogue.json',catalogue)
    return catalogue


def run_case(case, base_url: str, output_dir: Path, cache_dir: Path):
    name,query=case['name'],case['query']
    folder=output_dir/name
    folder.mkdir(parents=True,exist_ok=True)
    catalogue_url=base_url+'/api/field?'+urlencode(query)
    catalogue=collect_catalogue(base_url,query,folder)
    catalogue_raw=(folder/'catalogue.json').read_bytes()
    if catalogue.get('catalogue_truncated'):
        raise ValueError('Archive catalogue is truncated; this pilot requires an untruncated query.')
    records=sorted(catalogue['records'],key=lambda record:(record['mjd'],record['id']))
    if not records:
        return {'status':'no_archive_matches','archive':catalogue}
    record=records[0]
    cutout_query={key:query[key] for key in ['ra','dec','fov','release','survey']}
    cutout_query['url']=record['url']
    cutout_api=base_url+'/api/cutout?'+urlencode(cutout_query)
    with urlopen(cutout_api,timeout=110) as response:
        raw=response.read()
        record['cutout_url']=response.headers.get('X-Source-URL')
        record['retrieved_at']=response.headers.get('X-Retrieved-At')
    cache_dir.mkdir(parents=True,exist_ok=True)
    fits_path=cache_dir/(name+'_'+record['observation']+'.fits')
    fits_path.write_bytes(raw)
    item,reason=kernel.process_fits(raw,record,catalogue['query'])
    if item is None:
        raise ValueError('Display-kernel verification rejected the selected exposure: '+str(reason))
    provenance={'catalogue_request_url':catalogue_url,
        'catalogue_json_sha256':sha256(catalogue_raw).hexdigest(),
        'archive_source_url':catalogue['source_url'],'archive_source_sha256':catalogue['source_sha256'],
        'archive_retrieved_at':catalogue['retrieved_at'],
        'observation_table_parts':catalogue['observation_table_parts'],
        'archive_match_count':catalogue['matched_count'],
        'selection':'Earliest exposure by catalogue MJD, ties by ID; no replacements after measurement.',
        'record':record,'fits_sha256':sha256(raw).hexdigest(),'verified_frame':item[0]}
    write_json(folder/'provenance.json',provenance)
    with fits.open(fits_path,memmap=False) as hdus:
        ra,dec,radius=astrometry.footprint_cone(WCS(hdus['IMAGE'].header),hdus['IMAGE'].data.shape)
    gaia_path=folder/'gaia.csv'
    astrometry.fetch_gaia_catalogue(gaia_path,ra,dec,radius)
    report=astrometry.validate(fits_path,gaia_path,folder/'astrometry.json',folder/'overlay.png')
    association=report['association']
    return {'status':'measured' if association['matched_count'] else 'no_astrometric_matches',
        'provenance_file':str((folder/'provenance.json').relative_to(ROOT)),
        'report_file':str((folder/'astrometry.json').relative_to(ROOT)),
        'observation_id':report['input']['observation_id'],
        'date_avg_utc':report['input']['date_avg_utc'],
        'archive_match_count':catalogue['matched_count'],
        'matched_count':association['matched_count'],
        'isolated_match_count':association['isolated_match_count'],
        'metrics_all':association['metrics_all'],'metrics_isolated':association['metrics_isolated']}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url',default='http://localhost:5173')
    parser.add_argument('--output-dir',type=Path,default=ROOT/'research/results/qr3_release_matrix')
    parser.add_argument('--cache-dir',type=Path,default=ROOT/'.science-cache/qr3_release_matrix')
    parser.add_argument('--case',action='append',help='Run only named cases; repeat to select several. Omit for all 12.')
    args=parser.parse_args()
    args.output_dir=args.output_dir.resolve()
    args.cache_dir=args.cache_dir.resolve()
    selected=[case for case in cases() if not args.case or case['name'] in args.case]
    if not selected:parser.error('No declared case matches --case.')
    source_dir=args.output_dir/'method_sources'
    source_dir.mkdir(parents=True,exist_ok=True)
    for source in [Path(__file__),Path(astrometry.__file__),ROOT/'public/science/field_pipeline.py']:
        (source_dir/source.name).write_bytes(source.read_bytes())
    report={'validation':'targeted_qr3_release_detector_pilot','started_at_utc':utc_now(),
        'selection':'Predeclared fields and dates, one earliest catalogue exposure per survey/detector; all failures retained.',
        'software':{'numpy':np.__version__,'scipy':scipy.__version__,'astropy':astropy.__version__,'Pillow':PIL.__version__},
        'method_sha256':{'runner':sha256(Path(__file__).read_bytes()).hexdigest(),
            'astrometry':sha256(Path(astrometry.__file__).read_bytes()).hexdigest(),
            'display_kernel':sha256((ROOT/'public/science/field_pipeline.py').read_bytes()).hexdigest()},
        'cases':[], 'limitations':[
            'One predefined sky field per survey and one exposure per detector do not establish all-sky accuracy.',
            'Any measured offsets include centroid extraction, blending, chromatic effects and reference error; they are not pure WCS errors.',
            'No PSF fitting, parallax correction, source completeness, false-positive rate or photometric calibration is evaluated.',
            'Catalogue failures and cases without matched Gaia sources remain explicit and provide no astrometric accuracy constraint.']}
    for case in selected:
        print(json.dumps({'case':case['name'],'stage':'started'}),flush=True)
        try:result=run_case(case,args.base_url.rstrip('/'),args.output_dir,args.cache_dir)
        except Exception as error:result={'status':'failed','error':str(error),'failed_at_utc':utc_now()}
        report['cases'].append({**case,**result})
        report['updated_at_utc']=utc_now()
        write_json(args.output_dir/'summary.json',report)
        print(json.dumps({'case':case['name'],**result},ensure_ascii=False),flush=True)
    report['finished_at_utc']=utc_now()
    report['measured_cases']=sum(case['status']=='measured' for case in report['cases'])
    report['failed_cases']=sum(case['status']=='failed' for case in report['cases'])
    write_json(args.output_dir/'summary.json',report)


if __name__=='__main__':main()
