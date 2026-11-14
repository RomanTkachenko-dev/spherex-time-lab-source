import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {allDetectorRecords,currentLabRecords,labOptions,measurementsCsv,nominalChannel,type LabOptions,type LabReport} from '../lib/laboratory.ts';
import type {Manifest} from '../lib/science.ts';
const opts:LabOptions={ra:10,dec:20,fit_position:false,detect:true,snr:5,max_sources:100,response_tolerance:.05,radius_arcsec:2,max_speed_arcsec_day:100,max_gap_days:2};
test('laboratory bounds reject NaN and invalid motion parameters',()=>{
  assert.equal(labOptions(opts),opts);
  for(const patch of [{snr:NaN},{radius_arcsec:0},{max_sources:1.5},{ra:360},{response_tolerance:1}])assert.throws(()=>labOptions({...opts,...patch}));
});
test('existing demo cutout geometry and hashes are preserved',()=>{
  const manifest=JSON.parse(readFileSync(new URL('../public/data/atlas/manifest.json',import.meta.url),'utf8')) as Manifest;
  const records=currentLabRecords(manifest);
  assert.equal(records.length,12);assert.equal(records[0].fov,.3);
  assert.equal(records[0].expected_sha256,manifest.frames[0].sha256_cutout);
  assert.equal(records[0].cutout_url,manifest.frames[0].cutout_url);
  assert.equal(records[0].ra,manifest.frames[0].ra);
});
test('CSV preserves negative flux and conditional error',()=>{
  const r={frames:[{id:'frame1',date:'2026-01-01T00:00:00',detector:2,target:{channel_local:1,wavelength_um:1.2,flux_uJy:-2,flux_error_uJy:3,ra:1,dec:2,reduced_chi2:1,quality_ok:true}}]} as LabReport;
  assert.match(measurementsCsv(r),/2,18,1.2,-2,3/);
});
test('edge channels never alias a neighbouring detector in CSV',()=>{
  assert.equal(nominalChannel(1,1),1);assert.equal(nominalChannel(6,17),102);
  for(const local of [0,18,NaN])assert.equal(nominalChannel(2,local),null);
  const r={frames:[{id:'edge',date:'2026-01-01',detector:2,target:{channel_local:0,wavelength_um:1.2,flux_uJy:1,flux_error_uJy:3,ra:1,dec:2,reduced_chi2:1,quality_ok:true}}]} as LabReport;
  assert.match(measurementsCsv(r),/edge,2026-01-01,2,,1.2/);
});
test('all-detector search completes date subdivisions and retains provenance',async t=>{
  const calls:{detector:number;start:string;end:string;wavelength_min:unknown}[]=[];
  t.mock.method(globalThis,'fetch',async (_url:unknown,init:RequestInit)=>{
    const q=JSON.parse(String(init.body));calls.push(q);
    if(q.start!==q.end)return Response.json({error:'split'},{status:413});
    return Response.json({records:[{id:'obs'+q.start,observation:'obs'+q.start,detector:q.detector,mjd:q.start.endsWith('01')?61000:61001,url:`https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/example${q.detector}.fits`}],source_url:'catalogue',source_sha256:'hash'+q.detector,retrieved_at:'2026-10-03'});
  });
  const m={query:{ra:10,dec:20,release:'qr2',survey:'wide',fov:.1,start:'2025-12-01',end:'2025-12-02',detector:1,wavelength_min:1,wavelength_max:2}} as Manifest;
  const result=await allDetectorRecords(m,new AbortController().signal,()=>{});
  assert.equal(calls.length,18);assert.equal(result.records.length,12);assert.equal(result.catalogue.length,12);
  assert.deepEqual([...new Set(result.records.map(r=>r.detector))],[1,2,3,4,5,6]);
  assert.ok(calls.every(q=>q.wavelength_min===null));
  assert.ok(result.records.every(r=>r.release==='spherex_qr2'&&r.ra===10&&r.dec===20));
});
