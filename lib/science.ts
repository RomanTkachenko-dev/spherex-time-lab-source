import type { FieldQuery } from "./field-query";
import type { GaiaReference } from "./gaia";
import { MAX_CATALOGUE_PARTS, MAX_SERIES_FRAMES } from "./catalogue-batches.ts";
export type Frame = {
  id: string; observation_id: string; date: string; date_start: string; date_end: string;
  mjd: number; exposure_s: number; detector: string; release: string;
  image: string; object_image: string; quality_mask_image?: string; object_quality_mask_image?: string; wavelength_um: number; bandwidth_um: number;
  display_asset_sha256?: Record<string,string>;
  ra: number; dec: number; source_url: string; cutout_url: string; sha256_cutout: string;
  marker_sky: { x: number; y: number }; marker_sky_visible?: boolean; marker_object: { x: number; y: number };
  position_kind: string; measurement: null;
  quality: { level1: string; level2: string; flagged_display_fraction: number;
    flags_at_predicted_position?: number; bad_at_predicted_position?: boolean;
    flags_at_position?: number; bad_at_position?: boolean; coverage_fraction?: number;
    finite_pixel_count?: number; finite_coverage_fraction?: number;
    target_finite_pixel_count?: number; target_finite_coverage_fraction?: number;
    usable_coverage_fraction?: number; median_psf_fwhm_arcsec: number | null };
};
export type Manifest = {
  kind?: "field"; query?: FieldQuery; gaia_reference?: GaiaReference;
  archive_collection?: string;
  observation_table_parts?: { start: string; end: string; source_url: string; source_sha256: string; retrieved_at: string; matched_count: number }[];
  completeness?: { matched_count: number; candidate_count?: number; selected_count: number; processed_count: number; catalogue_truncated: boolean; selection: string; excluded: {id: string; reason: string}[] };
  software?: Record<string,string>;
  title: string; frames: Frame[]; source: string; description: string; schema_version: number;
  observation_table_url: string; observation_table_sha256: string; retrieved_at?: string;
  attribution: string; dataset_doi: string; method_version: string; limits: string[];
  display: { width: number; height: number; sky_fov_deg: number; object_fov_deg: number;
    sky_center_ra: number; sky_center_dec: number; low_MJy_sr: number; high_MJy_sr: number; [key:string]: unknown };
};
export function validateManifest(value: unknown): Manifest {
  const m=value as Manifest;
  const maxFrames = m?.schema_version === 4 ? MAX_SERIES_FRAMES : 120;
  if (!m || ![1,2,3,4].includes(m.schema_version) || (m.schema_version>=2 && (m.kind!=="field" || !m.query)) || !Array.isArray(m.frames) || m.frames.length<2 || m.frames.length>maxFrames || m.display?.width!==256 || m.display?.height!==256 || !(m.display.sky_fov_deg>0) || !(m.display.object_fov_deg>0)) throw Error("Набір спостережень не пройшов перевірку формату.");
  if (m.schema_version===4) {
    const validInterval=(value:unknown):value is [number,number]=>Array.isArray(value)&&value.length===2&&value.every(Number.isFinite)&&value[0]<=value[1];
    const low=m.display.low_MJy_sr, high=m.display.high_MJy_sr;
    const lowInterval=m.display.scale_low_interval_MJy_sr, highInterval=m.display.scale_high_interval_MJy_sr;
    const completeness=m.completeness;
    if (!Number.isInteger(m.query!.max_frames) || m.query!.max_frames<m.frames.length || m.query!.max_frames>MAX_SERIES_FRAMES || m.display.scale_algorithm!=="signed-binary-exponent-histogram-v1" || !Number.isInteger(m.display.scale_sample_count) || (m.display.scale_sample_count as number)<2 || !validInterval(lowInterval) || !validInterval(highInterval) || !Number.isFinite(low) || !Number.isFinite(high) || !(high>low) || low<lowInterval[0] || low>lowInterval[1] || high<highInterval[0] || high>highInterval[1] || !completeness || !Number.isInteger(completeness.selected_count) || completeness.selected_count<m.frames.length || completeness.processed_count!==m.frames.length || !Array.isArray(completeness.excluded) || completeness.excluded.length!==completeness.selected_count-m.frames.length) throw Error("Паспорт потокової серії не містить узгоджених меж шкали або повноти обробки.");
  }
  if (m.schema_version===3 || m.schema_version===4) {
    const release=m.query?.release, survey=m.query?.survey;
    const expected=release&&survey?"spherex_"+release+(survey==="deep"?"_deep":""):"";
    if(survey==="most"?!m.query?.most:!!m.query?.most) throw Error("Паспорт не узгоджує спосіб пошуку рухомої цілі.");
    if (!["qr2","qr3","dr1"].includes(release ?? "") || !["wide","deep","most"].includes(survey ?? "") || m.archive_collection!==expected || m.frames.some(f=>f.release!==expected) || m.dataset_doi!==(release==="dr1"?"10.26131/IRSA678":release==="qr3"?"10.26131/IRSA662":"10.26131/IRSA652")) throw Error("Реліз і тип огляду не узгоджені в паспорті.");
    if (m.observation_table_parts !== undefined) {
      const parts = m.observation_table_parts;
      const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
      if (!Array.isArray(parts) || parts.length < 1 || parts.length > MAX_CATALOGUE_PARTS) throw Error("Паспорт містить некоректний перелік частин запиту каталогу.");
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        let url: URL | null = null;
        try { url = new URL(part.source_url); } catch { /* validated below */ }
        const archiveUrl = url?.origin === "https://irsa.ipac.caltech.edu" && (url.pathname === "/SIA" || url.pathname === "/cgi-bin/MOST/nph-most");
        const startMjd = Date.parse(`${part.start}T00:00:00Z`) / 86_400_000 + 40587;
        const endMjd = Date.parse(`${part.end}T00:00:00Z`) / 86_400_000 + 40588;
        const siaTime = url?.pathname === "/SIA" ? url.searchParams.get("TIME")?.trim().split(/\s+/).map(Number) : null;
        const queryMatchesRange = url?.pathname === "/SIA"
          ? url.searchParams.get("COLLECTION") === m.archive_collection && url.searchParams.get("MAXREC") === "1000" && siaTime?.length === 2 && siaTime.every(Number.isFinite) && Math.abs(siaTime[0] - startMjd) < 1e-8 && Math.abs(siaTime[1] - endMjd) < 1e-8
          : url?.pathname === "/cgi-bin/MOST/nph-most" && url.searchParams.get("catalog") === "spherex" && url.searchParams.get("obs_begin") === part.start && url.searchParams.get("obs_end") === part.end;
        if (!validDate(part.start) || !validDate(part.end) || part.start > part.end || part.start < m.query!.start || part.end > m.query!.end || !archiveUrl || !queryMatchesRange || !/^[a-f0-9]{64}$/.test(part.source_sha256) || !Number.isFinite(Date.parse(part.retrieved_at)) || !Number.isInteger(part.matched_count) || part.matched_count < 0 || part.matched_count > 100_000 || (i === 0 && (part.start !== m.query!.start || part.source_url !== m.observation_table_url || part.source_sha256 !== m.observation_table_sha256 || part.retrieved_at !== m.retrieved_at)) || (i > 0 && (part.start !== new Date(Date.parse(`${parts[i - 1].end}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)))) throw Error("Паспорт каталогу не зберігає цілісне покриття дат або перевірюване походження.");
      }
      if (parts.at(-1)!.end !== m.query!.end || parts.reduce((sum, part) => sum + part.matched_count, 0) < (m.completeness?.matched_count ?? 0)) throw Error("Паспорт каталогу не охоплює кінцеву дату або кількість збігів.");
    }
  }
  if (m.display.asset_storage !== undefined && m.display.asset_storage !== "indexeddb-sha256-v1") throw Error("Невідомий формат зберігання зображень.");
  const localAssets = m.schema_version===4 || m.display.asset_storage === "indexeddb-sha256-v1";
  const imageValid = (s:unknown) => typeof s==='string' && (localAssets ? /^idb:[a-f0-9-]{36}:[a-f0-9]{64}$/.test(s) : m.kind==='field' ? s.length<700000 && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(s) : /^\/data\/atlas\/[a-z]+-\d{2}\.png$/.test(s));
  if(m.gaia_reference){
    const g=m.gaia_reference;
    if(m.kind!=="field"||g.service!=="IRSA TAP · Gaia DR3"||g.table!=="gaia_dr3_source"||!/^https:\/\/irsa\.ipac\.caltech\.edu\/TAP\/sync\?/.test(g.source_url)||!/^[a-f0-9]{64}$/.test(g.source_sha256)||!Number.isFinite(Date.parse(g.retrieved_at))||!Number.isFinite(g.center_ra)||g.center_ra<0||g.center_ra>=360||!Number.isFinite(g.center_dec)||Math.abs(g.center_dec)>90||!Number.isFinite(g.radius_deg)||g.radius_deg<=0||g.radius_deg>1.5||!Number.isInteger(g.record_count)||g.record_count!==g.sources.length||g.sources.length>1200||typeof g.truncated!=="boolean")throw Error("Паспорт Gaia DR3 містить некоректне походження або межі вибірки.");
    for(const s of g.sources)if(!/^\d{1,20}$/.test(s.source_id)||!Number.isFinite(s.ra)||s.ra<0||s.ra>=360||!Number.isFinite(s.dec)||Math.abs(s.dec)>90||!Number.isFinite(s.ref_epoch)||[s.ra_error,s.dec_error,s.pmra,s.pmdec,s.pmra_error,s.pmdec_error,s.phot_g_mean_mag].some(v=>v!==null&&v!==undefined&&!Number.isFinite(v)))throw Error("Паспорт Gaia DR3 містить некоректний запис каталогу.");
  }
  const ids=new Set<string>();
  m.frames.forEach((f,i)=>{
    const expectedPositionKind=m.kind==='field'?(m.query?.most?'irsa-most-matched-position':m.query?.ephemeris?'user-supplied-horizons-ephemeris':'requested-sky-position'):'IRSA-predicted-per-exposure';
    if(typeof f.id!=="string"||!/^\w+$/.test(f.id)||ids.has(f.id)||!Number.isFinite(f.mjd)||!Number.isFinite(f.wavelength_um)||f.wavelength_um<=0||!Number.isFinite(f.bandwidth_um)||f.bandwidth_um<=0||!Number.isFinite(f.ra)||f.ra<0||f.ra>=360||!Number.isFinite(f.dec)||Math.abs(f.dec)>90||!f.marker_sky||!f.marker_object||!f.quality||typeof f.source_url!=="string"||!f.source_url.startsWith("https://irsa.ipac.caltech.edu/")|| !imageValid(f.image)||!imageValid(f.object_image)||(m.kind==='field'&&!imageValid(f.quality_mask_image))||f.measurement!==null||f.position_kind!==expectedPositionKind|| (i>0&&f.mjd<m.frames[i-1].mjd)) throw Error("Метадані спостережень неузгоджені.");
    const fractions=[f.quality.coverage_fraction,f.quality.usable_coverage_fraction,f.quality.flagged_display_fraction,f.quality.finite_coverage_fraction,f.quality.target_finite_coverage_fraction].filter((n):n is number=>n!==undefined);
    if(fractions.some(n=>!Number.isFinite(n)||n<0||n>1))throw Error("Некоректна частка покриття або маски якості.");
    const finiteCounts=[f.quality.finite_pixel_count,f.quality.target_finite_pixel_count].filter((n):n is number=>n!==undefined);
    if(finiteCounts.some(n=>!Number.isInteger(n)||n<0||n>m.display.width*m.display.height))throw Error("Некоректна кількість скінченних пікселів.");
    const primaryFinite=m.query?.most||m.query?.ephemeris?f.quality.target_finite_pixel_count:f.quality.finite_pixel_count;
    if(primaryFinite===0)throw Error("Кадр не має скінченних значень у відповідній проєкції.");
    if(![f.marker_sky.x,f.marker_sky.y,f.marker_object.x,f.marker_object.y].every(n=>Number.isFinite(n)&&n>=0&&n<=255))throw Error("Некоректна проєкція координат.");
    if(!Number.isInteger(positionFlags(f))||positionFlags(f)<0||positionFlags(f)>4294967295||!/^\d{4}-\d{2}-\d{2}T/.test(f.date))throw Error("Некоректні прапорці або час кадру.");
    if(localAssets){const assets=f.display_asset_sha256;const names=["image","object_image","quality_mask_image","object_quality_mask_image"] as const;if(!assets||names.some(name=>!imageValid(f[name])||!/^([a-f0-9]{64})$/.test(assets[name]??"")||!String(f[name]).endsWith(`:${assets[name]}`)))throw Error("Паспорт не пов’язує PNG кадру з контрольною сумою.");}
    ids.add(f.id);
  });
  return m;
}
export function positionFlags(f:Frame){return f.quality.flags_at_position ?? f.quality.flags_at_predicted_position ?? NaN}
export function positionFlagged(f:Frame){return f.quality.bad_at_position ?? f.quality.bad_at_predicted_position ?? false}
export function spectralDifference(a:Frame,b:Frame){
  const delta=Math.abs(a.wavelength_um-b.wavelength_um);
  return {delta, widthRatio:delta/Math.min(a.bandwidth_um,b.bandwidth_um),sameExposure:a.id===b.id};
}
export function formatTime(date:string){return date.slice(11,19)}
export function mjdToIso(mjd:number){return new Date((mjd-40587)*86400000).toISOString()}
export function frameTimeFraction(frames:Pick<Frame,"mjd">[],index:number){
  if(frames.length<2||index<0||index>=frames.length)return 0;
  const start=frames[0].mjd,end=frames.at(-1)!.mjd;
  return end>start?(frames[index].mjd-start)/(end-start):0;
}
export function nearestFrameIndexAtFraction(frames:Pick<Frame,"mjd">[],fraction:number){
  if(frames.length<2)return 0;
  const start=frames[0].mjd,end=frames.at(-1)!.mjd;
  const target=start+Math.max(0,Math.min(1,fraction))*(end-start);
  return nearestFrameIndexAtMjd(frames,target);
}
/** Ties choose the earlier exposure; identical epochs choose their first frame. */
export function nearestFrameIndexAtMjd(frames:Pick<Frame,"mjd">[],target:number){
  if (!frames.length || !Number.isFinite(target)) return 0;
  let low=0,high=frames.length;
  while(low<high){const middle=(low+high)>>>1;if(frames[middle].mjd<target)low=middle+1;else high=middle;}
  if(low===0)return 0;
  if(low===frames.length)return frames.length-1;
  return target-frames[low-1].mjd<=frames[low].mjd-target?low-1:low;
}
export function describeFlags(flags:number){
  // Public image flags: https://irsa.ipac.caltech.edu/onlinehelp/spherex/spherex/sp.html
  // Preserve unlisted bits numerically instead of assigning an undocumented name.
  const definitions:[[number,string],...[number,string][]]=[[0,"TRANSIENT"],[1,"OVERFLOW"],[2,"SUR_ERROR"],[6,"NONFUNC"],[7,"DICHROIC"],[9,"MISSING_DATA"],[10,"HOT"],[11,"COLD"],[12,"FULLSAMPLE"],[14,"PHANMISS"],[15,"NONLINEAR"],[17,"PERSIST"],[19,"OUTLIER"],[20,"CROSSTALK"],[21,"SOURCE"],[22,"GHOST"],[23,"GHOST_FPA"],[24,"GHOST_EXT"],[25,"STREAK"],[26,"BLOOM"],[27,"SNOWBALL"],[28,"HALO"],[29,"SATELLITE_HALO"]];
  const known=definitions.reduce((mask,[bit])=>mask|(1<<bit),0)>>>0;
  const names=definitions.filter(([bit])=>(flags&(1<<bit))!==0).map(([,name])=>name);
  if((flags&~known)!==0)names.push("Невідомі біти: "+((flags&~known)>>>0));
  return names.length?names.join(" · "):"Без установлених прапорців";
}
