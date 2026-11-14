"use client";
import {useEffect,useRef,useState} from 'react';
import type {Manifest} from '@/lib/science';
import {allDetectorRecords,currentLabRecords,labOptions,measurementsCsv,type LabFrame,type LabOptions,type LabReport} from '@/lib/laboratory';
import {readLatestLab,saveLabAssociations} from '@/lib/lab-storage';
import {associateCandidates,candidateCone} from '@/lib/candidate-matches';
import type {GaiaReference} from '@/lib/gaia';
import './science-lab.css';

function saveFile(value:string,type:string,name:string){const url=URL.createObjectURL(new Blob([value],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function Plot({frames,spectrum,onSelect}:{frames:LabFrame[];spectrum:boolean;onSelect:(id:string)=>void}){
  const points=frames.filter(f=>f.target?.quality_ok);
  if(!points.length)return <p>Немає придатних вимірювань для графіка.</p>;
  const xValues=points.map(f=>spectrum?f.target!.wavelength_um:f.mjd);
  const yValues=points.flatMap(f=>[f.target!.flux_uJy-f.target!.flux_error_uJy,f.target!.flux_uJy+f.target!.flux_error_uJy]);
  const lo=xValues.reduce((a,b)=>Math.min(a,b),Infinity),hi=xValues.reduce((a,b)=>Math.max(a,b),-Infinity),bottom=yValues.reduce((a,b)=>Math.min(a,b),Infinity),top=yValues.reduce((a,b)=>Math.max(a,b),-Infinity);
  const x=(n:number)=>hi===lo?380:65+((n-lo)/(hi-lo))*630,y=(n:number)=>245-((n-bottom)/(top-bottom||1))*210;
  return <svg viewBox="0 0 760 300" role="group" aria-label={spectrum?'Спектр: потік і умовна похибка за довжиною хвилі':'Крива блиску вибраного каналу'}>
    <line x1="65" y1="245" x2="695" y2="245" stroke="currentColor"/><line x1="65" y1="35" x2="65" y2="245" stroke="currentColor"/>
    {(hi===lo?[.5]:[0,.25,.5,.75,1]).map(t=><text key={t} x={x(lo+t*(hi-lo))} y="265" textAnchor="middle">{(lo+t*(hi-lo)).toFixed(spectrum?3:5)}</text>)}
    {[0,.25,.5,.75,1].map(t=><text key={t} x="59" y={y(bottom+t*(top-bottom))+4} textAnchor="end">{(bottom+t*(top-bottom)).toPrecision(3)}</text>)}
    <text x="380" y="292" textAnchor="middle">{spectrum?'Довжина хвилі · мкм':'MJD · UTC'}</text><text x="12" y="20">Потік · мкЯн</text>
    {points.map(f=>{const p=f.target!,px=x(spectrum?p.wavelength_um:f.mjd),py=y(p.flux_uJy);return <g key={f.id} tabIndex={0} role="button" aria-label={`${f.date} UTC, ${p.flux_uJy.toPrecision(4)} ± ${p.flux_error_uJy.toPrecision(3)} мкЯн`} onClick={()=>onSelect(f.id)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onSelect(f.id);}}}><title>{f.id}: {p.wavelength_um.toFixed(5)} мкм; {f.date} UTC</title><line x1={px} x2={px} y1={y(p.flux_uJy-p.flux_error_uJy)} y2={y(p.flux_uJy+p.flux_error_uJy)} stroke="#b9ec68"/><circle cx={px} cy={py} r="4" fill="#b9ec68"/></g>;})}
  </svg>;
}

export default function ScienceLab({manifest,onFrame}:{manifest:Manifest;onFrame:(id:string)=>void}){
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[status,setStatus]=useState(''),[error,setError]=useState('');
  const [report,setReport]=useState<LabReport|null>(null),[resumeAvailable,setResumeAvailable]=useState(false);
  const [channel,setChannel]=useState(1),[selected,setSelected]=useState<string|null>(null),[all,setAll]=useState(false),[custom,setCustom]=useState(false);
  const [selectedTrack,setSelectedTrack]=useState<number|null>(null);
  const [matching,setMatching]=useState(false),[matchError,setMatchError]=useState(''),[matchAttempt,setMatchAttempt]=useState(0);
  const [options,setOptions]=useState<LabOptions>({ra:manifest.frames[0].ra,dec:manifest.frames[0].dec,fit_position:false,detect:false,snr:5,max_sources:100,response_tolerance:.05,radius_arcsec:2,max_speed_arcsec_day:100,max_gap_days:2});
  const worker=useRef<Worker|null>(null),request=useRef<AbortController|null>(null),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;worker.current?.terminate();request.current?.abort();};},[]);
  useEffect(()=>{
    if(!report||report.catalogue_crossmatch||!report.tracks.length||busy)return;
    const controller=new AbortController();const current=report;
    (async()=>{
      await Promise.resolve();if(controller.signal.aborted)return;
      setMatching(true);setMatchError('');
      const cone=candidateCone(current);if(!cone)return;
      const response=await fetch(`/api/gaia?ra=${cone.ra}&dec=${cone.dec}&radius=${cone.radius}`,{signal:controller.signal});
      const catalogue=await response.json() as GaiaReference&{error?:string};
      if(!response.ok)throw Error(catalogue.error||'Gaia DR3 недоступний.');
      if(controller.signal.aborted)return;
      const enriched={...current,catalogue_crossmatch:associateCandidates(current,catalogue)};
      await saveLabAssociations(enriched);
      if(!controller.signal.aborted){setMatching(false);setReport(enriched);}
    })().catch(e=>{if(!controller.signal.aborted)setMatchError(e instanceof Error?e.message:String(e));})
      .finally(()=>{if(!controller.signal.aborted)setMatching(false);});
    return()=>controller.abort();
  },[report,busy,matchAttempt]);
  async function restore(){try{const saved=await readLatestLab() as {report?:LabReport;next?:number;options?:LabOptions;records?:{ra:number;dec:number}[]}|undefined;if(saved){setReport(saved.report??null);setResumeAvailable(!saved.report);if(saved.options){setOptions(saved.options);setCustom(!!saved.records?.length&&saved.records.every(r=>r.ra===saved.options!.ra&&r.dec===saved.options!.dec));}if(saved.report)setChannel(saved.report.channels.find(c=>c.count>0)?.channel??1);setStatus(saved.report?'Відкрито останній збережений звіт.':`Збережено ${saved.next??0} із ${saved.records?.length??0} кадрів; можна продовжити.`);}else{setResumeAvailable(false);setStatus('Збережених обчислень іще немає.');}}catch(e){setError(String(e));}}
  function stop(){worker.current?.terminate();worker.current=null;request.current?.abort();setBusy(false);setResumeAvailable(true);setStatus('Зупинено. Завершені кадри збережені; перевірте доступне продовження.');}
  async function start(resume=false){
    setError('');setMatching(false);setBusy(true);setStatus('Готую аналіз…');
    request.current=new AbortController();
    try{
      const opts=resume?options:labOptions(options);
      let records, catalogue;
      if(!resume){
        if(all){const result=await allDetectorRecords(manifest,request.current.signal,setStatus);records=result.records;catalogue=result.catalogue;}
        else{records=currentLabRecords(manifest);catalogue={source_url:manifest.observation_table_url,source_sha256:manifest.observation_table_sha256,parts:manifest.observation_table_parts??[]};}
        if(custom)records=records.map(r=>({...r,ra:opts.ra,dec:opts.dec}));
        if(!records.length)throw Error('За цими датами немає кадрів для аналізу.');
      }
      if(request.current.signal.aborted||!mounted.current)return;
      const w=new Worker('/science/lab-worker.mjs',{type:'module'});worker.current=w;
      w.onmessage=event=>{
        if(!mounted.current||worker.current!==w)return;
        const message=event.data;
        if(message.type==='progress')setStatus(message.detail);
        if(message.type==='complete'){const value=message.report as LabReport;setReport(value);setOptions(value.options);setChannel(value.channels.find(c=>c.count>0)?.channel??1);setSelected(null);setBusy(false);setResumeAvailable(false);setStatus(`Аналіз завершено: ${value.frames.length} оброблено, ${value.excluded.length} відхилено.`);w.terminate();worker.current=null;}
        if(message.type==='error'){setError(message.message);setBusy(false);setResumeAvailable(true);w.terminate();worker.current=null;}
      };
      w.onerror=e=>{setError(e.message||'Збій наукового середовища.');setBusy(false);setResumeAvailable(true);w.terminate();worker.current=null;};
      w.postMessage({resume,options:opts,records,catalogue});
    }catch(e){if(mounted.current){setError(e instanceof Error?e.message:String(e));setBusy(false);}}
  }
  const active=report?.channels.find(c=>c.channel===channel);
  const allowed=new Set(active?.comparisons.filter(c=>c.compatible).map(c=>c.id));
  const lightFrames=report?.frames.filter(f=>allowed.has(f.id))??[];
  const picked=report?.frames.find(f=>f.id===selected);
  const track=selectedTrack===null?null:report?.tracks[selectedTrack];
  const referenceFrame=report?.frames.find(f=>f.id===active?.reference);
  function pick(id:string){setSelected(id);onFrame(id);}
  function numeric(key:keyof LabOptions,label:string,min:number,max:number,step:number){return <label>{label}<input type="number" min={min} max={max} step={step} value={Number.isFinite(Number(options[key]))?Number(options[key]):''} onChange={e=>setOptions(p=>({...p,[key]:e.target.value===''?NaN:Number(e.target.value)}))}/></label>;}
  return <section className="science-lab" aria-label="Наукова лабораторія">
    <button className="lab-open" aria-expanded={open} onClick={()=>{setOpen(v=>!v);if(!open&&!report)void restore();}}>Наукова лабораторія <span>Вимірювання · спектр · кандидати</span></button>
    {open&&<div className="lab-body"><h2>Від кадрів до вимірювань</h2><p>Модель точкового джерела на нативних FITS: ePSF + локальний фон + VARIANCE. Для галактик, комет із комою та нерозділених сусідів ця модель може бути непридатною.</p>
      <p className="lab-error">Дослідницький режим. Контроль на двох полях DR1 виявив обмеження детектора на щільних фонах і зміщення потоку при невідповідності форми джерела моделі. Точність та повноту на реальному небі ще не підтверджено; прийняття локальної підгонки не усуває систематичних похибок.</p>
      <fieldset disabled={busy}><legend>Дані та модель нового запуску</legend><p>Продовження використовує записи й параметри з контрольної точки. Новий запуск замінює останнє обчислення; потрібний звіт спочатку експортуйте.</p><div className="lab-controls">
        <label><input type="checkbox" checked={all} disabled={!manifest.query||!!manifest.query.most||!!manifest.query.ephemeris} onChange={e=>setAll(e.target.checked)}/> Знайти D1–D6 для тих самих дат і поля</label>
        <label><input type="checkbox" checked={custom} onChange={e=>setCustom(e.target.checked)}/> Власна нерухома позиція для вимірювання</label>
        {custom&&<>{numeric('ra','RA · градуси',0,359.999999,.000001)}{numeric('dec','Dec · градуси',-90,90,.000001)}</>}
        <label><input type="checkbox" checked={options.fit_position} onChange={e=>setOptions(p=>({...p,fit_position:e.target.checked}))}/> Підганяти центр джерела (інакше фіксована позиція)</label>
        <label><input type="checkbox" checked={options.detect} onChange={e=>setOptions(p=>({...p,detect:e.target.checked}))}/> Виявляти піки та зв’язувати кандидати у траєкторії</label>
        {numeric('response_tolerance','Допуск різниці нормованих відгуків (0–0,5)',0,.5,.01)}
        {options.detect&&<>{numeric('snr','Поріг сигнал/шум',3,100,.5)}{numeric('max_sources','Ліміт піків на кадр (перевищення дає помилку)',1,200,1)}{numeric('radius_arcsec','Допуск траєкторії · кутові секунди',.1,30,.1)}{numeric('max_speed_arcsec_day','Максимальна швидкість · ″/добу',.1,100000,1)}{numeric('max_gap_days','Максимальна тривалість траєкторії · доби',.001,365,.1)}</>}
      </div><p>{all?'Буде виконано окремий повний пошук кожного детектора.':'Аналіз поточної серії: '+manifest.frames.length+' кадрів.'} Порожні спектральні канали залишаться порожніми. Калібрації завантажуються за потреби й можуть бути об’ємними.</p></fieldset>
      <div className="lab-actions"><button disabled={busy} onClick={()=>void start()}>Почати новий аналіз</button><button disabled={busy||!resumeAvailable} onClick={()=>void start(true)}>Продовжити збережений</button>{busy&&<button onClick={stop}>Пауза</button>}<button disabled={busy} onClick={()=>void restore()}>Відкрити останній звіт</button></div>
      <p role="status" aria-live="polite">{status}</p>{error&&<p className="lab-error" role="alert">{error}</p>}
      {report&&<><div className="lab-actions"><button onClick={()=>saveFile(JSON.stringify(report,null,2),'application/json','spherex-science-report.json')}>Завантажити звіт JSON</button><button onClick={()=>saveFile(measurementsCsv(report),'text/csv;charset=utf-8','spherex-measurements.csv')}>Вимірювання CSV</button></div>
        <p>Звіт {report.created_at} · {report.frames.length} / {report.requested_count} кадрів. Це окремий збережений аналіз; він може стосуватися іншої серії. Параметри та джерела зафіксовано в JSON.</p>
        <h3>Спектр та покриття 102 каналів</h3><p>Кожна точка — окрема експозиція з власним часом. Похибки умовні, без систематичної складової калібрації. Пропуски не інтерполюються.</p>
        <Plot frames={report.frames} spectrum onSelect={pick}/>
        <div className="lab-channel-grid" aria-label="Спектральні канали">{report.channels.map(c=><button key={c.channel} className={c.count?'has-data':''} aria-pressed={channel===c.channel} aria-label={`Канал ${c.channel}, D${c.detector}, ${c.count} вимірювань`} title={`D${c.detector} · канал ${c.local} · ${c.count} вимірювань`} onClick={()=>setChannel(c.channel)}>{c.channel}<small>{c.count||'—'}</small></button>)}</div>
        <h3>Крива блиску · канал {channel}</h3><p>Порівнюються лише кадри одного релізу, які пройшли перевірку форми спектрального відгуку відносно першої експозиції каналу. ePSF враховується у моделі кожного кадру. Відгук наближений за лабораторною кривою; це не точне зрівнювання пропускання всіх пікселів.</p>
        <Plot frames={lightFrames} spectrum={false} onSelect={pick}/>
        <p>Прийнято до порівняння: {lightFrames.length} із {active?.count??0}. {active?.weighted_flux_uJy!=null&&`Середнє за припущення сталого потоку: ${active.weighted_flux_uJy.toPrecision(4)} ± ${active.error_uJy!.toPrecision(3)} мкЯн.`} {(active?.dof??0)>0&&` χ² = ${active!.chi2!.toFixed(2)}, ступені свободи = ${active!.dof}. Це умовна діагностика, не підтвердження змінності.`}</p>
        {!!active?.comparisons.length&&<details><summary>Чому вимірювання прийнято або відхилено</summary><p>Опорний кадр: {active.reference}. Допуск збереженого аналізу: {report.options.response_tolerance}. Спектральна відстань характеризує форму нормованих кривих; вона не є похибкою потоку.</p><div className="lab-table"><table><thead><tr><th>Експозиція</th><th>Спектральна відстань</th><th>Рішення</th></tr></thead><tbody>{active.comparisons.map(c=>{const frame=report.frames.find(f=>f.id===c.id);return <tr key={c.id}><td><button onClick={()=>pick(c.id)}>{c.id}</button></td><td>{c.distance?.toPrecision(4)??'Не визначено'}</td><td>{c.compatible?'Прийнято':frame?.release!==referenceFrame?.release?'Інший реліз':c.distance===null?'Немає придатного відгуку':'Відгуки не відповідають допуску'}</td></tr>;})}</tbody></table></div></details>}
        {picked?.target&&!picked.target.quality_ok&&<p className="lab-error">Вибране вимірювання не пройшло критерії моделі; воно не входить до спектра та кривої блиску.</p>}
        {picked?.target&&<div className="lab-picked"><strong>{picked.id}</strong><p>{picked.date} UTC · {picked.target.wavelength_um.toFixed(5)} мкм</p><p>Потік: {picked.target.flux_uJy.toPrecision(5)} ± {picked.target.flux_error_uJy.toPrecision(3)} мкЯн · S/N {picked.target.snr.toFixed(2)} · χ²/ν {picked.target.reduced_chi2.toFixed(2)}</p><p>RA {picked.target.ra.toFixed(7)}°, Dec {picked.target.dec.toFixed(7)}°. {picked.target.centroid_fitted?'Центр виміряно.':'Позицію зафіксовано, а не виміряно.'}</p>{picked.target.position_covariance_arcsec2&&<p>Умовні похибки центра E/N: {Math.sqrt(picked.target.position_covariance_arcsec2[0][0]).toFixed(3)}″ / {Math.sqrt(picked.target.position_covariance_arcsec2[1][1]).toFixed(3)}″.</p>}</div>}
        <h3>Кандидати та траєкторії</h3><p>{report.frames.reduce((s,f)=>s+f.detections.length,0)} детекцій · {report.tracks.length} траєкторій. Порядок: кількість незалежних часових точок, залишки моделі, часовий інтервал. Відсутність каталожного зіставлення не означає новий об’єкт; орбіти не обчислюються.</p>
        {report.options.detect&&report.frames.some(f=>f.detection_error)&&<details open><summary>Пошук кандидатів завершено не в усіх кадрах</summary><p>Помилка детектора не означає відсутності джерел. Траєкторії побудовано лише за доступними детекціями.</p>{report.frames.filter(f=>f.detection_error).map(f=><p key={f.id}>{f.id}: {f.detection_error}</p>)}</details>}
        {matching&&<p role="status">Автоматично зіставляємо траєкторії з Gaia DR3 на епохи експозицій…</p>}
        {matchError&&<p role="alert">Каталожне зіставлення не завершене: {matchError} <button onClick={()=>setMatchAttempt(v=>v+1)}>Повторити</button></p>}
        {report.catalogue_crossmatch&&<div className="lab-picked"><h4>Зіставлення з Gaia DR3</h4><p>Радіус {report.catalogue_crossmatch.radius_arcsec}″ на кожній епосі. Можлива позиційна відповідність не є підтвердженою ідентифікацією. Відсутність відповідності не означає новий об’єкт; каталог малих тіл тут не перевіряється.</p>
          {report.catalogue_crossmatch.catalogue.truncated&&<p role="alert">Вибірку Gaia обрізано лімітом сервісу. Результати позначено неповними.</p>}
          <div className="lab-table"><table><thead><tr><th>Траєкторія</th><th>Результат</th><th>Gaia source_id · RMS</th></tr></thead><tbody>{report.catalogue_crossmatch.tracks.map(t=><tr key={t.track}><td>{t.track+1}</td><td>{{'possible-association':'Можлива відповідність','ambiguous':'Кілька відповідностей','no-association':'Немає відповідності у вибірці','incomplete':'Неповна перевірка'}[t.status]}</td><td>{t.candidates.length?t.candidates.map(c=><div key={c.source_id}>{c.source_id} · {c.rms_arcsec.toFixed(3)}″ · {c.epochs} епох{!c.motion_applied?' · власний рух невідомий':''}</div>):'—'}</td></tr>)}</tbody></table></div>
          <a href={report.catalogue_crossmatch.catalogue.source_url} target="_blank" rel="noreferrer">Вихідний запит Gaia DR3 ↗</a><p>Каталог, час отримання, контрольна сума й усі відстані збережені в JSON-звіті. Перенесення позицій враховує власний рух, без паралаксу.</p></div>}
        {!report.options.detect&&<p>Для цього звіту пошук кандидатів не запускався. Увімкніть його в параметрах нового аналізу.</p>}
        {report.frames.filter(f=>f.detection_error).map(f=><p className="lab-error" key={f.id}>{f.id}: {f.detection_error}</p>)}{report.tracking_error&&<p role="alert">{report.tracking_error}</p>}
        <div className="lab-table"><table><thead><tr><th>№</th><th>Епохи</th><th>Рух · ″/добу</th><th>RMS · ″</th><th>Діб</th><th>Класифікація</th></tr></thead><tbody>{report.tracks.map((t,i)=><tr key={i}><td><button aria-pressed={selectedTrack===i} onClick={()=>{setSelectedTrack(i);setSelected(null);onFrame(report.frames[t.detections[0].frame].id);}}>{i+1}</button></td><td>{t.count}</td><td>{t.speed_arcsec_day.toFixed(3)}</td><td>{t.rms_arcsec.toFixed(3)}</td><td>{t.span_days.toFixed(4)}</td><td>{t.motion_resolved?'Кандидат із вимірним зміщенням':'Рух не розділено'}</td></tr>)}</tbody></table></div>
        {track&&<div className="lab-picked"><h4>Детекції траєкторії {(selectedTrack??0)+1}</h4><p>Це вимірювання самого кандидата на кожній експозиції. Потоки з різних спектральних смуг безпосередньо не порівнюються.</p><div className="lab-table"><table><thead><tr><th>Кадр · UTC</th><th>RA · °</th><th>Dec · °</th><th>Потік ± умовна σ · мкЯн</th><th>λ · мкм</th></tr></thead><tbody>{track.detections.map(d=>{const f=report.frames[d.frame],p=f.detections[d.detection];return <tr key={d.id}><td><button title={f.id} onClick={()=>onFrame(f.id)}>{f.date}</button></td><td>{p.ra.toFixed(7)}</td><td>{p.dec.toFixed(7)}</td><td>{p.flux_uJy.toPrecision(4)} ± {p.flux_error_uJy.toPrecision(3)}</td><td>{p.wavelength_um.toFixed(5)}</td></tr>;})}</tbody></table></div></div>}
        <details><summary>Усі вимірювання та причини відхилення</summary><div className="lab-table"><table><thead><tr><th>Експозиція</th><th>Потік · мкЯн</th><th>Умовна σ</th><th>Статус</th></tr></thead><tbody>{report.frames.map(f=><tr key={f.id}><td><button onClick={()=>pick(f.id)}>{f.id}</button></td><td>{f.target?.flux_uJy.toPrecision(4)??'—'}</td><td>{f.target?.flux_error_uJy.toPrecision(3)??'—'}</td><td>{f.target?(f.target.quality_ok?'Придатний за критеріями моделі':'Низький S/N центра або неузгоджена модель'):f.target_error}</td></tr>)}</tbody></table></div>{report.excluded.map(f=><p key={f.id}>{f.id}: {f.reason}</p>)}</details>
        <details><summary>Метод та межі висновків</summary><p>Нативна сітка FITS, зважена ePSF-підгонка і площинний фон. Похибки з VARIANCE збільшуються при надлишкових залишках; кореляції шуму, похибки ePSF, WCS і абсолютної калібрації до них не входять. Моделі сусідів одночасно не підганяються.</p><p>Поріг S/N не є ймовірністю хибного відкриття. Повнота й хибні спрацьовування залежать від поля; результати синтетичних перевірок наведено в research/LABORATORY.md. Геометричні канали 0 та 18 поза номінальними 102 не домислюються.</p><p>Метод: {report.method}<br/>SHA-256: <code>{report.code_sha256}</code></p><a href="https://caltech-ipac.github.io/irsa-tutorials/spherex-psf/" target="_blank" rel="noreferrer">Документація IRSA: ePSF</a> · <a href="https://irsa.ipac.caltech.edu/data/SPHEREx/docs/spherex_spectral_calibrations.html" target="_blank" rel="noreferrer">Спектральні калібрації</a></details>
      </>}
    </div>}
  </section>;
}
