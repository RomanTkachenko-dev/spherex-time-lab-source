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
import { LanguageContext, useMessage, useTranslation, type Language } from "@/lib/language";
import SkyAtlas, { type SkyAtlasControl } from "./sky-atlas";
import { inPanel, pixelToSky, separationArcmin, skyToPixel } from "@/lib/sky-link";
import { projectGaia, type GaiaReference } from "@/lib/gaia";
import { readDisplayAsset } from "@/lib/frame-assets";
import { differenceImage, manifestScale, type DifferenceResult, type DisplayScale } from "@/lib/difference";
import { restoreActiveSession, saveSession, updateSessionView, type SavedSession, type SessionView } from "@/lib/sessions";
import SessionLibrary from "./session-library";
import { BENCHMARK_TARGETS, annualMotion, benchmarkSearch } from "@/lib/benchmark-targets";
import FrameNavigation from "./frame-navigation";
import ScienceLab from "./science-lab";
import { centredScroll, stripLayout, visibleTiles, STRIP_PAUSE_GAP } from "@/lib/exposure-strip";

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

function ExposureTile({ frame, index, selected, left, label, onSelect }: { frame: Frame; index: number; selected: boolean; left: number; label: string; onSelect: () => void }) {
  const t = useTranslation();
  const {source:src,error} = useDisplaySource(frame.image);
  return <button className={`exposure ${selected ? "selected" : ""}`} style={{left}} onClick={onSelect} aria-label={t("Exposure {n}, {time} UTC",{n:index + 1,time:label})+(error?", "+t("thumbnail unavailable"):"")} aria-pressed={selected} title={`${index + 1} / ${label} UTC`}><img src={src ? publicAsset(src) : undefined} width={64} height={64} alt="" loading="lazy"/><span>{String(index + 1).padStart(2, "0")}</span></button>;
}

function ExposureStrip({ frames, index, playing, label, onSelect }: { frames: Frame[]; index: number; playing: boolean; label: (date: string) => string; onSelect: (index: number) => void }) {
  const t = useTranslation();
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ left: 0, width: 0 });
  const layout = useMemo(() => stripLayout(frames.map(f => f.mjd)), [frames]);
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const update = () => setView({ left: node.scrollLeft, width: node.clientWidth });
    update();
    const observer = new ResizeObserver(update); observer.observe(node);
    node.addEventListener("scroll", update, { passive: true });
    return () => { observer.disconnect(); node.removeEventListener("scroll", update); };
  }, []);
  // Keep the selected exposure in view: centre it when it is off-screen or near an edge.
  useEffect(() => {
    const node = scroller.current;
    if (!node || !layout.offsets.length) return;
    const tileLeft = layout.offsets[Math.min(index, layout.offsets.length - 1)];
    const margin = 72;
    if (tileLeft >= node.scrollLeft + margin && tileLeft + 64 <= node.scrollLeft + node.clientWidth - margin) return;
    const target = centredScroll(layout, index, node.clientWidth);
    const far = Math.abs(target - node.scrollLeft) > node.clientWidth * 2;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    node.scrollTo({ left: target, behavior: far || playing || reduced ? "auto" : "smooth" });
  }, [index, layout, playing]);
  const [start, end] = visibleTiles(layout, view.left, view.width || 800);
  const tiles = [];
  for (let i = start; i < end; i++) {
    if (layout.pauses[i]) tiles.push(<span key={`pause-${i}`} className="exposure-pause" style={{ left: layout.offsets[i] - 7 - STRIP_PAUSE_GAP / 2 - 1 }} aria-hidden="true"/>);
    tiles.push(<ExposureTile key={frames[i].id} frame={frames[i]} index={i} selected={i === index} left={layout.offsets[i]} label={label(frames[i].date)} onSelect={() => onSelect(i)}/>);
  }
  return <div className="exposure-window">
    <span>{t("All {n} exposures · selected: {i}",{n:frames.length,i:index + 1})}{view.width>0&&layout.width>view.width?" · "+t("scroll sideways to see the rest"):""}{layout.pauses.some(Boolean)?" · "+t("a line marks a pause of more than 10 min"):""}</span>
    <div ref={scroller} className="exposure-strip exposure-strip-virtual" role="group" aria-label={t("All exposures in time order")} tabIndex={-1}>
      <div className="exposure-track" style={{ width: layout.width }}>{tiles}</div>
    </div>
  </div>;
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
      context.scale(ratio, ratio); context.clearRect(0, 0, width, height); context.fillStyle = "#68a6ec";
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

function frameSources(frame: Frame, mode: Mode) {
  const image = mode === "sky" ? frame.image : frame.object_image;
  const mask = mode === "object" ? frame.object_quality_mask_image ?? frame.quality_mask_image ?? image.replace(/\.png$/,"-mask.png") : frame.quality_mask_image ?? image.replace(/\.png$/,"-mask.png");
  return { image, mask };
}

/** Decode a display PNG into RGBA pixels (null while loading or when unavailable). */
function useImagePixels(src: string) {
  const [state, setState] = useState<{src:string;pixels:Uint8ClampedArray|null;failed:boolean}>({src:"",pixels:null,failed:false});
  useEffect(() => {
    if (!src) return;
    let active = true;
    const image = new Image();
    image.onload = () => {
      if (!active) return;
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) { setState({src,pixels:null,failed:true}); return; }
      if (canvas.width !== 256 || canvas.height !== 256) {
        setState({src,pixels:null,failed:true});
        return;
      }
      try {
        context.drawImage(image, 0, 0);
        setState({src,pixels:context.getImageData(0,0,canvas.width,canvas.height).data,failed:false});
      } catch {
        setState({src,pixels:null,failed:true});
      }
    };
    image.onerror = () => { if (active) setState({src,pixels:null,failed:true}); };
    image.src = publicAsset(src);
    return () => { active = false; };
  }, [src]);
  return state.src === src ? state : {src,pixels:null,failed:false};
}

function GaiaCircles({ gaia, field, mjd, colour, label }: { gaia: GaiaReference; field: number; mjd: number; colour: string; label: string }) {
  const points = gaia.sources.flatMap(source => { const p = projectGaia(source, gaia.center_ra, gaia.center_dec, field, mjd); return p ? [{ source, ...p }] : []; });
  if (!points.length) return null;
  return <svg className="gaia-overlay" role="img" focusable="false" viewBox="0 0 256 256" aria-label={label}>{points.map(({source,x,y})=><circle key={source.source_id} cx={x} cy={y} r="2" fill="none" stroke={colour} strokeWidth="0.8"/>)}</svg>;
}

function DifferenceFrame({ frame, reference, mode, scale, field, gaia }: { frame: Frame; reference: Frame; mode: Mode; scale: DisplayScale; field: number; gaia: GaiaReference | null }) {
  const t = useTranslation();
  const a = frameSources(frame, mode), b = frameSources(reference, mode);
  const imageSourceA = useDisplaySource(a.image), imageSourceB = useDisplaySource(b.image);
  const maskSourceA = useDisplaySource(a.mask), maskSourceB = useDisplaySource(b.mask);
  const imageA = useImagePixels(imageSourceA.source), imageB = useImagePixels(imageSourceB.source);
  const maskA = useImagePixels(maskSourceA.source), maskB = useImagePixels(maskSourceB.source);
  const canvas = useRef<HTMLCanvasElement>(null);
  const result = useMemo<DifferenceResult | null>(() => {
    if (!imageA.pixels || !imageB.pixels) return null;
    if (!maskA.pixels || !maskB.pixels) return null;
    return differenceImage(imageA.pixels, imageB.pixels, maskA.pixels, maskB.pixels, scale);
  }, [imageA.pixels, imageB.pixels, maskA, maskB, scale]);
  useEffect(() => {
    const node = canvas.current, context = node?.getContext("2d");
    if (!node || !context || !result) return;
    const size = Math.round(Math.sqrt(result.rgba.length / 4));
    node.width = node.height = size;
    context.putImageData(new ImageData(new Uint8ClampedArray(result.rgba), size, size), 0, 0);
  }, [result]);
  const failed = [imageA, imageB, maskA, maskB].some(asset => asset.failed) ||
    [imageSourceA, imageSourceB, maskSourceA, maskSourceB].some(asset => asset.error);
  const empty = result?.validCount === 0;
  const total = result ? result.validCount + result.maskedCount + result.clippedCount : 0;
  const excluded = result && total ? (100 * (result.maskedCount + result.clippedCount) / total).toFixed(1) : null;
  return <figure className="sky-frame difference-frame">
    <figcaption><span>{t("Difference: current − reference")}</span><time>{frame.date.slice(0,10)} − {reference.date.slice(0,10)}</time></figcaption>
    <div className="image-space"><div className="sky-plane difference-plane">
      <canvas style={{visibility: result && !empty ? "visible" : "hidden"}} ref={canvas} width={256} height={256} role="img" aria-label={t("Difference image of two SPHEREx exposures")}/>
      {empty && <div className="asset-loading" role="status">{t("These exposures share no usable pixels.")}</div>}
      {!result && !failed && <div className="asset-loading" role="status">{t("Computing the difference…")}</div>}
      {gaia && mode === "sky" && <><GaiaCircles gaia={gaia} field={field} mjd={reference.mjd} colour="#e58ad8" label={t("Gaia DR3, reference exposure, MJD {mjd}",{mjd:reference.mjd.toFixed(5)})}/><GaiaCircles gaia={gaia} field={field} mjd={frame.mjd} colour="#68d8e5" label={t("Gaia DR3, current exposure, MJD {mjd}",{mjd:frame.mjd.toFixed(5)})}/></>}
    </div>{failed && <div className="image-error" role="alert">{t("Could not read an exposure or its quality mask.")}</div>}<div className="orientation" title={t("North is up, east is left (as seen on the sky)")}>N ↑<br/>E ←</div><span className="field-size" title={t("Width of the image in arcminutes (the full Moon is about 30′)")}>{t("Width ≈ {w}′",{w:(field * 60).toFixed(1)})}</span></div>
    <p className="difference-legend"><strong>{t("A visual difference of the display images. Source shapes and spectral responses can differ between exposures.")}</strong> {t("White: brighter in the current exposure; black: brighter in the reference; grey: no change. A moving object leaves a black–white pair. Checkered pixels are excluded (quality flags, missing data or clipping by the brightness scale).")}{excluded !== null && " " + t("Excluded: {p}%.",{p:excluded})}{gaia && mode === "sky" && " " + t("Gaia DR3 circles: cyan at the current exposure's epoch, pink at the reference's.")}</p>
  </figure>;
}

function SkyFrame({ frame, mode, marker, mask, label, field, moving, gaia, globe, onPick }: { frame: Frame; mode: Mode; marker: boolean; mask: boolean; label: string; field: number; moving: boolean; gaia: GaiaReference | null; globe?: { x: number; y: number } | null; onPick?: (x: number, y: number) => void }) {
  const t = useTranslation();
  const { image: referenceSrc, mask: overlayReference } = frameSources(frame, mode);
  const imageAsset = useDisplaySource(referenceSrc);
  const src = imageAsset.source;
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
    <figcaption><span>{label}</span><time>{frame.date.slice(0,10)} · {formatTime(frame.date)} UTC</time><span>≈ {frame.wavelength_um.toFixed(4)} {t("µm")}</span></figcaption>
    <div className="image-space"><div className={onPick ? "sky-plane is-pickable" : "sky-plane"} title={onPick ? t("Click a point to show it in the sky atlas") : undefined} onClick={onPick ? event => { const box = event.currentTarget.getBoundingClientRect(); onPick((event.clientX - box.left) / box.width * 256 - 0.5, (event.clientY - box.top) / box.height * 256 - 0.5); } : undefined}>
      {src && <img src={publicAsset(src)} width={256} height={256} alt={t("SPHEREx exposure {id}, {date} UTC",{id:frame.id,date:frame.date})} onError={() => setFailedSrc(src)}/>}{imageAsset.error&&<div className="asset-error" role="alert">{t("This exposure's image is missing from browser storage. Build the time series again.")}</div>}
      {!src&&!imageAsset.error&&<div className="asset-loading" role="status">{t("Loading the image from browser storage…")}</div>}
      {mask && overlaySrc && <img className="quality-overlay" src={publicAsset(overlaySrc)} width={256} height={256} alt={t("Orange quality overlay: pixels flagged by the archive")}/>}
      {gaiaPoints.length>0&&<svg className="gaia-overlay" role="img" focusable="false" viewBox="0 0 256 256" aria-label={t("Gaia DR3 catalogue positions, propagated to MJD {mjd}",{mjd:frame.mjd.toFixed(5)})}>{gaiaPoints.map(({source,x,y})=><circle key={source.source_id} cx={x} cy={y} r="2" fill="none" stroke="#68d8e5" strokeWidth="0.8"/>)}</svg>}
      {marker && (mode === "object" || frame.marker_sky_visible !== false) && <svg className="coordinate-overlay" viewBox="0 0 256 256" aria-label={moving ? (mode === "sky" ? t("Catalogue position of the target in the fixed ICRS view") : t("Image centred on the catalogue position of the target")) : frame.position_kind === "requested-sky-position" ? t("Query centre, not a detected object") : frame.position_kind === "user-supplied-horizons-ephemeris" ? t("Position from the imported Horizons ephemeris, not a detection") : t("IRSA predicted position, not a measurement")}><circle cx={point.x + 0.5} cy={point.y + 0.5} r="9" fill="none" stroke="#68a6ec" strokeWidth="0.8" strokeDasharray="3 2"/><path d={`M${point.x + 0.5},${point.y - 13} v-5 M${point.x + 0.5},${point.y + 14} v5`} stroke="#68a6ec" strokeWidth="0.8"/></svg>}
      {globe && <svg className="globe-overlay" viewBox="0 0 256 256" role="img" aria-label={t("Centre of the sky atlas")}><g stroke="#68d8e5" strokeWidth="1.2" fill="none"><circle cx={globe.x + 0.5} cy={globe.y + 0.5} r="5"/><path d={`M${globe.x + 0.5 - 14},${globe.y + 0.5} h8 M${globe.x + 0.5 + 6},${globe.y + 0.5} h8 M${globe.x + 0.5},${globe.y + 0.5 - 14} v8 M${globe.x + 0.5},${globe.y + 0.5 + 6} v8`}/></g></svg>}
    </div>{failed && <div className="image-error" role="alert">{t("The image didn't load. Reload the page or open the original FITS file.")}</div>}<div className="orientation" title={t("North is up, east is left (as seen on the sky)")}>N ↑<br/>E ←</div><span className="field-size" title={t("Width of the image in arcminutes (the full Moon is about 30′)")}>{t("Width ≈ {w}′",{w:(field * 60).toFixed(1)})}</span></div>
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
  const t = useTranslation(), msg = useMessage();
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  const [data, setData] = useState<Manifest | null>(null);
  const [error, setError] = useState(""), [attempt, setAttempt] = useState(0);
  const [index, setIndex] = useState(0), [reference, setReference] = useState(8);
  const [playing, setPlaying] = useState(false), [delay, setDelay] = useState("900");
  const [mode, setMode] = useState<Mode>("sky");
  const [compare, setCompare] = useState(false), [marker, setMarker] = useState(true), [mask, setMask] = useState(false);
  const [compareStyle, setCompareStyle] = useState<"side"|"difference"|"blink">("side");
  const [blinkReference, setBlinkReference] = useState(false);
  const blinkActive = compare && !playing && compareStyle === "blink";
  useEffect(() => {
    if (!blinkActive) return;
    const timer = setInterval(() => setBlinkReference(value => !value), 900);
    return () => clearInterval(timer);
  }, [blinkActive]);
  const [gaiaEnabled, setGaiaEnabled] = useState(false), [gaia, setGaia] = useState<GaiaReference|null>(null), [gaiaLoading, setGaiaLoading] = useState(false), [gaiaError, setGaiaError] = useState("");
  const [exportBusy,setExportBusy]=useState(false),[exportError,setExportError]=useState("");
  const [sessionId,setSessionId]=useState<string|null>(null),[sessionError,setSessionError]=useState("");
  const [sessionRevision,setSessionRevision]=useState(0);
  const currentSession=useRef<{id:string|null;view:SessionView|null}>({id:null,view:null});
  const viewer = useRef<HTMLElement>(null);
  const fieldSearch = useRef<FieldSearchControl>(null);
  const demo = useRef<Manifest | null>(null);
  const epochDemoFrame = useRef<string | null>(null);
  const gaiaRequest = useRef<AbortController|null>(null);
  const atlas = useRef<SkyAtlasControl>(null);
  const [globeCenter, setGlobeCenter] = useState<[number, number] | null>(null), [linked, setLinked] = useState(true), [picked, setPicked] = useState<{ ra: number; dec: number } | null>(null);
  useEffect(() => () => gaiaRequest.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    fetch(publicAsset("/data/atlas/manifest.json"), { signal: controller.signal }).then(r => { if (!r.ok) throw Error(t("Could not load the example observations. Check your connection and try again.")); return r.json(); }).then(validateManifest).then(async m => {
      demo.current=m;
      try {
        const saved=await restoreActiveSession()??await saveSession(m,initialView(m));
        if(!controller.signal.aborted)applySession(saved);
      } catch(e) {
        if(!controller.signal.aborted){setData(m);setReference(Math.min(8,m.frames.length-1));setSessionError(e instanceof Error?e.message:t("Saving in this browser is unavailable (private mode?). The viewer still works."));}
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
  const displayScale = useMemo(() => data ? manifestScale(data.display) : null, [data]);
  const showDifference = compare && compareStyle === "difference" && !!displayScale;
  const selectFrame = (value: number) => { setPlaying(false); setIndex(value); };
  const field = data?.kind === "field";
  const epochDemoOpen = Boolean(field && data && epochDemoFrame.current && data.frames.some(f => f.id === epochDemoFrame.current));
  const moving = Boolean(data?.query?.most || data?.query?.ephemeris);
  const multipleDays = data && data.frames[0].date.slice(0,10) !== data.frames.at(-1)!.date.slice(0,10);
  const timeLabel = (date:string) => `${multipleDays ? date.slice(0,10) + " · " : ""}${formatTime(date)}`;
  const waveRange = useMemo(()=>data ? data.frames.reduce<[number,number]>((range,f)=>[Math.min(range[0],f.wavelength_um),Math.max(range[1],f.wavelength_um)],[Infinity,-Infinity]) : [0,0],[data]);
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
    if(comparisonUrls&&(!a||!b))setSessionError(t('One of the chosen exposures failed processing. The series is open without replacing the pair.'));
    viewer.current?.scrollIntoView({behavior:'smooth',block:'start'});
  }
  async function openSession(session:SavedSession){await flushView();applySession(session);}
  const exportView:SessionView|null = frame ? {frame_id:frame.id,mode,compare,reference_id:refFrame?.id??null,predicted_marker:!field&&marker,centre_marker:!!field&&marker,quality_overlay:mask,gaia_enabled:gaiaEnabled} : null;
  const viewKey=JSON.stringify(exportView);
  useEffect(()=>{
    const view=JSON.parse(viewKey) as SessionView|null;
    currentSession.current={id:sessionId,view};
    if(!sessionId||!view)return;
    const persist=()=>{void updateSessionView(sessionId,view).catch(e=>setSessionError(e instanceof Error?e.message:t("Could not save the view settings.")));};
    const timer=setTimeout(persist,350);
    const onHide=()=>{if(document.visibilityState==="hidden")persist();};
    window.addEventListener("pagehide",persist);document.addEventListener("visibilitychange",onHide);
    return()=>{clearTimeout(timer);window.removeEventListener("pagehide",persist);document.removeEventListener("visibilitychange",onHide);};
  },[sessionId,viewKey]);
  const linkGrid = data && mode === "sky" ? { centerRa: data.display.sky_center_ra, centerDec: data.display.sky_center_dec, fovDeg: data.display.sky_fov_deg } : null;
  const globePixel = linked && linkGrid && globeCenter ? skyToPixel(globeCenter[0], globeCenter[1], linkGrid) : null;
  const globeInside = inPanel(globePixel);
  // The "globe moved to…" note is shown only while the globe still sits on the picked point.
  const pickedCurrent = picked && globeCenter && separationArcmin(picked.ra, picked.dec, globeCenter[0], globeCenter[1]) < 0.01 ? picked : null;
  const globeOffset = linkGrid && globeCenter ? separationArcmin(linkGrid.centerRa, linkGrid.centerDec, globeCenter[0], globeCenter[1]) : null;
  const pickPoint = linked && linkGrid ? (x: number, y: number) => {
    const sky = pixelToSky(x, y, linkGrid);
    setPicked(sky); setGlobeCenter([sky.ra, sky.dec]);
    atlas.current?.goto(sky.ra, sky.dec, Math.max(0.5, linkGrid.fovDeg * 4));
  } : undefined;
  const passportManifest = data && gaiaEnabled && gaia ? {...data,gaia_reference:gaia} : data;
  async function openEpochDemo() {
    try {
      const response = await fetch(publicAsset("/data/epochs/manifest.json"));
      if (!response.ok) throw Error(t("Could not load the DR1 example. Check your connection and try again."));
      const manifest = validateManifest(await response.json());
      epochDemoFrame.current = manifest.frames[0].id;
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
      if(!response.ok){const body=await response.json().catch(()=>({})) as {error?:string};throw Error(body.error||t("Could not create the series metadata file."));}
      const url=URL.createObjectURL(await response.blob()),anchor=document.createElement("a");anchor.href=url;anchor.download=`spherex-${frame.id}.json`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(error){setExportError(error instanceof Error?error.message:t("Could not download the series metadata."));}
    finally{setExportBusy(false);}
  }
  async function toggleGaia(enabled:boolean){
    gaiaRequest.current?.abort();gaiaRequest.current=null;setGaiaEnabled(enabled);
    if(!enabled){setGaia(null);setGaiaError("");setGaiaLoading(false);return;}
    if(!data||data.kind!=="field")return;
    const controller=new AbortController();gaiaRequest.current=controller;
    const radius=Math.SQRT2*data.display.sky_fov_deg/2+0.1;
    setGaia(null);setGaiaError("");setGaiaLoading(true);
    try{const response=await fetch(apiUrl(`/api/gaia?ra=${data.display.sky_center_ra}&dec=${data.display.sky_center_dec}&radius=${radius}`),{signal:controller.signal});const body=await response.json() as GaiaReference&{error?:string};if(!response.ok)throw Error(body.error||t("Could not load Gaia DR3 stars. Try again in a minute."));if(!controller.signal.aborted){const enriched=validateManifest({...data,gaia_reference:body});setGaia(body);setData(enriched);const current=currentSession.current;if(current.id&&current.view)await saveSession(enriched,{...current.view,gaia_enabled:true},current.id);}}
    catch(error){if(!controller.signal.aborted)setGaiaError(error instanceof Error?error.message:t("Could not load Gaia DR3 stars. Try again in a minute."));}
    finally{if(!controller.signal.aborted)setGaiaLoading(false);}
  }

  return <main className={link.embed ? "observatory observatory-embed" : "observatory"}>
    <header className="topbar"><a href={pagesBase || "/"} className="brand"><Orbit size={28}/><span>SPHEREx <b>TIME LAB</b></span></a><span className="edition">{t("Spot what changes in the infrared sky")}</span>{staticPages && !link.embed && <nav className="site-nav" aria-label={t("Site pages")}><a className="site-nav-link" href={pagesBase}>{t("Overview")}</a><a className="site-nav-link" href={`${pagesBase}about/`}>{t("About")}</a></nav>}<div className="header-actions"><label className="language-picker"><span>{t("Language")}</span><select value={language} onChange={event => switchLanguage(event.target.value === "uk" ? "uk" : "en")}><option value="en">English</option><option value="uk">Українська</option></select></label><Method data={data} onOpen={() => setPlaying(false)}/><a className="text-link" href="https://irsa.ipac.caltech.edu/Missions/spherex.html" target="_blank" rel="noreferrer" aria-label={t("NASA / IPAC archive (opens in a new tab)")}>NASA / IPAC <ArrowUpRight size={16}/></a></div></header>
    {!link.embed && <section className="how-it-works" aria-labelledby="how-title"><p id="how-title" className="how-lede">{t("Time Lab lets anyone flip through real NASA SPHEREx infrared pictures of the same patch of sky, taken days or months apart, to spot comets, asteroids and stars that change.")}</p><ol className="how-steps"><li><b>1</b>{t("Pick a spot in the sky atlas, or open a ready-made example.")}</li><li><b>2</b>{t("Press play and watch the exposures change over time.")}</li><li><b>3</b>{t("Judge what moved: stars stay put, moving objects shift.")}</li></ol></section>}
    {!liveArchive && <p className="demo-banner" role="note">{t("Demo version: the sky map, two ready-made examples and saved sessions work here. Archive search, Gaia stars and FITS analysis need the full (server) version.")}</p>}
    <SkyAtlas language={language} link={link} manifest={data} controlRef={atlas} onCenterChange={setGlobeCenter} onSearch={target => { setPlaying(false); fieldSearch.current?.prepareAt(target); }} onCurrentSeries={() => viewer.current?.scrollIntoView({ behavior: "smooth", block: "start" })}/>
    <div className="workspace">
      <aside className="library"><div className="section-label">{t("STEP 2 · WATCH")}</div><h1>{t("Sky in motion")}</h1><p className="intro">{t("Flip through real NASA SPHEREx pictures of one patch of sky, taken at different times, and see what moved.")}</p><button className={`target ${field?"":"active"}`} aria-pressed={!!data&&!field} onClick={()=>{if(demo.current)void prepared(demo.current).catch(e=>setSessionError(e instanceof Error?e.message:t("Could not save the series.")));}}><Orbit className="target-icon"/><span><strong>3I / ATLAS</strong><small>{t("Comet · 12 exposures in 2 hours")}</small></span></button><button className={`target ${epochDemoOpen?"active":""}`} aria-pressed={epochDemoOpen} onClick={()=>void openEpochDemo()}><Orbit className="target-icon"/><span><strong>{t("DR1 field")}</strong><small>{t("4 exposures · Aug 2025 – Feb 2026")}</small></span></button><div className="benchmark-targets" role="group" aria-label={t("Challenge test targets")}><div className="section-label">{t("TEST TARGETS")}</div>{BENCHMARK_TARGETS.map(target=>{const motion=annualMotion(target);return <button key={target.id} type="button" className="target benchmark" disabled={!liveArchive} title={liveArchive?`${target.reference}`:t("Needs the full (server) version with archive search.")} onClick={()=>{setPlaying(false);fieldSearch.current?.prepareAt(benchmarkSearch(target));}}><Orbit className="target-icon"/><span><strong>{target.name}</strong><small>{target.kind==="variable"?t("Variable star · brightness changes"):t("{a}″/yr ≈ {p} px/yr",{a:motion.arcsec.toFixed(1),p:motion.pixels.toFixed(1)})} · D{target.detector}</small></span></button>;})}{!liveArchive&&<p className="benchmark-note">{t("These examples run a live archive search, so they need the full (server) version.")}</p>}</div>{field&&<div className="active-field"><strong>{msg(data.title)}</strong><small>{t("Open now")}</small></div>}<div className="dataset-details"><span>{data?.frames[0].date.slice(0,10)} — {data?.frames.at(-1)?.date.slice(0,10)}</span><span>{t("{n} exposures",{n:data?.frames.length ?? "—"})} · {frame?.detector ?? "—"}</span><span>{archiveLabel} · {t("infrared light")}</span></div>{liveArchive && <FieldSearch controlRef={fieldSearch} onOpen={() => setPlaying(false)} onPrepared={prepared}/>}<SessionLibrary manifest={passportManifest} view={exportView} currentSessionId={sessionId} onLoad={openSession} onSaved={session=>{setSessionId(session.id);setSessionRevision(r=>r+1);}} refreshKey={sessionRevision}/>{sessionError&&<p className="session-error" role="alert">{msg(sessionError)}</p>}<div className="library-note"><Telescope size={22}/><p>{t("Press ▶ to play. Stars stay put; anything that shifts against them (a comet, an asteroid) or changes brightness is worth a closer look.")}</p><p>{t("Turn on Compare to see two moments side by side.")}</p></div><a className="text-link library-source" href={data?.source ?? "https://irsa.ipac.caltech.edu/Missions/spherex.html"} target="_blank" rel="noreferrer">{t("About this dataset")} <ArrowUpRight size={15}/></a></aside>
      <section className="lab-main" ref={viewer} tabIndex={0} aria-label={t("Exposure viewer. Arrow keys change the exposure; Space plays or pauses.")}>
        <div className="workspace-heading"><div><div className="section-label">{t("REAL DATA / SPHEREx {release}",{release:archiveLabel})}</div><h2>{data ? msg(data.title) : "SPHEREx"}</h2></div><div className="passport-actions"><button className="button" type="button" onClick={()=>void downloadPassport()} disabled={!data||exportBusy} title={data?.schema_version===4||data?.display.asset_storage==="indexeddb-sha256-v1"?t("The JSON lists hashes of images that are stored only in this browser."):t("Download a JSON file recording where every image came from (for reproducibility).")}><Download size={16}/>{exportBusy?t("Preparing…"):t("Download series metadata")}</button>{exportError&&<span className="passport-error" role="alert">{msg(exportError)}</span>}</div></div>
        <div className="viewer-panel"><div className="viewer-toolbar">{field&&!moving?<span className="view-label" title={t("All exposures are aligned on the same sky coordinates (ICRS).")}>{t("Aligned on the sky")}</span>:<Tabs value={mode} onValueChange={v => setMode(v as Mode)}><TabsList><TabsTrigger value="sky" title={t("Stars stay still; a moving object travels across the image.")}>{moving?t("Fixed field"):t("Fixed sky")}</TabsTrigger><TabsTrigger value="object" title={t("The image follows the object; the stars drift past it.")}>{moving?t("Follow target"):t("Follow comet")}</TabsTrigger></TabsList></Tabs>}<span className="frame-count" aria-live={playing ? "off" : "polite"}>{data ? `${String(index + 1).padStart(2, "0")} / ${data.frames.length}` : "—"}</span></div>
          <div className="view-options"><label title={t("Show a second (reference) exposure next to the current one.")}><Switch checked={compare} onCheckedChange={setCompare} disabled={!data}/>{t("Compare")}</label><label title={t("Dashed circle: where a catalogue expects the target, or the centre you asked for. It is not a detection.")}><Switch checked={marker} onCheckedChange={setMarker}/>{field?(data?.query?.most?t("MOST position"):data?.query?.ephemeris?t("Horizons position"):t("Query centre")):t("IRSA prediction")}</label>{liveArchive&&field&&mode==="sky"&&<label><Switch checked={gaiaEnabled} onCheckedChange={value=>void toggleGaia(value)}/>{t("Gaia DR3 stars")}</label>}<label title={t("Orange layer: pixels the archive flagged as suspicious (hot pixels, cosmic rays, ghosts…). The data underneath is kept.")}><Switch checked={mask} onCheckedChange={setMask}/>{t("Quality overlay")}</label><label title={t("Show the centre of the sky atlas as a cyan cross on the images, and click any point of an image to move the atlas there.")}><Switch checked={linked} onCheckedChange={value => { setLinked(value); setPicked(null); }}/>{t("Link with sky atlas")}</label></div>
          {linked && data && <div className="globe-link-status" role="status">{mode !== "sky" ? t("Linking with the atlas works in the fixed-sky view.") : <>{globeInside ? t("The cyan cross marks the centre of the sky atlas.") : globeOffset !== null ? t("The sky atlas is centred {d}′ away from this field, outside the image.", { d: globeOffset < 600 ? globeOffset.toFixed(1) : Math.round(globeOffset) }) : null} {pickedCurrent ? <>{t("Atlas moved to RA {ra}°, Dec {dec}°.", { ra: pickedCurrent.ra.toFixed(5), dec: pickedCurrent.dec.toFixed(5) })} <button type="button" className="text-link" onClick={() => atlas.current?.reveal()}>{t("Show in the atlas ↑")}</button></> : t("Click any point of an image to show it in the atlas.")}</>}</div>}
          {field&&mode==="sky"&&gaiaEnabled&&<div className="gaia-status" role="status">{gaiaLoading?t("Asking IRSA TAP for Gaia DR3 stars…"):gaiaError?msg(gaiaError):gaia&&<><span>{t("{n} Gaia DR3 stars returned in the search cone",{n:gaia.record_count})}{gaia.truncated?t("; more matches exist beyond the 1200 limit"):""}. {t("Positions shown for the current exposure, MJD {mjd}",{mjd:frame?.mjd.toFixed(5)??"—"})}{compare&&refFrame&&t("; reference exposure MJD {mjd}",{mjd:refFrame.mjd.toFixed(5)})}. {t("Each star's position is updated for every exposure using its proper motion.")}</span><details><summary>{t("Method and catalogue limits")}</summary><p>{t("The selection holds up to 1200 sources with a measured G magnitude, brightest first. Positions are propagated with constant proper motion from ref_epoch; if motion components are missing, the original catalogue position is shown. Parallax, radial velocity and covariances are not applied. The circles are Gaia catalogue positions, not SPHEREx detections or astrometric measurements by this pipeline.")}</p></details></>}</div>}
          {frame && data ? <div className={`frame-stage ${compare && !blinkActive ? "is-comparing" : ""}`}>{blinkActive && refFrame ? <SkyFrame frame={blinkReference ? refFrame : frame} mode={mode} marker={marker} mask={mask} label={t(blinkReference ? "Reference exposure" : "Current exposure")} field={mode === "sky" ? data.display.sky_fov_deg : data.display.object_fov_deg} moving={moving} gaia={field&&gaiaEnabled&&mode==="sky"?gaia:null} globe={globeInside ? globePixel : null} onPick={pickPoint}/> : showDifference && refFrame && displayScale ? <><SkyFrame frame={frame} mode={mode} marker={marker} mask={mask} label={t("Current exposure")} field={mode === "sky" ? data.display.sky_fov_deg : data.display.object_fov_deg} moving={moving} gaia={field&&gaiaEnabled&&mode==="sky"?gaia:null} globe={globeInside ? globePixel : null} onPick={pickPoint}/><DifferenceFrame frame={frame} reference={refFrame} mode={mode} scale={displayScale} field={mode === "sky" ? data.display.sky_fov_deg : data.display.object_fov_deg} gaia={field&&gaiaEnabled&&mode==="sky"?gaia:null}/></> : <><SkyFrame frame={frame} mode={mode} marker={marker} mask={mask} label={t("Current exposure")} field={mode === "sky" ? data.display.sky_fov_deg : data.display.object_fov_deg} moving={moving} gaia={field&&gaiaEnabled&&mode==="sky"?gaia:null} globe={globeInside ? globePixel : null} onPick={pickPoint}/>{compare && refFrame && <SkyFrame frame={refFrame} mode={mode} marker={marker} mask={mask} label={t("Reference exposure")} field={mode === "sky" ? data.display.sky_fov_deg : data.display.object_fov_deg} moving={moving} gaia={field&&gaiaEnabled&&mode==="sky"?gaia:null} globe={globeInside ? globePixel : null} onPick={pickPoint}/>}</>}</div> : <div className="viewer-empty" role="status">{error ? <><p>{msg(error)}</p><button className="button" onClick={() => setAttempt(a => a + 1)}>{t("Try again")}</button></> : <><Skeleton className="h-64 w-64"/><p>{t("Loading exposures…")}</p></>}</div>}
          {compare && frame && refFrame && difference && <div className="compare-controls" aria-label={t("Difference between the two exposures")}>
            <div>{t("Time apart")} <strong>{(Math.abs(frame.mjd - refFrame.mjd) * 1440).toFixed(1)} {t("min")}</strong></div>
            <div title={t("SPHEREx sees each exposure in a slightly different infrared colour.")}>{t("Wavelength difference")} <strong>≈ {difference.delta.toFixed(4)} {t("µm")}</strong></div>
            <div className="compare-style" role="radiogroup" aria-label={t("How to compare")}>
              <button type="button" role="radio" aria-checked={compareStyle==="side"} className={`button ${compareStyle==="side"?"active":""}`} onClick={()=>setCompareStyle("side")}>{t("Side by side")}</button>
              <button type="button" role="radio" aria-checked={compareStyle==="difference"} className={`button ${compareStyle==="difference"?"active":""}`} onClick={()=>setCompareStyle("difference")} disabled={!displayScale} title={displayScale?t("Show where the two exposures differ: white is brighter now, black was brighter before."):t("This series has no known brightness scale, so a difference can't be computed.")}>{t("Difference")}</button>
              <button type="button" role="radio" aria-checked={compareStyle==="blink"} className={`button ${compareStyle==="blink"?"active":""}`} onClick={()=>{setPlaying(false);setBlinkReference(false);setCompareStyle("blink");}}>{t("Blink")}</button>
            </div>
          </div>}
          {data?.completeness?.selection.startsWith("Selected pair only.") && <p className="compare-controls">{t("Showing the 2 chosen exposures out of {n} found. The brightness scale is set for this pair. Build the full series with \"Find exposures\".",{n:data.completeness.matched_count})}</p>}
          {compare && data && <div className="compare-controls"><label>{t("Reference exposure")}</label><Slider min={0} max={data.frames.length-1} step={1} value={[reference]} onValueChange={([v])=>setReference(v)} aria-label={t("Choose the reference exposure to compare with")} aria-valuetext={refFrame?`${reference+1}, ${timeLabel(refFrame.date)} UTC`:undefined}/>{frame && refFrame && <span>{reference+1} / {data.frames.length}</span>}</div>}
          <div className="timeline"><div className="playback"><button className="icon-button" aria-label={t("Previous exposure")} disabled={!data || index === 0} onClick={() => selectFrame(index - 1)}><ChevronLeft size={18}/></button><button className="play-button" aria-label={playing ? t("Pause") : t("Play")} disabled={!data} onClick={() => setPlaying(p => !p)}>{playing ? <Pause size={19}/> : <Play size={19}/>}</button><button className="icon-button" aria-label={t("Next exposure")} disabled={!data || index === data.frames.length - 1} onClick={() => selectFrame(index + 1)}><ChevronRight size={18}/></button></div><div className="time-track"><div className="time-slider"><Slider min={0} max={1000} step={1} value={[Math.round(timeFraction*1000)]} onValueChange={([v]) => seekTimeline(v/1000)} disabled={!data} aria-label={t("Observation time; jumps to the nearest exposure")} aria-valuetext={frame ? frame.date+" UTC" : undefined}/>{data&&<TimelineMarks frames={data.frames}/>}</div><div className="track-labels"><span>{data ? timeLabel(data.frames[0].date) : "—"}</span><span>{t("UTC · each tick is one exposure")}</span><span>{data ? timeLabel(data.frames.at(-1)!.date) : "—"}</span></div></div><Select value={delay} onValueChange={setDelay}><SelectTrigger className="speed-select" aria-label={t("Playback speed")}><SelectValue/></SelectTrigger><SelectContent><SelectItem value="1600">{t("Slow")}</SelectItem><SelectItem value="900">{t("Normal")}</SelectItem><SelectItem value="400">{t("Fast")}</SelectItem></SelectContent></Select></div>
        </div>
        {data&&<FrameNavigation frames={data.frames} index={index} reference={reference} compare={compare} onSelect={selectFrame} onReference={setReference}/>}
        {data && <ExposureStrip frames={data.frames} index={index} playing={playing} label={timeLabel} onSelect={selectFrame}/>}
        <div className="spectral-notice"><Info size={19}/><div><strong>{t("Time and colour change together")}</strong><p>{t("Each exposure sees a slightly different infrared colour (wavelength), so a brightness change between exposures does not by itself mean the object changed.")} {compare && difference ? t("Δλ = {d} µm; that is {r} of the smaller bandwidth.",{d:difference.delta.toFixed(4),r:difference.widthRatio.toFixed(2)}) : t("At the marked position: {a}–{b} µm.",{a:waveRange[0].toFixed(4),b:waveRange[1].toFixed(4)})}</p>{compare && difference?.sameExposure && <p>{t("You picked the same exposure twice. Choose another reference exposure to compare.")}</p>}</div></div>
        <p className="viewer-caption">{mode === "sky" ? t("Shared sky grid: stars should stay in place.") : t("Each image is centred on the comet's predicted position, so the stars drift.")} {t("A dark checkerboard in new series marks missing data.")} {t("Labels and the slider show real UTC time; playback steps evenly between exposures, not in real time.")} {frame && index > 0 && t("Since the previous exposure: {m} min.",{m:((frame.mjd - data!.frames[index - 1].mjd) * 1440).toFixed(1)})}</p>{data?.completeness&&<details className="series-report"><summary>{t("Selection report: {n} exposures out of {m} found",{n:data.frames.length,m:data.completeness.matched_count})}</summary><p>{data.completeness.selected_count===data.completeness.matched_count?t("All {s} catalogue matches were processed; {k} passed the FITS/WCS checks and {x} were rejected.",{s:data.completeness.selected_count,k:data.frames.length,x:data.completeness.excluded.length}):t("{s} of {m} matches were selected, spread evenly in MJD. {x} were rejected by the FITS/WCS checks.",{s:data.completeness.selected_count,m:data.completeness.matched_count,x:data.completeness.excluded.length})}</p>{data.completeness.catalogue_truncated&&<p className="flagged-text">{t("The catalogue was capped at 1000 records, so this selection is incomplete.")}</p>}{data.completeness.excluded.map((f,i)=><p key={i}><code>{f.id}</code><br/>{msg(f.reason.split("\n").filter(Boolean).at(-1))}</p>)}{data.observation_table_parts&&data.observation_table_parts.length>1?<details><summary>{t("Repeat the archive queries ({n} parts)",{n:data.observation_table_parts.length})}</summary>{data.observation_table_parts.map((part,i)=><p key={`${part.start}-${i}`}><a className="text-link" href={part.source_url} target="_blank" rel="noreferrer">{t("Part {n}",{n:i+1})} · {part.start}–{part.end} ↗</a><br/><code>SHA-256 {part.source_sha256}</code></p>)}</details>:<a className="text-link" href={data.observation_table_url} target="_blank" rel="noreferrer">{t("Repeat the catalogue query ↗")}</a>}</details>}<div className="image-credit-inline">NASA / JPL-Caltech / IPAC · {t("one brightness scale for all exposures")}</div>
      </section>
      <aside className="inspector"><div className="section-label">{t("STEP 3 · CHECK")}</div><h3>{t("About this exposure")}<br/>{t("and its source")}</h3>{frame && <><dl><div><dt>{t("Mid-exposure time · UTC")}</dt><dd>{formatTime(frame.date)}</dd><p className="detail-note">{frame.date.slice(0,10)}</p></div><div><dt title={t("The infrared colour SPHEREx recorded at this spot.")}>{field?(moving?t("Wavelength near the target"):t("Wavelength at the field centre")):t("Wavelength near the comet")}</dt><dd>≈ {frame.wavelength_um.toFixed(4)} <small>{t("µm")}</small></dd><p className="detail-note">{t("Bandwidth ≈ {w} µm",{w:frame.bandwidth_um.toFixed(4)})}</p></div><div><dt>{field?(data?.query?.most?t("IRSA MOST position"):data?.query?.ephemeris?t("Horizons position"):t("Query centre")):t("IRSA prediction")} · ICRS</dt><dd className="coordinates">RA {frame.ra.toFixed(6)}°<br/>Dec {frame.dec.toFixed(6)}°</dd><p className="detail-note">{field?(data?.query?.most?t("ra_obj/dec_obj from the MOST table; no separate coordinate epoch or uncertainty is given"):data?.query?.ephemeris?t("Geocentric Horizons prediction at DATE-AVG; not a SPHEREx measurement"):t("Coordinates of the chosen field; not a detected object")):t("Predicted coordinates, not measured on the image")}</p></div><div><dt>{t("Exposure time")}</dt><dd>{frame.exposure_s.toFixed(2)} <small>{t("s")}</small></dd></div><div><dt title={t("FLAGS are the archive's per-pixel quality notes.")}>{field?(moving?t("Quality flags near the target"):t("Quality flags at the field centre")):t("Quality flags at the predicted position")}</dt><dd className={`value-text ${positionFlagged(frame) ? "flagged-text" : ""}`}>{msg(describeFlags(positionFlags(frame)))}</dd><p className="detail-note">{positionFlagged(frame) ? t("This pixel needs checking; its signal is kept.") : t("No warning flags, but that alone doesn't guarantee the signal is real.")}</p></div></dl><details className="frame-details"><summary>{t("Technical details")}</summary><p>{t("Median PSF FWHM of the exposure: {v}″. This describes the instrument's blur, not the size of an object.",{v:frame.quality.median_psf_fwhm_arcsec?.toFixed(2) ?? "—"})}</p><p>{frame.quality.coverage_fraction!==undefined&&t("Output-grid centres inside the exposure: {v}%. ",{v:(frame.quality.coverage_fraction*100).toFixed(1)})}{t("Usable pixels within the covered area: {v}.",{v:frame.quality.usable_coverage_fraction===undefined?"—":(frame.quality.usable_coverage_fraction*100).toFixed(1)+"%"})} {t("FLAGS or missing interpolation support: {v}% of the panel.",{v:(frame.quality.flagged_display_fraction * 100).toFixed(1)})}</p>{frame.quality.finite_pixel_count!==undefined&&<p>{t("Valid pixels: {n} of 65,536 in the fixed field",{n:frame.quality.finite_pixel_count})}{moving&&frame.quality.target_finite_pixel_count!==undefined?t("; near the target: {n}",{n:frame.quality.target_finite_pixel_count}):""}. {t("Missing values are not zero signal.")}</p>}<p>MJD-AVG: {frame.mjd.toFixed(8)}</p><p>{t("Archive checks: L1 {a}, L2 {b}.",{a:frame.quality.level1,b:frame.quality.level2})}</p></details><a className="button source-button" href={frame.source_url} target="_blank" rel="noreferrer">{t("Original FITS file")} <ArrowUpRight size={16}/></a><a className="text-link cutout-link" href={frame.cutout_url} target="_blank" rel="noreferrer">{t("FITS cutout")} <ArrowUpRight size={14}/></a><p className="identifier">{frame.id}</p><div className="science-note"><p>{t("A visual hint is where checking starts, not a discovery. This version doesn't confirm discoveries automatically.")}</p></div></>}</aside>
    </div>{liveArchive&&data&&<ScienceLab key={data.frames[0].sha256_cutout+data.frames.length} manifest={data} onFrame={id=>{const i=data.frames.findIndex(f=>f.id===id);if(i>=0)selectFrame(i);}}/>}<footer className="footer"><span>{t("Open data. Traceable sources.")}</span><span>{t("Research version · 0.10")}</span></footer>
  </main>;
}
