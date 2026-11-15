"use client";
import { apiUrl, apiOrigin, publicAsset } from "@/lib/site-mode";
import {useEffect,useRef,useState} from 'react';
import type {Manifest} from '@/lib/science';
import {allDetectorRecords,currentLabRecords,labOptions,measurementsCsv,type LabFrame,type LabOptions,type LabReport} from '@/lib/laboratory';
import {readLatestLab,saveLabAssociations} from '@/lib/lab-storage';
import {associateTrackCones} from '@/lib/candidate-matches';
import type {GaiaReference} from '@/lib/gaia';
import {ChevronDown} from 'lucide-react';
import {useMessage,useTranslation} from '@/lib/language';
import './science-lab.css';

function saveFile(value:string,type:string,name:string){const url=URL.createObjectURL(new Blob([value],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function Plot({frames,spectrum,onSelect}:{frames:LabFrame[];spectrum:boolean;onSelect:(id:string)=>void}){
  const t=useTranslation();
  const points=frames.filter(f=>f.target?.quality_ok);
  if(!points.length)return <p>{t('No usable measurements to plot yet.')}</p>;
  const xValues=points.map(f=>spectrum?f.target!.wavelength_um:f.mjd);
  const yValues=points.flatMap(f=>[f.target!.flux_uJy-f.target!.flux_error_uJy,f.target!.flux_uJy+f.target!.flux_error_uJy]);
  const lo=xValues.reduce((a,b)=>Math.min(a,b),Infinity),hi=xValues.reduce((a,b)=>Math.max(a,b),-Infinity),bottom=yValues.reduce((a,b)=>Math.min(a,b),Infinity),top=yValues.reduce((a,b)=>Math.max(a,b),-Infinity);
  const x=(n:number)=>hi===lo?380:65+((n-lo)/(hi-lo))*630,y=(n:number)=>245-((n-bottom)/(top-bottom||1))*210;
  return <svg viewBox="0 0 760 300" role="group" aria-label={spectrum?t('Spectrum: flux and nominal error by wavelength'):t('Light curve of the selected channel')}>
    <line x1="65" y1="245" x2="695" y2="245" stroke="currentColor"/><line x1="65" y1="35" x2="65" y2="245" stroke="currentColor"/>
    {(hi===lo?[.5]:[0,.25,.5,.75,1]).map(f=><text key={f} x={x(lo+f*(hi-lo))} y="265" textAnchor="middle">{(lo+f*(hi-lo)).toFixed(spectrum?3:5)}</text>)}
    {[0,.25,.5,.75,1].map(f=><text key={f} x="59" y={y(bottom+f*(top-bottom))+4} textAnchor="end">{(bottom+f*(top-bottom)).toPrecision(3)}</text>)}
    <text x="380" y="292" textAnchor="middle">{spectrum?t('Wavelength · µm'):'MJD · UTC'}</text><text x="12" y="20">{t('Flux · µJy')}</text>
    {points.map(f=>{const p=f.target!,px=x(spectrum?p.wavelength_um:f.mjd),py=y(p.flux_uJy);return <g key={f.id} tabIndex={0} role="button" aria-label={`${f.date} UTC, ${p.flux_uJy.toPrecision(4)} ± ${p.flux_error_uJy.toPrecision(3)} ${t('µJy')}`} onClick={()=>onSelect(f.id)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onSelect(f.id);}}}><title>{f.id}: {p.wavelength_um.toFixed(5)} {t('µm')}; {f.date} UTC</title><line x1={px} x2={px} y1={y(p.flux_uJy-p.flux_error_uJy)} y2={y(p.flux_uJy+p.flux_error_uJy)} stroke="#b9ec68"/><circle cx={px} cy={py} r="4" fill="#b9ec68"/></g>;})}
  </svg>;
}

export default function ScienceLab({manifest,onFrame}:{manifest:Manifest;onFrame:(id:string)=>void}){
  const t=useTranslation(),msg=useMessage();
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[status,setStatus]=useState(''),[error,setError]=useState('');
  const [report,setReport]=useState<LabReport|null>(null),[resumeAvailable,setResumeAvailable]=useState(false);
  const [channel,setChannel]=useState(1),[selected,setSelected]=useState<string|null>(null),[all,setAll]=useState(false),[custom,setCustom]=useState(false);
  const [selectedTrack,setSelectedTrack]=useState<number|null>(null);
  const [matching,setMatching]=useState(false),[matchError,setMatchError]=useState(''),[matchAttempt,setMatchAttempt]=useState(0);
  const [options,setOptions]=useState<LabOptions>({ra:manifest.frames[0].ra,dec:manifest.frames[0].dec,fit_position:false,detect:false,snr:5,max_sources:100,response_tolerance:.05,radius_arcsec:2,max_speed_arcsec_day:100,max_gap_days:2});
  const worker=useRef<Worker|null>(null),request=useRef<AbortController|null>(null),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;worker.current?.terminate();request.current?.abort();};},[]);
  useEffect(()=>{
    if(!report||report.catalogue_crossmatch?.per_track||!report.tracks.length||busy)return;
    const controller=new AbortController();const current=report;
    (async()=>{
      await Promise.resolve();if(controller.signal.aborted)return;
      setMatching(true);setMatchError('');
      const result = await associateTrackCones(current, async cone => {
      const response=await fetch(apiUrl(`/api/gaia?ra=${cone.ra}&dec=${cone.dec}&radius=${cone.radius}`),{signal:controller.signal});
      const catalogue=await response.json() as GaiaReference&{error?:string};
      if(!response.ok)throw Error(catalogue.error||t('Gaia DR3 is unavailable. Try again in a minute.'));
        return catalogue;
      }, controller.signal);
      if(controller.signal.aborted)return;
      const enriched={...current,catalogue_crossmatch:result};
      await saveLabAssociations(enriched);
      if(!controller.signal.aborted){setMatching(false);setReport(enriched);}
    })().catch(e=>{if(!controller.signal.aborted)setMatchError(e instanceof Error?e.message:String(e));})
      .finally(()=>{if(!controller.signal.aborted)setMatching(false);});
    return()=>controller.abort();
  },[report,busy,matchAttempt]);
  async function restore(){try{const saved=await readLatestLab() as {report?:LabReport;next?:number;options?:LabOptions;records?:{ra:number;dec:number}[]}|undefined;if(saved){setReport(saved.report??null);setResumeAvailable(!saved.report);if(saved.options){setOptions(saved.options);setCustom(!!saved.records?.length&&saved.records.every(r=>r.ra===saved.options!.ra&&r.dec===saved.options!.dec));}if(saved.report)setChannel(saved.report.channels.find(c=>c.count>0)?.channel??1);setStatus(saved.report?t('Opened the last saved report.'):t('{a} of {n} exposures saved; you can resume.',{a:saved.next??0,n:saved.records?.length??0}));}else{setResumeAvailable(false);setStatus(t('No saved analysis yet.'));}}catch(e){setError(String(e));}}
  function stop(){worker.current?.terminate();worker.current=null;request.current?.abort();setBusy(false);setResumeAvailable(true);setStatus(t('Paused. Finished exposures are saved; you can resume.'));}
  async function start(resume=false){
    setError('');setMatching(false);setBusy(true);setStatus(t('Preparing the analysis…'));
    request.current=new AbortController();
    try{
      const opts=resume?options:labOptions(options);
      let records, catalogue;
      if(!resume){
        if(all){const result=await allDetectorRecords(manifest,request.current.signal,setStatus);records=result.records;catalogue=result.catalogue;}
        else{records=currentLabRecords(manifest);catalogue={source_url:manifest.observation_table_url,source_sha256:manifest.observation_table_sha256,parts:manifest.observation_table_parts??[]};}
        if(custom)records=records.map(r=>({...r,ra:opts.ra,dec:opts.dec}));
        if(!records.length)throw Error(t('No exposures to analyse for these dates.'));
      }
      if(request.current.signal.aborted||!mounted.current)return;
      const w=new Worker(publicAsset('/science/lab-worker.mjs'),{type:'module'});worker.current=w;
      w.onmessage=event=>{
        if(!mounted.current||worker.current!==w)return;
        const message=event.data;
        if(message.type==='progress')setStatus(message.detail);
        if(message.type==='complete'){const value=message.report as LabReport;setReport(value);setOptions(value.options);setChannel(value.channels.find(c=>c.count>0)?.channel??1);setSelected(null);setBusy(false);setResumeAvailable(false);setStatus(t('Analysis finished: {a} processed, {b} rejected.',{a:value.frames.length,b:value.excluded.length}));w.terminate();worker.current=null;}
        if(message.type==='error'){setError(message.message);setBusy(false);setResumeAvailable(true);w.terminate();worker.current=null;}
      };
      w.onerror=e=>{setError(e.message||t('The science module crashed. You can resume the saved analysis.'));setBusy(false);setResumeAvailable(true);w.terminate();worker.current=null;};
      w.postMessage({resume,options:opts,records,catalogue,apiOrigin});
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
  return <section className="science-lab" aria-label={t('Science lab')}>
    <button className="lab-open" aria-expanded={open} onClick={()=>{setOpen(v=>!v);if(!open&&!report)void restore();}}><span className="lab-open-title">{t('Science lab (advanced)')}<ChevronDown size={20} className="lab-open-chevron" aria-hidden="true"/></span> <span>{t('Measure brightness · spectrum · find moving candidates')}</span></button>
    {open&&<div className="lab-body"><h2>{t('From images to measurements')}</h2><p>{t('A point-source model fitted to the native FITS images: ePSF + local background + VARIANCE. It may not suit galaxies, comets with a coma, or blended neighbours.')}</p>
      <p className="lab-error">{t('Research mode. Tests on two DR1 fields showed detector limits on crowded backgrounds and flux bias when the source shape doesn\'t match the model. Accuracy and completeness on the real sky are not yet confirmed; an accepted local fit does not remove systematic errors.')}</p>
      <fieldset disabled={busy}><legend>{t('Data and model for a new run')}</legend><p>{t('Resuming uses the records and settings from the saved progress. A new run replaces the last analysis, so export any report you need first.')}</p><div className="lab-controls">
        <label><input type="checkbox" checked={all} disabled={!manifest.query||!!manifest.query.most||!!manifest.query.ephemeris} onChange={e=>setAll(e.target.checked)}/> {t('Find D1–D6 for the same dates and field')}</label>
        <label><input type="checkbox" checked={custom} onChange={e=>setCustom(e.target.checked)}/> {t('Measure at my own fixed position')}</label>
        {custom&&<>{numeric('ra',t('RA · degrees'),0,359.999999,.000001)}{numeric('dec',t('Dec · degrees'),-90,90,.000001)}</>}
        <label><input type="checkbox" checked={options.fit_position} onChange={e=>setOptions(p=>({...p,fit_position:e.target.checked}))}/> {t('Fit the source centre (otherwise the position is fixed)')}</label>
        <label><input type="checkbox" checked={options.detect} onChange={e=>setOptions(p=>({...p,detect:e.target.checked}))}/> {t('Detect peaks and link candidates into tracks')}</label>
        {numeric('response_tolerance',t('Tolerance for normalised response difference (0–0.5)'),0,.5,.01)}
        {options.detect&&<>{numeric('snr',t('Signal-to-noise threshold'),3,100,.5)}{numeric('max_sources',t('Max peak fits per exposure'),1,200,1)}{numeric('radius_arcsec',t('Track tolerance · arcseconds'),.1,30,.1)}{numeric('max_speed_arcsec_day',t('Max speed · ″/day'),.1,100000,1)}{numeric('max_gap_days',t('Max track duration · days'),.001,365,.1)}</>}
      </div><p>{all?t('Each detector will be searched separately in full.'):t('Analysing the current series: {n} exposures.',{n:manifest.frames.length})} {t('Empty wavelength channels stay empty. Calibrations are downloaded when needed and can be large.')}</p></fieldset>
      <div className="lab-actions"><button disabled={busy} onClick={()=>void start()}>{t('Start a new analysis')}</button><button disabled={busy||!resumeAvailable} onClick={()=>void start(true)}>{t('Resume saved analysis')}</button>{busy&&<button onClick={stop}>{t('Pause')}</button>}<button disabled={busy} onClick={()=>void restore()}>{t('Open last report')}</button></div>
      <p role="status" aria-live="polite">{msg(status)}</p>{error&&<p className="lab-error" role="alert">{msg(error)}</p>}
      {report&&<><div className="lab-actions"><button onClick={()=>saveFile(JSON.stringify(report,null,2),'application/json','spherex-science-report.json')}>{t('Download report (JSON)')}</button><button onClick={()=>saveFile(measurementsCsv(report),'text/csv;charset=utf-8','spherex-measurements.csv')}>{t('Measurements (CSV)')}</button></div>
        <p>{t('Report {date} · {a} / {n} exposures. This is a separately saved analysis and may belong to another series. Settings and sources are recorded in the JSON.',{date:report.created_at,a:report.frames.length,n:report.requested_count})}</p>
        <h3>{t('Spectrum and coverage of the 102 channels')}</h3><p>{t('Each point is a separate exposure with its own time. Error bars are nominal and leave out calibration systematics. Gaps are not filled in.')}</p>
        <Plot frames={report.frames} spectrum onSelect={pick}/>
        <div className="lab-channel-grid" aria-label={t('Wavelength channels')}>{report.channels.map(c=><button key={c.channel} className={c.count?'has-data':''} aria-pressed={channel===c.channel} aria-label={t('Channel {c}, D{d}, {n} measurements',{c:c.channel,d:c.detector,n:c.count})} title={t('D{d} · channel {l} · {n} measurements',{d:c.detector,l:c.local,n:c.count})} onClick={()=>setChannel(c.channel)}>{c.channel}<small>{c.count||'—'}</small></button>)}</div>
        <h3>{t('Light curve · channel {c}',{c:channel})}</h3><p>{t('Only exposures from one release whose spectral response shape passed the check against the channel\'s first exposure are compared. The ePSF is included in each exposure\'s model. The response is approximated from a lab curve; it does not exactly match the transmission of every pixel.')}</p>
        <Plot frames={lightFrames} spectrum={false} onSelect={pick}/>
        <p>{t('Accepted for comparison: {a} of {n}.',{a:lightFrames.length,n:active?.count??0})} {active?.weighted_flux_uJy!=null&&t('Mean assuming constant flux: {f} ± {e} µJy.',{f:active.weighted_flux_uJy.toPrecision(4),e:active.error_uJy!.toPrecision(3)})} {(active?.dof??0)>0&&t(' χ² = {c}, degrees of freedom = {d}. This is a rough diagnostic, not proof of variability.',{c:active!.chi2!.toFixed(2),d:active!.dof})}</p>
        {!!active?.comparisons.length&&<details><summary>{t('Why each measurement was accepted or rejected')}</summary><p>{t('Reference exposure: {r}. Tolerance of the saved analysis: {tol}. Spectral distance describes the shape of the normalised curves; it is not a flux error.',{r:active.reference??'',tol:report.options.response_tolerance})}</p><div className="lab-table"><table><thead><tr><th>{t('Exposure')}</th><th>{t('Spectral distance')}</th><th>{t('Decision')}</th></tr></thead><tbody>{active.comparisons.map(c=>{const frame=report.frames.find(f=>f.id===c.id);return <tr key={c.id}><td><button onClick={()=>pick(c.id)}>{c.id}</button></td><td>{c.distance?.toPrecision(4)??t('Not defined')}</td><td>{c.compatible?t('Accepted'):frame?.release!==referenceFrame?.release?t('Different release'):c.distance===null?t('No usable response'):t('Responses outside tolerance')}</td></tr>;})}</tbody></table></div></details>}
        {picked?.target&&!picked.target.quality_ok&&<p className="lab-error">{t('The selected measurement failed the model criteria, so it is not in the spectrum or light curve.')}</p>}
        {picked?.target&&<div className="lab-picked"><strong>{picked.id}</strong><p>{picked.date} UTC · {picked.target.wavelength_um.toFixed(5)} {t('µm')}</p><p>{t('Flux')}: {picked.target.flux_uJy.toPrecision(5)} ± {picked.target.flux_error_uJy.toPrecision(3)} {t('µJy')} · S/N {picked.target.snr.toFixed(2)} · χ²/ν {picked.target.reduced_chi2.toFixed(2)}</p><p>RA {picked.target.ra.toFixed(7)}°, Dec {picked.target.dec.toFixed(7)}°. {picked.target.centroid_fitted?t('Centre measured.'):t('Position fixed, not measured.')}</p>{picked.target.position_covariance_arcsec2&&<p>{t('Nominal centre errors E/N: {e}″ / {n}″.',{e:Math.sqrt(picked.target.position_covariance_arcsec2[0][0]).toFixed(3),n:Math.sqrt(picked.target.position_covariance_arcsec2[1][1]).toFixed(3)})}</p>}</div>}
        <h3>{t('Candidates and tracks')}</h3><p>{t('{d} detections · {n} tracks. Sorted by number of independent time points, model residuals, then time span. No catalogue match does not mean a new object; orbits are not computed.',{d:report.frames.reduce((s,f)=>s+f.detections.length,0),n:report.tracks.length})}</p>
        {report.options.detect&&report.frames.some(f=>f.detection_error)&&<details open><summary>{t('The candidate search did not finish in every exposure')}</summary><p>{t('A detector error does not mean there are no sources. Tracks use only the detections that are available.')}</p>{report.frames.filter(f=>f.detection_error).map(f=><p key={f.id}>{f.id}: {msg(f.detection_error)}</p>)}</details>}
        {report.options.detect && report.frames.some(f=>f.detection_diagnostics?.skipped_peaks) && <p role="status">{t('In some exposures only the strongest peaks were processed. {n} peaks were skipped, so the search is incomplete.',{n:report.frames.reduce((sum,f)=>sum+(f.detection_diagnostics?.skipped_peaks??0),0)})}</p>}
        {matching&&<p role="status">{t('Matching tracks against Gaia DR3 at each exposure time…')}</p>}
        {matchError&&<p role="alert">{t('Catalogue matching did not finish:')} {msg(matchError)} <button onClick={()=>setMatchAttempt(v=>v+1)}>{t('Retry')}</button></p>}
        {report.catalogue_crossmatch&&<div className="lab-picked"><h4>{t('Gaia DR3 match')}</h4><p>{t('Radius {r}″ at each epoch. A possible positional match is not a confirmed identification. No match does not mean a new object; the small-body catalogue is not checked here.',{r:report.catalogue_crossmatch.radius_arcsec})}</p>
          {report.catalogue_crossmatch.tracks.some(tr=>tr.status==="incomplete")&&<p role="alert">{t('The check is incomplete for some tracks. Sources and reasons are saved in the report.')}</p>}
          <div className="lab-table"><table><thead><tr><th>{t('Track')}</th><th>{t('Result')}</th><th>Gaia source_id · RMS</th></tr></thead><tbody>{report.catalogue_crossmatch.tracks.map(tr=><tr key={tr.track}><td>{tr.track+1}</td><td>{{'possible-association':t('Possible match'),'ambiguous':t('Several matches'),'no-association':t('No match in the selection'),'incomplete':t('Incomplete check')}[tr.status]}</td><td>{tr.candidates.length?tr.candidates.map(c=><div key={c.source_id}>{c.source_id} · {c.rms_arcsec.toFixed(3)}″ · {t('{n} epochs',{n:c.epochs})}{!c.motion_applied?' · '+t('proper motion unknown'):''}</div>):'—'}</td></tr>)}</tbody></table></div>
          <a href={report.catalogue_crossmatch.catalogue.source_url} target="_blank" rel="noreferrer">{t('Original Gaia DR3 query ↗')}</a><p>{t('The catalogue, retrieval time, checksum and all distances are saved in the JSON report. Positions are moved for proper motion, without parallax.')}</p></div>}
        {!report.options.detect&&<p>{t('The candidate search was not run for this report. Turn it on in the settings for a new analysis.')}</p>}
        {report.frames.filter(f=>f.detection_error).map(f=><p className="lab-error" key={f.id}>{f.id}: {msg(f.detection_error)}</p>)}{report.tracking_error&&<p role="alert">{msg(report.tracking_error)}</p>}
        <div className="lab-table"><table><thead><tr><th>#</th><th>{t('Epochs')}</th><th>{t('Motion · ″/day')}</th><th>RMS · ″</th><th>{t('Days')}</th><th>{t('Classification')}</th></tr></thead><tbody>{report.tracks.map((tr,i)=><tr key={i}><td><button aria-pressed={selectedTrack===i} onClick={()=>{setSelectedTrack(i);setSelected(null);onFrame(report.frames[tr.detections[0].frame].id);}}>{i+1}</button></td><td>{tr.count}</td><td>{tr.speed_arcsec_day.toFixed(3)}</td><td>{tr.rms_arcsec.toFixed(3)}</td><td>{tr.span_days.toFixed(4)}</td><td>{tr.motion_resolved?t('Candidate with measurable motion'):t('Motion not resolved')}</td></tr>)}</tbody></table></div>
        {track&&<div className="lab-picked"><h4>{t('Detections in track {n}',{n:(selectedTrack??0)+1})}</h4><p>{t('These are measurements of the candidate itself in each exposure. Fluxes from different wavelength bands are not directly comparable.')}</p><div className="lab-table"><table><thead><tr><th>{t('Exposure · UTC')}</th><th>RA · °</th><th>Dec · °</th><th>{t('Flux ± nominal σ · µJy')}</th><th>λ · {t('µm')}</th></tr></thead><tbody>{track.detections.map(d=>{const f=report.frames[d.frame],p=f.detections[d.detection];return <tr key={d.id}><td><button title={f.id} onClick={()=>onFrame(f.id)}>{f.date}</button></td><td>{p.ra.toFixed(7)}</td><td>{p.dec.toFixed(7)}</td><td>{p.flux_uJy.toPrecision(4)} ± {p.flux_error_uJy.toPrecision(3)}</td><td>{p.wavelength_um.toFixed(5)}</td></tr>;})}</tbody></table></div></div>}
        <details><summary>{t('All measurements and reasons for rejection')}</summary><div className="lab-table"><table><thead><tr><th>{t('Exposure')}</th><th>{t('Flux · µJy')}</th><th>{t('Nominal σ')}</th><th>{t('Status')}</th></tr></thead><tbody>{report.frames.map(f=><tr key={f.id}><td><button onClick={()=>pick(f.id)}>{f.id}</button></td><td>{f.target?.flux_uJy.toPrecision(4)??'—'}</td><td>{f.target?.flux_error_uJy.toPrecision(3)??'—'}</td><td>{f.target?(f.target.quality_ok?t('Usable by the model criteria'):t('Low central S/N or inconsistent model')):msg(f.target_error)}</td></tr>)}</tbody></table></div>{report.excluded.map(f=><p key={f.id}>{f.id}: {msg(f.reason)}</p>)}</details>
        <details><summary>{t('Method and limits of the conclusions')}</summary><p>{t('Native FITS grid, weighted ePSF fit and a planar background. Errors from VARIANCE are inflated when residuals are too large; noise correlations, ePSF, WCS and absolute calibration errors are not included. Neighbouring sources are not fitted at the same time.')}</p><p>{t('The S/N threshold is not a false-discovery probability. Completeness and false alarms depend on the field; synthetic test results are in research/LABORATORY.md. Geometric channels 0 and 18 outside the nominal 102 are not invented.')}</p><p>{t('Method:')} {report.method}<br/>SHA-256: <code>{report.code_sha256}</code></p><a href="https://caltech-ipac.github.io/irsa-tutorials/spherex-psf/" target="_blank" rel="noreferrer">{t('IRSA documentation: ePSF')}</a> · <a href="https://irsa.ipac.caltech.edu/data/SPHEREx/docs/spherex_spectral_calibrations.html" target="_blank" rel="noreferrer">{t('Spectral calibrations')}</a></details>
      </>}
    </div>}
  </section>;
}
