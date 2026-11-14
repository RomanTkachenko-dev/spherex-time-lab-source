import { apiUrl } from "./site-mode.ts";
import type { Manifest } from './science';
import type { CandidateCrossmatch } from './candidate-matches';
import { collectCatalogueParts, MAX_SERIES_FRAMES, type CatalogueBatchBody, type CatalogueRecord } from './catalogue-batches.ts';
import { cutoutRequest } from './field-query.ts';
export type LabOptions={ra:number;dec:number;fit_position:boolean;detect:boolean;snr:number;max_sources:number;response_tolerance:number;radius_arcsec:number;max_speed_arcsec_day:number;max_gap_days:number};
export type Measurement={ra:number;dec:number;flux_uJy:number;flux_error_uJy:number;snr:number;reduced_chi2:number;quality_ok:boolean;wavelength_um:number;bandwidth_um:number;channel_local:number;position_covariance_arcsec2:number[][]|null;centroid_fitted:boolean};
export type LabFrame={id:string;date:string;mjd:number;detector:number;release:string;target:Measurement|null;target_error:string|null;detections:Measurement[];detection_error?:string|null;detection_diagnostics?:{total_peaks:number;attempted_peaks:number;skipped_peaks:number;duplicates:number;rejected_quality:number;rejected_fit:number}};
export type Channel={channel:number;detector:number;local:number;count:number;reference:string|null;weighted_flux_uJy:number|null;error_uJy:number|null;chi2:number|null;dof:number;response?:{wavelength_um:number[];transmission:number[]}|null;comparisons:{id:string;distance:number|null;compatible:boolean}[]};
export type Track={count:number;rms_arcsec:number;speed_arcsec_day:number;span_days:number;motion_resolved:boolean;detections:{id:string;frame:number;detection:number;t:number;x:number;y:number}[]};
export type LabReport={schema_version:number;method:string;frames:LabFrame[];channels:Channel[];tracks:Track[];options:LabOptions;excluded:{id:string;reason:string}[];requested_count:number;code_sha256:string;created_at:string;limits:string[];tracking_error?:string;catalogue_crossmatch?:CandidateCrossmatch};
export type LabRecord={id:string;observation:string;detector:number;mjd:number;url:string;release:string;ra:number;dec:number;cutout_ra:number;cutout_dec:number;fov:number;cutout_url:string;expected_sha256?:string};
export function nominalChannel(detector:number,local:number):number|null{
  return Number.isInteger(detector)&&detector>=1&&detector<=6&&Number.isInteger(local)&&local>=1&&local<=17?(detector-1)*17+local:null;
}
export function labOptions(input:LabOptions):LabOptions{
  if(!Number.isFinite(input.ra)||input.ra<0||input.ra>=360||!Number.isFinite(input.dec)||Math.abs(input.dec)>90)throw Error('Некоректна позиція ICRS.');
  const ranges:[number,number,number][]=[[input.snr,3,100],[input.max_sources,1,200],[input.response_tolerance,0,0.5],[input.radius_arcsec,0.1,30],[input.max_speed_arcsec_day,0.1,100000],[input.max_gap_days,0.001,365]];
  if(ranges.some(([v,a,b])=>!Number.isFinite(v)||v<a||v>b)||!Number.isInteger(input.max_sources))throw Error('Параметри лабораторії виходять за допустимі межі.');
  return input;
}
export function currentLabRecords(m:Manifest):LabRecord[]{
  return m.frames.map(f=>{
    const cutout=new URL(f.cutout_url);const coordinates=(cutout.searchParams.get('center')||'').split(',').map(Number);
    const size=Number(cutout.searchParams.get('size'));const fov=size/1.6;
    if(coordinates.length!==2||!coordinates.every(Number.isFinite)||!Number.isFinite(fov)||fov<0.03||fov>0.3)throw Error('Неможливо відтворити геометрію FITS-вирізки. Побудуйте нову серію.');
    return {id:f.id,observation:f.observation_id,detector:Number(f.detector.slice(1)),mjd:f.mjd,url:f.source_url,release:f.release,ra:f.ra,dec:f.dec,cutout_ra:coordinates[0],cutout_dec:coordinates[1],fov,cutout_url:f.cutout_url,expected_sha256:f.sha256_cutout};
  });
}
export async function allDetectorRecords(m:Manifest,signal:AbortSignal,progress:(s:string)=>void){
  if(!m.query||m.query.most||m.query.ephemeris)throw Error('Пошук D1–D6 доступний для нерухомого поля. Для рухомої цілі аналізуйте поточну серію.');
  const records:LabRecord[]=[];const catalogue:unknown[]=[];
  for(let detector=1;detector<=6;detector++){
    const query={...m.query,detector,max_frames:60,wavelength_min:null,wavelength_max:null};
    progress(`Пошук спектрального покриття D${detector} / D6…`);
    const batches=await collectCatalogueParts({interval:{start:query.start,end:query.end},movingObject:false,request:async interval=>{
      const r=await fetch(apiUrl('/api/field'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...query,...interval}),signal});
      const body=await r.json() as CatalogueBatchBody<CatalogueRecord>;return {status:r.status,ok:r.ok,body};
    }});
    for(const part of batches.parts){const b=part.body as Record<string,unknown>;catalogue.push({detector,interval:part.interval,source_url:b.source_url,source_sha256:b.source_sha256,retrieved_at:b.retrieved_at});}
    if(records.length+batches.records.length>MAX_SERIES_FRAMES)throw Error(`Пошук D1–D6 перевищив ${MAX_SERIES_FRAMES} кадрів. Звузьте період; частковий список не буде використано.`);
    for(const row of batches.records){
      if(typeof row.observation!=='string'||typeof row.url!=='string')throw Error('Архів повернув некоректний запис.');
      records.push({id:row.observation+'D'+detector,observation:row.observation,detector,mjd:row.mjd,url:row.url,release:'spherex_'+query.release+(query.survey==='deep'?'_deep':''),ra:query.ra,dec:query.dec,cutout_ra:query.ra,cutout_dec:query.dec,fov:query.fov,cutout_url:cutoutRequest({...query,url:row.url})});
    }
  }
  return {records:records.sort((a,b)=>a.mjd-b.mjd||a.id.localeCompare(b.id)),catalogue};
}
export function measurementsCsv(report:LabReport){
  const header='frame_id,UTC,detector,channel,wavelength_um,flux_uJy,conditional_error_uJy,ra_deg,dec_deg,reduced_chi2,quality_ok,local_channel';
  return header+'\n'+report.frames.filter(f=>f.target).map(f=>{const p=f.target!;return [f.id,f.date,f.detector,nominalChannel(f.detector,p.channel_local)??'',p.wavelength_um,p.flux_uJy,p.flux_error_uJy,p.ra,p.dec,p.reduced_chi2,p.quality_ok,p.channel_local].join(',');}).join('\n')+'\n';
}
