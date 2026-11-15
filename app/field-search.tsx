"use client";
import { useMessage, useTranslation } from "@/lib/language";
import { apiUrl, apiOrigin, publicAsset } from "@/lib/site-mode";
import { useEffect, useImperativeHandle, useRef, useState, type FormEvent, type Ref } from "react";
import type { SkySearchTarget } from "@/lib/sky-atlas";
import { ArrowUpRight, LoaderCircle, Search, X } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { mjdToIso, validateManifest, type Manifest } from "@/lib/science";
import { validateFieldQuery } from "@/lib/field-query";
import { collectCatalogueParts, MAX_CATALOGUE_CHUNK_FRAMES, MAX_SERIES_FRAMES } from "@/lib/catalogue-batches";
import { assembleCatalogueParts } from "@/lib/catalogue-merge";
import type { FieldQuery } from "@/lib/field-query";
import { parseHorizonsText, type ImportedEphemeris } from "@/lib/ephemeris";
import { completeProcessingCheckpoint, deleteProcessingCheckpoint, listProcessingCheckpoints, type ProcessingCheckpointSummary } from "@/lib/processing-checkpoints";

type ArchiveRecord = { id: string; observation: string; mjd: number; band: string; exposure_s: number | null; url: string; target_ra?: number; target_dec?: number };
type CataloguePart = { start: string; end: string; source_url: string; source_sha256: string; retrieved_at: string; matched_count: number };
type ArchiveResult = { records: ArchiveRecord[]; truncated?: boolean; source_url: string; source_sha256: string; retrieved_at: string; matched_count: number; candidate_count: number; catalogue_truncated: boolean; selection: string; observation_table_parts?: CataloguePart[]; query: FieldQuery };
type ArchiveResponse = Omit<ArchiveResult, "query"> & { query?: FieldQuery | null; error?: string };
type ProgressState = { stage: string; completed: number; total: number; detail: string; storage?: { free_bytes: number; usage_bytes: number; estimated_remaining_bytes: number | null } | null };
type ResolvedTarget = { query_name: string; canonical_name: string; ra: number; dec: number; object_type: string | null; reference_position: string | null; resolver: string; resolver_url: string; service: string };
export type FieldSearchControl = { openAt: (target: SkySearchTarget) => void; prepareAt: (target: SkySearchTarget) => void };
export default function FieldSearch({ onOpen, onPrepared, controlRef }: { onOpen: () => void; onPrepared: (manifest: Manifest, comparisonUrls?: [string,string]) => void | Promise<void>; controlRef?: Ref<FieldSearchControl> }) {
  const t = useTranslation(), msg = useMessage();
  const [open, setOpen] = useState(false), [mode, setMode] = useState("series");
  const [detector, setDetector] = useState("5");
  const [release, setRelease] = useState("dr1"), [survey, setSurvey] = useState("wide");
  const [place, setPlace] = useState<"atlas"|"m101"|"custom"|"moving">("atlas");
  const [motionMode, setMotionMode] = useState<"most"|"horizons">("most"), [mostName, setMostName] = useState("20000004");
  const [ra, setRa] = useState("167.2"), [dec, setDec] = useState("5.15");
  const [targetName, setTargetName] = useState(""), [resolvedTarget, setResolvedTarget] = useState<ResolvedTarget | null>(null), [resolving, setResolving] = useState(false);
  const [ephemeris, setEphemeris] = useState<ImportedEphemeris|null>(null);
  const [start, setStart] = useState("2025-12-14"), [end, setEnd] = useState("2025-12-14");
  const [fov, setFov] = useState("0.12"), [wavelengthMin, setWavelengthMin] = useState(""), [wavelengthMax, setWavelengthMax] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [result, setResult] = useState<ArchiveResult | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState<ProgressState | null>(null);
  const [selection, setSelection] = useState("");
  const [excluded, setExcluded] = useState<{id:string; reason:string}[]>([]);
  const [checkpoints, setCheckpoints] = useState<ProcessingCheckpointSummary[]>([]);
  const worker = useRef<Worker | null>(null), request = useRef<AbortController | null>(null), timeout = useRef<ReturnType<typeof setTimeout> | null>(null), assetSeries = useRef<string|null>(null);
  const job = useRef(0);
  const requestedComparison = useRef<[string,string] | undefined>(undefined);
  async function prepareAt(target: SkySearchTarget) {
    setOpen(true); onOpen();
    if (busy || resolving) { setError(t('Finish or pause the current job first.')); return; }
    setMode('series');setPlace('custom');setRa(String(target.ra));setDec(String(target.dec));
    setStart(target.start);setEnd(target.end);setDetector(String(target.detector));setRelease(target.release);setSurvey(target.survey);setFov('0.12');
    setTargetName('');setResolvedTarget(null);setEphemeris(null);setWavelengthMin('');setWavelengthMax('');setSelection('');
    stop(); const currentJob = job.current;
    requestedComparison.current = target.comparisonUrls;
    setBusy(true); setError(''); setResult(null); setExcluded([]);
    const controller = new AbortController(); request.current = controller;
    try {
      const query = validateFieldQuery({...target,fov:0.12,max_frames:MAX_CATALOGUE_CHUNK_FRAMES});
      const {parts} = await collectCatalogueParts<ArchiveRecord,ArchiveResponse>({
        interval:{start:target.start,end:target.end},movingObject:false,
        request:async interval => {
          const response = await fetch(apiUrl('/api/field'),{method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,body:JSON.stringify({...query,...interval})});
          return {status:response.status,ok:response.ok,body:await response.json() as ArchiveResponse};
        },onProgress:value=>setProgress({stage:'catalogue',...value}),
      });
      if(currentJob!==job.current)return;
      const assembled=assembleCatalogueParts(parts,{start:target.start,end:target.end},false);
      const body={...assembled,query:assembled.query as FieldQuery};
      if(body.records.length<2)throw Error(t('A comparison needs at least two exposures.'));
      const pair = target.comparisonUrls?.map(url => body.records.find(record => record.url === url));
      if (pair) {
        if (!pair[0] || !pair[1] || pair[0].url === pair[1].url) {
          throw Error(t("The chosen pair is not in the catalogue. Pick the exposures again."));
        }
        body.records = [pair[0], pair[1]].sort((a, b) => a.mjd - b.mjd);
        body.candidate_count = 2;
        body.selection = "Selected pair only. Shared display scale computed from these two exposures.";
      }
      setSelection(`${target.release.toUpperCase()} · D${target.detector} · ${t("{n} exposures",{n:body.records.length})} · RA ${target.ra.toFixed(5)}°, Dec ${target.dec.toFixed(5)}°`);
      startWorker(currentJob,crypto.randomUUID(),body);
    } catch(e) { if(currentJob===job.current){stop();setProgress(null);setError(e instanceof Error?e.message:String(e));} }
  }
  async function refreshCheckpoints() { try { setCheckpoints(await listProcessingCheckpoints()); } catch(e) { setError(e instanceof Error ? e.message : t("Saved-progress storage is unavailable.")); } }
  // Closing, pausing and reload keep committed checkpoints. Deletion is a separate explicit action.
  function stop() { job.current++; worker.current?.terminate(); worker.current=null; request.current?.abort(); if(timeout.current)clearTimeout(timeout.current);assetSeries.current=null;setBusy(false); }
  useEffect(() => {
    void listProcessingCheckpoints().then(setCheckpoints).catch(() => {});
    return () => { worker.current?.terminate(); request.current?.abort(); if(timeout.current)clearTimeout(timeout.current); };
  }, []);
  function armTimeout() {
    if(timeout.current)clearTimeout(timeout.current);
    timeout.current=setTimeout(()=>{stop();void refreshCheckpoints();setError(t("The job stopped responding. The last progress is saved; you can resume it from the list below."));},180000);
  }
  function startWorker(currentJob: number, id: string, catalogue?: ArchiveResult) {
    const w=new Worker(publicAsset("/science/field-worker.mjs"),{type:"module"});worker.current=w;assetSeries.current=id;armTimeout();
    w.onmessage=async({data})=>{
      if(currentJob!==job.current)return;
      armTimeout();
      if(data.type==="progress")setProgress(data);
      if(data.type==="complete") {
        stop();setBusy(true);
        setProgress({stage:"save",completed:0,total:0,detail:t("Saving the finished session…")});
        try {
          const manifest=validateManifest(data.manifest);
          const pairOnly = manifest.completeness?.selection.startsWith("Selected pair only.");
          await onPrepared(manifest, requestedComparison.current ?? (pairOnly
            ? [manifest.frames[0].source_url, manifest.frames[1].source_url] : undefined));
          requestedComparison.current = undefined;
          await completeProcessingCheckpoint(id);
          setProgress(null);setOpen(false);
        } catch(e) { setError(e instanceof Error?e.message:t("The result failed a check. Progress is saved.")); }
        finally { setProgress(null);setBusy(false);void refreshCheckpoints(); }
      }
      if(data.type==="error") {
        stop();setProgress(null);void refreshCheckpoints();
        setError(String(data.error).split("\n").filter(Boolean).at(-1)?.replace(/^ValueError: /,"")||t("Processing failed."));setExcluded(data.excluded||[]);
      }
    };
    w.onerror=()=>{if(currentJob!==job.current)return;stop();void refreshCheckpoints();setError(t("The processing module stopped. You can resume from the saved progress."));};
    w.postMessage(catalogue?{type:"build",catalogue,assetSeriesId:id,apiOrigin}:{type:"resume",assetSeriesId:id,apiOrigin});
  }
  function resumeCheckpoint(checkpoint: ProcessingCheckpointSummary) {
    if(busy||resolving)return;
    requestedComparison.current=undefined;
    stop();setBusy(true);setError("");setExcluded([]);setResult(null);
    setSelection(`${checkpoint.release.toUpperCase()} · ${checkpoint.survey} · D${checkpoint.detector} · ${t("{n} records",{n:checkpoint.total})} · RA ${checkpoint.ra}° · Dec ${checkpoint.dec}° · ${checkpoint.start} — ${checkpoint.end} UTC`);
    setProgress({stage:"restore",completed:0,total:checkpoint.total,detail:t("Restoring the saved job…")});
    startWorker(job.current,checkpoint.id);
  }
  async function removeCheckpoint(id: string) {
    if(busy)return;
    try { await deleteProcessingCheckpoint(id);await refreshCheckpoints();setError(""); }
    catch(e){setError(e instanceof Error?e.message:t("Could not delete the saved progress."));}
  }
  function choosePlace(value: "atlas" | "m101" | "custom" | "moving") {
    if(busy||resolving)return;
    setPlace(value);
    setTargetName(""); setResolvedTarget(null);
    setEphemeris(null);
    setMode("series");
    setResult(null); setError(""); setExcluded([]);
    if (value === "atlas") {
      setRa("167.2"); setDec("5.15"); setStart("2025-12-14"); setEnd("2025-12-14");
      setDetector("5"); setRelease("dr1"); setSurvey("wide"); setFov("0.12");
    } else if (value === "m101") {
      setRa("210.80227"); setDec("54.34895"); setStart("2025-06-01"); setEnd("2025-12-31");
      setDetector("2"); setRelease("dr1"); setSurvey("wide"); setFov("0.10");
    } else if (value === "moving") {
      setMostName("20000004"); setMotionMode("most"); setStart("2025-08-01"); setEnd("2025-08-31");
      setDetector("6"); setRelease("dr1"); setSurvey("wide"); setFov("0.30");
    } else {
      setRa(""); setDec("");
    }
  }
  async function importEphemeris(file?: File) {
    setEphemeris(null); setError("");
    if (!file) return;
    try {
      if (file.size > 2_000_000) throw Error(t("The file is too large to import (limit 2 MB)."));
      const text = await file.text();
      const parsed = parseHorizonsText(text);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      const source_sha256 = [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,"0")).join("");
      setEphemeris({source:"JPL Horizons",source_url:"https://ssd.jpl.nasa.gov/horizons/app.html",target_name:parsed.target_name,source_file_name:file.name.slice(0,128),source_sha256,observer:"Earth geocenter",frame:"ICRF",time_scale:"UTC",points:parsed.points});
      setTargetName(parsed.target_name);
    } catch(e) { setError(e instanceof Error?e.message:t("Could not read the Horizons ephemeris.")); }
  }
  async function resolveTarget() {
    if(busy||resolving)return;
    const name = targetName.trim();
    if (!name) { setError(t("Type an object name, e.g. M101, to look up its coordinates.")); return; }
    setResolving(true); setError(""); setResolvedTarget(null);
    try {
      const response = await fetch(apiUrl(`/api/resolve?name=${encodeURIComponent(name)}`), { signal: AbortSignal.timeout(12000) });
      const body = await response.json() as ResolvedTarget & { error?: string };
      if (!response.ok) throw Error(body.error || t("Couldn't recognise that name. Check the spelling or type RA and Dec yourself."));
      if (!Number.isFinite(body.ra) || !Number.isFinite(body.dec) || body.ra < 0 || body.ra >= 360 || body.dec < -90 || body.dec > 90) throw Error(t("The name service returned invalid coordinates."));
      setRa(String(Number(body.ra.toFixed(8)))); setDec(String(Number(body.dec.toFixed(8))));
      setPlace("custom"); setResolvedTarget(body);
    } catch(e) { setError(e instanceof Error ? e.message : t("Couldn't recognise that name. Check the spelling or type RA and Dec yourself.")); }
    finally { setResolving(false); }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if(busy||resolving)return;
    requestedComparison.current=undefined;
    const mostSearch=place==="moving"&&motionMode==="most";
    if (mostSearch && !mostName.trim()) { setError(t("Enter the target's name or NAIF ID for the IRSA MOST search.")); return; }
    if (place==="moving" && motionMode==="horizons" && !ephemeris) { setError(t("For Horizons, import a text ephemeris file first.")); return; }
    if (place!=="moving" && targetName.trim() && !resolvedTarget) { setError(t("Press \"Look up coordinates\" for the name first, or clear it and type RA/Dec yourself.")); return; }
    stop();const currentJob=job.current;
    setBusy(true);setError("");setResult(null);setExcluded([]);setSelection("");
    setProgress({stage:"catalogue",completed:0,total:0,detail:t("Searching the NASA archive (IRSA) for exposures…")});
    const params = new URLSearchParams();
    new FormData(e.currentTarget).forEach((value,key)=>{if(typeof value==="string")params.set(key,value.trim());});
    params.set("release",release);params.set("survey",survey);
    if(mode==="series"){params.set("detector",detector);params.set("max_frames",String(MAX_SERIES_FRAMES));}
    if (resolvedTarget) {
      params.set("target_name", resolvedTarget.query_name);
      params.set("target_canonical_name", resolvedTarget.canonical_name);
      params.set("target_resolver", resolvedTarget.resolver);
      params.set("target_type", resolvedTarget.object_type ?? "");
      params.set("target_reference", resolvedTarget.reference_position ?? "");
    }
    const payload: Record<string,unknown> = Object.fromEntries(params);
    if (mostSearch) {
      payload.name=mostName.trim(); payload.survey="most";
    } else if (place==="moving" && ephemeris) {
      delete payload.ra; delete payload.dec; delete payload.target_name;
      payload.ephemeris=ephemeris;
    }
    const controller=new AbortController();request.current=controller;
    try {
      if(mode==="series"&&!mostSearch) {
        validateFieldQuery(payload);
      }
      const endpoint=mode==="series"?(mostSearch?"/api/most":"/api/field"):"/api/archive?"+params;
      let body: ArchiveResult;
      if (mode === "series") {
        const { parts: fetched } = await collectCatalogueParts<ArchiveRecord, ArchiveResponse>({
          interval: { start: String(payload.start), end: String(payload.end) }, movingObject: mostSearch,
          request: async interval => {
            const requestPayload = { ...payload, ...interval, max_frames: MAX_CATALOGUE_CHUNK_FRAMES, ...(mostSearch ? { allow_sparse: true } : {}) };
            const response = await fetch(apiUrl(endpoint), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestPayload), signal: controller.signal });
            return { status: response.status, ok: response.ok, body: await response.json() as ArchiveResponse };
          },
          onProgress: value => setProgress({ stage: "catalogue", ...value }),
        });
        const assembled = assembleCatalogueParts(fetched, { start: String(payload.start), end: String(payload.end) }, mostSearch);
        body = { ...assembled, query: assembled.query as FieldQuery };
      } else {
        const response = await fetch(apiUrl(endpoint),{method:"GET",signal:controller.signal});
        const listBody = await response.json() as ArchiveResponse;
        if(!response.ok)throw Error(listBody.error||t("The NASA archive didn't respond. Try again in a minute."));
        body = listBody as ArchiveResult;
      }
      if(!Array.isArray(body.records))throw Error(t("The archive sent an unexpected response. Try again in a minute."));
      if(currentJob!==job.current)return;
      if(mode==="list"){setResult(body);setBusy(false);setProgress(null);return;}
      if(body.records.length<2)throw Error(body.records.length===0
        ? t("No usable exposures for these coordinates and dates. Try a longer date range or one of the ready-made examples.")
        : t("Only one usable exposure was found. A time series needs at least two: try a longer date range or another spot."));
      setSelection(`${body.query.release.toUpperCase()} · ${body.query.survey==="most"?t("IRSA MOST matches"):body.query.survey==="deep"?"Deep Survey":"Wide Survey"}. ${t("Found: {n}. Exposures to check: {m}.",{n:body.matched_count,m:body.records.length})} ${body.catalogue_truncated?t("The catalogue was capped; the selection is incomplete."):""}`);
      startWorker(currentJob,crypto.randomUUID(),body);
    } catch(e) { if(currentJob!==job.current)return;stop();if(!(e instanceof Error&&e.name==="AbortError"))setError(e instanceof Error?e.message:t("The NASA archive didn't respond. Try again in a minute.")); }
  }
  useImperativeHandle(controlRef, () => ({ openAt: target => {
    setOpen(true); onOpen();
    if (busy || resolving) { setError(t("Finish or pause the current job first, then pick the spot on the globe again.")); return; }
    setMode("series"); setPlace("custom"); setRa(String(target.ra)); setDec(String(target.dec));
    setStart(target.start); setEnd(target.end); setDetector(String(target.detector));
    setRelease(target.release); setSurvey(target.survey); setFov("0.12");
    setTargetName(""); setResolvedTarget(null); setEphemeris(null);
    setWavelengthMin(""); setWavelengthMax(""); setResult(null); setError(""); setSelection(""); setExcluded([]);
  }, prepareAt: target => { void prepareAt(target); } }));
  return <Dialog open={open} onOpenChange={value=>{if(progress?.stage==="save")return;if(value){onOpen();void refreshCheckpoints();}else{stop();setProgress(null);}setOpen(value);}}>
    <DialogTrigger asChild><button className="button archive-button"><Search size={17}/>{t("Find exposures")}</button></DialogTrigger>
    <DialogContent className="archive-dialog" showCloseButton={false}><DialogClose className="dialog-close" aria-label={t("Close")}><X size={18}/></DialogClose><DialogHeader><DialogTitle>{t("Find SPHEREx exposures of a patch of sky")}</DialogTitle><DialogDescription>{t("1 Pick an example or type a star or galaxy name → 2 choose dates → 3 we fetch every SPHEREx picture of that spot and line them up in time.")}</DialogDescription></DialogHeader>
      <Tabs value={mode} onValueChange={value=>{if(busy||resolving)return;setMode(value);setResult(null);setError("");setProgress(null);}}><TabsList><TabsTrigger value="series" disabled={busy||resolving}>{t("Time series")}</TabsTrigger><TabsTrigger value="list" disabled={busy||resolving||place==="moving"}>{t("List of exposures")}</TabsTrigger></TabsList></Tabs>
      <p className="dialog-intro">{mode==="series"?(place==="moving"?t("Choose a known solar-system object or import an ephemeris; the search follows its path within one shared ICRS field."):t("New here? Pick an example. Coordinates set the centre of the patch (ICRS, degrees); dates are whole UTC days, and the end date is included.")):t("Lists raw archive records within 18″ of the coordinates, with links to the original FITS files. No images are built.")}</p>
      <form onSubmit={submit} className="archive-form">
        <section className={place==="moving"?"search-step moving-search":"search-step"}><div className="step-heading"><span>1</span><div><strong>{t("Patch of sky")}</strong><small>{t("Choose an example, a name or coordinates")}</small></div></div>
          <div className="place-presets" role="group" aria-label={t("Ready-made sky fields")}>
            <button type="button" className={`place-card ${place==="atlas"?"selected":""}`} aria-pressed={place==="atlas"} disabled={busy||resolving} onClick={()=>choosePlace("atlas")}><strong>3I / ATLAS</strong><small>{t("Comet field · DR1 · 14 Dec 2025")}</small></button>
            <button type="button" className={`place-card ${place==="m101"?"selected":""}`} aria-pressed={place==="m101"} disabled={busy||resolving} onClick={()=>choosePlace("m101")}><strong>M101</strong><small>{t("Pinwheel Galaxy · DR1 · 2025")}</small></button>
            <button type="button" className={`place-card ${place==="custom"?"selected":""}`} aria-pressed={place==="custom"} disabled={busy||resolving} onClick={()=>choosePlace("custom")}><strong>{t("My coordinates")}</strong><small>{t("Type RA and Dec in degrees")}</small></button>
            <button type="button" className={place==="moving"?"place-card selected":"place-card"} aria-pressed={place==="moving"} disabled={busy||resolving} onClick={()=>choosePlace("moving")}><strong>{t("Moving object")}</strong><small>{t("Asteroid or comet · IRSA MOST or Horizons")}</small></button>
          </div>
          <div className="resolve-name"><label htmlFor="target-name">{t("…or type an object name")}</label><div className="resolve-controls"><Input id="target-name" value={targetName} onChange={e=>{const value=e.target.value;setTargetName(value);setResolvedTarget(null);setError("");if(value){setPlace("custom");setRa("");setDec("");}}} onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();void resolveTarget();}}} disabled={busy||resolving} placeholder={t("e.g. M101 or NGC 6822")}/><button className="button resolve-button" type="button" onClick={resolveTarget} disabled={busy||resolving||!targetName.trim()}>{resolving?<LoaderCircle className="animate-spin" size={15}/>:<Search size={15}/>} {resolving?t("Looking up…"):t("Look up coordinates")}</button></div><small>{t("Names of stars and galaxies are looked up in the SIMBAD/NED catalogues. For moving bodies, and stars with large proper motion, use coordinates for the observation date.")}</small>{resolvedTarget&&<div className="resolved-target" role="status"><strong>{resolvedTarget.canonical_name}</strong><span>RA {resolvedTarget.ra.toFixed(6)}° · Dec {resolvedTarget.dec.toFixed(6)}°</span><small>{resolvedTarget.resolver} · {resolvedTarget.service}{resolvedTarget.reference_position?` · ref. ${resolvedTarget.reference_position}`:""}. {t("Catalogue coordinates; proper motion is not applied to the exposure date. This is not a SPHEREx detection.")}</small></div>}</div>
          <div className="coordinate-fields"><label><span>RA <small>{t("right ascension · 0–360°")}</small></span><Input name="ra" type="number" step="any" min="0" max="359.999999999" value={ra} onChange={e=>{setRa(e.target.value);setPlace("custom");setResolvedTarget(null);setTargetName("");}} required={place!=="moving"} disabled={busy||resolving||place==="moving"} placeholder={t("e.g. 167.2")}/></label><label><span>Dec <small>{t("declination · −90 to +90°")}</small></span><Input name="dec" type="number" step="any" min="-90" max="90" value={dec} onChange={e=>{setDec(e.target.value);setPlace("custom");setResolvedTarget(null);setTargetName("");}} required={place!=="moving"} disabled={busy||resolving||place==="moving"} placeholder={t("e.g. +5.15")}/></label></div>
        </section>
        {place==="moving"&&<div className="ephemeris-import">
          <div className="motion-mode-switch" role="group" aria-label={t("Where the moving object's path comes from")}><button type="button" className={motionMode==="most"?"selected":""} disabled={busy||resolving} aria-pressed={motionMode==="most"} onClick={()=>{setMotionMode("most");setError("");}}>{t("IRSA MOST · known object")}</button><button type="button" className={motionMode==="horizons"?"selected":""} disabled={busy||resolving} aria-pressed={motionMode==="horizons"} onClick={()=>{setMotionMode("horizons");setError("");}}>{t("Import a Horizons ephemeris")}</button></div>
          {motionMode==="most"&&<div className="most-search"><label htmlFor="most-target">{t("Object name or NAIF ID")}</label><Input id="most-target" value={mostName} onChange={e=>setMostName(e.target.value)} disabled={busy} placeholder={t("e.g. 20000004 or 4 Vesta")}/><small>{t("MOST computes the orbit of a known object and returns the SPHEREx images that contain it. One MOST query covers up to 90 days; longer periods are split automatically.")}</small><a className="text-link" href="https://irsa.ipac.caltech.edu/applications/MOST/" target="_blank" rel="noreferrer">{t("About the Moving Object Search Tool ↗")}</a></div>}
          {motionMode==="horizons"&&<>
          <label htmlFor="horizons-name">{t("Moving object name")}</label>
          <Input id="horizons-name" value={ephemeris?.target_name??""} readOnly disabled={busy} placeholder={t("Read from the Horizons file")}/>
          <label htmlFor="horizons-file">{t("Import a Horizons result (.txt)")}
            <input id="horizons-file" type="file" accept=".txt,text/plain" disabled={busy} onChange={e=>{void importEphemeris(e.currentTarget.files?.[0]);e.currentTarget.value="";}}/>
          </label>
          {ephemeris&&<div className="resolved-target" role="status"><strong>{ephemeris.target_name}</strong><span>{t("{n} positions",{n:ephemeris.points.length})} · {mjdToIso(ephemeris.points[0].mjd).slice(0,10)} — {mjdToIso(ephemeris.points.at(-1)!.mjd).slice(0,10)} UTC</span><small>Earth geocenter · ICRF · {t("coordinates are interpolated to each FITS DATE-AVG.")} SHA-256 {ephemeris.source_sha256.slice(0,16)}…</small></div>}
          <small>{t("The file is read locally in your browser. Only the parsed coordinates are sent; the metadata keeps them and a hash, not the file. The path must fit inside the chosen field of view.")}</small>
          <details className="horizons-guide"><summary>{t("How to download a table from JPL Horizons")}</summary>
            <ol><li>{t("Open the")} <a href="https://ssd.jpl.nasa.gov/horizons/app.html" target="_blank" rel="noreferrer">{t("official JPL Horizons ↗")}</a> {t("and choose")} <b>Observer Table</b> {t("and your target.")}</li><li>{t("Set the observer to")} <b>Earth geocenter (500)</b>{t(", the time span from the \"From\" date to the day after \"To\", and the UT time scale.")}</li><li>{t("Keep ICRF RA/Dec and calendar time, turn off visibility filters, generate the table and press")} <b>Download Results</b>.</li></ol>
            <p>{t("Match the ephemeris step to how fast the object moves; long steps make interpolation less accurate. For nearby bodies the geocentric prediction can differ from the SPHEREx view because of parallax.")}</p>
          </details>
          </>}
        </div>}
        <section className="search-step"><div className="step-heading"><span>2</span><div><strong>{t("Dates")}</strong><small>{t("First and last day, in UTC")}</small></div></div><div className="date-fields"><label>{t("From")}<Input name="start" type="date" value={start} onChange={e=>setStart(e.target.value)} required={mode==="series"} disabled={busy}/></label><label>{t("To · inclusive")}<Input name="end" type="date" value={end} onChange={e=>setEnd(e.target.value)} required={mode==="series"} disabled={busy}/></label></div></section>
        <details className="advanced-search" open={advanced} onToggle={e=>setAdvanced(e.currentTarget.open)}><summary>{t("Advanced options")} <span>{release.toUpperCase()} · {place==="moving"&&motionMode==="most"?"IRSA MOST":survey==="deep"?"Deep":"Wide"} · D{detector}</span></summary><p>{place==="moving"&&motionMode==="most"?t("IRSA MOST returns its own SPHEREx matches. The Wide/Deep switch doesn't apply here; products are chosen by release and detector."):t("DR1 and QR3 are separate data releases: check both for your dates. QR2 can no longer be searched; saved QR2 series still open unchanged.")}</p>
          <div className="advanced-grid"><div className="form-choice"><label htmlFor="archive-release">{t("Data release")}</label><Select value={release} onValueChange={setRelease} disabled={busy}><SelectTrigger id="archive-release"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="dr1">{t("DR1 · main release")}</SelectItem><SelectItem value="qr3">{t("QR3 · newer quick release")}</SelectItem></SelectContent></Select></div><div className="form-choice"><label htmlFor="archive-survey">{t("Survey type")}</label><Select value={place==="moving"&&motionMode==="most"?"most":survey} onValueChange={setSurvey} disabled={busy||(place==="moving"&&motionMode==="most")}><SelectTrigger id="archive-survey"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="wide">Wide Survey</SelectItem><SelectItem value="deep">Deep Survey</SelectItem><SelectItem value="most">{t("IRSA MOST · moving objects")}</SelectItem></SelectContent></Select></div>
        {mode==="series"&&<><div className="form-choice"><label htmlFor="detector" title={t("SPHEREx has six detectors, D1–D6; each sees a different range of infrared wavelengths.")}>{t("Detector")}</label><Select value={detector} onValueChange={setDetector} disabled={busy}><SelectTrigger id="detector"><SelectValue/></SelectTrigger><SelectContent>{[1,2,3,4,5,6].map(d=><SelectItem value={String(d)} key={d}>D{d}</SelectItem>)}</SelectContent></Select></div><label>{t("Field of view · degrees")}<Input name="fov" type="number" step="any" min="0.03" max="0.3" value={fov} onChange={e=>setFov(e.target.value)} required disabled={busy}/><small>{t("Width of the picture. Allowed: 0.03–0.30° (the full Moon is about 0.5°).")}</small></label><div className="wavelength-fields"><span>{t("Wavelength range · µm")}</span><div><Input aria-label={t("Minimum central wavelength, µm")} name="wavelength_min" type="number" min="0.01" step="any" placeholder={t("From (optional)")} value={wavelengthMin} onChange={e=>setWavelengthMin(e.target.value)} disabled={busy}/><Input aria-label={t("Maximum central wavelength, µm")} name="wavelength_max" type="number" min="0.01" step="any" placeholder={t("To (optional)")} value={wavelengthMax} onChange={e=>setWavelengthMax(e.target.value)} disabled={busy}/></div><small>{t("A rough filter on the infrared colour (wavelength) at the field centre; it doesn't match full spectral responses.")}</small></div><p className="form-explanation">{t("Every match is processed; no moments are skipped. If the archive answer is too big, or IRSA MOST needs shorter windows, the dates are split into non-overlapping UTC parts and merged into one series of up to {max} exposures; the URL and SHA-256 of each part go into the metadata. Exposures that fail the FITS/WCS or wavelength checks are listed separately.",{max:MAX_SERIES_FRAMES})}</p></>}</div>
        </details>
        <button className="button search-submit" type="submit" disabled={busy||resolving}>{busy?<LoaderCircle className="animate-spin" size={17}/>:<Search size={17}/>} {busy?t("Checking the archive and preparing exposures…"):mode==="series"?t("Build the time series"):t("List exposures")}</button>
      </form>
      {busy&&progress&&<div className="job-progress" role="status"><strong>{msg(progress.detail)}</strong>{progress.total>0&&<Progress value={progress.completed/progress.total*100} aria-label={t("Exposures processed")}/>}{selection&&<p>{selection}</p>}<p>{t("Once the catalogue arrives, progress is saved in this browser. Closing this window or tab pauses the job; you can resume it later. For series up to 120 exposures the exact brightness scale is recomputed on resume.")}</p>{progress.storage&&<p>{t("The browser estimates {free} MiB free",{free:(progress.storage.free_bytes/1048576).toFixed(0)})}{progress.storage.estimated_remaining_bytes!==null?t("; remaining images need about {need} MiB",{need:(progress.storage.estimated_remaining_bytes/1048576).toFixed(0)}):""}. {t("These are rough numbers.")}{progress.storage.estimated_remaining_bytes!==null&&progress.storage.estimated_remaining_bytes>progress.storage.free_bytes&&" "+t("That is more than the free space. Pause and delete series you don't need in Saved sessions.")}</p>}{progress.stage!=="save"&&<div className="checkpoint-actions"><button className="button" onClick={()=>{stop();setProgress(null);void refreshCheckpoints();setError(t("Paused. Progress is saved."));}}>{t("Pause")}</button><button className="button" onClick={async()=>{const id=assetSeries.current;stop();setProgress(null);try{if(id)await deleteProcessingCheckpoint(id);await refreshCheckpoints();setError(t("Cancelled and its temporary data deleted. Saved sessions are untouched."));}catch(e){setError(e instanceof Error?e.message:t("Could not delete the saved progress."));}}}>{t("Cancel and delete")}</button></div>}</div>}
      {checkpoints.length>0&&!busy&&<section className="processing-checkpoints" aria-label={t("Unfinished jobs")}><h3>{t("Unfinished jobs")}</h3><p>{t("Resuming uses the original catalogue and method version. Changing the form above does not change a saved job.")}</p>{checkpoints.map(checkpoint=><article key={checkpoint.id} className="processing-checkpoint"><strong>{checkpoint.release.toUpperCase()} · {checkpoint.survey} · D{checkpoint.detector} · {t("{n} records",{n:checkpoint.total})}</strong><p>RA {checkpoint.ra}° · Dec {checkpoint.dec}° · {checkpoint.start} — {checkpoint.end} UTC</p><small>{checkpoint.phase==="complete"?t("Processing done; waiting to be saved as a session"):checkpoint.phase==="render"?t("Images: {r}; checked {a}",{r:checkpoint.rendered,a:checkpoint.analyzed}):checkpoint.phase==="legacy"?t("Resuming will redo the exact calculation for this small series"):t("Checked: {a} of {n}",{a:checkpoint.analyzed,n:checkpoint.total})} · {checkpoint.updatedAt?.slice(0,19).replace("T"," ")} UTC</small>{checkpoint.error&&<p className="detail-note">{msg(checkpoint.error.split("\n").filter(Boolean).at(-1))}</p>}<div className="checkpoint-actions"><button className="button" disabled={busy||resolving} onClick={()=>resumeCheckpoint(checkpoint)}>{checkpoint.phase==="complete"?t("Save and open"):t("Resume")}</button><button className="button" disabled={busy} onClick={()=>void removeCheckpoint(checkpoint.id)}>{t("Delete job")}</button></div></article>)}</section>}
      {error&&<p className="error-message" role="alert">{msg(error)}</p>}{excluded.length>0&&<details className="excluded-frames"><summary>{t("Rejected exposures: {n}",{n:excluded.length})}</summary>{excluded.map((f,i)=><p key={i}><code>{f.id}</code><br/>{msg(f.reason.split("\n").filter(Boolean).at(-1))}</p>)}</details>}
      {result&&<div className="archive-results"><div className="results-summary" role="status"><strong>{result.records.length?t("Records found: {n}",{n:result.records.length}):t("No observations here for these dates. Try a longer date range.")}</strong><span>RA {result.query.ra}° · Dec {result.query.dec}°</span></div>{result.truncated&&<p className="limit-notice">{t("Showing up to 60 records. Narrow the dates to see them all.")}</p>}{result.records.length>0&&<Table><TableHeader><TableRow><TableHead>{t("Start · UTC")}</TableHead><TableHead>{t("Detector")}</TableHead><TableHead>{t("Exposure time")}</TableHead><TableHead>{t("Source")}</TableHead></TableRow></TableHeader><TableBody>{result.records.map((r,i)=><TableRow key={`${r.id}-${i}`}><TableCell><time>{mjdToIso(r.mjd).slice(0,19).replace("T"," ")}</time><small className="record-id">{r.observation}</small></TableCell><TableCell>{r.band||"—"}</TableCell><TableCell>{r.exposure_s==null?"—":`${r.exposure_s.toFixed(1)} ${t("s")}`}</TableCell><TableCell><a className="text-link" href={r.url} target="_blank" rel="noreferrer">FITS <ArrowUpRight size={14}/></a></TableCell></TableRow>)}</TableBody></Table>}<a className="text-link" href={result.source_url} target="_blank" rel="noreferrer">{t("IRSA query (VOTable)")} <ArrowUpRight size={15}/></a><p className="detail-note">{t("Retrieved {time} UTC. An exposure covering the spot doesn't guarantee a useful signal there.",{time:result.retrieved_at.slice(0,19).replace("T"," ")})}</p></div>}
    </DialogContent>
  </Dialog>;
}
