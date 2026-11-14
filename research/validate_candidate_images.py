"""Independent labelled image sequences through detection AND track linking.

Analytic Gaussian injection is separate from the production ePSF spline renderer.
These controls validate this noise/PSF/motion regime only, not survey completeness.
"""
import importlib.util
import json
from pathlib import Path
from hashlib import sha256
import numpy as np
from astropy.wcs import WCS
from astropy.coordinates import SkyCoord
from astropy import units as u

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('lab',ROOT/'public/science/lab_pipeline.py')
lab=importlib.util.module_from_spec(spec);spec.loader.exec_module(lab)

def main():
    seed=20261115;rng=np.random.default_rng(seed)
    yy,xx=np.indices((51,51));ey,ex=np.mgrid[-16:17,-16:17]/5
    epsf=np.exp(-(ex*ex+ey*ey)/(2*.85**2))/(2*np.pi*.85**2)
    cal={'epsf':epsf[None,:,:],'xc':np.array([25]),'yc':np.array([25]),'oversampling':(5,5),
         'channel':np.broadcast_to(1,(2040,2040)),'wave':np.broadcast_to(1.,(2040,2040)),'width':np.broadcast_to(.02,(2040,2040))}
    w=WCS(naxis=2);w.wcs.crpix=[26,26];w.wcs.crval=[359.999,20];w.wcs.cdelt=[-6.15/3600,6.15/3600];w.wcs.ctype=['RA---TAN','DEC--TAN']
    hdr={'CRPIX1A':1,'CRPIX2A':1};valid=np.ones(xx.shape,bool);variance=np.ones(xx.shape)
    options={'ra':359.999,'dec':20,'radius_arcsec':1.2,'max_speed_arcsec_day':100,'max_gap_days':2}
    records=[];flux_errors=[];position_errors=[];false_blank=0
    for trial in range(20):
        frames=[];truth=[]
        phase=rng.uniform(-.3,.3,(3,2));flux=rng.uniform(100,220,3)
        for epoch in range(6):
            positions=np.array([[12,12],[37,14],[13+epoch*.7,36]],float)+phase
            image=5+.01*xx-.02*yy+rng.normal(0,1,xx.shape)
            for index,(x,y) in enumerate(positions):
                profile=np.exp(-((xx-x)**2+(yy-y)**2)/(2*.85**2));profile/=profile.sum();image+=flux[index]*profile
            detections,peaks,rejected=lab.detect_sources(image,variance,valid,w,hdr,cal,5,100)
            labels=[]
            for d in detections:
                dist=np.hypot(positions[:,0]-d['x'],positions[:,1]-d['y']);index=int(np.argmin(dist))
                label=index if dist[index]*6.15<2 else None;labels.append(label)
                if label is not None:
                    flux_errors.append(d['amplitude']/flux[index]-1);position_errors.append(float(dist[index]*6.15))
            frames.append({'id':f'{trial}-{epoch}','mjd':61000+epoch*.2,'detections':detections})
            truth.append(labels)
        tracks=lab.link_tracks(frames,options)
        movers=[t for t in tracks if t['motion_resolved']]
        labels=[[truth[d['frame']][d['detection']] for d in t['detections']] for t in movers]
        recovered=sum(all(value==2 for value in ids) for ids in labels)
        false=sum(not all(value==2 for value in ids) for ids in labels)
        blank=rng.normal(0,1,xx.shape);det,_,_=lab.detect_sources(blank,variance,valid,w,hdr,cal,5,100);false_blank+=len(det)
        records.append({'trial':trial,'detections':sum(len(f['detections']) for f in frames),'moving_tracks':len(movers),'correct_moving_tracks':recovered,'false_moving_tracks':false})
    result={'seed':seed,'method_sha256':sha256((ROOT/'public/science/lab_pipeline.py').read_bytes()).hexdigest(),
      'definition':{'fields':20,'epochs_per_field':6,'sources_per_field':3,'moving_sources_per_field':1,'gaussian_sigma_pixels':.85,'noise_sigma':1,'pixel_scale_arcsec':6.15,'epoch_step_days':.2,'movement_pixels_per_epoch':.7,'detection_peak_threshold':5,'association_radius_arcsec':2},
      'summary':{'fields_with_recovered_mover':sum(r['correct_moving_tracks']>0 for r in records),'false_moving_tracks':sum(r['false_moving_tracks'] for r in records),'noise_only_detections':false_blank,'matched_detections':len(flux_errors),'median_fractional_flux_error':float(np.median(flux_errors)),'median_position_error_arcsec':float(np.median(position_errors))},
      'trials':records,'limitations':['Synthetic isolated Gaussian sources and independent Gaussian noise. Same known PSF family, independently rendered.','No crowding, variable PSF, cosmic rays, real backgrounds, orbital curvature or calibration uncertainty. No all-sky completeness claim.']}
    dest=ROOT/'research/results/dr1-holdout';dest.mkdir(parents=True,exist_ok=True)
    (dest/'candidate-images.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result['summary'],indent=2))
if __name__=='__main__':main()
