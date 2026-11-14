import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateArchiveScope,cutoutRequest} from '../lib/field-query.ts';
import {cubeMetadata,cubeRenderFrequency} from '../lib/hips.ts';
const snapshot=JSON.parse(readFileSync(new URL('../lib/spherex-hips.json',import.meta.url),'utf8'));
test('DR1 spectral images and deep collection are kept separate from all-sky cube',()=>{
  assert.equal(validateArchiveScope({release:'dr1',survey:'wide'}).collection,'spherex_dr1');
  assert.equal(validateArchiveScope({release:'dr1',survey:'deep'}).collection,'spherex_dr1_deep');
  const p={url:'https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/a.fits',ra:0,dec:0,fov:.12,release:'dr1'};
  assert.ok(cutoutRequest(p).includes('/dr1/level2/'));
  assert.throws(()=>cutoutRequest({...p,release:'qr3'}));
  assert.throws(()=>cutoutRequest({...p,url:p.url.replace('level2','hips5_cube')}));
});
test('all 102 renderer planes map exactly to their official metadata indices',()=>{
  const m=cubeMetadata(snapshot.properties),lo=299792458/m.max,hi=299792458/m.min;
  for(let i=0;i<102;i++)assert.equal(Math.floor((cubeRenderFrequency(i,m)-lo)/(hi-lo)*m.depth),i);
  assert.equal(m.wavelengths[0],.753);assert.equal(m.wavelengths[101],4.988);
  assert.throws(()=>cubeRenderFrequency(102,m));
  assert.throws(()=>cubeMetadata({...snapshot.properties,hips_cube_depth:'101'}));
});
