import test from "node:test";
import assert from "node:assert/strict";
import { validateFieldQuery, validateArchiveScope, cutoutRequest, selectAcrossTime } from "../lib/field-query.ts";
import { containsSRegion, interpolateEphemeris, parseHorizonsText } from "../lib/ephemeris.ts";
import { collectCatalogueParts, inclusiveIntervalDays, MAX_SERIES_FRAMES, mergeCatalogueRecords, splitDateInterval } from "../lib/catalogue-batches.ts";
import { assembleCatalogueParts } from "../lib/catalogue-merge.ts";

const base={ra:167.2,dec:5.15,start:"2025-12-14",end:"2025-12-14",detector:5,fov:0.12,max_frames:4};
test("field validation rejects blank coordinates, impossible dates and unpaired spectral bounds",()=>{
  assert.equal(validateFieldQuery(base).wavelength_min,null);
  assert.deepEqual(validateArchiveScope({}),{release:"qr2",survey:"wide",collection:"spherex_qr2"});
  assert.deepEqual(validateArchiveScope({release:"qr2",survey:"deep"}),{release:"qr2",survey:"deep",collection:"spherex_qr2_deep"});
  assert.equal(validateFieldQuery({...base,ra:0,dec:-90}).dec,-90);
  assert.equal(validateFieldQuery({...base,ra:359.99999,dec:90}).dec,90);
  assert.equal(validateFieldQuery({...base,max_frames:60}).max_frames,60);
  assert.equal(validateFieldQuery({...base,max_frames:120}).max_frames,120);
  assert.equal(validateFieldQuery({...base,max_frames:MAX_SERIES_FRAMES}).max_frames,MAX_SERIES_FRAMES);
  for(const change of [{ra:" "},{ra:360},{dec:91},{detector:2.5},{fov:0},{max_frames:MAX_SERIES_FRAMES+1},{start:"2025-02-30"},{start:"2025-12-15"},{wavelength_min:3},{wavelength_min:4,wavelength_max:3}])assert.throws(()=>validateFieldQuery({...base,...change}));
});
test("oversized inclusive date intervals split without gaps or overlaps and merge rows chronologically",()=>{
  assert.equal(inclusiveIntervalDays({start:"2025-01-01",end:"2025-03-31"}),90);
  assert.deepEqual(splitDateInterval({start:"2025-01-01",end:"2025-01-01"}),null);
  const halves=splitDateInterval({start:"2025-01-01",end:"2025-01-04"});
  assert.deepEqual(halves,[{start:"2025-01-01",end:"2025-01-02"},{start:"2025-01-03",end:"2025-01-04"}]);
  const rows=mergeCatalogueRecords([{records:[{id:"b",observation:"o2",detector:1,mjd:2,url:"b"},{id:"a",observation:"o1",detector:1,mjd:1,url:"a"}]},{records:[{id:"duplicate",observation:"o2",detector:1,mjd:2,url:"b"},{id:"c",observation:"o3",detector:1,mjd:3,url:"c"}]}]);
  assert.deepEqual(rows.map(row=>row.id),["a","b","c"]);
});
test("catalogue collection retries oversized windows and preserves ordered, deduplicated rows",async()=>{
  const calls:string[]=[];
  type TestRecord={id:string;observation:string;detector:number;mjd:number;url:string};
  const result=await collectCatalogueParts<TestRecord,{records:TestRecord[];error?:string}>({interval:{start:"2025-01-01",end:"2025-01-04"},movingObject:false,request:async interval=>{
    calls.push(`${interval.start}/${interval.end}`);
    if(inclusiveIntervalDays(interval)>2)return{status:413,ok:false,body:{records:[],error:"too many"}};
    const firstDay=Number(interval.start.slice(-2)),lastDay=Number(interval.end.slice(-2));
    const records=Array.from({length:lastDay-firstDay+1},(_,i)=>{const day=firstDay+i;return{id:`frame${day}`,observation:`obs${day}`,detector:1,mjd:day,url:`https://archive/${day}`};});
    if(firstDay===3)records.push({id:"duplicate",observation:"obs2",detector:1,mjd:2,url:"https://archive/2"});
    return{status:200,ok:true,body:{records}};
  }});
  assert.deepEqual(calls,["2025-01-01/2025-01-04","2025-01-01/2025-01-02","2025-01-03/2025-01-04"]);
  assert.equal(result.parts.length,2);
  assert.deepEqual(result.records.map(row=>row.id),["frame1","frame2","frame3","frame4"]);
});
test("413 split responses assemble into one complete, provenance-preserving series query",async()=>{
  type RecordRow={id:string;observation:string;detector:number;mjd:number;url:string;target_ra?:number;target_dec?:number};
  type Body={records:RecordRow[];query?:ReturnType<typeof validateFieldQuery>;source_url:string;source_sha256:string;retrieved_at:string;matched_count:number;candidate_count:number;catalogue_truncated:boolean;selection:string;error?:string};
  const dayMjd=(date:string)=>Date.parse(`${date}T00:00:00Z`)/86400000+40587;
  const sourceUrl=(start:string,end:string)=>{
    const params=new URLSearchParams({POS:"CIRCLE 167.2 5.15 0.000001",COLLECTION:"spherex_qr2",MAXREC:"1000",TIME:`${dayMjd(start)} ${dayMjd(end)+1}`});
    return `https://irsa.ipac.caltech.edu/SIA?${params}`;
  };
  const retrieved="2026-09-29T10:00:00.000Z";
  const result=await collectCatalogueParts<RecordRow,Body>({interval:{start:"2025-01-01",end:"2025-01-04"},movingObject:false,request:async interval=>{
    if(inclusiveIntervalDays(interval)>2)return{status:413,ok:false,body:{records:[],source_url:sourceUrl(interval.start,interval.end),source_sha256:"0".repeat(64),retrieved_at:retrieved,matched_count:0,candidate_count:0,catalogue_truncated:false,selection:"",error:"too many"}};
    const days=interval.start.endsWith("01")?[1,2]:[2,3,4];
    const records=days.map(day=>({id:`frame${day}`,observation:`obs${day}`,detector:5,mjd:dayMjd(`2025-01-0${day}`)+0.5,url:`https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/2025W01/5/frame${day}.fits`}));
    return{status:200,ok:true,body:{records,query:validateFieldQuery({...base,start:interval.start,end:interval.end,max_frames:60}),source_url:sourceUrl(interval.start,interval.end),source_sha256:(interval.start.endsWith("01")?"a":"b").repeat(64),retrieved_at:retrieved,matched_count:records.length,candidate_count:records.length,catalogue_truncated:false,selection:"all archive matches"}};
  }});
  const assembled=assembleCatalogueParts(result.parts,{start:"2025-01-01",end:"2025-01-04"},false);
  assert.deepEqual(assembled.records.map(record=>record.id),["frame1","frame2","frame3","frame4"]);
  assert.equal(assembled.query?.start,"2025-01-01");assert.equal(assembled.query?.end,"2025-01-04");assert.equal(assembled.query?.max_frames,MAX_SERIES_FRAMES);
  assert.equal(assembled.matched_count,4);assert.equal(assembled.candidate_count,4);
  assert.equal(assembled.observation_table_parts.length,2);
  assert.deepEqual(assembled.observation_table_parts.map(part=>[part.start,part.end,part.source_sha256[0]]),[["2025-01-01","2025-01-02","a"],["2025-01-03","2025-01-04","b"]]);
  assert.equal(assembled.source_url,assembled.observation_table_parts[0].source_url);
  assert.equal(assembled.source_sha256,assembled.observation_table_parts[0].source_sha256);
});
test("catalogue collection respects MOST 90-day request windows and fails clearly on one-day overflow",async()=>{
  const intervals:string[]=[];
  const result=await collectCatalogueParts({interval:{start:"2025-01-01",end:"2025-04-01"},movingObject:true,request:async interval=>{
    intervals.push(`${interval.start}/${interval.end}`);
    assert.ok(inclusiveIntervalDays(interval)<=90);
    return{status:200,ok:true,body:{records:[]}};
  }});
  assert.equal(result.parts.length,2);
  assert.equal(intervals.length,2);
  await assert.rejects(collectCatalogueParts({interval:{start:"2025-01-01",end:"2025-01-01"},movingObject:false,request:async()=>({status:413,ok:false,body:{records:[],error:"too many"}})}),/одну UTC-добу/);
});
test("catalogue collection stops instead of silently sampling above the bounded series capacity",async()=>{
  type TestRecord={id:string;observation:string;detector:number;mjd:number};
  await assert.rejects(collectCatalogueParts<TestRecord,{records:TestRecord[];error?:string}>({interval:{start:"2025-01-01",end:"2025-01-04"},movingObject:false,request:async interval=>{
    if(inclusiveIntervalDays(interval)>2)return{status:413,ok:false,body:{records:[],error:"too many"}};
    const firstDay=Number(interval.start.slice(-2));
    const length=firstDay===1?Math.ceil((MAX_SERIES_FRAMES+1)/2):Math.floor((MAX_SERIES_FRAMES+1)/2);
    const records=Array.from({length},(_,i)=>({id:`${firstDay}_${i}`,observation:`${firstDay}_${i}`,detector:1,mjd:firstDay+i/100}));
    return{status:200,ok:true,body:{records}};
  }}),/понад 15360 унікальних кадрів/);
});
test("cutout proxy accepts only the selected IRSA release and calibrated FITS path",()=>{
  const url="https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/2025W50/5/level2_test.fits";
  const result=new URL(cutoutRequest({...base,url,release:"qr2",survey:"wide"}));
  assert.equal(result.searchParams.get("center"),"167.2,5.15");
  assert.equal(result.searchParams.get("size"),"0.192");
  for(const bad of [url.replace("https:","http:"),url.replace("irsa.ipac.caltech.edu","irsa.ipac.caltech.edu.example.org"),url.replace("https://","https://name:secret@"),url+"?url=http://localhost",url+"#x",url.replace("qr2","other"),"https://irsa.ipac.caltech.edu/private.fits","http://127.0.0.1/"])assert.throws(()=>cutoutRequest({...base,url:bad,release:"qr2"}));
  assert.throws(()=>cutoutRequest({...base,url,release:"qr3"}));
  const qr3="https://irsa.ipac.caltech.edu/ibe/data/spherex/qr3/level2/2026W35/5/level2_test.fits";
  assert.equal(new URL(cutoutRequest({...base,url:qr3,release:"qr3",survey:"deep"})).pathname,"/ibe/data/spherex/qr3/level2/2026W35/5/level2_test.fits");
});
test("bounded sampling targets elapsed MJD intervals and preserves chronological order",()=>{
  const a=[0,1,2,3,4,100,200,400,800,1000].map((mjd,id)=>({id,mjd}));
  assert.deepEqual(selectAcrossTime(a,4).map(r=>r.mjd),[0,400,800,1000]);
  assert.deepEqual(selectAcrossTime(a,24),a);
  assert.deepEqual(selectAcrossTime([],4),[]);
  assert.deepEqual(selectAcrossTime(a,1),[a[0]]);
});
test("resolved object names retain catalog provenance without accepting a client-supplied source URL",()=>{
  const query=validateFieldQuery({...base,target_name:"M101",target_canonical_name:"M 101",target_resolver:"Sc=Simbad",target_reference:"20052ApJ...625..679T",target_type:"G"});
  assert.deepEqual(query.target,{query_name:"M101",canonical_name:"M 101",resolver:"Sc=Simbad",resolver_url:"https://cds.unistra.fr/cgi-bin/nph-sesame/",object_type:"G",reference_position:"20052ApJ...625..679T"});
  assert.throws(()=>validateFieldQuery({...base,target_name:"M101",target_canonical_name:"M 101"}));
  assert.equal(validateFieldQuery({...base,target_resolver_url:"https://attacker.invalid/"}).target,undefined);
});
test("Horizons Observer Table import parses only geocentric ICRF UT ephemerides and interpolates across RA zero",()=>{
  const text=`Target body name: C/2025 A1 (Test comet)
Center body name: Earth (399)
Center-site name: GEOCENTRIC
Start time      : A.D. 2025-Dec-14 00:00:00.0000 UT
Stop  time      : A.D. 2025-Dec-15 00:00:00.0000 UT
RA format       : HMS
Time format     : CAL
 Date__(UT)__HR:MN     R.A._____(ICRF)_____DEC
$$SOE
 2025-Dec-14 00:00 Nm  23 59 59.00 +10 00 00.0  20.0
 2025-Dec-14 12:00:00.500 Nm  00 00 00.50 +10 06 00.0  20.0
 2025-Dec-15 00:00 Nm  00 00 02.00 +10 12 00.0  20.0
$$EOE`;
  const parsed=parseHorizonsText(text);
  assert.equal(parsed.target_name,"C/2025 A1 (Test comet)");
  assert.equal(parsed.points.length,3);
  assert.ok(parsed.points[0].ra>359.99);
  assert.ok(Math.abs((parsed.points[1].mjd-parsed.points[0].mjd)*86400-43200.5)<0.001);
  const halfway=interpolateEphemeris(parsed.points,(parsed.points[0].mjd+parsed.points[1].mjd)/2);
  assert.ok(halfway!==null&&(halfway.ra<0.01||halfway.ra>359.99)&&halfway.dec>10);
  assert.equal(interpolateEphemeris(parsed.points,parsed.points[0].mjd-1),null);
  assert.throws(()=>parseHorizonsText(text.replace("Center-site name: GEOCENTRIC","Center-site name: Kitt Peak")),/Earth geocenter/);
  assert.equal(containsSRegion("POLYGON ICRS 359.9 -1 0.1 -1 0.1 1 359.9 1 359.9 -1",0,0),true);
  assert.equal(containsSRegion("POLYGON ICRS 359.9 -1 0.1 -1 0.1 1 359.9 1 359.9 -1",2,0),false);
  const query=validateFieldQuery({dec:0,start:"2025-12-14",end:"2025-12-14",detector:2,fov:0.3,max_frames:4,release:"qr2",survey:"wide",ephemeris:{source:"JPL Horizons",source_url:"https://ssd.jpl.nasa.gov/horizons/app.html",target_name:parsed.target_name,source_file_name:"target.txt",source_sha256:"a".repeat(64),observer:"Earth geocenter",frame:"ICRF",time_scale:"UTC",points:parsed.points}});
  assert.ok(query.ra>=0&&query.ra<360);
  assert.throws(()=>validateFieldQuery({dec:0,start:"2025-12-14",end:"2025-12-14",detector:2,fov:0.03,max_frames:4,release:"qr2",survey:"wide",ephemeris:{source:"JPL Horizons",source_url:"https://ssd.jpl.nasa.gov/horizons/app.html",target_name:parsed.target_name,source_file_name:"target.txt",source_sha256:"a".repeat(64),observer:"Earth geocenter",frame:"ICRF",time_scale:"UTC",points:parsed.points}}));
});

test("catalogue collection waits out a longer archive outage but not rejections or timeouts", async () => {
  type R = { id: string; observation: string; detector: number; mjd: number; url: string };
  const ok = { status: 200, ok: true, body: { records: [{ id: "a", observation: "o", detector: 1, mjd: 1, url: "a" }] as R[] } };
  const down = { status: 502, ok: false, body: { records: [] as R[], error: "IRSA down", retryable: true } };
  const run = async (responses: { status: number; ok: boolean; body: { records: R[]; error?: string; retryable?: boolean } }[]) => {
    const waits: number[] = [], details: string[] = []; let calls = 0;
    const result = await collectCatalogueParts<R, { records: R[]; error?: string; retryable?: boolean }>({
      interval: { start: "2025-12-14", end: "2025-12-14" }, movingObject: false, unavailableRetryDelaysMs: [4000, 10000],
      sleep: async ms => { waits.push(ms); }, onProgress: p => details.push(p.detail),
      request: async () => responses[Math.min(calls++, responses.length - 1)],
    }).catch((error: Error) => error);
    return { result, waits, details, calls };
  };
  const recovered = await run([down, down, ok]);
  assert.ok(!(recovered.result instanceof Error) && recovered.result.records.length === 1);
  assert.deepEqual(recovered.waits, [4000, 10000]); assert.equal(recovered.calls, 3);
  assert.match(recovered.details[0], /повторна спроба 1\/2 через 4 с/);
  const persistent = await run([down]);
  assert.ok(persistent.result instanceof Error && persistent.result.message === "IRSA down"); assert.equal(persistent.calls, 3);
  for (const response of [{ ...down, body: { ...down.body, retryable: false } }, { ...down, status: 504 }, { ...down, status: 400 }]) {
    const once = await run([response]);
    assert.ok(once.result instanceof Error); assert.equal(once.calls, 1, `status ${response.status} is not retried by the client`); assert.deepEqual(once.waits, []);
  }
});
