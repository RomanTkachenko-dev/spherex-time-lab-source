import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseVOTable } from "../lib/votable.ts";
import { validateManifest, spectralDifference, mjdToIso, describeFlags, frameTimeFraction, nearestFrameIndexAtFraction, nearestFrameIndexAtMjd } from "../lib/science.ts";
import { MAX_SERIES_FRAMES } from "../lib/catalogue-batches.ts";

const dataset=JSON.parse(readFileSync(new URL("../public/data/atlas/manifest.json",import.meta.url),"utf8"));
test("UTC navigation handles dense observations, ties, identical epochs and series boundaries",()=>{
  const frames=[{mjd:61000},{mjd:61000.000001},{mjd:61000.000001},{mjd:61002}];
  assert.equal(nearestFrameIndexAtMjd(frames,61000.000001),1);
  assert.equal(nearestFrameIndexAtMjd(frames,60000),0);
  assert.equal(nearestFrameIndexAtMjd(frames,62000),3);
  assert.equal(nearestFrameIndexAtMjd([{mjd:1},{mjd:3}],2),0);
  const dense=Array.from({length:15360},(_,i)=>({mjd:61000+i/100000}));
  assert.equal(nearestFrameIndexAtMjd(dense,dense[12345].mjd),12345);
});
test("portable local asset storage preserves legacy science schemas and enforces hashes",()=>{
  const local=structuredClone(dataset),hash="a".repeat(64);
  local.display.asset_storage="indexeddb-sha256-v1";
  for(const frame of local.frames){frame.display_asset_sha256={};for(const name of ["image","object_image","quality_mask_image","object_quality_mask_image"]){frame[name]=`idb:11111111-1111-1111-1111-111111111111:${hash}`;frame.display_asset_sha256[name]=hash;}}
  assert.equal(validateManifest(local).schema_version,dataset.schema_version);
  local.frames[0].display_asset_sha256.image="b".repeat(64);
  assert.throws(()=>validateManifest(local),/контрольною сумою/);
});
test("observations retain unique identities, ordered times, and predicted-only coordinates",()=>{
  const m=validateManifest(dataset);
  assert.equal(m.frames.length,12);
  for(const f of m.frames){
    assert.equal(f.measurement,null); assert.equal(f.position_kind,"IRSA-predicted-per-exposure");
    assert.match(f.sha256_cutout,/^[a-f0-9]{64}$/);
    assert.ok(Math.abs(Date.parse(f.date+"Z")-Date.parse(mjdToIso(f.mjd)))<2);
  }
  const duplicate=structuredClone(dataset);duplicate.frames[1].id=duplicate.frames[0].id;
  assert.throws(()=>validateManifest(duplicate));
  const fake=structuredClone(dataset);fake.frames[0].measurement={confidence:1};
  assert.throws(()=>validateManifest(fake));
});
test("manifest accepts 120 all-frame series and rejects a larger series",()=>{
  const makeSeries=(length:number)=>({...dataset,frames:Array.from({length},(_,i)=>({...dataset.frames[i%dataset.frames.length],id:`frame_${i}`,observation_id:`observation_${i}`,mjd:61000+i,date:new Date((61000+i-40587)*86400000).toISOString()}))});
  assert.equal(validateManifest(makeSeries(120)).frames.length,120);
  assert.throws(()=>validateManifest(makeSeries(121)),/формату/);
});
test("streamed passport accepts large series only with content-addressed local display assets",()=>{
  const streamed=structuredClone(dataset);
  const assetHash="a".repeat(64), assetRef=`idb:${"b".repeat(8)}-${"b".repeat(4)}-${"b".repeat(4)}-${"b".repeat(4)}-${"b".repeat(12)}:${assetHash}`;
  streamed.schema_version=4;streamed.kind="field";streamed.archive_collection="spherex_qr2";streamed.dataset_doi="10.26131/IRSA652";
  streamed.query={ra:167.2,dec:5.15,start:"2025-12-14",end:"2025-12-14",detector:5,fov:0.12,max_frames:MAX_SERIES_FRAMES,wavelength_min:null,wavelength_max:null,release:"qr2",survey:"wide"};
  streamed.display={...streamed.display,low_MJy_sr:0.1005,high_MJy_sr:5,scale_algorithm:"signed-binary-exponent-histogram-v1",scale_sample_count:262144,scale_low_interval_MJy_sr:[0.1,0.101],scale_high_interval_MJy_sr:[4.99,5.01]};
  streamed.completeness={matched_count:121,selected_count:121,processed_count:121,catalogue_truncated:false,selection:"all archive matches",excluded:[]};
  streamed.frames=Array.from({length:121},(_,i)=>({...dataset.frames[i%dataset.frames.length],id:`stream_${i}`,observation_id:`stream_${i}`,mjd:61000+i,date:new Date((61000+i-40587)*86400000).toISOString(),release:"spherex_qr2",position_kind:"requested-sky-position",image:assetRef,object_image:assetRef,quality_mask_image:assetRef,object_quality_mask_image:assetRef,display_asset_sha256:{image:assetHash,object_image:assetHash,quality_mask_image:assetHash,object_quality_mask_image:assetHash}}));
  assert.equal(validateManifest(streamed).frames.length,121);
  const partlyRejected=structuredClone(streamed);partlyRejected.frames=partlyRejected.frames.slice(0,119);partlyRejected.completeness.processed_count=119;partlyRejected.completeness.excluded=[{id:"bad_a",reason:"WCS"},{id:"bad_b",reason:"FITS"}];
  assert.equal(validateManifest(partlyRejected).completeness?.excluded.length,2);
  assert.throws(()=>validateManifest({...streamed,frames:streamed.frames.slice(0,1)}));
  const broken=structuredClone(streamed);broken.frames[0].display_asset_sha256.image="bad";
  assert.throws(()=>validateManifest(broken),/контрольною сумою/);
  const badBounds=structuredClone(streamed);badBounds.display.scale_low_interval_MJy_sr=[0.2,0.1];
  assert.throws(()=>validateManifest(badBounds),/меж шкали/);
  const badCount=structuredClone(streamed);badCount.completeness.processed_count=120;
  assert.throws(()=>validateManifest(badCount),/повноти обробки/);
  const badMask=structuredClone(streamed);badMask.frames[0].object_quality_mask_image=`untrusted:${assetHash}`;
  assert.throws(()=>validateManifest(badMask),/контрольною сумою/);
});
test("multipart archive provenance covers the requested UTC dates contiguously and validates every raw hash",()=>{
  const m=structuredClone(dataset);
  m.schema_version=3;m.kind="field";m.archive_collection="spherex_qr2";m.dataset_doi="10.26131/IRSA652";
  m.query={ra:167.2,dec:5.15,start:"2025-12-14",end:"2025-12-16",detector:5,fov:0.12,max_frames:120,wavelength_min:null,wavelength_max:null,release:"qr2",survey:"wide"};
  m.frames=(m.frames as Array<Record<string,unknown>>).slice(0,2).map((f,i)=>({...f,id:`multipart${i}`,release:"spherex_qr2",position_kind:"requested-sky-position",image:"data:image/png;base64,AA==",object_image:"data:image/png;base64,AA==",quality_mask_image:"data:image/png;base64,AA==",source_url:"https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/example.fits"}));
  m.observation_table_url="https://irsa.ipac.caltech.edu/SIA?POS=CIRCLE+167.2+5.15+0.000001&COLLECTION=spherex_qr2&MAXREC=1000&TIME=61023+61024";
  m.observation_table_sha256="a".repeat(64);m.retrieved_at="2026-09-29T00:00:00.000Z";
  m.observation_table_parts=[{start:"2025-12-14",end:"2025-12-14",source_url:m.observation_table_url,source_sha256:"a".repeat(64),retrieved_at:m.retrieved_at,matched_count:2},{start:"2025-12-15",end:"2025-12-16",source_url:"https://irsa.ipac.caltech.edu/SIA?POS=CIRCLE+167.2+5.15+0.000001&COLLECTION=spherex_qr2&MAXREC=1000&TIME=61024+61026",source_sha256:"b".repeat(64),retrieved_at:m.retrieved_at,matched_count:3}];
  assert.equal(validateManifest(m).observation_table_parts?.length,2);
  const gap=structuredClone(m);gap.observation_table_parts![1].start="2025-12-16";
  assert.throws(()=>validateManifest(gap),/походження/);
  const badHash=structuredClone(m);badHash.observation_table_parts![1].source_sha256="bad";
  assert.throws(()=>validateManifest(badHash),/походження/);
});
test("multipart MOST provenance binds every service URL to its date window",()=>{
  const m=structuredClone(dataset);
  const retrieved="2026-09-29T00:00:00.000Z",hash1="a".repeat(64),hash2="b".repeat(64);
  const mostUrl=(start:string,end:string)=>"https://irsa.ipac.caltech.edu/cgi-bin/MOST/nph-most?"+new URLSearchParams({catalog:"spherex",input_type:"name_input",obj_name:"4 Vesta",obs_begin:start,obs_end:end,output_mode:"Brief"});
  const firstUrl=mostUrl("2025-08-01","2025-08-15");
  m.schema_version=3;m.kind="field";m.archive_collection="spherex_qr2";m.dataset_doi="10.26131/IRSA652";
  m.query={ra:220,dec:-12,start:"2025-08-01",end:"2025-08-31",detector:6,fov:0.3,max_frames:120,wavelength_min:null,wavelength_max:null,release:"qr2",survey:"most",most:{source:"IRSA MOST",source_url:firstUrl,source_sha256:hash1,target_name:"4 Vesta",catalog:"spherex",retrieved_at:retrieved,match_count:8}};
  m.frames=(m.frames as Array<Record<string,unknown>>).slice(0,2).map((f,i)=>({...f,id:`mostpart${i}`,release:"spherex_qr2",position_kind:"irsa-most-matched-position",image:"data:image/png;base64,AA==",object_image:"data:image/png;base64,AA==",quality_mask_image:"data:image/png;base64,AA==",source_url:"https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/example.fits"}));
  m.observation_table_url=firstUrl;m.observation_table_sha256=hash1;m.retrieved_at=retrieved;
  m.observation_table_parts=[{start:"2025-08-01",end:"2025-08-15",source_url:firstUrl,source_sha256:hash1,retrieved_at:retrieved,matched_count:4},{start:"2025-08-16",end:"2025-08-31",source_url:mostUrl("2025-08-16","2025-08-31"),source_sha256:hash2,retrieved_at:retrieved,matched_count:4}];
  assert.equal(validateManifest(m).observation_table_parts?.length,2);
  const wrongWindow=structuredClone(m);wrongWindow.observation_table_parts![1].source_url=mostUrl("2025-08-17","2025-08-31");
  assert.throws(()=>validateManifest(wrongWindow),/походження/);
});
test("schema 3 passports bind every frame to one QR release and survey",()=>{
  const m=structuredClone(dataset);
  const collection="spherex_qr3_deep";
  m.schema_version=3;m.kind="field";m.archive_collection=collection;m.dataset_doi="10.26131/IRSA662";
  m.query={ra:167.2,dec:5.15,start:"2025-12-14",end:"2025-12-14",detector:5,fov:0.12,max_frames:2,wavelength_min:null,wavelength_max:null,release:"qr3",survey:"deep"};
  m.frames=(m.frames as Array<Record<string,unknown>>).slice(0,2).map((f,i)=>({...f,id:"qr3test"+i,release:collection,position_kind:"requested-sky-position",image:"data:image/png;base64,AA==",object_image:"data:image/png;base64,AA==",quality_mask_image:"data:image/png;base64,AA==",object_quality_mask_image:"data:image/png;base64,AA==",source_url:"https://irsa.ipac.caltech.edu/ibe/data/spherex/qr3/level2/example.fits"}));
  assert.equal(validateManifest(m).archive_collection,collection);
  const mixed=structuredClone(m);mixed.frames[1].release="spherex_qr2_deep";
  assert.throws(()=>validateManifest(mixed));
  const wrongDoi=structuredClone(m);wrongDoi.dataset_doi="10.26131/IRSA652";
  assert.throws(()=>validateManifest(wrongDoi));
});
test("MOST and Gaia provenance survive the science passport validator",()=>{
  const m=structuredClone(dataset);
  m.schema_version=3;m.kind="field";m.archive_collection="spherex_qr2";m.dataset_doi="10.26131/IRSA652";
  m.query={ra:220,dec:-12,start:"2025-08-01",end:"2025-08-31",detector:6,fov:0.3,max_frames:2,wavelength_min:null,wavelength_max:null,release:"qr2",survey:"most",most:{source:"IRSA MOST",source_url:"https://irsa.ipac.caltech.edu/cgi-bin/MOST/nph-most?catalog=spherex",source_sha256:"a".repeat(64),target_name:"4 Vesta",catalog:"spherex",retrieved_at:"2026-09-29T00:00:00.000Z",match_count:8}};
  m.frames=(m.frames as Array<Record<string,unknown>>).slice(0,2).map((f,i)=>({...f,id:"mosttest"+i,release:"spherex_qr2",position_kind:"irsa-most-matched-position",image:"data:image/png;base64,AA==",object_image:"data:image/png;base64,AA==",quality_mask_image:"data:image/png;base64,AA==",object_quality_mask_image:"data:image/png;base64,AA==",source_url:"https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/example.fits"}));
  m.gaia_reference={service:"IRSA TAP · Gaia DR3",table:"gaia_dr3_source",source_url:"https://irsa.ipac.caltech.edu/TAP/sync?QUERY=SELECT",source_sha256:"b".repeat(64),retrieved_at:"2026-09-29T00:00:00.000Z",center_ra:220,center_dec:-12,radius_deg:0.32,record_count:1,truncated:false,sources:[{source_id:"2097892344989583488",ra:220.01,dec:-12.01,ra_error:0.1,dec_error:0.1,pmra:2,pmdec:-3,pmra_error:0.1,pmdec_error:0.1,ref_epoch:2016,phot_g_mean_mag:16.2}]};
  assert.equal(validateManifest(m).gaia_reference?.record_count,1);
  const broken=structuredClone(m);broken.gaia_reference!.source_sha256="not-a-hash";
  assert.throws(()=>validateManifest(broken),/Gaia DR3/);
});
test("spectral difference and flags remain descriptive rather than confidence scores",()=>{
  const m=validateManifest(dataset), diff=spectralDifference(m.frames[0],m.frames[8]);
  assert.ok(diff.delta>0.28&&diff.delta<0.29);assert.equal(diff.sameExposure,false);
  assert.deepEqual(spectralDifference(m.frames[0],m.frames[0]),{delta:0,widthRatio:0,sameExposure:true});
  assert.equal(describeFlags(524288),"OUTLIER");assert.equal(describeFlags(2097152),"SOURCE");
  assert.match(describeFlags(2147483648),/2147483648/);
  assert.equal(describeFlags(16),"Невідомі біти: 16");
});
test("timeline positions and seeking use elapsed observation time, not frame index",()=>{
  const irregular=[{mjd:100},{mjd:101},{mjd:110}];
  assert.equal(frameTimeFraction(irregular,1),0.1);
  assert.equal(nearestFrameIndexAtFraction(irregular,0.1),1);
  assert.equal(nearestFrameIndexAtFraction(irregular,0.7),2);
  assert.equal(nearestFrameIndexAtFraction(irregular,-1),0);
  assert.equal(frameTimeFraction([{mjd:5},{mjd:5}],1),0);
});
test("real IRSA SIA fixture uses FIELD names instead of generic column IDs",()=>{
  const parsed=parseVOTable(readFileSync(new URL("./fixtures/irsa-sia.vot",import.meta.url),"utf8"));
  assert.equal(parsed.rows.length,30); assert.ok(parsed.rows[0].access_url.startsWith("https://irsa.ipac.caltech.edu/"));
  assert.ok(Number(parsed.rows[0].t_min)>60000); assert.equal(parsed.rows[0].col_0,undefined);
});
test("VOTable handles null cells and refuses expansion, errors and malformed rows",()=>{
  const table='<TABLE><FIELD ID="col_0" name="t_min"/><FIELD name="url"/><DATA><TABLEDATA><TR><TD/><TD>a&amp;b</TD></TR></TABLEDATA></DATA></TABLE>';
  assert.deepEqual(parseVOTable(table).rows,[{t_min:"",url:"a&b"}]);
  assert.equal(parseVOTable(table+'<INFO value="OVERFLOW" name="QUERY_STATUS"/>').overflow,true);
  assert.throws(()=>parseVOTable(table+'<INFO value="ERROR" name="QUERY_STATUS"/>'));
  assert.throws(()=>parseVOTable('<!DOCTYPE x SYSTEM "secret">'+table));
  assert.throws(()=>parseVOTable(table.replace('<TD/>','')));
});
