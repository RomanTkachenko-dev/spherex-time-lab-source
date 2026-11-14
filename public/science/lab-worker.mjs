let apiOrigin = "";
const scienceAsset = path => self.location ? new URL(path, self.location.href).href : "/science/" + path;
import { labStore } from './lab-storage.mjs';
const RUNTIME = 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/';
const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
const progress = detail => self.postMessage({type:'progress',detail});
async function get(url) {
  let error;
  for(let attempt=0;attempt<3;attempt++) {
    if(attempt)progress(`Повторне завантаження після мережевого збою · спроба ${attempt+1}/3`);
    try {
      const response=await fetch(url,{signal:AbortSignal.timeout(180000)});
      if(response.ok)return response;
      if(response.status<500&&response.status!==429)throw Object.assign(Error(`HTTP ${response.status}: ${url}`),{permanent:true});
      error=Error(`HTTP ${response.status}`);
    } catch(e) {if(e.permanent)throw e;error=e;}
  }
  throw error;
}
async function run(message) {
  const source=await (await get(scienceAsset('lab_pipeline.py'))).text();
  const codeHash=await hash(new TextEncoder().encode(source));
  const calibration=await (await get(scienceAsset('calibration/manifest.json'))).json();
  let state=message.resume?await labStore('get'):null;
  if(message.resume&&!state)throw Error('Немає збереженого обчислення.');
  if(state&&(state.code_sha256!==codeHash||JSON.stringify(state.calibration)!==JSON.stringify(calibration)))throw Error('Метод або калібрація змінились. Почніть новий аналіз.');
  if(!state)state={schema_version:1,code_sha256:codeHash,calibration,records:message.records,options:message.options,catalogue:message.catalogue,frames:[],excluded:[],next:0,report:null};
  if(state.report){self.postMessage({type:'complete',report:state.report});return;}
  progress('Завантажую наукове середовище та калібрації…');
  const {loadPyodide}=await import(RUNTIME+'pyodide.mjs');
  const py=await loadPyodide({indexURL:RUNTIME});
  await py.loadPackage(['astropy','scipy']);
  await py.runPythonAsync(source);
  const loaded=new Set();
  async function loadDetector(detector){
    if(loaded.has(detector))return;
    const spec=calibration.detectors[String(detector)];
    if(!spec)throw Error('Відсутня калібрація детектора.');
    const raw=new Uint8Array(await (await get(scienceAsset('calibration/'+spec.file))).arrayBuffer());
    if(await hash(raw)!==spec.sha256)throw Error('Контрольна сума калібрації не збігається.');
    py.globals.set('cal_raw',raw);py.globals.set('cal_detector',detector);
    await py.runPythonAsync('load_calibration(cal_detector,bytes(cal_raw)); del cal_raw');
    loaded.add(detector);
  }
  py.globals.set('options_json',JSON.stringify(state.options));
  await py.runPythonAsync('lab_options=json.loads(options_json)');
  await labStore('put',state);
  for(let i=state.next;i<state.records.length;i++){
    const record=state.records[i];
    progress(`FITS ${i+1} / ${state.records.length} · D${record.detector}`);
    await loadDetector(record.detector);
    const params=new URLSearchParams({url:record.url,ra:String(record.cutout_ra),dec:String(record.cutout_dec),fov:String(record.fov),release:record.release.includes('dr1')?'dr1':record.release.includes('qr3')?'qr3':'qr2'});
    const response=await get(apiOrigin+'/api/cutout?'+params);
    const raw=new Uint8Array(await response.arrayBuffer());
    py.globals.set('raw',raw);py.globals.set('record_json',JSON.stringify(record));
    const tileKeys=JSON.parse(await py.runPythonAsync('TILES.clear(); json.dumps(required_tiles(bytes(raw)))'));
    for(const key of tileKeys){
      const spec=calibration.detectors[String(record.detector)].tiles[key];
      if(!spec)throw Error('Відсутня спектральна карта.');
      const data=new Uint8Array(await (await get(scienceAsset('calibration/'+spec.file))).arrayBuffer());
      if(await hash(data)!==spec.sha256)throw Error('Контрольна сума спектральної карти не збігається.');
      py.globals.set('tile_raw',data);py.globals.set('tile_key',record.detector+':'+key);
      await py.runPythonAsync('load_tile(tile_key,bytes(tile_raw)); del tile_raw');
    }
    try {
      const frame=JSON.parse(await py.runPythonAsync('json.dumps(analyze_fits(bytes(raw),json.loads(record_json),lab_options),allow_nan=False)'));
      if(frame?.id!==record.id||frame.detector!==record.detector||!Number.isFinite(frame.mjd)||!Array.isArray(frame.detections)||!/^[a-f0-9]{64}$/.test(frame.sha256||''))throw Error('Обчислювальний модуль повернув неузгоджену ідентичність або формат результату.');
      frame.retrieved_at=response.headers.get('X-Retrieved-At')||new Date().toISOString();
      state.frames.push(frame);
    } catch(error){
      if(error.name!=='PythonError'||!/(?:ValueError|KeyError|UnitConversionError):/.test(error.message))throw error;
      state.excluded.push({id:record.id,reason:String(error.message).trim().split('\n').at(-1)});
    } finally {await py.runPythonAsync('del raw');}
    state.next=i+1;await labStore('put',state);
  }
  progress('Зіставляю спектральні відгуки та перевіряю траєкторії…');
  for(const detector of new Set(state.frames.map(f=>f.detector)))await loadDetector(detector);
  py.globals.set('frames_json',JSON.stringify(state.frames));
  const report=JSON.parse(await py.runPythonAsync('json.dumps(finish_lab(json.loads(frames_json),lab_options),allow_nan=False)'));
  Object.assign(report,{created_at:new Date().toISOString(),code_sha256:codeHash,calibration,catalogue:state.catalogue,records:state.records,excluded:state.excluded,requested_count:state.records.length,runtime:RUNTIME,
    software:JSON.parse(await py.runPythonAsync("json.dumps({'numpy':np.__version__,'astropy':__import__('astropy').__version__,'scipy':__import__('scipy').__version__})"))});
  state.report=report;await labStore('put',state);
  self.postMessage({type:'complete',report});
}
self.onmessage=async event=>{
  apiOrigin = event.data.apiOrigin || "";
  try {
    if(navigator.locks)await navigator.locks.request('spherex-lab-run',{ifAvailable:true},async lock=>{if(!lock)throw Error('Лабораторія вже працює в іншій вкладці.');await run(event.data);});
    else throw Error('Для збереження аналізу потрібен браузер із Web Locks.');
  }catch(error){self.postMessage({type:'error',message:error.message||String(error)});}
};
