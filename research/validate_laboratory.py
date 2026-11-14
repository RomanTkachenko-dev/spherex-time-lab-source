"""Held-out synthetic injections and noise controls with reproducible seeds."""
import json
from pathlib import Path
import numpy as np
from test_laboratory import lab, gaussian_epsf

def main():
    rng=np.random.default_rng(20261004)
    y,x=np.mgrid[:31,:31].astype(float); variance=np.ones((31,31));valid=np.ones((31,31),bool)
    flux_z=[];position_errors=[];failures=0
    for _ in range(80):
        cx,cy=15+rng.uniform(-.45,.45,2);flux=float(rng.uniform(70,180))
        p=np.exp(-((x-cx)**2+(y-cy)**2)/(2*.85**2));p/=p.sum()
        image=flux*p+10+.12*(x-15)+rng.normal(size=x.shape)
        try:r=lab.fit_source(image,variance,valid,15,15,gaussian_epsf(),(5,5),True)
        except ValueError:failures+=1;continue
        flux_z.append((r['amplitude']-flux)/r['error']);position_errors.append(np.hypot(r['x']-cx,r['y']-cy))
    # Independent held-out motion fields; synthetic astrometric scatter 0.1 arcsec.
    recovered=0;false_moving=0
    options={'ra':40.,'dec':20.,'radius_arcsec':.6,'max_speed_arcsec_day':50,'max_gap_days':1}
    for _ in range(20):
        frames=[]
        for epoch in range(5):
            points=[]
            for source in range(6):
                e=source*25+(epoch*.12*12 if source==0 else 0)+rng.normal(0,.1)
                n=source*20+rng.normal(0,.1)
                c=lab.SkyCoord(40*lab.u.deg,20*lab.u.deg).spherical_offsets_by(e*lab.u.arcsec,n*lab.u.arcsec)
                points.append({'ra':float(c.ra.deg),'dec':float(c.dec.deg),'snr':10})
            frames.append({'id':str(epoch),'mjd':60000+epoch*.12,'detections':points})
        tracks=lab.link_tracks(frames,options)
        movers=[t for t in tracks if t['motion_resolved']]
        recovered+=int(any(all(d['detection']==0 for d in t['detections']) for t in movers))
        false_moving+=sum(not all(d['detection']==0 for d in t['detections']) for t in movers)
    result={'seed':20261004,'injections':80,'failed_fits':failures,'mean_flux_z':float(np.mean(flux_z)),
            'std_flux_z':float(np.std(flux_z,ddof=1)),'fraction_within_2sigma':float(np.mean(np.abs(flux_z)<=2)),
            'median_position_error_pixels':float(np.median(position_errors)),
            'motion_fields':20,'injected_moving_tracks':20,'recovered_moving_tracks':recovered,'false_moving_tracks':false_moving,
            'limitations':'Ideal isolated Gaussian injections; independent Gaussian noise; synthetic detections for tracking. Not real-sky completeness, not end-to-end detector purity.'}
    dest=Path(__file__).parent/'results/laboratory';dest.mkdir(parents=True,exist_ok=True)
    (dest/'synthetic-validation.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result,indent=2))

if __name__=='__main__':main()
