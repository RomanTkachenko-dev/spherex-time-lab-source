"""Checks display geometry and provenance, not detection accuracy or photometry."""
import json
import unittest
from hashlib import sha256
from pathlib import Path
import numpy as np
from PIL import Image
from build_dataset import display_wcs, project, BAD_MASK

ROOT=Path(__file__).resolve().parents[1]

class ScienceChecks(unittest.TestCase):
    def test_projection_orientation(self):
        w=display_wcs(167.2,5.15,0.26)
        center=np.array(w.all_world2pix(167.2,5.15,0),dtype=float)
        self.assertTrue(np.allclose(center,[127.5,127.5]))
        east=w.all_world2pix(167.21,5.15,0)
        north=w.all_world2pix(167.2,5.16,0)
        self.assertLess(east[0],center[0])
        self.assertGreater(north[1],center[1])  # PNG is flipped vertically.

    def test_flagged_signal_is_retained(self):
        w=display_wcs(20,0,0.1,n=8)
        signal=np.ones((8,8));signal[3,3]=99
        flags=np.zeros((8,8),dtype=np.uint32);flags[3,3]=1<<19
        image,mask=project(signal,flags,w,w,n=8)
        self.assertAlmostEqual(image[3,3],99,places=5)
        self.assertTrue(mask[3,3])
        self.assertEqual(int(BAD_MASK)&(1<<21),0)
        self.assertEqual(int(BAD_MASK)&(1<<12),0)

    def test_assets_and_cached_fits_hashes(self):
        m=json.loads((ROOT/'public/data/atlas/manifest.json').read_text(encoding='utf8'))
        for f in m['frames']:
            for kind in ('image','object_image'):
                p=ROOT/'public'/f[kind].lstrip('/')
                with Image.open(p) as image:
                    self.assertEqual(image.size,(256,256));self.assertEqual(image.mode,'L')
                with Image.open(p.with_name(p.stem+'-mask.png')) as mask:
                    self.assertEqual(mask.size,(256,256));self.assertEqual(mask.mode,'RGBA')
            cache=ROOT/'.science-cache'/f"{f['id']}.fits"
            if cache.exists():
                self.assertEqual(sha256(cache.read_bytes()).hexdigest(),f['sha256_cutout'])
            self.assertIsNone(f['measurement'])

if __name__=='__main__':unittest.main()
