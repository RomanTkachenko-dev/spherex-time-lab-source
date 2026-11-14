"""Held-out DR1 fields, external Gaia positions, analytic injections on real backgrounds.

The two fields, dates, seed and thresholds below are fixed before inspecting results.
No tuning or substitution of fields on failures. The second field interval was
expanded to DR1 coverage after zero matches in the initial week, before any fits.
The initial availability failure is retained in initial-availability.json. Cache contains original responses.
Run: python research/validate_dr1_controls.py
"""
from pathlib import Path
from io import BytesIO
from hashlib import sha256
from datetime import datetime, timezone
import importlib.util
import json
import csv
import xml.etree.ElementTree as ET
import requests
import time
import numpy as np
from astropy.io import fits
from astropy.coordinates import SkyCoord
from astropy import units as u
from astropy.time import Time

ROOT=Path(__file__).resolve().parents[1]
CACHE=ROOT/'.science-cache/dr1-holdout'; CACHE.mkdir(parents=True,exist_ok=True)
OUT=ROOT/'research/results/dr1-holdout'; OUT.mkdir(parents=True,exist_ok=True)
spec=importlib.util.spec_from_file_location('lab',ROOT/'public/science/lab_pipeline.py')
lab=importlib.util.module_from_spec(spec);spec.loader.exec_module(lab)
calibration=json.loads((ROOT/'public/science/calibration/manifest.json').read_text())
FIELDS=[('psf-tutorial',305.59875,41.14888888888889,4),('hips-tutorial',60.8109955,51.3404038,2)]
SEED=20261114

def get(url,name):
    path=CACHE/name
    if not path.exists():
        for attempt in range(3):
            response=requests.get(url,timeout=120)
            if response.status_code not in (502,503,504):break
            if attempt<2:time.sleep(2)
        response.raise_for_status();path.write_bytes(response.content)
    raw=path.read_bytes()
    return raw,{'url':url,'sha256':sha256(raw).hexdigest(),'cache_file':path.name,'retrieved_at':datetime.fromtimestamp(path.stat().st_mtime,timezone.utc).isoformat()}

def catalogue(ra,dec,d,name):
    params={'COLLECTION':'spherex_dr1','POS':f'CIRCLE {ra} {dec} 0.000001','TIME':('60796 60803' if name=='psf-tutorial' else '60789 61174'),'MAXREC':'1000'}
    url=requests.Request('GET','https://irsa.ipac.caltech.edu/SIA',params=params).prepare().url
    raw,source=get(url,name+'-sia-v2.xml');root=ET.fromstring(raw);ns={'v':'http://www.ivoa.net/xml/VOTable/v1.3'}
    if any(i.get('value') in ('ERROR','OVERFLOW') for i in root.findall('.//v:INFO',ns)):raise ValueError('SIA error or overflow')
    table=root.find('.//v:TABLE',ns);cols=[f.get('name') for f in table.findall('v:FIELD',ns)]
    rows=[dict(zip(cols,[c.text or '' for c in r])) for r in table.findall('.//v:TR',ns)]
    rows=sorted([r for r in rows if r['energy_bandpassname']==f'SPHEREx-D{d}' and r['obs_collection']=='spherex_dr1'],key=lambda r:float(r['t_min']))
    if len(rows)<4:raise ValueError(f'Only {len(rows)} records; no replacement field selected')
    return [rows[i] for i in np.linspace(0,len(rows)-1,4).round().astype(int)],source

def gaia(ra,dec,name):
    query=f"SELECT TOP 1201 source_id,ra,dec,pmra,pmdec,ref_epoch FROM gaia_dr3_source WHERE CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',{ra},{dec},0.15))=1 ORDER BY phot_g_mean_mag ASC"
    url=requests.Request('GET','https://irsa.ipac.caltech.edu/TAP/sync',params={'QUERY':query,'FORMAT':'CSV'}).prepare().url
    raw,source=get(url,name+'-gaia.csv');rows=list(csv.DictReader(raw.decode().splitlines()))
    source['truncated']=len(rows)>1200
    return rows[:1200],source

def main():
    rng=np.random.default_rng(SEED);results=[]
    for name,ra,dec,detector in FIELDS:
        result={'field':name,'ra':ra,'dec':dec,'detector':detector,'frames':[],'errors':[]};results.append(result)
        try:
            rows,result['catalogue']=catalogue(ra,dec,detector,name)
            stars,result['gaia']=gaia(ra,dec,name)
            c=calibration['detectors'][str(detector)]
            raw=(ROOT/'public/science/calibration'/c['file']).read_bytes();assert sha256(raw).hexdigest()==c['sha256'];lab.load_calibration(detector,raw)
            for i,row in enumerate(rows):
                print(name,i+1,flush=True)
                url=row['access_url']+f'?center={ra},{dec}&size=0.16'
                try:raw,provenance=get(url,f'{name}-{i}.fits')
                except requests.RequestException as error:
                    result['errors'].append(f'frame {i}: {error}');continue
                rng=np.random.default_rng(SEED+detector*100+i)
                lab.TILES.clear()
                for key in lab.required_tiles(raw):
                    tile=c['tiles'][key];data=(ROOT/'public/science/calibration'/tile['file']).read_bytes()
                    assert sha256(data).hexdigest()==tile['sha256'];lab.load_tile(f'{detector}:{key}',data)
                record={'id':row['obs_id']+f'D{detector}','observation':row['obs_id'],'detector':detector,'release':'spherex_dr1','url':row['access_url'],'cutout_url':url,'ra':ra,'dec':dec}
                options={'ra':ra,'dec':dec,'fit_position':True,'detect':True,'snr':5,'max_sources':200,'radius_arcsec':3,'max_speed_arcsec_day':100,'max_gap_days':10,'response_tolerance':.05}
                measured=lab.analyze_fits(raw,record,options)
                f={'source':provenance,'id':record['id'],'mjd':measured['mjd'],'epsf_source':measured['epsf_source'],'detections':len(measured['detections']),'detection_error':measured['detection_error'],'gaia_pairs':[],'injections':[]};result['frames'].append(f)
                # External reference propagated by Astropy, independently of browser implementation.
                propagated=[]
                for s in stars:
                    try:
                        pos=SkyCoord(ra=float(s['ra'])*u.deg,dec=float(s['dec'])*u.deg,pm_ra_cosdec=float(s['pmra'])*u.mas/u.yr,pm_dec=float(s['pmdec'])*u.mas/u.yr,obstime=Time(float(s['ref_epoch']),format='jyear')).apply_space_motion(Time(measured['mjd'],format='mjd'))
                        propagated.append((s['source_id'],pos))
                    except (ValueError,TypeError):continue
                for p in measured['detections']:
                    sky=SkyCoord(p['ra']*u.deg,p['dec']*u.deg)
                    matches=[(sid,float(sky.separation(pos).arcsec)) for sid,pos in propagated if sky.separation(pos).arcsec<=3]
                    if len(matches)==1:f['gaia_pairs'].append({'source_id':matches[0][0],'separation_arcsec':matches[0][1]})
                with fits.open(BytesIO(raw),memmap=False) as hdul:
                    hdr=hdul['IMAGE'].header;wcs=lab.WCS(hdr)
                    image=hdul['IMAGE'].data.astype(float);variance=hdul['VARIANCE'].data.astype(float);flags=hdul['FLAGS'].data.astype(np.uint32)
                    valid=np.isfinite(image)&np.isfinite(variance)&(variance>0)&((flags&lab.BAD_MASK)==0)
                    e=hdul['EPSF'];cal=dict(lab.CAL[detector]);cal.update(epsf=e.data['EPSF'].copy(),xc=e.data['XCENTER'].copy(),yc=e.data['YCENTER'].copy(),oversampling=np.array([e.header['OVSMPY'],e.header['OVSMPX']]))
                    yy,xx=np.indices(image.shape);height,width=image.shape
                    # Independent analytic Gaussian shapes deliberately do NOT use the fitted ePSF generator.
                    # Differential flux subtracts the fit on the unchanged real background.
                    for j in range(12):
                        x,y=rng.uniform(10,width-11),rng.uniform(10,height-11)
                        sigma=float(rng.uniform(.65,1.05));p=np.exp(-((xx-x)**2+(yy-y)**2)/(2*sigma*sigma));p/=p.sum()
                        amplitude=float(30*np.sqrt(variance[int(y),int(x)])/np.sqrt(np.sum(p*p)))
                        entry={'x':x,'y':y,'sigma_pixels':sigma,'amplitude_native':amplitude,'nominal_white_noise_snr':30};f['injections'].append(entry)
                        try:
                            baseline=lab.measure_at(image,variance,valid,wcs,hdr,cal,x,y,False)
                            fit=lab.measure_at(image+amplitude*p,variance,valid,wcs,hdr,cal,x,y,False)
                            # Convert injected amplitude with an independent local WCS pixel-area calculation.
                            origin=wcs.pixel_to_world(x,y);east=wcs.pixel_to_world(x+1,y);north=wcs.pixel_to_world(x,y+1)
                            ex,ey=origin.spherical_offsets_to(east);nx,ny=origin.spherical_offsets_to(north)
                            area=abs(ex.to_value(u.rad)*ny.to_value(u.rad)-ey.to_value(u.rad)*nx.to_value(u.rad))
                            truth=amplitude*area*1e12
                            entry.update(injected_flux_uJy=truth,recovered_delta_uJy=fit['flux_uJy']-baseline['flux_uJy'],fractional_error=(fit['flux_uJy']-baseline['flux_uJy'])/truth-1,conditional_error_uJy=fit['flux_error_uJy'],quality_ok=fit['quality_ok'])
                            found,_,_=lab.detect_sources(image+amplitude*p,variance,valid,wcs,hdr,cal,5,200)
                            sky=wcs.pixel_to_world(x,y)
                            entry['detected_within_3arcsec']=any(sky.separation(SkyCoord(q['ra']*u.deg,q['dec']*u.deg)).arcsec<=3 for q in found)
                        except (ValueError,KeyError) as error:entry['error']=str(error)
        except Exception as error:result['errors'].append(f'{type(error).__name__}: {error}')
        (OUT/'report.json').write_text(json.dumps({'seed':SEED,'fields':results},indent=2,allow_nan=False)+'\n')
    pairs=[p for r in results for f in r['frames'] for p in f['gaia_pairs']]
    injections=[p for r in results for f in r['frames'] for p in f['injections']]
    good=[p for p in injections if 'fractional_error' in p]
    summary={'created_at':datetime.now(timezone.utc).isoformat(),'seed':SEED,'method_sha256':sha256((ROOT/'public/science/lab_pipeline.py').read_bytes()).hexdigest(),
      'fields':results,'summary':{'frames':sum(len(r['frames']) for r in results),'gaia_pairs':len(pairs),'gaia_median_separation_arcsec':float(np.median([p['separation_arcsec'] for p in pairs])) if pairs else None,'injections':len(injections),'measured':len(good),'median_fractional_flux_error':float(np.median([p['fractional_error'] for p in good])) if good else None,'detections_within_3arcsec':sum(p.get('detected_within_3arcsec',False) for p in injections)},
      'limitations':['Pilot on two preselected fields, four frames each; no claim of all-sky precision or completeness.','Gaia matches selected within 3 arcsec: conditional residuals, possibly contaminated, not blind ground truth; repeated stars are not independent.','Gaussian injections intentionally mismatch ePSF. Differential flux on real background; source photon noise not added. Detection may coincide with pre-existing sources. This is a model-stress check, not survey completeness.','No comparison of Gaia G flux with infrared flux. Original responses and FITS hashes retained.']}
    (OUT/'report.json').write_text(json.dumps(summary,indent=2,allow_nan=False)+'\n')
    print(json.dumps(summary['summary'],indent=2),flush=True)
    if any(r['errors'] for r in results):raise SystemExit(1)

if __name__=='__main__':main()
