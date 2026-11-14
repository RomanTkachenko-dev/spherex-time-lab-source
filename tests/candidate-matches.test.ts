import test from 'node:test';
import assert from 'node:assert/strict';
import {associateCandidates,candidateCone,separationArcsec} from '../lib/candidate-matches.ts';
import type {LabReport} from '../lib/laboratory.ts';
import type {GaiaReference} from '../lib/gaia.ts';

function fixture(){
  const report={frames:[0,1,2].map(i=>({mjd:57388+i,detections:[{ra:359.9999,dec:0}]})),tracks:[{detections:[0,1,2].map(i=>({frame:i,detection:0}))}]} as unknown as LabReport;
  const catalogue={center_ra:0,center_dec:0,radius_deg:.2,truncated:false,sources:[{source_id:'9007199254740993',ra:.0001,dec:0,pmra:0,pmdec:0,ref_epoch:2016}]} as GaiaReference;
  return {report,catalogue};
}
test('Gaia association requires the same identifier at every epoch across RA zero',()=>{
  const {report,catalogue}=fixture();const result=associateCandidates(report,catalogue);
  assert.equal(result.tracks[0].status,'possible-association');
  assert.equal(result.tracks[0].candidates[0].source_id,'9007199254740993');
  assert.ok(Math.abs(result.tracks[0].candidates[0].rms_arcsec-.72)<1e-6);
  report.frames[2].detections[0].ra=.01;
  assert.equal(associateCandidates(report,catalogue).tracks[0].status,'no-association');
});
test('ambiguous, truncated and repeated-epoch matches are never definite identifications',()=>{
  const {report,catalogue}=fixture();catalogue.sources.push({...catalogue.sources[0],source_id:'2'});
  assert.equal(associateCandidates(report,catalogue).tracks[0].status,'ambiguous');
  catalogue.truncated=true;
  assert.equal(associateCandidates(report,catalogue).tracks[0].status,'incomplete');
  catalogue.truncated=false;report.frames[1].mjd=report.frames[0].mjd;
  assert.equal(associateCandidates(report,catalogue).tracks[0].status,'incomplete');
});
test('missing proper motion stays explicit and catalogue scope is bounded',()=>{
  const {report,catalogue}=fixture();catalogue.sources[0].pmra=null;
  assert.equal(associateCandidates(report,catalogue).tracks[0].candidates[0].motion_applied,false);
  catalogue.radius_deg=.0001;
  assert.equal(associateCandidates(report,catalogue).tracks[0].status,'incomplete');
  assert.ok(candidateCone(report)!.radius>.1);
  report.frames[2].detections[0].ra=180;
  assert.throws(()=>candidateCone(report));
  assert.ok(separationArcsec(0,89.999,180,89.999)<8);
});
