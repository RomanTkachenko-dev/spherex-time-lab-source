"""Independent synthetic controls; these do not establish survey completeness."""
import importlib.util
from pathlib import Path
import unittest
import numpy as np
from astropy.wcs import WCS

spec = importlib.util.spec_from_file_location('laboratory', Path(__file__).resolve().parents[1]/'public/science/lab_pipeline.py')
lab = importlib.util.module_from_spec(spec); spec.loader.exec_module(lab)

def gaussian_epsf(sigma=.85):
    y, x = np.mgrid[-16:17, -16:17]/5
    return np.exp(-(x*x+y*y)/(2*sigma*sigma))/(2*np.pi*sigma*sigma)

class LaboratoryTest(unittest.TestCase):
    def setUp(self):
        self.y, self.x = np.mgrid[:31, :31].astype(float)
        self.epsf = gaussian_epsf()
        # Independent analytic injection, not the production spline renderer.
        p = np.exp(-((self.x-15.23)**2+(self.y-14.81)**2)/(2*.85**2)); p/=p.sum()
        self.image = 120*p+4+.07*(self.x-15)-.03*(self.y-15)
        self.var = np.full((31,31), .1**2); self.good = np.ones((31,31),bool)

    def test_centroid_flux_and_covariance(self):
        r=lab.fit_source(self.image,self.var,self.good,15,15,self.epsf,(5,5),True)
        self.assertAlmostEqual(r['x'],15.23,delta=.01);self.assertAlmostEqual(r['y'],14.81,delta=.01)
        self.assertAlmostEqual(r['amplitude'],120,delta=.2)
        self.assertTrue(np.all(np.linalg.eigvalsh(r['position_covariance_pixel2'])>0))

    def test_masked_core_and_edges_rejected(self):
        self.good[13:18,13:18]=False
        with self.assertRaisesRegex(ValueError,'20%'):lab.fit_source(self.image,self.var,self.good,15,15,self.epsf,(5,5))
        with self.assertRaisesRegex(ValueError,'11×11'):lab.fit_source(self.image,self.var,self.good,1,1,self.epsf,(5,5))

    def test_forced_negative_flux_is_not_clipped(self):
        r=lab.fit_source(-self.image,self.var,self.good,15.23,14.81,self.epsf,(5,5),False)
        self.assertLess(r['amplitude'],0);self.assertIsNone(r['position_covariance_pixel2'])

    def test_response_overlap(self):
        x=np.linspace(1,2,501); a=(x,np.exp(-((x-1.5)/.03)**2))
        self.assertAlmostEqual(lab.response_distance(a,a),0,places=10)
        self.assertGreater(lab.response_distance(a,(x+.2,a[1])),.99)
        self.assertIsNone(lab.response_distance(a,None))

    def test_psf_change_is_fit_not_flux_change(self):
        results=[]
        for sigma in [.65,1.05]:
            p=np.exp(-((self.x-15.2)**2+(self.y-15.1)**2)/(2*sigma*sigma));p/=p.sum()
            result=lab.fit_source(80*p+3,self.var,self.good,15.2,15.1,gaussian_epsf(sigma),(5,5),False)
            results.append(result['amplitude'])
        self.assertLess(abs(results[0]-results[1]),.4)

    def test_track_across_ra_zero_with_stationary_distractor(self):
        frames=[]
        for i in range(5):
            frames.append({'id':f'f{i}','mjd':60000+i*.1,'detections':[
                {'ra':(359.9998+i*.0001)%360,'dec':45.,'snr':12},
                {'ra':359.99,'dec':45.01,'snr':30}]})
        options={'ra':0.,'dec':45.,'radius_arcsec':.05,'max_speed_arcsec_day':10,'max_gap_days':1}
        tracks=lab.link_tracks(frames,options)
        self.assertEqual(len(tracks),2)
        moving=[t for t in tracks if t['motion_resolved']]
        self.assertEqual(len(moving),1);self.assertEqual(moving[0]['count'],5)
        self.assertAlmostEqual(moving[0]['speed_arcsec_day'],3.6/np.sqrt(2),places=3)

    def test_no_track_from_same_epoch_or_two_epochs(self):
        f=[{'id':str(i),'mjd':60000+i//2*.1,'detections':[{'ra':1.,'dec':1.,'snr':8}]} for i in range(4)]
        self.assertEqual(lab.link_tracks(f,{'ra':1.,'dec':1.,'radius_arcsec':1,'max_speed_arcsec_day':10,'max_gap_days':1}),[])

    def test_empty_spectrum_has_102_missing_channels(self):
        channels=lab.spectral_summary([], .05)
        self.assertEqual(len(channels),102)
        self.assertTrue(all(c['count']==0 and c['weighted_flux_uJy'] is None for c in channels))

    def test_spectral_cohort_rejects_different_release_and_shifted_response(self):
        wave=np.linspace(.9,1.1,300)
        lab.CAL[1]={'lambda_1':wave,'response_1':np.exp(-((wave-1)/.01)**2),'centre_1':np.array(1.)}
        point={'channel_local':1,'quality_ok':True,'wavelength_um':1.,'flux_uJy':10.,'flux_error_uJy':1.}
        frames=[{'id':'a','detector':1,'mjd':1.,'release':'qr3','target':point},
                {'id':'b','detector':1,'mjd':2.,'release':'qr2','target':point},
                {'id':'c','detector':1,'mjd':3.,'release':'qr3','target':{**point,'wavelength_um':1.05}}]
        result=lab.spectral_summary(frames,.05)[0]
        self.assertEqual([p['compatible'] for p in result['comparisons']],[True,False,False])
        self.assertEqual(result['dof'],0)

    def test_detection_noise_and_injected_source(self):
        w=WCS(naxis=2);w.wcs.crpix=[16,16];w.wcs.crval=[120,30];w.wcs.cdelt=[-6.15/3600,6.15/3600];w.wcs.ctype=['RA---TAN','DEC--TAN']
        cal={'xc':np.array([15]),'yc':np.array([15]),'epsf':np.array([self.epsf]),'oversampling':(5,5),
             'channel':np.broadcast_to(1,(2040,2040)),'wave':np.broadcast_to(1.,(2040,2040)),'width':np.broadcast_to(.02,(2040,2040))}
        args=(self.var,self.good,w,{'CRPIX1A':1,'CRPIX2A':1},cal,5,100)
        points,_,_=lab.detect_sources(self.image,*args)
        self.assertEqual(len(points),1)
        noise=np.random.default_rng(628).normal(0,.1,self.image.shape)
        points,_,_=lab.detect_sources(noise,*args)
        self.assertEqual(points,[])

    def test_pixel_flux_and_sky_covariance_units(self):
        w=WCS(naxis=2);w.wcs.crpix=[16,16];w.wcs.crval=[120,30];w.wcs.cdelt=[-6.15/3600,6.15/3600];w.wcs.ctype=['RA---TAN','DEC--TAN']
        cal={'xc':np.array([15]),'yc':np.array([15]),'epsf':np.array([self.epsf]),'oversampling':(5,5),
             'channel':np.ones((2040,2040),dtype='uint8'),'wave':np.ones((2040,2040)),'width':np.full((2040,2040),.02)}
        m=lab.measure_at(self.image,self.var,self.good,w,{'CRPIX1A':1,'CRPIX2A':1},cal,15,15,True)
        self.assertAlmostEqual(m['pixel_solid_angle_sr'],(6.15*np.pi/(180*3600))**2,delta=1e-14)
        self.assertTrue(m['quality_ok']);self.assertGreater(m['flux_error_uJy'],0)

if __name__=='__main__':unittest.main()
