import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto,createHash} from 'node:crypto';
const digest=x=>createHash('sha256').update(x).digest('hex');
const source=(await readFile(new URL('../public/science/lab-worker.mjs',import.meta.url),'utf8'))
  .replace("import { labStore } from './lab-storage.mjs';",'const labStore=__store;')
  .replace("await import(RUNTIME+'pyodide.mjs')",'({loadPyodide:async()=>__py})');
const records=[0,1].map(i=>({id:'f'+i,observation:'o'+i,detector:1,release:'spherex_qr3',mjd:60000+i,url:'https://archive.invalid/'+i,ra:1,dec:2,cutout_ra:1,cutout_dec:2,fov:.1}));
function harness(box,{fail=false,method='method',invalid=false,quota=false}={}){
  const messages=[],analyzed=[],loads=[],values=new Map();let committed=0;
  const py={globals:{set:(k,v)=>values.set(k,v)},loadPackage:async()=>{},runPythonAsync:async c=>{
    if(c.includes('required_tiles'))return '["0-0"]';
    if(c.startsWith('load_calibration'))loads.push(values.get('cal_detector'));
    if(c.includes('analyze_fits')){const r=JSON.parse(values.get('record_json'));analyzed.push(r.id);return JSON.stringify(invalid?{}:{id:r.id,detector:r.detector,mjd:r.mjd,sha256:digest(r.id),detections:[]});}
    if(c.includes('finish_lab'))return JSON.stringify({frames:JSON.parse(values.get('frames_json')),channels:[],tracks:[]});
    if(c.includes("'numpy'"))return '{}';
    return null;
  }};
  const context={__py:py,__store:async(action,value)=>{if(action==='get')return structuredClone(box.value);if(quota&&value.next===1&&++committed===1)throw Error('quota');box.value=structuredClone(value);},
    self:{postMessage:m=>messages.push(m)},crypto:webcrypto,TextEncoder,Uint8Array,URLSearchParams,AbortSignal,Response,Set,
    navigator:{locks:{request:async(_n,_o,f)=>f({})}},fetch:async url=>{
      if(url==='/science/lab_pipeline.py')return new Response(method);
      if(url.endsWith('manifest.json'))return Response.json({detectors:{1:{file:'d.npz',sha256:digest('cal'),tiles:{'0-0':{file:'t.npz',sha256:digest('tile')}}}}});
      if(url.endsWith('d.npz'))return new Response('cal');if(url.endsWith('t.npz'))return new Response('tile');
      if(fail&&url.includes('invalid%2F1'))throw Error('offline');
      return new Response('fits');
    }};
  vm.runInNewContext(source,context);
  return {messages,analyzed,loads,run:resume=>context.self.onmessage({data:{resume,records,options:{},catalogue:{}}})};
}
test('lab network interruption persists completed frames; resume loads calibration even when finishing',async()=>{
  const box={};const first=harness(box,{fail:true});await first.run(false);
  assert.equal(box.value.next,1);assert.equal(first.messages.at(-1).type,'error');assert.deepEqual(box.value.excluded,[]);
  const second=harness(box);await second.run(true);
  assert.deepEqual(second.analyzed,['f1']);assert.equal(box.value.report.frames.length,2);
  assert.deepEqual(box.value.report.records,records);
  box.value.report=null;const finalize=harness(box);await finalize.run(true);
  assert.deepEqual(finalize.analyzed,[]);assert.deepEqual(finalize.loads,[1]);assert.equal(finalize.messages.at(-1).type,'complete');
});
test('lab changed method cannot combine checkpoints; malformed numerical results do not commit',async()=>{
  const box={};await harness(box,{fail:true}).run(false);
  const changed=harness(box,{method:'different'});await changed.run(true);assert.equal(changed.messages.at(-1).type,'error');assert.equal(box.value.next,1);
  const invalid=harness({}, {invalid:true});await invalid.run(false);assert.equal(invalid.messages.at(-1).type,'error');
});
test('lab failed persistence resumes before uncommitted frame',async()=>{
  const box={};const first=harness(box,{quota:true});await first.run(false);assert.equal(box.value.next,0);
  const second=harness(box);await second.run(true);assert.deepEqual(second.analyzed,['f0','f1']);assert.equal(box.value.report.frames.length,2);
});
