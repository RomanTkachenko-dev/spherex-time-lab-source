"use client";
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
    if (busy || resolving) { setError('Спочатку завершіть або зупиніть поточну обробку.'); return; }
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
          const response = await fetch('/api/field',{method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,body:JSON.stringify({...query,...interval})});
          return {status:response.status,ok:response.ok,body:await response.json() as ArchiveResponse};
        },onProgress:value=>setProgress({stage:'catalogue',...value}),
      });
      if(currentJob!==job.current)return;
      const assembled=assembleCatalogueParts(parts,{start:target.start,end:target.end},false);
      const body={...assembled,query:assembled.query as FieldQuery};
      if(body.records.length<2)throw Error('Для порівняння потрібні принаймні дві експозиції.');
      setSelection(`${target.release.toUpperCase()} · D${target.detector} · ${body.records.length} експозицій · RA ${target.ra.toFixed(5)}°, Dec ${target.dec.toFixed(5)}°`);
      startWorker(currentJob,crypto.randomUUID(),body);
    } catch(e) { if(currentJob===job.current){stop();setProgress(null);setError(e instanceof Error?e.message:String(e));} }
  }
  async function refreshCheckpoints() { try { setCheckpoints(await listProcessingCheckpoints()); } catch(e) { setError(e instanceof Error ? e.message : "Сховище контрольних точок недоступне."); } }
  // Closing, pausing and reload keep committed checkpoints. Deletion is a separate explicit action.
  function stop() { job.current++; worker.current?.terminate(); worker.current=null; request.current?.abort(); if(timeout.current)clearTimeout(timeout.current);assetSeries.current=null;setBusy(false); }
  useEffect(() => {
    void listProcessingCheckpoints().then(setCheckpoints).catch(() => {});
    return () => { worker.current?.terminate(); request.current?.abort(); if(timeout.current)clearTimeout(timeout.current); };
  }, []);
  function armTimeout() {
    if(timeout.current)clearTimeout(timeout.current);
    timeout.current=setTimeout(()=>{stop();void refreshCheckpoints();setError("Обчислення довго не відповідає. Останню контрольну точку збережено; його можна продовжити зі списку нижче.");},180000);
  }
  function startWorker(currentJob: number, id: string, catalogue?: ArchiveResult) {
    const w=new Worker("/science/field-worker.mjs",{type:"module"});worker.current=w;assetSeries.current=id;armTimeout();
    w.onmessage=async({data})=>{
      if(currentJob!==job.current)return;
      armTimeout();
      if(data.type==="progress")setProgress(data);
      if(data.type==="complete") {
        stop();setBusy(true);
        setProgress({stage:"save",completed:0,total:0,detail:"Збереження готової дослідницької сесії…"});
        try {
          const manifest=validateManifest(data.manifest);
          await onPrepared(manifest, requestedComparison.current);
          requestedComparison.current = undefined;
          await completeProcessingCheckpoint(id);
          setProgress(null);setOpen(false);
        } catch(e) { setError(e instanceof Error?e.message:"Набір не пройшов перевірку. Контрольна точка збережена."); }
        finally { setProgress(null);setBusy(false);void refreshCheckpoints(); }
      }
      if(data.type==="error") {
        stop();setProgress(null);void refreshCheckpoints();
        setError(String(data.error).split("\n").filter(Boolean).at(-1)?.replace(/^ValueError: /,"")||"Помилка обробки.");setExcluded(data.excluded||[]);
      }
    };
    w.onerror=()=>{if(currentJob!==job.current)return;stop();void refreshCheckpoints();setError("Обчислювальний модуль зупинився. Збережену контрольну точку можна продовжити.");};
    w.postMessage(catalogue?{type:"build",catalogue,assetSeriesId:id}:{type:"resume",assetSeriesId:id});
  }
  function resumeCheckpoint(checkpoint: ProcessingCheckpointSummary) {
    if(busy||resolving)return;
    requestedComparison.current=undefined;
    stop();setBusy(true);setError("");setExcluded([]);setResult(null);
    setSelection(`${checkpoint.release.toUpperCase()} · ${checkpoint.survey} · D${checkpoint.detector} · ${checkpoint.total} записів · RA ${checkpoint.ra}° · Dec ${checkpoint.dec}° · ${checkpoint.start} — ${checkpoint.end} UTC`);
    setProgress({stage:"restore",completed:0,total:checkpoint.total,detail:"Відновлення збереженого обчислення…"});
    startWorker(job.current,checkpoint.id);
  }
  async function removeCheckpoint(id: string) {
    if(busy)return;
    try { await deleteProcessingCheckpoint(id);await refreshCheckpoints();setError(""); }
    catch(e){setError(e instanceof Error?e.message:"Не вдалося видалити контрольну точку.");}
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
      if (file.size > 2_000_000) throw Error("Файл завеликий для імпорту (ліміт 2 MB).");
      const text = await file.text();
      const parsed = parseHorizonsText(text);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      const source_sha256 = [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,"0")).join("");
      setEphemeris({source:"JPL Horizons",source_url:"https://ssd.jpl.nasa.gov/horizons/app.html",target_name:parsed.target_name,source_file_name:file.name.slice(0,128),source_sha256,observer:"Earth geocenter",frame:"ICRF",time_scale:"UTC",points:parsed.points});
      setTargetName(parsed.target_name);
    } catch(e) { setError(e instanceof Error?e.message:"Не вдалося прочитати ефемериду Horizons."); }
  }
  async function resolveTarget() {
    if(busy||resolving)return;
    const name = targetName.trim();
    if (!name) { setError("Введіть назву об’єкта для пошуку координат."); return; }
    setResolving(true); setError(""); setResolvedTarget(null);
    try {
      const response = await fetch(`/api/resolve?name=${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(12000) });
      const body = await response.json() as ResolvedTarget & { error?: string };
      if (!response.ok) throw Error(body.error || "Не вдалося розпізнати назву.");
      if (!Number.isFinite(body.ra) || !Number.isFinite(body.dec) || body.ra < 0 || body.ra >= 360 || body.dec < -90 || body.dec > 90) throw Error("Служба повернула некоректні координати.");
      setRa(String(Number(body.ra.toFixed(8)))); setDec(String(Number(body.dec.toFixed(8))));
      setPlace("custom"); setResolvedTarget(body);
    } catch(e) { setError(e instanceof Error ? e.message : "Не вдалося розпізнати назву."); }
    finally { setResolving(false); }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if(busy||resolving)return;
    requestedComparison.current=undefined;
    const mostSearch=place==="moving"&&motionMode==="most";
    if (mostSearch && !mostName.trim()) { setError("Уведіть назву або NAIF ID цілі для пошуку IRSA MOST."); return; }
    if (place==="moving" && motionMode==="horizons" && !ephemeris) { setError("Для Horizons спочатку імпортуйте текстову ефемериду."); return; }
    if (place!=="moving" && targetName.trim() && !resolvedTarget) { setError("Спочатку розпізнайте назву кнопкою «Знайти координати» або очистьте її та введіть RA/Dec вручну."); return; }
    stop();const currentJob=job.current;
    setBusy(true);setError("");setResult(null);setExcluded([]);setSelection("");
    setProgress({stage:"catalogue",completed:0,total:0,detail:"Пошук експозицій в IRSA…"});
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
            const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestPayload), signal: controller.signal });
            return { status: response.status, ok: response.ok, body: await response.json() as ArchiveResponse };
          },
          onProgress: value => setProgress({ stage: "catalogue", ...value }),
        });
        const assembled = assembleCatalogueParts(fetched, { start: String(payload.start), end: String(payload.end) }, mostSearch);
        body = { ...assembled, query: assembled.query as FieldQuery };
      } else {
        const response = await fetch(endpoint,{method:"GET",signal:controller.signal});
        const listBody = await response.json() as ArchiveResponse;
        if(!response.ok)throw Error(listBody.error||"Запит не виконано.");
        body = listBody as ArchiveResult;
      }
      if(!Array.isArray(body.records))throw Error("Некоректна відповідь архіву.");
      if(currentJob!==job.current)return;
      if(mode==="list"){setResult(body);setBusy(false);setProgress(null);return;}
      if(body.records.length<2)throw Error(body.records.length===0
        ? "За цими координатами й датами придатних експозицій не знайдено. Розширте період або виберіть перевірений приклад."
        : "Знайдено лише одну придатну експозицію. Для часової серії потрібні щонайменше дві: спробуйте ширший період або змініть область неба.");
      setSelection(`${body.query.release.toUpperCase()} · ${body.query.survey==="most"?"збіги IRSA MOST":body.query.survey==="deep"?"Deep Survey":"Wide Survey"}. Знайдено: ${body.matched_count}. До перевірки кадрів: ${body.records.length}. ${body.catalogue_truncated?"Каталог обмежено; вибірка неповна.":""}`);
      startWorker(currentJob,crypto.randomUUID(),body);
    } catch(e) { if(currentJob!==job.current)return;stop();if(!(e instanceof Error&&e.name==="AbortError"))setError(e instanceof Error?e.message:"Не вдалося виконати запит."); }
  }
  useImperativeHandle(controlRef, () => ({ openAt: target => {
    setOpen(true); onOpen();
    if (busy || resolving) { setError("Спочатку завершіть або зупиніть поточну обробку, потім повторно оберіть поле на сфері."); return; }
    setMode("series"); setPlace("custom"); setRa(String(target.ra)); setDec(String(target.dec));
    setStart(target.start); setEnd(target.end); setDetector(String(target.detector));
    setRelease(target.release); setSurvey(target.survey); setFov("0.12");
    setTargetName(""); setResolvedTarget(null); setEphemeris(null);
    setWavelengthMin(""); setWavelengthMax(""); setResult(null); setError(""); setSelection(""); setExcluded([]);
  }, prepareAt: target => { void prepareAt(target); } }));
  return <Dialog open={open} onOpenChange={value=>{if(progress?.stage==="save")return;if(value){onOpen();void refreshCheckpoints();}else{stop();setProgress(null);}setOpen(value);}}>
    <DialogTrigger asChild><button className="button archive-button"><Search size={17}/>Знайти кадри</button></DialogTrigger>
    <DialogContent className="archive-dialog" showCloseButton={false}><DialogClose className="dialog-close" aria-label="Закрити"><X size={18}/></DialogClose><DialogHeader><DialogTitle>Знайти спостереження неба</DialogTitle><DialogDescription>Оберіть готове поле або введіть координати. Потім задайте період — ми перевіримо покриття архіву SPHEREx.</DialogDescription></DialogHeader>
      <Tabs value={mode} onValueChange={value=>{if(busy||resolving)return;setMode(value);setResult(null);setError("");setProgress(null);}}><TabsList><TabsTrigger value="series" disabled={busy||resolving}>Часова серія</TabsTrigger><TabsTrigger value="list" disabled={busy||resolving||place==="moving"}>Окремі експозиції</TabsTrigger></TabsList></Tabs>
      <p className="dialog-intro">{mode==="series"?(place==="moving"?"Імпортуйте ефемериду; запит охопить її траєкторію в межах одного спільного поля ICRS.":"Для швидкого старту виберіть приклад. Координати задають центр ділянки ICRS; дати — календарні дні UTC, кінцева дата включається."):"Знайдіть сирі записи архіву в межах 18″ від заданої координати. Цей режим показує перелік експозицій і посилання на оригінальні FITS-файли."}</p>
      <form onSubmit={submit} className="archive-form">
        <section className={place==="moving"?"search-step moving-search":"search-step"}><div className="step-heading"><span>1</span><div><strong>Ділянка неба</strong><small>Виберіть перевірене поле або задайте координати</small></div></div>
          <div className="place-presets" role="group" aria-label="Готові поля неба">
            <button type="button" className={`place-card ${place==="atlas"?"selected":""}`} aria-pressed={place==="atlas"} disabled={busy||resolving} onClick={()=>choosePlace("atlas")}><strong>3I / ATLAS</strong><small>Ділянка · DR1 · 14.12.2025</small></button>
            <button type="button" className={`place-card ${place==="m101"?"selected":""}`} aria-pressed={place==="m101"} disabled={busy||resolving} onClick={()=>choosePlace("m101")}><strong>M101</strong><small>Ділянка · DR1 · 2025</small></button>
            <button type="button" className={`place-card ${place==="custom"?"selected":""}`} aria-pressed={place==="custom"} disabled={busy||resolving} onClick={()=>choosePlace("custom")}><strong>Мої координати</strong><small>Введіть ICRS RA та Dec у градусах</small></button>
            <button type="button" className={place==="moving"?"place-card selected":"place-card"} aria-pressed={place==="moving"} disabled={busy||resolving} onClick={()=>choosePlace("moving")}><strong>Рухома ціль</strong><small>IRSA MOST або Horizons</small></button>
          </div>
          <div className="resolve-name"><label htmlFor="target-name">Або введіть назву об’єкта</label><div className="resolve-controls"><Input id="target-name" value={targetName} onChange={e=>{const value=e.target.value;setTargetName(value);setResolvedTarget(null);setError("");if(value){setPlace("custom");setRa("");setDec("");}}} onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();void resolveTarget();}}} disabled={busy||resolving} placeholder="Напр. M101 або NGC 6822"/><button className="button resolve-button" type="button" onClick={resolveTarget} disabled={busy||resolving||!targetName.trim()}>{resolving?<LoaderCircle className="animate-spin" size={15}/>:<Search size={15}/>} {resolving?"Шукаємо…":"Знайти координати"}</button></div><small>Назви позасонячних об’єктів шукаються через каталоги SIMBAD/NED. Для рухомих тіл та зір із власним рухом потрібні координати, перенесені на дату спостереження.</small>{resolvedTarget&&<div className="resolved-target" role="status"><strong>{resolvedTarget.canonical_name}</strong><span>RA {resolvedTarget.ra.toFixed(6)}° · Dec {resolvedTarget.dec.toFixed(6)}°</span><small>{resolvedTarget.resolver} · {resolvedTarget.service}{resolvedTarget.reference_position?` · ref. ${resolvedTarget.reference_position}`:""}. Каталожні координати; власний рух не поширено на епоху кадру. Це не виявлення SPHEREx.</small></div>}</div>
          <div className="coordinate-fields"><label><span>RA <small>пряме піднесення · 0–360°</small></span><Input name="ra" type="number" step="any" min="0" max="359.999999999" value={ra} onChange={e=>{setRa(e.target.value);setPlace("custom");setResolvedTarget(null);setTargetName("");}} required={place!=="moving"} disabled={busy||resolving||place==="moving"} placeholder="Напр. 167.2"/></label><label><span>Dec <small>схилення · −90–+90°</small></span><Input name="dec" type="number" step="any" min="-90" max="90" value={dec} onChange={e=>{setDec(e.target.value);setPlace("custom");setResolvedTarget(null);setTargetName("");}} required={place!=="moving"} disabled={busy||resolving||place==="moving"} placeholder="Напр. +5.15"/></label></div>
        </section>
        {place==="moving"&&<div className="ephemeris-import">
          <div className="motion-mode-switch" role="group" aria-label="Джерело орбіти рухомої цілі"><button type="button" className={motionMode==="most"?"selected":""} disabled={busy||resolving} aria-pressed={motionMode==="most"} onClick={()=>{setMotionMode("most");setError("");}}>IRSA MOST · відомий об’єкт</button><button type="button" className={motionMode==="horizons"?"selected":""} disabled={busy||resolving} aria-pressed={motionMode==="horizons"} onClick={()=>{setMotionMode("horizons");setError("");}}>Імпорт ефемериди Horizons</button></div>
          {motionMode==="most"&&<div className="most-search"><label htmlFor="most-target">Назва або NAIF ID тіла</label><Input id="most-target" value={mostName} onChange={e=>setMostName(e.target.value)} disabled={busy} placeholder="Напр. 20000004 або 4 Vesta"/><small>MOST обчислює орбіту відомого об’єкта й повертає SPHEREx-зображення, що його охоплюють. Запит MOST охоплює до 90 діб; довші періоди діляться автоматично.</small><a className="text-link" href="https://irsa.ipac.caltech.edu/applications/MOST/" target="_blank" rel="noreferrer">Про Moving Object Search Tool ↗</a></div>}
          {motionMode==="horizons"&&<>
          <label htmlFor="horizons-name">Назва рухомої цілі</label>
          <Input id="horizons-name" value={ephemeris?.target_name??""} readOnly disabled={busy} placeholder="Буде прочитана з файлу Horizons"/>
          <label htmlFor="horizons-file">Імпортувати результат Horizons (.txt)
            <input id="horizons-file" type="file" accept=".txt,text/plain" disabled={busy} onChange={e=>{void importEphemeris(e.currentTarget.files?.[0]);e.currentTarget.value="";}}/>
          </label>
          {ephemeris&&<div className="resolved-target" role="status"><strong>{ephemeris.target_name}</strong><span>{ephemeris.points.length} позицій · {mjdToIso(ephemeris.points[0].mjd).slice(0,10)} — {mjdToIso(ephemeris.points.at(-1)!.mjd).slice(0,10)} UTC</span><small>Earth geocenter · ICRF · координати інтерполюються до DATE-AVG FITS. SHA-256 {ephemeris.source_sha256.slice(0,16)}…</small></div>}
          <small>Файл читається локально в браузері. До запиту переходять розібрані координати; у паспорті збережено їх і хеш, не сам файл. Траєкторія має вміститися у вибране поле зору.</small>
          <details className="horizons-guide"><summary>Як завантажити таблицю з JPL Horizons</summary>
            <ol><li>Відкрийте <a href="https://ssd.jpl.nasa.gov/horizons/app.html" target="_blank" rel="noreferrer">офіційний JPL Horizons ↗</a> і виберіть тип <b>Observer Table</b> та ціль.</li><li>Задайте спостерігача <b>Earth geocenter (500)</b>, інтервал від дати «Від» до наступної доби після «До» і шкалу UT.</li><li>Залиште ICRF RA/Dec та календарний час, вимкніть фільтри видимості, згенеруйте таблицю й натисніть <b>Download Results</b>.</li></ol>
            <p>Крок ефемериди має відповідати швидкості руху; довгі проміжки знижують точність інтерполяції. Для близьких тіл геоцентричний прогноз може відрізнятися від позиції зі SPHEREx через паралакс.</p>
          </details>
          </>}
        </div>}
        <section className="search-step"><div className="step-heading"><span>2</span><div><strong>Період спостережень</strong><small>День початку й завершення за UTC</small></div></div><div className="date-fields"><label>Від<Input name="start" type="date" value={start} onChange={e=>setStart(e.target.value)} required={mode==="series"} disabled={busy}/></label><label>До · включно<Input name="end" type="date" value={end} onChange={e=>setEnd(e.target.value)} required={mode==="series"} disabled={busy}/></label></div></section>
        <details className="advanced-search" open={advanced} onToggle={e=>setAdvanced(e.currentTarget.open)}><summary>Наукові параметри <span>{release.toUpperCase()} · {place==="moving"&&motionMode==="most"?"IRSA MOST":survey==="deep"?"Deep":"Wide"} · D{detector}</span></summary><p>{place==="moving"&&motionMode==="most"?"IRSA MOST повертає власні SPHEREx-збіги. Перемикач Wide/Deep тут не застосовується; продукти відбираються за релізом і детектором.":"DR1 і QR3 — окремі релізи: перевіряйте обидва для потрібного періоду. QR2 більше не доступний для нового пошуку; збережені серії відкриваються без зміни релізу."}</p>
          <div className="advanced-grid"><div className="form-choice"><label htmlFor="archive-release">Реліз продуктів</label><Select value={release} onValueChange={setRelease} disabled={busy}><SelectTrigger id="archive-release"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="dr1">DR1 · основний випуск</SelectItem><SelectItem value="qr3">QR3 · новіший випуск</SelectItem></SelectContent></Select></div><div className="form-choice"><label htmlFor="archive-survey">Тип огляду</label><Select value={place==="moving"&&motionMode==="most"?"most":survey} onValueChange={setSurvey} disabled={busy||(place==="moving"&&motionMode==="most")}><SelectTrigger id="archive-survey"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="wide">Wide Survey</SelectItem><SelectItem value="deep">Deep Survey</SelectItem><SelectItem value="most">IRSA MOST · рухомі цілі</SelectItem></SelectContent></Select></div>
        {mode==="series"&&<><div className="form-choice"><label htmlFor="detector">Детектор</label><Select value={detector} onValueChange={setDetector} disabled={busy}><SelectTrigger id="detector"><SelectValue/></SelectTrigger><SelectContent>{[1,2,3,4,5,6].map(d=><SelectItem value={String(d)} key={d}>D{d}</SelectItem>)}</SelectContent></Select></div><label>Поле зору · градуси<Input name="fov" type="number" step="any" min="0.03" max="0.3" value={fov} onChange={e=>setFov(e.target.value)} required disabled={busy}/><small>Допустимий діапазон цієї версії: 0,03–0,30°.</small></label><div className="wavelength-fields"><span>Спектральний інтервал · мкм</span><div><Input aria-label="Мінімальна центральна довжина хвилі, мкм" name="wavelength_min" type="number" min="0.01" step="any" placeholder="Від — необов’язково" value={wavelengthMin} onChange={e=>setWavelengthMin(e.target.value)} disabled={busy}/><Input aria-label="Максимальна центральна довжина хвилі, мкм" name="wavelength_max" type="number" min="0.01" step="any" placeholder="До — необов’язково" value={wavelengthMax} onChange={e=>setWavelengthMax(e.target.value)} disabled={busy}/></div><small>Це оглядовий фільтр приблизної довжини хвилі в центрі поля, а не зіставлення спектральних відгуків.</small></div><p className="form-explanation">Обробляються всі знайдені збіги без вибірки моментів часу. Якщо відповідь архіву завелика або IRSA MOST вимагає коротших вікон, інтервал автоматично ділиться на неперекривні UTC-частини; результати зводяться в одну серію до {MAX_SERIES_FRAMES} кадрів, а URL і SHA‑256 частин зберігаються в паспорті. Кадри, що не проходять перевірки FITS/WCS чи спектрального діапазону, буде окремо зазначено.</p></>}</div>
        </details>
        <button className="button search-submit" type="submit" disabled={busy||resolving}>{busy?<LoaderCircle className="animate-spin" size={17}/>:<Search size={17}/>} {busy?"Перевіряємо архів і готуємо кадри…":mode==="series"?"Показати часову серію":"Знайти експозиції"}</button>
      </form>
      {busy&&progress&&<div className="job-progress" role="status"><strong>{progress.detail}</strong>{progress.total>0&&<Progress value={progress.completed/progress.total*100} aria-label="Оброблено кадрів"/>}{selection&&<p>{selection}</p>}<p>Після отримання каталогу прогрес зберігається локально. Закриття цього вікна або вкладки призупиняє обчислення; його можна продовжити. Для серій до 120 кадрів точний розрахунок шкали починається повторно.</p>{progress.storage&&<p>За оцінкою браузера вільно {(progress.storage.free_bytes/1048576).toFixed(0)} MiB{progress.storage.estimated_remaining_bytes!==null?`; прогноз решти PNG: ${(progress.storage.estimated_remaining_bytes/1048576).toFixed(0)} MiB`:""}. Це приблизні значення.{progress.storage.estimated_remaining_bytes!==null&&progress.storage.estimated_remaining_bytes>progress.storage.free_bytes&&" Очікуваний обсяг перевищує вільне місце. Призупиніть і видаліть непотрібні серії в бібліотеці."}</p>}{progress.stage!=="save"&&<div className="checkpoint-actions"><button className="button" onClick={()=>{stop();setProgress(null);void refreshCheckpoints();setError("Обчислення призупинено. Контрольна точка збережена.");}}>Призупинити</button><button className="button" onClick={async()=>{const id=assetSeries.current;stop();setProgress(null);try{if(id)await deleteProcessingCheckpoint(id);await refreshCheckpoints();setError("Підготовку скасовано; її проміжні дані видалено. Збережені сесії залишились у бібліотеці.");}catch(e){setError(e instanceof Error?e.message:"Не вдалося видалити контрольну точку.");}}}>Скасувати й видалити</button></div>}</div>}
      {checkpoints.length>0&&!busy&&<section className="processing-checkpoints" aria-label="Незавершені обчислення"><h3>Збережені обчислення</h3><p>Відновлення використовує початковий каталог і версію методу. Зміни форми вище не змінюють збережений запит.</p>{checkpoints.map(checkpoint=><article key={checkpoint.id} className="processing-checkpoint"><strong>{checkpoint.release.toUpperCase()} · {checkpoint.survey} · D{checkpoint.detector} · {checkpoint.total} записів</strong><p>RA {checkpoint.ra}° · Dec {checkpoint.dec}° · {checkpoint.start} — {checkpoint.end} UTC</p><small>{checkpoint.phase==="complete"?"Обробку завершено; очікує збереження сесії":checkpoint.phase==="render"?`PNG: ${checkpoint.rendered}; перевірено ${checkpoint.analyzed}`:checkpoint.phase==="legacy"?"Відновлення повторить точний розрахунок невеликої серії":`Перевірено: ${checkpoint.analyzed} із ${checkpoint.total}`} · {checkpoint.updatedAt?.slice(0,19).replace("T"," ")} UTC</small>{checkpoint.error&&<p className="detail-note">{checkpoint.error.split("\n").filter(Boolean).at(-1)}</p>}<div className="checkpoint-actions"><button className="button" disabled={busy||resolving} onClick={()=>resumeCheckpoint(checkpoint)}>{checkpoint.phase==="complete"?"Зберегти й відкрити":"Продовжити"}</button><button className="button" disabled={busy} onClick={()=>void removeCheckpoint(checkpoint.id)}>Видалити обчислення</button></div></article>)}</section>}
      {error&&<p className="error-message" role="alert">{error}</p>}{excluded.length>0&&<details className="excluded-frames"><summary>Відхилені кадри: {excluded.length}</summary>{excluded.map((f,i)=><p key={i}><code>{f.id}</code><br/>{f.reason.split("\n").filter(Boolean).at(-1)}</p>)}</details>}
      {result&&<div className="archive-results"><div className="results-summary" role="status"><strong>{result.records.length?`Знайдено записів: ${result.records.length}`:"Спостережень у цій вибірці немає"}</strong><span>RA {result.query.ra}° · Dec {result.query.dec}°</span></div>{result.truncated&&<p className="limit-notice">Показано до 60 записів. Звузьте дати для повнішого перегляду.</p>}{result.records.length>0&&<Table><TableHeader><TableRow><TableHead>Початок · UTC</TableHead><TableHead>Детектор</TableHead><TableHead>Експозиція</TableHead><TableHead>Джерело</TableHead></TableRow></TableHeader><TableBody>{result.records.map((r,i)=><TableRow key={`${r.id}-${i}`}><TableCell><time>{mjdToIso(r.mjd).slice(0,19).replace("T"," ")}</time><small className="record-id">{r.observation}</small></TableCell><TableCell>{r.band||"—"}</TableCell><TableCell>{r.exposure_s==null?"—":`${r.exposure_s.toFixed(1)} с`}</TableCell><TableCell><a className="text-link" href={r.url} target="_blank" rel="noreferrer">FITS <ArrowUpRight size={14}/></a></TableCell></TableRow>)}</TableBody></Table>}<a className="text-link" href={result.source_url} target="_blank" rel="noreferrer">Запит IRSA (VOTable) <ArrowUpRight size={15}/></a><p className="detail-note">Отримано {result.retrieved_at.slice(0,19).replace("T"," ")} UTC. Перетин поля не гарантує корисного сигналу.</p></div>}
    </DialogContent>
  </Dialog>;
}
