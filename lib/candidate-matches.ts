import { propagateGaia, type GaiaReference } from './gaia.ts';
import type { LabReport } from './laboratory.ts';

export type TrackAssociation = {
  track: number; status: 'possible-association' | 'ambiguous' | 'no-association' | 'incomplete';
  candidates: { source_id: string; max_separation_arcsec: number; rms_arcsec: number; separations_arcsec: number[]; epochs: number; motion_applied: boolean }[];
};
export type CandidateCrossmatch = {
  schema_version: 1; method: 'gaia-dr3-all-epochs-radius-v1'; radius_arcsec: number;
  catalogue: GaiaReference; tracks: TrackAssociation[]; completed_at: string;
  limitations: string[];
  per_track?: { track: number; catalogue?: GaiaReference; error?: string }[];
};
export function separationArcsec(ra:number,dec:number,ra2:number,dec2:number) {
  const r=Math.PI/180,d=(dec2-dec)*r,a=(ra2-ra)*r;
  const h=Math.sin(d/2)**2+Math.cos(dec*r)*Math.cos(dec2*r)*Math.sin(a/2)**2;
  return 2*Math.asin(Math.sqrt(Math.min(1,Math.max(0,h))))/r*3600;
}
export function candidateCone(report:LabReport) {
  const points=report.tracks.flatMap(t=>t.detections.map(d=>report.frames[d.frame].detections[d.detection]));
  if(!points.length)return null;
  const {ra,dec}=points[0];
  const radius=Math.max(.01,...points.map(p=>separationArcsec(ra,dec,p.ra,p.dec)/3600))+.1;
  if(radius>1.5)throw Error('Кандидати охоплюють понад 1,5°. Каталожне зіставлення потребує меншої ділянки.');
  return {ra,dec,radius};
}
export function associateCandidates(report:LabReport,catalogue:GaiaReference,radius=3):CandidateCrossmatch {
  if(!Number.isFinite(radius)||radius<=0||radius>30)throw Error('Некоректний радіус зіставлення.');
  const tracks=report.tracks.map((track,index):TrackAssociation=>{
    const points=track.detections.map(d=>({point:report.frames[d.frame].detections[d.detection],mjd:report.frames[d.frame].mjd}));
    const epochs=new Set(points.map(p=>p.mjd)).size;
    const inside=points.every(p=>separationArcsec(catalogue.center_ra,catalogue.center_dec,p.point.ra,p.point.dec)/3600+radius/3600<catalogue.radius_deg);
    const candidates=catalogue.sources.flatMap(source=>{
      const distances=points.map(({point,mjd})=>{const p=propagateGaia(source,mjd);return separationArcsec(p.ra,p.dec,point.ra,point.dec);});
      if(!distances.length||distances.some(d=>d>radius))return [];
      return [{source_id:source.source_id,max_separation_arcsec:Math.max(...distances),rms_arcsec:Math.sqrt(distances.reduce((s,d)=>s+d*d,0)/distances.length),separations_arcsec:distances,epochs,motion_applied:source.pmra!==null&&source.pmdec!==null}];
    }).sort((a,b)=>a.rms_arcsec-b.rms_arcsec);
    const status=!inside||epochs<3||catalogue.truncated?'incomplete':candidates.length>1?'ambiguous':candidates.length===1?'possible-association':'no-association';
    return {track:index,status,candidates};
  });
  return {schema_version:1,method:'gaia-dr3-all-epochs-radius-v1',radius_arcsec:radius,catalogue,tracks,completed_at:new Date().toISOString(),limitations:[
    'Positional associations, not confirmed identities or probabilities. One Gaia source must lie within the radius at every detection epoch; at least three independent epochs are required.',
    'Bounded Gaia DR3 subset selected by G magnitude. Cone padded by 0.1 degree at catalogue epoch; very high proper-motion sources can be missed. Truncation is explicit.',
    'Constant proper motion only: no parallax, radial velocity or observer-dependent apparent position. Missing proper motion is retained and marked.',
    'Gaia does not exhaust infrared sources or solar-system objects. No association never means a new object. No orbit identification is performed.',
  ]};
}

/** Query a separate footprint for each track; preserve independent failures. */
export async function associateTrackCones(
  report: LabReport,
  fetchCatalogue: (cone: {ra: number; dec: number; radius: number}) => Promise<GaiaReference>,
  signal: AbortSignal,
): Promise<CandidateCrossmatch> {
  const tracks: TrackAssociation[] = [];
  const perTrack: NonNullable<CandidateCrossmatch["per_track"]> = [];
  let first: CandidateCrossmatch | undefined;
  const budget = 60;
  for (const [index, track] of report.tracks.entries()) {
    signal.throwIfAborted();
    const subset = {...report, tracks: [track]};
    try {
      if (index >= budget) throw Error("Досягнуто ліміту каталожних запитів.");
      const points = track.detections.map(d => report.frames[d.frame].detections[d.detection]);
      if (!points.length) throw Error("Траєкторія не містить детекцій.");
      const {ra, dec} = points[0];
      const span = points.reduce((max, q) => Math.max(max, separationArcsec(ra, dec, q.ra, q.dec)), 0);
      const radius = Math.max(.01, (span + 18) / 3600);
      if (radius > 1.5) throw Error("Траєкторія ширша за дозволений конус Gaia.");
      const catalogue = await fetchCatalogue({ra, dec, radius});
      const match = associateCandidates(subset, catalogue);
      first ??= match;
      tracks.push({...match.tracks[0], track: index});
      perTrack.push({track: index, catalogue});
    } catch (error) {
      signal.throwIfAborted();
      tracks.push({track: index, status: "incomplete", candidates: []});
      perTrack.push({track: index, error: error instanceof Error ? error.message : String(error)});
    }
  }
  if (!first) throw Error(perTrack[0]?.error || "Gaia DR3 недоступний.");
  return {...first, tracks, per_track: perTrack, limitations: [
    ...first.limitations.filter((_, i) => i !== 1),
    "Separate magnitude-limited cones per track, with 18 arcsec padding and a 0.01 degree minimum radius. Large proper motions can move sources into the footprint from outside the query. Truncated, failed and unqueried tracks are marked incomplete.",
  ]};
}
