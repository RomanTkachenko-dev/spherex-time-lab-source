import test from "node:test";
import assert from "node:assert/strict";
import { parseMostBrief } from "../lib/most.ts";
import { parseGaiaCsv, projectGaia, propagateGaia } from "../lib/gaia.ts";
import { validateFieldQuery, cutoutRequest } from "../lib/field-query.ts";

function mostTable(rows: Record<string,string>[]) {
  const columns = ["ra_obj","dec_obj","mjd_start","mjd_end","exposure_time","observationid","productid","uri"];
  const widths = [18,18,24,24,20,30,16,180];
  const line = (values: string[]) => values.map((value,i)=>value.padStart(widths[i])).join("");
  const header = "|"+columns.map((value,i)=>value.padStart(widths[i]-1)).join("|")+"|";
  const types = "|"+columns.map((_,i)=>"char".padStart(widths[i]-1)).join("|")+"|";
  return ["\\object_name = test",header,types,...rows.map(row=>line(columns.map(key=>row[key]??"")))].join("\n");
}

test("IRSA MOST Brief parser retains only safe SPHEREx level-2 matches and detector identity",()=>{
  const rows=[
    {ra_obj:"359.99",dec_obj:"-2.5",mjd_start:"60891.4",mjd_end:"60891.401",exposure_time:"113.5",observationid:"2025W32_1A_0105_1",productid:"D6",uri:"ibe/data/spherex/qr2/level2/2025W32/6/level2_sample_1D6_spx_l2b-v20.fits"},
    {ra_obj:"12.5",dec_obj:"3",mjd_start:"60892.1",mjd_end:"60892.101",exposure_time:"113.5",observationid:"2025W32_1A_0106_1",productid:"D3",uri:"ibe/data/spherex/qr3/level2/2025W32/3/level2_sample_1D3_spx_l2b-v20.fits"},
    {ra_obj:"12.5",dec_obj:"3",mjd_start:"60893.1",mjd_end:"60893.101",exposure_time:"113.5",observationid:"bad",productid:"D3",uri:"https://example.com/file.fits"},
  ];
  const parsed=parseMostBrief(mostTable(rows));
  assert.equal(parsed.length,2);
  assert.equal(parsed[0].detector,6);
  assert.equal(parsed[0].release,"spherex_qr2");
  assert.match(parsed[0].url,/^https:\/\/irsa\.ipac\.caltech\.edu\/ibe\/data\/spherex\/qr2\/level2\//);
  assert.equal(parsed[1].detector,3);
  assert.throws(()=>parseMostBrief("MOST: Unable to load ephemeris file for target, exiting"),/Unable to load ephemeris/);
});

test("Gaia DR3 CSV keeps 64-bit source IDs, null motion and epoch fields",()=>{
  const csv="phot_g_mean_mag,source_id,ra,dec,ra_error,dec_error,pmra,pmdec,pmra_error,pmdec_error,ref_epoch\n16.2,2097892344989583488,359.9999,12,0.2,0.3,100,-50,1,2,2016.000\n17.1,2097893856820155008,2,13,,,,,,,2016.000\n";
  const sources=parseGaiaCsv(csv);
  assert.equal(sources.length,2);
  assert.equal(sources[0].source_id,"2097892344989583488");
  assert.equal(sources[1].pmra,null);
  assert.equal(sources[0].phot_g_mean_mag,16.2);
});

test("Gaia proper motion is propagated spherically and TAN projection handles RA wrap",()=>{
  const source={source_id:"1",ra:359.9999,dec:0,ra_error:0.1,dec_error:0.1,pmra:100,pmdec:0,pmra_error:1,pmdec_error:1,ref_epoch:2016,phot_g_mean_mag:15};
  const atRef=propagateGaia(source,51544.5+(2016-2000)*365.25);
  assert.ok(Math.abs(atRef.ra-source.ra)<1e-10);
  const moved=propagateGaia(source,51544.5+(2017-2000)*365.25);
  assert.ok(moved.ra>source.ra || moved.ra<0.001);
  const projected=projectGaia({...source,ra:0.0001,pmra:0,pmdec:0},359.9999,0,0.1,51544.5+365.25*2016);
  assert.ok(projected && projected.x<127.5 && Math.abs(projected.y-127.5)<0.01);
  const noMotion=propagateGaia({...source,pmra:null,pmdec:null},60000);
  assert.equal(noMotion.motion_applied,false);
});

test("IRSA MOST provenance is required for its query scope and accepted by the cutout validator",()=>{
  const most={source:"IRSA MOST",source_url:"https://irsa.ipac.caltech.edu/cgi-bin/MOST/nph-most?catalog=spherex&input_type=name_input&obj_name=Vesta",source_sha256:"a".repeat(64),target_name:"4 Vesta",catalog:"spherex",retrieved_at:"2026-09-29T00:00:00.000Z",match_count:8};
  const query=validateFieldQuery({ra:220,dec:-12,start:"2025-08-01",end:"2025-08-31",detector:6,fov:0.3,max_frames:4,release:"qr2",survey:"most",most});
  assert.equal(query.most?.target_name,"4 Vesta");
  const url="https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/2025W32/6/level2_sample_1D6_spx_l2b-v20.fits";
  assert.equal(new URL(cutoutRequest({ra:220,dec:-12,start:"2025-08-01",end:"2025-08-31",detector:6,fov:0.3,max_frames:4,release:"qr2",survey:"most",url,cutout_ra:221,cutout_dec:-12})).searchParams.get("center"),"221,-12");
  assert.throws(()=>validateFieldQuery({ra:220,dec:-12,start:"2025-08-01",end:"2025-08-31",detector:6,fov:0.3,max_frames:4,release:"qr2",survey:"most"}),/IRSA MOST|метаданих/i);
});
