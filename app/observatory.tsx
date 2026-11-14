"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, ChevronLeft, ChevronRight, Download, Info, Orbit, Pause, Play, Telescope } from "lucide-react";
import { pagesBase, publicAsset, staticPages, apiUrl, liveArchive } from "@/lib/site-mode";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import Method from "./method";
import { Skeleton } from "@/components/ui/skeleton";
import { describeFlags, positionFlags, positionFlagged, formatTime, spectralDifference, validateManifest, frameTimeFraction, nearestFrameIndexAtFraction, type Frame, type Manifest } from "@/lib/science";
import FieldSearch, { type FieldSearchControl } from "./field-search";
import { readAtlasLink } from "@/lib/sky-atlas";
import { LanguageContext, useTranslation, type Language } from "@/lib/language";
import { isProperMotion } from "@/lib/ephemeris";
import SkyAtlas from "./sky-atlas";
import { projectGaia, type GaiaReference } from "@/lib/gaia";
import { readDisplayAsset } from "@/lib/frame-assets";
import { restoreActiveSession, saveSession, updateSessionView, type SavedSession, type SessionView } from "@/lib/sessions";
import SessionLibrary from "./session-library";
import FrameNavigation from "./frame-navigation";
import ScienceLab from "./science-lab";

type Mode = "sky" | "object";
function initialView(manifest:Manifest):SessionView {
  return {frame_id:manifest.frames[0].id,mode:manifest.query?.most?"object":"sky",compare:false,reference_id:manifest.frames[Math.min(1,manifest.frames.length-1)].id,predicted_marker:manifest.kind!=="field",centre_marker:manifest.kind==="field",quality_overlay:false,gaia_enabled:false};
}
function useDisplaySource(reference: string, enabled=true) {
  const [resolved, setResolved] = useState<{reference:string;source:string;error:boolean}>({reference:"",source:"",error:false});
  useEffect(() => {
    if (!enabled || !reference.startsWith("idb:")) return;
    let active = true, objectUrl = "";
    readDisplayAsset(reference).then(blob => {
      if (active) { objectUrl = URL.createObjectURL(blob); setResolved({reference,source:objectUrl,error:false}); }
    }).catch(() => { if (active) setResolved({reference,source:"",error:true}); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [reference,enabled]);
  if (!enabled) return {reference,source:"",error:false};
  if (!reference.startsWith("idb:")) return {reference,source:reference,error:false};
  return resolved.reference===reference?resolved:{reference,source:"",error:false};
}

function ExposureTile({ frame, index, selected, afterGap, label, onSelect }: { frame: Frame; index: number; selected: boolean; afterGap: boolean; label: string; onSelect: () => void }) {
  const {source:src,error} = useDisplaySource(frame.image);
  return <button className={`exposure ${selected ? "selected" : ""} ${afterGap ? "after-gap" : ""}`} onClick={onSelect} aria-label={`Кадр ${index + 1}, ${label} UTC${error?", ескіз недоступний":""}`} aria-pressed={selected} title={`${index + 1} / ${label} UTC`}><img src={src || undefined} width={64} height={64} alt="" loading="lazy"/><span>{String(index + 1).padStart(2, "0")}</span></button>;
}

function TimelineMarks({ frames }: { frames: Frame[] }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const node = canvas.current;
    if (!node) return;
    const draw = () => {
      const width = Math.max(1, Math.floor(node.clientWidth));
      const height = 8, ratio = window.devicePixelRatio || 1;
      node.width = width * ratio; node.height = height * ratio;
      const context = node.getContext("2d");
      if (!context) return;
      context.scale(ratio, ratio); context.clearRect(0, 0, width, height); context.fillStyle = "#b9ec68";
      const first = frames[0]?.mjd ?? 0, span = (frames.at(-1)?.mjd ?? first) - first;
      for (const frame of frames) {
        const x = span > 0 ? (frame.mjd - first) / span * Math.max(0, width - 1) : 0;
        context.fillRect(Math.round(x), 1, 1, height - 2);
      }
    };
    draw();
    const observer = new ResizeObserver(draw); observer.observe(node);
    return () => observer.disconnect();
  }, [frames]);
  return <canvas ref={canvas} className="time-markers" aria-hidden="true"/>;
}

function SkyFrame({ frame, mode, marker, mask, label, field, moving, gaia }: { frame: Frame; mode: Mode; marker: boolean; mask: boolean; label: string; field: number; moving: boolean; gaia: GaiaReference | null }) {
  const t = useTranslation();
  const referenceSrc = mode === "sky" ? frame.image : frame.object_image;
  const imageAsset = useDisplaySource(referenceSrc);
  const src = imageAsset.source;
  const overlayReference = mode === "object" ? frame.object_quality_mask_image ?? frame.quality_mask_image ?? referenceSrc.replace(/\.png$/,"-mask.png") : frame.quality_mask_image ?? referenceSrc.replace(/\.png$/,"-mask.png");
  const overlayAsset = useDisplaySource(overlayReference,mask);
  const overlaySrc = overlayAsset.source;
  const point = mode === "sky" ? frame.marker_sky : frame.marker_object;
  const gaiaPoints = gaia && mode === "sky" ? gaia.sources.flatMap(source => {
    const projected = projectGaia(source, gaia.center_ra, gaia.center_dec, field, frame.mjd);
    return projected ? [{ source, ...projected }] : [];
  }) : [];
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = failedSrc === src;
  return <figure className="sky-frame">
    <figcaption><span>{label}</span><time>{frame.date.slice(0,10)} · {formatTime(frame.date)} UTC</time><span>≈ {frame.wavelength_um.toFixed(4)} мкм</span></figcaption>
    <div className="image-space"><div className="sky-plane">
      {src && <img src={publicAsset(src)} width={256} height={256} alt={`Кадр SPHEREx ${frame.id}, ${frame.date} UTC`} onError={() => setFailedSrc(src)}/>}{imageAsset.error&&<div className="asset-error" role="alert">Локальне PNG цього кадру відсутнє. Повторно підготуйте часову серію.</div>}
      {!src&&!imageAsset.error&&<div className="asset-loading" role="status">Завантаження кадру з локального сховища…</div>}
      {mask && overlaySrc && <img className="quality-overlay" src={publicAsset(overlaySrc)} width={256} height={256} alt="Помаранчевий шар прапорців якості"/>}
      {gaiaPoints.length>0&&<svg className="gaia-overlay" role="img" focusable="false" viewBox="0 0 256 256" aria-label={`Каталожні позиції Gaia DR3, поширені до MJD ${frame.mjd.toFixed(5)}`}>{gaiaPoints.map(({source,x,y})=><circle key={source.source_id} cx={x} cy={y} r="2" fill="none" stroke="#68d8e5" strokeWidth="0.8"/>)}</svg>}
      {marker && (mode === "object" || frame.marker_sky_visible !== false) && <svg className="coordinate-overlay" viewBox="0 0 256 256" aria-label={moving ? (mode === "sky" ? "Каталожна позиція цілі у фіксованій проєкції ICRS" : "Центр проєкції кадру за каталожною позицією цілі") : frame.position_kind === "requested-sky-position" ? "Центр запиту, не виявлення об’єкта" : frame.position_kind === "catalogue-proper-motion-propagated" ? t("Положення за власним рухом каталогу, не виявлення") : frame.position_kind === "user-supplied-horizons-ephemeris" ? "Положення за введеною ефемеридою Horizons, не виявлення" : "Прогнозоване положення IRSA, не вимірювання"}><circle cx={point.x + 0.5} cy={point.y + 0.5} r="9" fill="none" stroke="#bbec68" strokeWidth="0.8" strokeDasharray="3 2"/><path d={`M${point.x + 0.5},${point.y - 13} v-5 M${point.x + 0.5},${point.y + 14} v5`} stroke="#bbec68" strokeWidth="0.8"/></svg>}
    </div>{failed && <div className="image-error" role="alert">Кадр не завантажився. Оновіть сторінку або відкрийте вихідний FITS.</div>}<div className="orientation" title="Північ угорі, схід ліворуч">N ↑<br/>E ←</div><span className="field-size">Поле ≈ {(field * 60).toFixed(1)}′</span></div>
  </figure>;
}

export default function Observatory() {
  const [settings, setSettings] = useState<{language: Language; link: ReturnType<typeof readAtlasLink>}>();
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    let preference = params.get("lang");
    try { preference ??= localStorage.getItem("spherex-language"); } catch { /* Embedded storage may be blocked. */ }
    setSettings({language: preference === "uk" ? "uk" : "en", link: readAtlasLink(params)});
  }, []);
  if (!settings) return null;
  function switchLanguage(language: Language) {
    try { localStorage.setItem("spherex-language", language); } catch { /* The URL still retains the preference. */ }
    document.documentElement.lang = language;
    const url = new URL(location.href);
    url.searchParams.set("lang", language);
    history.replaceState(null, "", url);
    setSettings(value => value && {...value, language});
  }
  return <LanguageContext.Provider value={settings.language}>
    <ObservatoryView {...settings} switchLanguage={switchLanguage}/>
  </LanguageContext.Provider>;
}

function ObservatoryView({language, link, switchLanguage}: {
  language: Language; link: ReturnType<typeof readAtlasLink>; switchLanguage: (language: Language) => void;
}) {
  const t = useTranslation();
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  const [data, setData] = useState<Manifest | null>(null);
  const [error, setError] = useState(""), [attempt, setAttempt] = useState(0);
  const [index, setIndex] = useState(0), [reference, setReference] = useState(8);
  const [playing, setPlaying] = useState(false), [delay, setDelay] = useState("900");
  const [mode, setMode] = useState<Mode>("sky");
  const [compare, setCompare] = useState(false), [marker, setMarker] = useState(true), [mask, setMask] = useState(false);
  const [gaiaEnabled, setGaiaEnabled] = useState(false), [gaia, setGaia] = useState<GaiaReference|null>(null), [gaiaLoading, setGaiaLoading] = useState(false), [gaiaError, setGaiaError] = useState("");
  const [exportBusy,setExportBusy]=useState(false),[exportError,setExportError]=useState("");
  const [sessionId,setSessionId]=useState<string|null>(null),[sessionError,setSessionError]=useState("");
  const [sessionRevision,setSessionRevision]=useState(0);
  const currentSession=useRef<{id:string|null;view:SessionView|null}>({id:null,view:null});
  const viewer = useRef<HTMLElement>(null);
  const fieldSearch = useRef<FieldSearchControl>(null);
  const demo = useRef<Manifest | null>(null);
  const gaiaRequest = useRef<AbortController|null>(null);
  useEffect(() => () => gaiaRequest.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    fetch(publicAsset("/data/atlas/manifest.json"), { signal: controller.signal }).then(r => { if (!r.ok) throw Error("Не вдалося завантажити спостереження."); return r.json(); }).then(validateManifest).then(async m => {
      demo.current=m;
      try {
        const saved=await restoreActiveSession()??await saveSession(m,initialView(m));
        if(!controller.signal.aborted)applySession(saved);
      } catch(e) {
        if(!controller.signal.aborted){setData(m);setReference(Math.min(8,m.frames.length-1));setSessionError(e instanceof Error?e.message:"Локальне збереження недоступне.");}
      }
    }).catch(e => { if (e.name !== "AbortError") setError(e.message); });
    return () => controller.abort();
  }, [attempt]);
  useEffect(() => { if (!playing || !data) return; const timer = setInterval(() => setIndex(i => (i + 1) % data.frames.length), Number(delay)); return () => clearInterval(timer); }, [playing, data, delay]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!data || !viewer.current?.contains(document.activeElement) || (e.target instanceof Element && e.target.closest("button,input,select,[role=slider],[role=combobox],[role=switch],[role=tab]"))) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); setPlaying(false); setIndex(i => Math.min(data.frames.length - 1, Math.max(0, i + (e.key === "ArrowRight" ? 1 : -1)))); }
      if (e.code === "Space") { e.preventDefault(); setPlaying(p => !p); }
    }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [data]);
  const frame = data?.frames[index], refFrame = data?.frames[reference];
  const difference = frame && refFrame ? spectralDifference(frame, refFrame) : null;
  const selectFrame = (value: number) => { setPlaying(false); setIndex(value); };
  const field = data?.kind === "field";
  const moving = Boolean(data?.query?.most || data?.query?.ephemeris);
  const multipleDays = data && data.frames[0].date.slice(0,10) !== data.frames.at(-1)!.date.slice(0,10);
  const timeLabel = (date:string) => `${multipleDays ? date.slice(0,10) + " · " : ""}${formatTime(date)}`;
  const waveRange = useMemo(()=>data ? data.frames.reduce<[number,number]>((range,f)=>[Math.min(range[0],f.wavelength_um),Math.max(range[1],f.wavelength_um)],[Infinity,-Infinity]) : [0,0],[data]);
  const stripStart = data ? Math.max(0,Math.min(index-3,data.frames.length-7)) : 0;
  const stripFrames = data?.frames.slice(stripStart,stripStart+7) ?? [];
  const timeFraction = data ? frameTimeFraction(data.frames,index) : 0;
  const archiveCollection = data ? (field && data.query ? "spherex_"+data.query.release+(data.query.survey==="deep"?"_deep":"") : data.frames[0].release) : "spherex_qr2";
  const archiveLabel = data?.query?.survey==="most" ? archiveCollection.replace("spherex_dr","DR").replace("spherex_qr","QR")+" · IRSA MOST" : archiveCollection.replace("spherex_dr","DR").replace("spherex_qr","QR").replace("_deep"," · Deep Survey") + (archiveCollection.endsWith("_deep") ? "" : " · Wide Survey");
  const seekTimeline = (fraction:number) => { if(data)selectFrame(nearestFrameIndexAtFraction(data.frames,fraction)); };
  function applySession(session:SavedSession){
    const m=session.manifest,v=session.view;
    gaiaRequest.current?.abort();setPlaying(false);setData(m);setSessionId(session.id);
    setIndex(Math.max(0,m.frames.findIndex(f=>f.id===v.frame_id)));setReference(Math.max(0,m.frames.findIndex(f=>f.id===v.reference_id)));
    setMode(v.mode);setCompare(v.compare);setMask(v.quality_overlay===true);setMarker(m.kind==="field"?v.centre_marker!==false:v.predicted_marker!==false);
    setGaiaEnabled(v.gaia_enabled===true&&!!m.gaia_reference);setGaia(m.gaia_reference??null);setGaiaLoading(false);setGaiaError("");setSessionError("");setSessionRevision(r=>r+1);
  }
  async function flushView(){const current=currentSession.current;if(current.id&&current.view)await updateSessionView(current.id,current.view);}
  async function prepared(m:Manifest, comparisonUrls?: [string,string]){
    await flushView();
    const view=initialView(m);
    const a=comparisonUrls?m.frames.find(f=>f.source_url===comparisonUrls[0]):null;
    const b=comparisonUrls?m.frames.find(f=>f.source_url===comparisonUrls[1]):null;
    if(a&&b&&a.id!==b.id){view.frame_id=a.id;view.reference_id=b.id;view.compare=true;view.mode='sky';}
    applySession(await saveSession(m,view));
    if(comparisonUrls&&(!a||!b))setSessionError('Один із вибраних кадрів не пройшов обробку. Серію відкрито без підміни вибраної пари.');
    viewer.current?.scrollIntoView({behavior:'smooth',block:'start'});
  }
  async function openSession(session:SavedSession){await flushView();applySession(session);}
  const exportView:SessionView|null = frame ? {frame_id:frame.id,mode,compare,reference_id:refFrame?.id??null,predicted_marker:!field&&marker,centre_marker:!!field&&marker,quality_overlay:mask,gaia_enabled:gaiaEnabled} : null;
  const viewKey=JSON.stringify(exportView);
  useEffect(()=>{
    const view=JSON.parse(viewKey) as SessionView|null;
    currentSession.current={id:sessionId,view};
    if(!sessionId||!view)return;
    const persist=()=>{void updateSessionView(sessionId,view).catch(e=>setSessionError(e instanceof Error?e.message:"Не вдалося зберегти стан перегляду."));};
    const timer=setTimeout(persist,350);
    const onHide=()=>{if(document.visibilityState==="hidden")persist();};
    window.addEventListener("pagehide",persist);document.addEventListener("visibilitychange",onHide);
    return()=>{clearTimeout(timer);window.removeEventListener("pagehide",persist);document.removeEventListener("visibilitychange",onHide);};
  },[sessionId,viewKey]);
  const passportManifest = data && gaiaEnabled && gaia ? {...data,gaia_reference:gaia} : data;
  async function openEpochDemo() {
    try {
      const response = await fetch(publicAsset("/data/epochs/manifest.json"));
      if (!response.ok) throw Error("Не вдалося завантажити приклад DR1.");
      const manifest = validateManifest(await response.json());
      await prepared(manifest, [manifest.frames[0].source_url, manifest.frames.at(-1)!.source_url]);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
    }
  }
  async function downloadPassport(){
    if(!passportManifest||!frame)return;
    setExportBusy(true);setExportError("");
    try{
      const response=staticPages ? new Response(JSON.stringify({view:exportView,dataset:passportManifest},null,2),{headers:{"Content-Type":"application/json"}}) : await fetch(apiUrl("/api/evidence"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({manifest:passportManifest,view:exportView})});
      if(!response.ok){const body=await response.json().catch(()=>({})) as {error?:string};throw Error(body.error||"Не вдалося сформувати паспорт.");}
      const url=URL.createObjectURL(await response.blob()),anchor=document.createElement("a");anchor.href=url;anchor.download=`spherex-${frame.id}.json`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(error){setExportError(error instanceof Error?error.message:"Не вдалося завантажити паспорт.");}
    finally{setExportBusy(false);}
  }
  async function toggleGaia(enabled:boolean){
    gaiaRequest.current?.abort();gaiaRequest.current=null;setGaiaEnabled(enabled);
    if(!enabled){setGaia(null);setGaiaError("");setGaiaLoading(false);return;}
    if(!data||data.kind!=="field")return;
    const controller=new AbortController();gaiaRequest.current=controller;
    const radius=Math.SQRT2*data.display.sky_fov_deg/2+0.1;
    setGaia(null);setGaiaError("");setGaiaLoading(true);
    try{const response=await fetch(apiUrl(`/api/gaia?ra=${data.display.sky_center_ra}&dec=${data.display.sky_center_dec}&radius=${radius}`),{signal:controller.signal});const body=await response.json() as GaiaReference&{error?:string};if(!response.ok)throw Error(body.error||"Не вдалося завантажити Gaia DR3.");if(!controller.signal.aborted){const enriched=validateManifest({...data,gaia_reference:body});setGaia(body);setData(enriched);const current=currentSession.current;if(current.id&&current.view)await saveSession(enriched,{...current.view,gaia_enabled:true},current.id);}}
    catch(error){if(!controller.signal.aborted)setGaiaError(error instanceof Error?error.message:"Не вдалося завантажити Gaia DR3.");}
    finally{if(!controller.signal.aborted)setGaiaLoading(false);}
  }

  return <main className={link.embed ? "observatory observatory-embed" : "observatory"}>
    <header className="topbar"><a href={pagesBase || "/"} className="brand"><Orbit size={28}/><span>SPHEREx <b>TIME LAB</b></span></a><span className="edition">{t("Лабораторія змін неба")}</span><div className="header-actions"><label className="language-picker"><span>{t("Мова")}</span><select value={language} onChange={event => switchLanguage(event.target.value === "uk" ? "uk" : "en")}><option value="en">English</option><option value="uk">Українська</option></select></label><Method data={data} onOpen={() => setPlaying(false)}/><a className="text-link" href="https://irsa.ipac.caltech.edu/Missions/spherex.html" target="_blank" rel="noreferrer" aria-label={t("Архів NASA / IPAC")}>NASA / IPAC <ArrowUpRight size={16}/></a></div></header>
    {!liveArchive && <p className="intro" role="note">Демонстрація GitHub Pages: небесна мозаїка, серії 3I/ATLAS і DR1 та локальні сесії. Пошук архіву, Gaia та аналіз FITS доступні у серверній версії.</p>}
    <SkyAtlas language={language} link={link} manifest={data} onSearch={target => { setPlaying(false); fieldSearch.current?.prepareAt(target); }} onCurrentSeries={() => viewer.current?.scrollIntoView({ behavior: "smooth", block: "start" })}/>
    <div className="workspace">
      <aside className="library"><div className="section-label">{t("СПОСТЕРЕЖЕННЯ")}</div><h1>{t("Небо в русі")}</h1><p className="intro">{t("Порівнюйте справжні кадри SPHEREx у часі.")}</p><button className={`target ${field?"":"active"}`} onClick={()=>{if(demo.current)void prepared(demo.current).catch(e=>setSessionError(e instanceof Error?e.message:"Не вдалося зберегти серію."));}}><Orbit className="target-icon"/><span><strong>3I / ATLAS</strong><small>{t("Готовий приклад · 12 кадрів")}</small></span></button><button className="target" onClick={()=>void openEpochDemo()}><Orbit className="target-icon"/><span><strong>{t("Поле DR1")}</strong><small>{t("4 кадри · серпень 2025 — лютий 2026")}</small></span></button>{field&&<div className="active-field"><strong>{data.title}</strong><small>{t("Поточна серія")}</small></div>}<div className="dataset-details"><span>{data?.frames[0].date.slice(0,10)} — {data?.frames.at(-1)?.date.slice(0,10)}</span><span>{data?.frames.length ?? "—"} кадрів · {frame?.detector ?? "—"}</span><span>{archiveLabel} · інфрачервоне світло</span></div>{liveArchive && <FieldSearch controlRef={fieldSearch} onOpen={() => setPlaying(false)} onPrepared={prepared}/>}<SessionLibrary manifest={passportManifest} view={exportView} currentSessionId={sessionId} onLoad={openSession} onSaved={session=>{setSessionId(session.id);setSessionRevision(r=>r+1);}} refreshKey={sessionRevision}/>{sessionError&&<p className="session-error" role="alert">{sessionError}</p>}<div className="library-note"><Telescope size={22}/><p>Почніть із відтворення. Шукайте зміни положень відносно зір на спільному полі неба.</p><p>Увімкніть порівняння, щоб розглянути два моменти поруч.</p></div><a className="text-link library-source" href={data?.source ?? "https://irsa.ipac.caltech.edu/Missions/spherex.html"} target="_blank" rel="noreferrer">{t("Про цей набір")} <ArrowUpRight size={15}/></a></aside>
      <section className="lab-main" ref={viewer} tabIndex={0} aria-label="Переглядач. Стрілки змінюють кадр, пробіл запускає відтворення.">
        <div className="workspace-heading"><div><div className="section-label">РЕАЛЬНІ ДАНІ / SPHEREx {archiveLabel}</div><h2>{data?.title ?? "SPHEREx"}</h2></div><div className="passport-actions"><button className="button" type="button" onClick={()=>void downloadPassport()} disabled={!data||exportBusy} title={data?.schema_version===4||data?.display.asset_storage==="indexeddb-sha256-v1"?"JSON містить хеші PNG, які зберігаються локально в цьому браузері.":"Завантажити перевірений науковий паспорт."}><Download size={16}/>{exportBusy?t("Формуємо…"):"Завантажити паспорт серії"}</button>{exportError&&<span className="passport-error" role="alert">{exportError}</span>}</div></div>
        <div className="viewer-panel"><div className="viewer-toolbar">{field&&!moving?<span className="view-label">{t("Спільне поле ICRS")}</span>:<Tabs value={mode} onValueChange={v => setMode(v as Mode)}><TabsList><TabsTrigger value="sky">{moving?"Нерухоме поле":"Нерухоме небо"}</TabsTrigger><TabsTrigger value="object">{moving?"За ціллю":"За кометою"}</TabsTrigger></TabsList></Tabs>}<span className="frame-count" aria-live={playing ? "off" : "polite"}>{data ? `${String(index + 1).padStart(2, "0")} / ${data.frames.length}` : "—"}</span></div>
          <div className="view-options"><label><Switch checked={compare} onCheckedChange={setCompare} disabled={!data}/>{t("Порівняти")}</label><label><Switch checked={marker} onCheckedChange={setMarker}/>{field?(data?.query?.most?"Позиція MOST":isProperMotion(data?.query?.ephemeris)?t("Позиція за власним рухом"):data?.query?.ephemeris?"Позиція Horizons":"Центр запиту"):"Прогноз IRSA"}</label>{liveArchive&&field&&mode==="sky"&&<label><Switch checked={gaiaEnabled} onCheckedChange={value=>void toggleGaia(value)}/>{t("Каталог Gaia DR3")}</label>}<label><Switch checked={mask} onCheckedChange={setMask}/>{t("Шар якості")}</label></div>
          {field&&mode==="sky"&&gaiaEnabled&&<div className="gaia-status" role="status">{gaiaLoading?"Запит Gaia DR3 до IRSA TAP…":gaiaError?gaiaError:gaia&&<><span>Повернуто {gaia.record_count} джерел Gaia DR3 у пошуковому конусі{gaia.truncated?"; є додаткові збіги поза лімітом 1200":""}. Епоха проєкції: поточний кадр MJD {frame?.mjd.toFixed(5)??"—"}{compare&&refFrame&&`; опорний кадр MJD ${refFrame.mjd.toFixed(5)}`}. Координати перераховуються для кожного кадру за власним рухом.</span><details><summary>Метод і межі каталогу</summary><p>Вибірка містить до 1200 джерел із виміряною зоряною величиною G, упорядкованих за її зростанням. Координати поширюються сталою власного руху з епохи ref_epoch; якщо компоненти руху відсутні, показується початкова каталожна позиція. У моделі не застосовано паралакс, променеву швидкість або коваріації. Символи показують каталожні позиції Gaia, а не виявлення SPHEREx чи астрометричне вимірювання цього конвеєра.</p></details></>}</div>}
          {frame && data ? <div className={`frame-stage ${compare ? "is-comparing" : ""}`}><SkyFrame frame={frame} mode={mode} marker={marker} mask={mask} label={t("Поточний кадр")} field={mode === "sky" ? data.display.sky_fov_deg : data.display.object_fov_deg} moving={moving} gaia={field&&gaiaEnabled&&mode==="sky"?gaia:null}/>{compare && refFrame && <SkyFrame frame={refFrame} mode={mode} marker={marker} mask={mask} label={t("Опорний кадр")} field={mode === "sky" ? data.display.sky_fov_deg : data.display.object_fov_deg} moving={moving} gaia={field&&gaiaEnabled&&mode==="sky"?gaia:null}/>}</div> : <div className="viewer-empty" role="status">{error ? <><p>{error}</p><button className="button" onClick={() => setAttempt(a => a + 1)}>{t("Спробувати ще раз")}</button></> : <><Skeleton className="h-64 w-64"/><p>{t("Завантаження спостережень…")}</p></>}</div>}
          {compare && frame && refFrame && difference && <div className="compare-controls" aria-label="Різниця між кадрами">
            <div>{t("Різниця часу")} <strong>{(Math.abs(frame.mjd - refFrame.mjd) * 1440).toFixed(1)} {t("хв")}</strong></div>
            <div>{t("Різниця довжини хвилі")} <strong>≈ {difference.delta.toFixed(4)} {t("мкм")}</strong></div>
          </div>}
          {data?.completeness?.selection.startsWith("Selected pair only.") && <p className="compare-controls">Відкрито 2 вибрані кадри з {data.completeness.matched_count} знайдених. Шкалу яскравості розраховано для цієї пари. Повну серію можна підготувати через «Знайти кадри».</p>}
          {compare && data && <div className="compare-controls"><label>{t("Опорний кадр")}</label><Slider min={0} max={data.frames.length-1} step={1} value={[reference]} onValueChange={([v])=>setReference(v)} aria-label="Вибір опорного кадру для порівняння" aria-valuetext={refFrame?`${reference+1}, ${timeLabel(refFrame.date)} UTC`:undefined}/>{frame && refFrame && <span>{reference+1} / {data.frames.length}</span>}</div>}
          <div className="timeline"><div className="playback"><button className="icon-button" aria-label={t("Попередній кадр")} disabled={!data || index === 0} onClick={() => selectFrame(index - 1)}><ChevronLeft size={18}/></button><button className="play-button" aria-label={playing ? t("Пауза") : t("Відтворити")} disabled={!data} onClick={() => setPlaying(p => !p)}>{playing ? <Pause size={19}/> : <Play size={19}/>}</button><button className="icon-button" aria-label={t("Наступний кадр")} disabled={!data || index === data.frames.length - 1} onClick={() => selectFrame(index + 1)}><ChevronRight size={18}/></button></div><div className="time-track"><div className="time-slider"><Slider min={0} max={1000} step={1} value={[Math.round(timeFraction*1000)]} onValueChange={([v]) => seekTimeline(v/1000)} disabled={!data} aria-label="Час спостереження; вибір найближчого кадру" aria-valuetext={frame ? frame.date+" UTC" : undefined}/>{data&&<TimelineMarks frames={data.frames}/>}</div><div className="track-labels"><span>{data ? timeLabel(data.frames[0].date) : "—"}</span><span>UTC · усі експозиції позначено рисками</span><span>{data ? timeLabel(data.frames.at(-1)!.date) : "—"}</span></div></div><Select value={delay} onValueChange={setDelay}><SelectTrigger className="speed-select" aria-label="Швидкість відтворення"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="1600">{t("Повільно")}</SelectItem><SelectItem value="900">{t("Звичайно")}</SelectItem><SelectItem value="400">{t("Швидко")}</SelectItem></SelectContent></Select></div>
        </div>
        {data&&<FrameNavigation frames={data.frames} index={index} reference={reference} compare={compare} onSelect={selectFrame} onReference={setReference}/>}
        {data && <div className="exposure-window"><span>Кадри поруч: {stripStart+1}–{Math.min(stripStart+stripFrames.length,data.frames.length)} із {data.frames.length}</span><div className="exposure-strip" aria-label="Кадри поряд із вибраним моментом">{stripFrames.map((f, offset) => {const i=stripStart+offset;return <ExposureTile key={f.id} frame={f} index={i} selected={i===index} afterGap={i>0&&(f.mjd-data.frames[i-1].mjd)*1440>10} label={timeLabel(f.date)} onSelect={()=>selectFrame(i)}/>;})}</div></div>}
        <div className="spectral-notice"><Info size={19}/><div><strong>{t("Час і спектр змінюються разом")}</strong><p>Яскравість кадрів не можна напряму порівнювати як часову змінність. {compare && difference ? `Δλ = ${difference.delta.toFixed(4)} мкм; це ${difference.widthRatio.toFixed(2)} від меншої ширини смуги.` : `У позначеній позиції: ${waveRange[0].toFixed(4)}–${waveRange[1].toFixed(4)} мкм.`}</p>{compare && difference?.sameExposure && <p>Обрано той самий кадр — змініть опорний для порівняння.</p>}</div></div>
        <p className="viewer-caption">{mode === "sky" ? "Спільна координатна сітка; нерухомі зорі мають залишатися на своїх місцях." : "Центр кожного кадру — прогнозована позиція комети; зорі зміщуються відносно центру."} Темна шахова фактура у нових серіях позначає відсутні дані. Мітки та повзунок відповідають реальному UTC часу; анімація рівномірно переходить між кадрами і не відтворює реальне спливання часу. {frame && index > 0 && `Від попереднього кадру: ${((frame.mjd - data!.frames[index - 1].mjd) * 1440).toFixed(1)} хв.`}</p>{data?.completeness&&<details className="series-report"><summary>Паспорт вибірки: {data.frames.length} кадрів із {data.completeness.matched_count} знайдених</summary><p>{data.completeness.selected_count===data.completeness.matched_count?`До обробки передано всі ${data.completeness.selected_count} збігів каталогу; після перевірок FITS/WCS залишилося ${data.frames.length}, відхилено ${data.completeness.excluded.length}.`:`До обробки відібрано ${data.completeness.selected_count} із ${data.completeness.matched_count} збігів; кадри рівномірно добиралися за MJD. Після перевірок FITS/WCS відхилено ${data.completeness.excluded.length}.`}</p>{data.completeness.catalogue_truncated&&<p className="flagged-text">Каталог обмежено 1000 записами. Це неповна вибірка.</p>}{data.completeness.excluded.map((f,i)=><p key={i}><code>{f.id}</code><br/>{f.reason.split("\n").filter(Boolean).at(-1)}</p>)}{data.observation_table_parts&&data.observation_table_parts.length>1?<details><summary>Відтворити запити архіву ({data.observation_table_parts.length} частини)</summary>{data.observation_table_parts.map((part,i)=><p key={`${part.start}-${i}`}><a className="text-link" href={part.source_url} target="_blank" rel="noreferrer">Частина {i+1} · {part.start}—{part.end} ↗</a><br/><code>SHA-256 {part.source_sha256}</code></p>)}</details>:<a className="text-link" href={data.observation_table_url} target="_blank" rel="noreferrer">Відтворити запит каталогу ↗</a>}</details>}<div className="image-credit-inline">NASA / JPL-Caltech / IPAC · одна шкала яскравості для всіх кадрів</div>
      </section>
      <aside className="inspector"><div className="section-label">{t("ПАСПОРТ КАДРУ")}</div><h3>{t("Від зображення")}<br/>{t("до джерела")}</h3>{frame && <><dl><div><dt>{t("Середина спостереження · UTC")}</dt><dd>{formatTime(frame.date)}</dd><p className="detail-note">{frame.date.slice(0,10)}</p></div><div><dt>Довжина хвилі {field?(moving?"біля цілі":"у центрі поля"):"біля комети"}</dt><dd>≈ {frame.wavelength_um.toFixed(4)} <small>{t("мкм")}</small></dd><p className="detail-note">Ширина смуги ≈ {frame.bandwidth_um.toFixed(4)} мкм</p></div><div><dt>{field?(data?.query?.most?"Позиція IRSA MOST":isProperMotion(data?.query?.ephemeris)?t("Позиція за власним рухом"):data?.query?.ephemeris?"Позиція Horizons":"Центр запиту"):"Прогноз IRSA"} · ICRS</dt><dd className="coordinates">RA {frame.ra.toFixed(6)}°<br/>Dec {frame.dec.toFixed(6)}°</dd><p className="detail-note">{field?(data?.query?.most?"Позиція ra_obj/dec_obj з таблиці MOST; окрема епоха координати та невизначеність не надані":isProperMotion(data?.query?.ephemeris)?t("Каталожна позиція, поширена власним рухом до DATE-AVG; паралакс не враховано; не вимірювання SPHEREx"):data?.query?.ephemeris?"Геоцентричний прогноз Horizons на DATE-AVG; не вимірювання SPHEREx":"Координати вибраного поля; не виявлення об’єкта"):"Не виміряні на зображенні координати"}</p></div><div><dt>{t("Експозиція")}</dt><dd>{frame.exposure_s.toFixed(2)} <small>с</small></dd></div><div><dt>FLAGS {field?(moving?"біля цілі":"у центрі поля"):"біля прогнозованої позиції"}</dt><dd className={`value-text ${positionFlagged(frame) ? "flagged-text" : ""}`}>{describeFlags(positionFlags(frame))}</dd><p className="detail-note">{positionFlagged(frame) ? "Піксель потребує перевірки; сигнал збережено." : "Інформаційний статус не гарантує достовірності сигналу."}</p></div></dl><details className="frame-details"><summary>{t("Технічні метадані")}</summary><p>Медіана FWHM PSF експозиції: {frame.quality.median_psf_fwhm_arcsec?.toFixed(2) ?? "—"}″. Це характеристика інструмента, а не розмір об’єкта.</p><p>{frame.quality.coverage_fraction!==undefined&&`Центри вихідної сітки в кадрі: ${(frame.quality.coverage_fraction*100).toFixed(1)}%. `}Придатні пікселі серед покритої ділянки: {frame.quality.usable_coverage_fraction===undefined?"—":(frame.quality.usable_coverage_fraction*100).toFixed(1)+"%"}. FLAGS або відсутня інтерполяційна підтримка: {(frame.quality.flagged_display_fraction * 100).toFixed(1)}% панелі.</p>{frame.quality.finite_pixel_count!==undefined&&<p>Скінченні пікселі: {frame.quality.finite_pixel_count} із 65 536 у нерухомому полі{moving&&frame.quality.target_finite_pixel_count!==undefined?`; біля цілі: ${frame.quality.target_finite_pixel_count}`:""}. Відсутні значення не є нульовим сигналом.</p>}<p>MJD-AVG: {frame.mjd.toFixed(8)}</p><p>Перевірки архіву: L1 {frame.quality.level1}, L2 {frame.quality.level2}.</p></details><a className="button source-button" href={frame.source_url} target="_blank" rel="noreferrer">{t("Вихідний FITS")} <ArrowUpRight size={16}/></a><a className="text-link cutout-link" href={frame.cutout_url} target="_blank" rel="noreferrer">{t("FITS-вирізка")} <ArrowUpRight size={14}/></a><p className="identifier">{frame.id}</p><div className="science-note"><p>Візуальна підказка — початок перевірки. Автоматичних підтверджень відкриття в цій версії немає.</p></div></>}</aside>
    </div>{liveArchive&&data&&<ScienceLab key={data.frames[0].sha256_cutout+data.frames.length} manifest={data} onFrame={id=>{const i=data.frames.findIndex(f=>f.id===id);if(i>=0)selectFrame(i);}}/>}<footer className="footer"><span>{t("Відкриті дані. Простежувані джерела.")}</span><span>{t("Дослідницька версія · 0.10")}</span></footer>
  </main>;
}
