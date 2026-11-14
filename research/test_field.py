"""Display-kernel tests; synthetic fixtures below do not establish sky accuracy."""
import base64
from copy import deepcopy
from hashlib import sha256
from io import BytesIO
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('field_pipeline',ROOT/'public/science/field_pipeline.py')
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)

def synthetic_field(data):
    """A documented synthetic TAN grid; spectral calibration is stubbed in tests."""
    header=p.display_wcs(20,0,0.32,n=64).to_header()
    header.update(OBSID='SYNTH_BLANK',DETECTOR=1,TIMESYS='UTC',BUNIT='MJy/sr',XPOSURE=100)
    header['MJD-AVG']=61023.0
    header['DATE-AVG']='2025-12-14T00:00:00'
    header['DATE-BEG']='2025-12-13T23:59:10'
    header['DATE-END']='2025-12-14T00:00:50'
    hdus=p.fits.HDUList([p.fits.PrimaryHDU(),p.fits.ImageHDU(data,header=header,name='IMAGE'),
        p.fits.ImageHDU(np.zeros(data.shape,dtype=np.uint32),name='FLAGS')])
    stream=BytesIO();hdus.writeto(stream)
    record={'id':'SYNTH_BLANKD1','observation':'SYNTH_BLANK','release':'spherex_qr3',
        'url':'https://irsa.ipac.caltech.edu/synthetic-test-only.fits',
        'cutout_url':'https://irsa.ipac.caltech.edu/synthetic-test-only.fits','retrieved_at':'2026-09-29T00:00:00Z'}
    query={'ra':20,'dec':0,'fov':0.03,'detector':1,'release':'qr3','survey':'wide'}
    return stream.getvalue(),record,query

class FieldChecks(unittest.TestCase):
    def test_missing_image_is_excluded_for_fixed_and_moving_fields(self):
        raw,record,query=synthetic_field(np.full((64,64),np.nan))
        with patch.object(p,'spectral_at',return_value=(1.2,0.02)):
            for moving in (False,True):
                with self.subTest(moving=moving):
                    q={**query,**({'most':{'target_name':'synthetic'}} if moving else {})}
                    r={**record,'target_ra':20.1,'target_dec':0}
                    result,reason=p.process_fits(raw,r,q)
                    self.assertIsNone(result)
                    self.assertIn('скінченних',reason)

    def test_moving_target_keeps_finite_object_when_fixed_field_is_empty(self):
        data=np.full((64,64),np.nan);data[25:40,5:20]=7
        raw,record,query=synthetic_field(data)
        record.update(target_ra=20.1,target_dec=0)
        with patch.object(p,'spectral_at',return_value=(1.2,0.02)):
            fixed,reason=p.process_fits(raw,record,query)
            self.assertIsNone(fixed)
            moving,reason=p.process_fits(raw,record,{**query,'most':{'target_name':'synthetic'}})
        self.assertIsNone(reason)
        frame,sky,object_sky,*_=moving
        self.assertEqual(frame['quality']['finite_pixel_count'],0)
        self.assertGreater(frame['quality']['target_finite_pixel_count'],0)
        self.assertFalse(np.isfinite(sky).any());self.assertTrue(np.isfinite(object_sky).any())

    def test_missing_data_texture_differs_from_finite_zero_signal(self):
        data=np.zeros((16,16));data[:8,:]=np.nan
        gray=p.display_gray(data,0,10)
        self.assertEqual(set(np.unique(gray[:8])),{32,56})
        self.assertEqual(set(np.unique(gray[8:])),{0})

    def test_stream_checkpoint_roundtrip_and_corruption_rejection(self):
        p.reset_stream();p._add_scale_samples(np.linspace(-4,8,10000))
        expected=p.stream_scale_limits();saved=p.export_stream_state()
        p.reset_stream();p.restore_stream_state(saved)
        self.assertEqual(p.stream_scale_limits(),expected)
        for mutate in ('count','duplicate','negative','version'):
            state=json.loads(saved)
            if mutate=='count':state['sample_count']+=1
            elif mutate=='duplicate':state['bins'].append(state['bins'][0])
            elif mutate=='negative':state['bins'][0][1]=-1
            else:state['version']=99
            with self.subTest(mutate=mutate),self.assertRaises(ValueError):p.restore_stream_state(json.dumps(state))
            self.assertEqual(p.stream_scale_limits(),expected)

    def test_rejected_nonfinite_metadata_does_not_change_stream_histogram(self):
        raw,record,query=synthetic_field(np.arange(64*64,dtype=float).reshape(64,64))
        p.reset_stream()
        with tempfile.TemporaryDirectory() as directory,patch.object(p,'spectral_at',return_value=(1.2,0.02)):
            path=Path(directory)/'frame.fits'
            path.write_bytes(raw)
            first=json.loads(p.add_stream_frame(str(path),json.dumps(record),json.dumps(query)))
            self.assertTrue(first['included'])
            before=p.export_stream_state()
            sample_count=json.loads(before)['sample_count']
            self.assertGreater(sample_count,0)
            for invalid in ('Inf','-Inf','NaN'):
                with self.subTest(exposure=invalid):
                    with p.fits.open(BytesIO(raw)) as hdus:
                        # FITS string metadata can convert to nonfinite floats.
                        hdus['IMAGE'].header['XPOSURE']=invalid
                        product=BytesIO();hdus.writeto(product)
                    path.write_bytes(product.getvalue())
                    with self.assertRaises(ValueError):
                        p.add_stream_frame(str(path),json.dumps(record),json.dumps(query))
                    self.assertEqual(p.export_stream_state(),before)
            path.write_bytes(raw)
            second=json.loads(p.add_stream_frame(str(path),json.dumps(record),json.dumps(query)))
            self.assertTrue(second['included'])
            self.assertEqual(json.loads(p.export_stream_state())['sample_count'],2*sample_count)

    def test_streaming_percentile_brackets_cover_exact_reference_values(self):
        rng=np.random.default_rng(41)
        values=np.concatenate([-np.exp(rng.normal(0,2,50000)),np.zeros(4000),np.exp(rng.normal(0,2,90000)),np.array([-1e100,1e100,np.nan,np.inf])])
        p.reset_stream();p._add_scale_samples(values[:30000]);p._add_scale_samples(values[30000:])
        scale=p.stream_scale_limits()
        exact_low,exact_high=np.percentile(values[np.isfinite(values)],[12,99.7])
        self.assertLessEqual(scale['low_interval'][0],exact_low);self.assertGreaterEqual(scale['low_interval'][1],exact_low)
        self.assertLessEqual(scale['high_interval'][0],exact_high);self.assertGreaterEqual(scale['high_interval'][1],exact_high)
        self.assertLessEqual(scale['low_interval'][0],scale['low']);self.assertGreaterEqual(scale['low_interval'][1],scale['low'])
        self.assertLessEqual(scale['high_interval'][0],scale['high']);self.assertGreaterEqual(scale['high_interval'][1],scale['high'])
        self.assertEqual(scale['sample_count'],int(np.isfinite(values).sum()))
        self.assertEqual(scale['algorithm'],'signed-binary-exponent-histogram-v1')

    def test_streaming_histogram_footprint_stays_constant_as_frames_arrive(self):
        values=np.linspace(-4,8,4096,dtype=np.float64)
        p.reset_stream();initial=p._stream_histogram.nbytes
        for _ in range(300):p._add_scale_samples(values)
        self.assertEqual(p._stream_histogram.nbytes,initial)
        self.assertEqual(p._stream_sample_count,300*values.size)

    def test_wrap_and_polar_coordinates(self):
        for ra,dec in [(359.999,0),(0,0),(15,89.9),(15,-89.9)]:
            w=p.display_wcs(ra,dec,0.1)
            x,y=w.all_world2pix(ra,dec,0)
            self.assertTrue(np.allclose([x,y],[127.5,127.5],atol=1e-7))
        w=p.display_wcs(359.999,0,0.1)
        self.assertLess(w.all_world2pix(0.001,0,0)[0],127.5)

    def test_flags_missing_pixels_and_signal(self):
        w=p.display_wcs(20,0,0.1,n=8)
        a=np.ones((8,8));a[3,3]=99;a[5,5]=np.nan
        flags=np.zeros_like(a,dtype=np.uint32);flags[3,3]=1<<19
        rendered,mask,footprint=p.project(a,flags,w,w,n=8)
        self.assertAlmostEqual(rendered[3,3],99,places=5)
        self.assertTrue(mask[3,3]);self.assertTrue(np.isnan(rendered[5,5]));self.assertTrue(mask[5,5])
        self.assertTrue(footprint.all())
        self.assertEqual(int(p.BAD_MASK)&((1<<21)|(1<<12)),0)
        self.assertNotEqual(int(p.BAD_MASK)&(1<<31),0)

    def test_geometric_coverage_is_separate_from_flagged_usable_area(self):
        a=np.ones((8,8));flags=np.zeros((8,8),dtype=np.uint32);flags[2:4,2:4]=1<<19
        w=p.display_wcs(20,0,0.1,n=8)
        rendered,mask,footprint=p.project(a,flags,w,w,n=8)
        metrics=p.coverage_metrics(rendered,mask,footprint)
        self.assertEqual(metrics['coverage_fraction'],1.0)
        self.assertLess(metrics['usable_coverage_fraction'],1.0)
        self.assertGreater(metrics['flagged_display_fraction'],0.0)
        outside=p.display_wcs(120,0,0.1,n=8)
        blank,bad,uncovered=p.project(a,flags,w,outside,n=8)
        self.assertFalse(uncovered.any())
        self.assertEqual(p.coverage_metrics(blank,bad,uncovered)['coverage_fraction'],0.0)

    def test_common_stretch_and_minimum_series(self):
        # Deliberately synthetic arrays verify a shared display mapping only.
        a=np.arange(65536,dtype=float).reshape(256,256);mask=np.zeros_like(a,dtype=bool)
        f={'mjd':1,'id':'test1'};g={'mjd':2,'id':'test2'}
        c={'query':dict(ra=20,dec=0,fov=.1,detector=1,start='2025-01-01',end='2025-01-02',max_frames=2),
           'source_url':'test-only','source_sha256':'test-only','retrieved_at':'test-only',
           'matched_count':2,'records':[f,g],'catalogue_truncated':False,'selection':'test-only'}
        m=p.finalize_series([(f,a,a,mask,mask),(g,a,a,mask,mask)],c,[],{})
        self.assertEqual(m['frames'][0]['image'],m['frames'][1]['image'])
        raw=base64.b64decode(m['frames'][0]['image'].split(',')[1])
        with Image.open(BytesIO(raw)) as image:self.assertEqual(image.size,(256,256))
        self.assertEqual(m['completeness']['processed_count'],2)
        with self.assertRaises(ValueError):p.finalize_series([(f,a,a,mask,mask)],c,[],{})

    @unittest.skipUnless((ROOT/'.science-cache/field-first-record.json').exists(),'run a live cutout check to populate optional IRSA cache')
    def test_actual_irsa_cutout_identity_provenance_and_wavelength_filter(self):
        cache=ROOT/'.science-cache'
        raw=(cache/'field-first.fits').read_bytes()
        record=json.loads((cache/'field-first-record.json').read_text())
        catalogue=json.loads((cache/'field-catalogue.json').read_text(encoding='utf-8-sig'))
        q=catalogue['query'];item,reason=p.process_fits(raw,record,q)
        self.assertIsNone(reason);f=item[0]
        self.assertIsNone(f['measurement']);self.assertEqual(f['position_kind'],'requested-sky-position')
        self.assertEqual(f['sha256_cutout'],sha256(raw).hexdigest())
        self.assertTrue(0<f['quality']['coverage_fraction']<=1)
        self.assertEqual((f['ra'],f['dec']),(q['ra'],q['dec']))
        self.assertLess(f['quality']['coordinate_roundtrip_arcsec'],1e-3)
        # A disjoint test interval must exclude this frame without editing it.
        reject={**q,'wavelength_min':f['wavelength_um']+1,'wavelength_max':f['wavelength_um']+2}
        excluded,reason=p.process_fits(raw,record,reject)
        self.assertIsNone(excluded);self.assertIsNotNone(reason)
        with self.assertRaises(ValueError):p.process_fits(raw,{**record,'observation':'wrong-observation'},q)

    @unittest.skipUnless((ROOT/'.science-cache/field-first-record.json').exists(),'run a live cutout check to populate optional IRSA cache')
    def test_streamed_two_pass_path_on_real_fits_pixels_with_synthetic_identities(self):
        cache=ROOT/'.science-cache'
        raw=(cache/'field-first.fits').read_bytes()
        base_record=json.loads((cache/'field-first-record.json').read_text())
        catalogue=json.loads((cache/'field-catalogue.json').read_text(encoding='utf-8-sig'))
        query={**catalogue['query'],'max_frames':15360}
        records=[]; first_pass=[]; raw_products=[]
        p.reset_stream()
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'frame.fits'
            for index in range(2):
                observation=f'SYNTH_STREAM_{index:03}'
                with p.fits.open(BytesIO(raw)) as hdus:
                    hdus['IMAGE'].header['OBSID']=observation
                    product=BytesIO();hdus.writeto(product)
                synthetic_raw=product.getvalue();raw_products.append(synthetic_raw)
                record={**base_record,'id':observation+'D5','observation':observation}
                records.append(record);path.write_bytes(synthetic_raw)
                result=json.loads(p.add_stream_frame(str(path),json.dumps(record),json.dumps(query)))
                self.assertTrue(result['included'],result.get('reason'))
                first_pass.append(result['frame'])
            scale=p.stream_scale_limits()
            frames=[];series_id='11111111-1111-4111-8111-111111111111'
            for record,raw_product,first in zip(records,raw_products,first_pass):
                path.write_bytes(raw_product)
                rendered=json.loads(p.render_stream_frame(str(path),json.dumps(record),json.dumps(query),json.dumps(scale)))
                frame=rendered['frame']
                self.assertEqual(frame['sha256_cutout'],first['sha256_cutout'])
                self.assertEqual(frame['id'],first['id'])
                hashes={}
                for name,uri in rendered['assets'].items():
                    png=base64.b64decode(uri.split(',',1)[1]);digest=sha256(png).hexdigest()
                    frame[name]=f'idb:{series_id}:{digest}';hashes[name]=digest
                frame['display_asset_sha256']=hashes;frames.append(frame)
        source=json.loads((cache/'field-catalogue.json').read_text(encoding='utf-8-sig'))
        source.update({'query':query,'records':records,'matched_count':2,'candidate_count':2,'catalogue_truncated':False,'selection':'synthetic two-pass test'})
        manifest=p.finish_stream(json.dumps(source),json.dumps(frames),'[]','{}',json.dumps(scale))
        self.assertEqual(manifest['schema_version'],4)
        self.assertEqual(manifest['completeness']['processed_count'],2)
        self.assertEqual(manifest['display']['scale_sample_count'],scale['sample_count'])
        self.assertEqual(len(manifest['frames']),2)

if __name__=='__main__':unittest.main()
