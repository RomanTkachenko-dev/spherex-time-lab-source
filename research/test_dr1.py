"""DR1 must use the ePSF delivered with its exposure, not an older substitute."""
from io import BytesIO
import unittest
import numpy as np
from astropy.io import fits
from test_laboratory import lab, gaussian_epsf

class DR1Test(unittest.TestCase):
    def make(self,include=True):
        y,x=np.indices((31,31));profile=np.exp(-((x-15.2)**2+(y-14.8)**2)/(2*.85**2));profile/=profile.sum()
        w=lab.WCS(naxis=2);w.wcs.crpix=[16,16];w.wcs.crval=[20,20];w.wcs.cdelt=[-6.15/3600,6.15/3600];w.wcs.ctype=['RA---TAN','DEC--TAN']
        header=w.to_header();header.update(OBSID='CONTROL',DETECTOR=1,TIMESYS='UTC',BUNIT='MJy / sr',CRPIX1A=1,CRPIX2A=1)
        header['MJD-AVG']=61000.;header['DATE-AVG']='2025-11-21T00:00:00'
        v=fits.Header();v['BUNIT']='MJy2 / sr2'
        hdus=[fits.PrimaryHDU(),fits.ImageHDU(120*profile+5,header,name='IMAGE'),fits.ImageHDU(np.full((31,31),.01),v,name='VARIANCE'),fits.ImageHDU(np.zeros((31,31),np.int32),name='FLAGS')]
        if include:
            e=fits.BinTableHDU.from_columns([fits.Column(name='XCENTER',format='E',array=[15]),fits.Column(name='YCENTER',format='E',array=[15]),fits.Column(name='EPSF',format='1089D',dim='(33,33)',array=[gaussian_epsf()])],name='EPSF')
            e.header.update(DETCOORD='sky',DETECTOR=1,OVSMPX=5,OVSMPY=5);hdus.append(e)
        lab.CAL[1]={'xc':np.array([15]),'yc':np.array([15]),'epsf':np.array([gaussian_epsf(1.5)]),'oversampling':(5,5),'channel':np.ones((31,31)),'wave':np.ones((31,31)),'width':np.full((31,31),.02)}
        ra,dec=w.all_pix2world(15.2,14.8,0)
        record={'id':'CONTROLD1','observation':'CONTROL','detector':1,'release':'spherex_dr1','url':'synthetic','cutout_url':'synthetic','ra':float(ra),'dec':float(dec)}
        stream=BytesIO();fits.HDUList(hdus).writeto(stream)
        return stream.getvalue(),record,{'fit_position':False,'detect':False}

    def test_native_epsf_overrides_older_calibration(self):
        result=lab.analyze_fits(*self.make())
        self.assertEqual(result['epsf_source'],'native-FITS-EPSF')
        self.assertAlmostEqual(result['target']['amplitude'],120,delta=.2)

    def test_missing_dr1_epsf_is_explicit(self):
        with self.assertRaisesRegex(ValueError,'EPSF'):lab.analyze_fits(*self.make(False))

if __name__=='__main__':unittest.main()
