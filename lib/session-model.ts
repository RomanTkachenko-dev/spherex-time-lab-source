import { validateManifest, type Manifest } from "./science.ts";

export type CompareMode = "side" | "blink" | "difference";
export type DifferenceReference = "reference" | "median" | "previous";
export const DIFFERENCE_SCALES = [2, 3, 5, 10] as const;
export type SessionView = { frame_id: string; mode: "sky" | "object"; compare: boolean; reference_id: string | null; predicted_marker?: boolean; centre_marker?: boolean; quality_overlay?: boolean; gaia_enabled?: boolean;
  /** Optional since 0.11; older sessions and bundles mean side-by-side comparison. */
  compare_mode?: CompareMode; difference_reference?: DifferenceReference; difference_k?: number };
export type SavedSession = { id: string; title: string; manifest: Manifest; view: SessionView; created_at: string; updated_at: string; asset_series_ids: string[] };
export type SessionSummary = Omit<SavedSession, "manifest"> & { frame_count: number };

/** Imported/local passports become renderer input, so validate fields beyond the scientific schema. */
export function validateSessionManifest(value: unknown): Manifest {
  const manifest=validateManifest(value);
  const archiveLink=(value:unknown)=>{
    if(typeof value!=="string"||value.length>16_384)return false;
    try{const url=new URL(value);return url.origin==="https://irsa.ipac.caltech.edu"&&!url.username&&!url.password;}catch{return false;}
  };
  const text=(value:unknown,maximum=16_384)=>typeof value==="string"&&value.length<=maximum;
  if(!text(manifest.title,1000)||!manifest.title.trim()||!text(manifest.description)||!text(manifest.attribution)||!text(manifest.method_version,1000)||!text(manifest.dataset_doi,1000)||!archiveLink(manifest.source)||!archiveLink(manifest.observation_table_url)||!/^[a-f0-9]{64}$/.test(manifest.observation_table_sha256)||((manifest.kind === "field" || manifest.retrieved_at !== undefined) && !Number.isFinite(Date.parse(manifest.retrieved_at ?? "")))||!Array.isArray(manifest.limits)||manifest.limits.length>100||!manifest.limits.every(item=>text(item)))throw Error("Паспорт сесії містить некоректні описи або посилання на джерела.");
  const display=manifest.display;
  if(![display.sky_center_ra,display.sky_center_dec,display.low_MJy_sr,display.high_MJy_sr].every(Number.isFinite)||display.sky_center_ra<0||display.sky_center_ra>=360||Math.abs(display.sky_center_dec)>90||display.high_MJy_sr<=display.low_MJy_sr)throw Error("Паспорт містить некоректну координатну сітку або шкалу зображень.");
  for(const frame of manifest.frames){
    if(!archiveLink(frame.source_url)||!archiveLink(frame.cutout_url)||!/^[a-f0-9]{64}$/.test(frame.sha256_cutout)||!Number.isFinite(frame.exposure_s)||frame.exposure_s<=0||!text(frame.detector,64)||!text(frame.release,128)||!text(frame.quality.level1,128)||!text(frame.quality.level2,128)||(frame.quality.median_psf_fwhm_arcsec!==null&&!Number.isFinite(frame.quality.median_psf_fwhm_arcsec)))throw Error("Паспорт кадру містить некоректні джерела, експозицію або якість.");
    for(const date of [frame.date,frame.date_start,frame.date_end])if(!text(date,64)||!Number.isFinite(Date.parse(date)))throw Error("Паспорт кадру містить некоректний час.");
  }
  if(manifest.completeness?.excluded.some(item=>!text(item.id,1000)||!text(item.reason,16_384)))throw Error("Паспорт містить некоректний перелік відхилених кадрів.");
  return manifest;
}

/** The compact autosave can validate its shape without rereading the FITS manifest. */
export function validateSessionViewShape(value: unknown): SessionView {
  const view = value as SessionView;
  const identifier = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 1000;
  if (!view || !["sky", "object"].includes(view.mode) || typeof view.compare !== "boolean" || !identifier(view.frame_id) || (view.reference_id !== null && !identifier(view.reference_id)) || (view.compare && view.reference_id === null)) throw Error("Стан перегляду не відповідає кадрам сесії.");
  const compare_mode: CompareMode = view.compare_mode === "blink" || view.compare_mode === "difference" ? view.compare_mode : "side";
  const difference_reference: DifferenceReference = view.difference_reference === "median" || view.difference_reference === "previous" ? view.difference_reference : "reference";
  const difference_k = (DIFFERENCE_SCALES as readonly number[]).includes(Number(view.difference_k)) ? Number(view.difference_k) : 5;
  return {frame_id: view.frame_id, mode: view.mode, compare: view.compare, reference_id: view.reference_id, predicted_marker: view.predicted_marker === true, centre_marker: view.centre_marker === true, quality_overlay: view.quality_overlay === true, gaia_enabled: view.gaia_enabled === true, compare_mode, difference_reference, difference_k};
}

export function validateSessionView(value: unknown, manifest: Manifest): SessionView {
  const view = validateSessionViewShape(value);
  if (!manifest.frames.some(frame => frame.id === view.frame_id) || (view.reference_id !== null && !manifest.frames.some(frame => frame.id === view.reference_id)) || (manifest.kind === "field" && view.mode === "object" && !manifest.query?.most && !manifest.query?.ephemeris)) throw Error("Стан перегляду не відповідає кадрам сесії.");
  return view;
}

export function manifestSeriesIds(manifest: Manifest): string[] {
  return [...new Set(manifest.frames.flatMap(frame => [frame.image, frame.object_image, frame.quality_mask_image, frame.object_quality_mask_image]).flatMap(ref => {
    const match = typeof ref === "string" && /^idb:([a-f0-9-]{36}):[a-f0-9]{64}$/.exec(ref);
    return match ? [match[1]] : [];
  }))];
}

export function validateSavedSession(value: unknown): SavedSession {
  const session = value as SavedSession;
  if (!session || !/^[a-f0-9-]{36}$/.test(session.id) || typeof session.title !== "string" || !Number.isFinite(Date.parse(session.created_at)) || !Number.isFinite(Date.parse(session.updated_at))) throw Error("Некоректна збережена сесія.");
  const manifest = validateSessionManifest(session.manifest);
  return {...session, manifest, view: validateSessionView(session.view, manifest), asset_series_ids: manifestSeriesIds(manifest)};
}
