"use client";
import { useMessage, useTranslation } from "@/lib/language";
import { apiUrl, liveArchive } from "@/lib/site-mode";
import { useEffect, useImperativeHandle, useRef, useState, type FormEvent, type Ref } from "react";
import { Globe2, Search, Crosshair, Plus, Minus, Pause, Play, ArrowDown, LoaderCircle } from "lucide-react";
import { loadAladin, type AladinApi, type SkyOverlay, type SkyViewer, type SkyImage } from "@/lib/aladin";
import hipsSnapshot from "@/lib/spherex-hips.json";
import { cubeMetadata, cubeRenderFrequency, SPHEREX_HIPS, DSS_HIPS } from "@/lib/hips";
import { readAtlasLink, parseSkyCoordinates, parseSkyFootprint, skyObservationDate, type SkyObservation, type SkySearchTarget } from "@/lib/sky-atlas";
import { collectCatalogueParts, MAX_CATALOGUE_CHUNK_FRAMES } from "@/lib/catalogue-batches";
import { validateFieldQuery } from "@/lib/field-query";
import { frameTimeFraction, nearestFrameIndexAtFraction, type Manifest } from "@/lib/science";
import "./sky-atlas.css";

export type SkyAtlasControl = { goto: (ra: number, dec: number, fov?: number) => void; reveal: () => void };
type Coverage = { query: SkySearchTarget; records: SkyObservation[]; sources: string[]; retrieved: string };
const hipsMeta = cubeMetadata(hipsSnapshot.properties);

export default function SkyAtlas({ manifest, onSearch, onCurrentSeries, link, controlRef, onCenterChange }: {
  controlRef?: Ref<SkyAtlasControl>; onCenterChange?: (center: [number, number]) => void;
  language: "en" | "uk"; link?: ReturnType<typeof readAtlasLink>;
  manifest: Manifest | null; onSearch: (target: SkySearchTarget) => void; onCurrentSeries: () => void;
}) {
  const t = useTranslation(), msg = useMessage();
  const initial = useRef(link);
  const autoStarted = useRef(false);
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<{ viewer: SkyViewer; api: AladinApi; overlay: SkyOverlay } | null>(null);
  const request = useRef<AbortController | null>(null), resolver = useRef<AbortController | null>(null);
  const [ready, setReady] = useState(false), [mapError, setMapError] = useState("");
  const [attempt, setAttempt] = useState(0), [collapsed, setCollapsed] = useState(false);
  const [center, setCenter] = useState<[number, number]>(link?.coordinates ?? [167.2, 5.15]);
  const [target, setTarget] = useState(""), [nameBusy, setNameBusy] = useState(false);
  const [start, setStart] = useState(link?.start ?? "2025-12-14"), [end, setEnd] = useState(link?.end ?? link?.start ?? "2025-12-14");
  const [release, setRelease] = useState<"qr2" | "qr3" | "dr1">(link?.release ?? "dr1"), [survey, setSurvey] = useState<"wide" | "deep">(link?.survey ?? "wide");
  const [detector, setDetector] = useState(link?.detector ?? 5);
  const [coverage, setCoverage] = useState<Coverage | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [progress, setProgress] = useState("");
  const [index, setIndex] = useState(0), [playing, setPlaying] = useState(false);
  const [referenceIndex, setReferenceIndex] = useState(0);
  const [background, setBackground] = useState('spherex'), [cubeIndex, setCubeIndex] = useState(1);
  const [backgroundStatus, setBackgroundStatus] = useState(''), [backgroundError, setBackgroundError] = useState('');
  const cubeLayer = useRef<SkyImage | null>(null), cubeIndexRef = useRef(cubeIndex);
  useEffect(() => { cubeIndexRef.current = cubeIndex; }, [cubeIndex]);
  const selected = coverage?.records[index];
  const polygon = parseSkyFootprint(selected?.s_region);

  useEffect(() => {
    let disposed = false;
    const container = host.current!;
    const timer = setTimeout(() => { if (!disposed) setMapError(t("The map is taking longer than expected to load. Check your connection or retry.")); }, 25000);
    loadAladin().then(api => {
      if (disposed) return;
      const viewer = api.aladin(container, {
        survey: SPHEREX_HIPS, target: initial.current?.coordinates?.join(" ") ?? "167.2 5.15", fov: initial.current?.fov ?? 180,
          projection: "SIN", cooFrame: "ICRS", showCooGrid: true, log: false,
        showLayersControl: false, showGotoControl: false, showShareControl: false,
        showProjectionControl: false, showZoomControl: false, showFullscreenControl: true,
        showSimbadPointerControl: false, showContextMenu: false, showSettingsControl: false,
        showCooGridControl: true,
      });
      const overlay = api.graphicOverlay({ name: "SPHEREx exposure footprint", color: "#77b1f4", lineWidth: 2 });
      viewer.addOverlay(overlay);
      viewer.on("positionChanged", p => { if (!disposed && Number.isFinite(p.ra) && Number.isFinite(p.dec)) setCenter([p.ra, p.dec]); });
      viewer.on("click", p => { if (!disposed && !p.isDragging && Number.isFinite(p.ra) && Number.isFinite(p.dec)) { viewer.gotoRaDec(p.ra, p.dec); setCenter([p.ra, p.dec]); } });
      engine.current = { viewer, api, overlay }; clearTimeout(timer); setMapError(""); setReady(true);
    }).catch(error => { if (!disposed) { console.error('Sky viewer initialization failed', error); clearTimeout(timer); setMapError(t("The sky globe could not start. It needs WebGL2 and a network connection. The exposure viewer below still works.")); } });
    return () => { disposed = true; clearTimeout(timer); engine.current = null; container.replaceChildren(); };
  }, [attempt]);
  useEffect(() => {
    const current = engine.current;
    if (!current || !ready) return;
    let active = true;
    cubeLayer.current = null;
    void Promise.resolve().then(() => { if(active){setBackgroundError('');setBackgroundStatus(t('Loading the selected sky survey…'));} });
    const timer = setTimeout(() => { if (active) { setBackgroundStatus(''); setBackgroundError(t('The sky survey is not responding. Choose another background or retry the map.')); } }, 25000);
    const layer = current.api.imageHiPS(background === 'spherex' ? SPHEREX_HIPS : DSS_HIPS, {
      successCallback: image => {
        if (!active) return;
        clearTimeout(timer);
        if (background === 'spherex') { cubeLayer.current = image; image.setFrequency({value:cubeRenderFrequency(cubeIndexRef.current, hipsMeta),unit:'Hz'}); }
        setBackgroundStatus(''); setBackgroundError('');
      },
      errorCallback: () => { if (active) { clearTimeout(timer); setBackgroundStatus(''); setBackgroundError(t('Could not load the selected background.')); } },
    });
    Promise.resolve(current.viewer.setBaseImageLayer(layer)).catch(() => {
      if (active) { clearTimeout(timer); setBackgroundStatus(''); setBackgroundError(t('Could not load the selected background.')); }
    });
    return () => { active = false; clearTimeout(timer); cubeLayer.current = null; };
  }, [background, ready]);
  useEffect(() => { cubeLayer.current?.setFrequency({value:cubeRenderFrequency(cubeIndex, hipsMeta),unit:'Hz'}); }, [cubeIndex]);
  useEffect(() => () => { request.current?.abort(); resolver.current?.abort(); }, []);
  useEffect(() => {
    if (collapsed || !playing || !coverage || coverage.records.length < 2) return;
    const timer = setInterval(() => setIndex(i => (i + 1) % coverage.records.length), 1000);
    return () => clearInterval(timer);
  }, [playing, coverage, collapsed]);
  useEffect(() => {
    const current = engine.current;
    if (!current || !ready) return;
    current.overlay.removeAll();
    const points = parseSkyFootprint(selected?.s_region);
    if (points) current.overlay.addFootprints([current.api.polygon(points)]);
    // Empty redraw also clears a previous footprint when the query returned no records.
    else current.overlay.addFootprints([]);
  }, [selected, ready]);

  const section = useRef<HTMLElement>(null);
  const centerListener = useRef(onCenterChange);
  useEffect(() => { centerListener.current = onCenterChange; }, [onCenterChange]);
  // Report the map centre to the exposure viewer, throttled so dragging stays smooth.
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => centerListener.current?.(center), 120);
    return () => clearTimeout(timer);
  }, [center, ready]);
  useImperativeHandle(controlRef, () => ({
    goto: (ra, dec, fov) => goto(ra, dec, fov),
    reveal: () => { setCollapsed(false); section.current?.scrollIntoView({ behavior: "smooth", block: "start" }); },
  }));
  function goto(ra: number, dec: number, fov?: number) {
    engine.current?.viewer.gotoRaDec(ra, dec); if (fov) engine.current?.viewer.setFoV(fov);
    setCenter([ra, dec]);
  }
  async function resolve(event: FormEvent) {
    event.preventDefault(); if (!target.trim()) return;
    resolver.current?.abort(); const controller = new AbortController(); resolver.current = controller;
    const coordinates = parseSkyCoordinates(target);
    if (coordinates) { goto(...coordinates, 8); setError(""); return; }
    if (!liveArchive) { setError(t("Type RA and Dec in degrees, e.g. 210.80, 54.35. Search by name needs the full (server) version.")); return; }
    setNameBusy(true); setError("");
    try {
      const response = await fetch(apiUrl(`/api/resolve?name=${encodeURIComponent(target.trim())}`), { signal: controller.signal });
      const body = await response.json() as { ra: number; dec: number; error?: string };
      if (!response.ok) throw Error(body.error || t("Name not found."));
      if (!parseSkyCoordinates(`${body.ra} ${body.dec}`)) throw Error(t("The name service returned invalid coordinates."));
      if (!controller.signal.aborted) goto(body.ra, body.dec, 8);
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : t("Could not find that object.")); }
    finally { if (!controller.signal.aborted) setNameBusy(false); }
  }
  function currentQuery(): SkySearchTarget {
    const [ra, dec] = engine.current?.viewer.getRaDec() ?? center;
    return { ra, dec, start, end, detector, release, survey };
  }
  async function searchCoverage(event?: FormEvent, coordinates?: [number, number]) {
    event?.preventDefault(); request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setError(""); setPlaying(false); setCoverage(null); setIndex(0);
    try {
      const query = currentQuery();
      if (coordinates) [query.ra, query.dec] = coordinates;
      validateFieldQuery({ ...query, fov: 0.12, max_frames: 60 });
      setBusy(true); setProgress(t("Looking for exposures that cover the map centre…"));
      const result = await collectCatalogueParts<SkyObservation, { records: SkyObservation[]; source_url: string; retrieved_at: string; error?: string }>({
        interval: { start, end }, movingObject: false,
        request: async interval => {
          const response = await fetch(apiUrl("/api/field"), { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
            body: JSON.stringify({ ...query, ...interval, fov: 0.12, max_frames: MAX_CATALOGUE_CHUNK_FRAMES }) });
          return { status: response.status, ok: response.ok, body: await response.json() as { records: SkyObservation[]; source_url: string; retrieved_at: string; error?: string } };
        }, onProgress: p => { if (!controller.signal.aborted) setProgress(p.detail); },
      });
      if (controller.signal.aborted) return;
      setCoverage({ query, records: result.records, sources: result.parts.map(p => p.body.source_url), retrieved: result.parts.at(-1)?.body.retrieved_at ?? "" });
      setReferenceIndex(Math.max(0,result.records.length-1));
      if (result.records.length) goto(query.ra, query.dec, 12);
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : t("The NASA archive didn't respond. Try again in a minute.")); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  useEffect(() => {
    if (!ready || !liveArchive || !initial.current?.search || autoStarted.current) return;
    autoStarted.current = true;
    void searchCoverage(undefined, initial.current.coordinates ?? undefined);
    // Launch only once, using the initial validated URL filters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  function useCurrent() {
    if (!manifest) return;
    goto(manifest.display.sky_center_ra, manifest.display.sky_center_dec, 8);
    setStart(manifest.query?.start ?? manifest.frames[0].date.slice(0, 10));
    setEnd(manifest.query?.end ?? manifest.frames.at(-1)!.date.slice(0, 10));
    setRelease(manifest.query?.release === "qr3" ? "qr3" : "dr1");
    setSurvey(manifest.query?.survey === "deep" ? "deep" : "wide");
    setDetector(manifest.query?.detector ?? (Number(manifest.frames[0].detector.replace(/\D/g, "")) || 5));
  }

  return <section ref={section} className="sky-atlas" aria-label={t("Sky globe")}>
    <div className="atlas-heading"><div><span className="section-label">{t("SKY MAP · STEP 1")}</span><h2><Globe2 size={25}/> {t("Sky globe")}</h2><p>{t("Move the sky to any spot, then ask the NASA archive when SPHEREx photographed it.")}</p></div><button className="button" onClick={() => setCollapsed(v => !v)} aria-expanded={!collapsed}>{collapsed ? t("Show map") : t("Hide map")}</button></div>
    <div hidden={collapsed}>
      <div className="atlas-layout"><aside className="atlas-controls">
        <form onSubmit={resolve}><label htmlFor="atlas-target">{!liveArchive ? t("Go to coordinates (RA, Dec)") : t("Go to an object or coordinates")}</label><div className="atlas-search"><input id="atlas-target" value={target} onChange={e => setTarget(e.target.value)} placeholder={!liveArchive ? "210.80227, 54.34895" : t("e.g. M101 or 210.80227, 54.34895")} disabled={!ready || nameBusy}/><button className="button" disabled={!ready || nameBusy || !target.trim()} aria-label={t("Go to this place on the globe")}>{nameBusy ? <LoaderCircle size={17} className="animate-spin"/> : <Search size={17}/>}</button></div></form>
        <p className="atlas-help">{t("Drag to move, scroll or use + / − to zoom, click a point to centre it. RA and Dec are sky coordinates in degrees, like longitude and latitude.")}</p>
        <label>{t("Sky background")}<select value={background} onChange={e => setBackground(e.target.value)} disabled={!ready}><option value="spherex">{t("SPHEREx DR1 · infrared mosaic")}</option><option value="dss">{t("DSS2 · visible-light survey")}</option></select></label>
        {background === 'spherex' && <label>{t("Mosaic wavelength channel")}<select value={cubeIndex} onChange={e => setCubeIndex(Number(e.target.value))}>{hipsMeta.wavelengths.map((wave,i) => <option key={i} value={i}>D{Math.floor(i/17)+1} · {t("channel {n}",{n:i%17+1})} · {wave.toFixed(3)} {t("µm")}{[50,51].includes(i) ? " · "+t("blank") : ""}</option>)}</select></label>}
        {backgroundStatus && <p role="status" className="atlas-help">{backgroundStatus}</p>}{backgroundError && <p role="alert" className="error-message">{backgroundError}</p>}
        {background === 'spherex' && [50,51].includes(cubeIndex) && <p className="atlas-help">{t("This channel is blank in the published IRSA mosaic. That does not mean the sky is empty there.")}</p>}
        <div className="atlas-coordinate"><span>{t("Map centre · ICRS")}</span><strong>RA {center[0].toFixed(5)}°<br/>Dec {center[1].toFixed(5)}°</strong></div>
        <button className="button" disabled={!ready || !manifest} onClick={useCurrent}><Crosshair size={15}/> {t("Go to the open series")}</button>
        <form onSubmit={searchCoverage} className="atlas-filters">
          <div className="atlas-pair"><label>{t("From · UTC")}<input type="date" required value={start} onChange={e => setStart(e.target.value)} disabled={busy}/></label><label>{t("To · UTC")}<input type="date" required value={end} min={start} onChange={e => setEnd(e.target.value)} disabled={busy}/></label></div>
          <div className="atlas-pair"><label>{t("Data release")}<select value={release} onChange={e => setRelease(e.target.value as "qr2" | "qr3" | "dr1")} disabled={busy}><option value="dr1">DR1</option><option value="qr3">QR3</option></select></label><label>{t("Survey")}<select value={survey} onChange={e => setSurvey(e.target.value as "wide" | "deep")} disabled={busy}><option value="wide">Wide</option><option value="deep">Deep</option></select></label></div>
          <label title={t("SPHEREx has six detectors, D1–D6; each sees a different range of infrared wavelengths.")}>{t("Detector")}<select value={detector} onChange={e => setDetector(Number(e.target.value))} disabled={busy}>{[1,2,3,4,5,6].map(d => <option key={d} value={d}>D{d}</option>)}</select></label>
          <button className="button atlas-primary" disabled={!liveArchive || !ready || busy || nameBusy}>{busy ? <LoaderCircle size={16} className="animate-spin"/> : <Search size={16}/>} {busy ? t("Checking the archive…") : t("When did SPHEREx see the centre?")}</button>{!liveArchive && <p className="atlas-help">{t("Archive search is available in the full (server) version. This demo shows the sky map and two ready-made examples.")}</p>}
        </form>
        {busy && <><p role="status" className="atlas-help">{msg(progress)}</p><button className="button" onClick={() => { request.current?.abort(); setBusy(false); setProgress(""); }}>{t("Cancel search")}</button></>}
        {link?.invalidCoordinates && <p role="status">{t("The link had invalid coordinates, so the default field is shown.")}</p>}
        {error && <p className="error-message" role="alert">{msg(error)}</p>}
      </aside><div className="atlas-map-column"><div className="atlas-map-wrap">
        <div className="atlas-crosshair" aria-hidden="true">+</div><div ref={host} className="atlas-canvas" aria-label={t("Interactive sky map with SPHEREx footprints")}/>
        {!ready && !mapError && <p className="atlas-loading" role="status">{t("Loading the sky globe…")}</p>}
        {mapError && <div className="atlas-loading" role="alert"><p>{mapError}</p><button className="button" onClick={() => { setReady(false); setMapError(""); setAttempt(n => n + 1); }}>{t("Retry map")}</button></div>}
        {ready && <div className="atlas-map-tools"><button className="button" aria-label={t("Zoom in")} onClick={() => engine.current!.viewer.setFoV(Math.max(0.03, engine.current!.viewer.getFov()[0] / 2))}><Plus size={17}/></button><button className="button" aria-label={t("Zoom out")} onClick={() => engine.current!.viewer.setFoV(Math.min(180, engine.current!.viewer.getFov()[0] * 2))}><Minus size={17}/></button><button className="button" onClick={() => engine.current!.viewer.setFoV(180)}>{t("Zoom out fully")}</button></div>}
      </div><p className="atlas-credit">{background === 'spherex' ? <>{t("Background:")} <a href={SPHEREX_HIPS} target="_blank" rel="noreferrer">SPHEREx DR1 / NASA · Caltech/IPAC</a>, {t("overview mosaic")} · {hipsMeta.wavelengths[cubeIndex].toFixed(3)} {t("µm")}. {t("The mosaic combines different dates and is for browsing, not for measurements.")}</> : <>{t("Background:")} <a href={DSS_HIPS} target="_blank" rel="noreferrer">DSS2 / STScI · CDS · ESA HiPS</a>, {t("a visible-light survey from various dates.")}</>} {t("The time slider moves the exposure outline, not the background picture. The globe shows directions only, not distances to stars.")}</p>
      <div className="atlas-results" aria-live="polite">
        {!coverage && <p>{t("Ask the archive about the map centre to see the outline and time of each exposure. No outline yet just means you haven't searched.")}</p>}
        {coverage && <><div className="atlas-result-heading"><strong>{t("{n} exposures",{n:coverage.records.length})} · {coverage.query.release.toUpperCase()} {coverage.query.survey} · D{coverage.query.detector}</strong><button className="button" onClick={() => goto(coverage.query.ra, coverage.query.dec, 12)}>{t("Go to the searched spot")}</button></div><p className="atlas-help">{t("For RA {ra}°, Dec {dec}° · {start}–{end} UTC. This covers the chosen point only, not the whole mission map.",{ra:coverage.query.ra.toFixed(5),dec:coverage.query.dec.toFixed(5),start:coverage.query.start,end:coverage.query.end})}</p>
          {!selected && <p>{t("No exposures match these settings. Try a longer date range, another detector or another spot.")}</p>}
          {selected && <><div className="atlas-timeline"><button className="button" aria-label={playing ? t("Pause the exposure sequence") : t("Play the exposure sequence")} disabled={coverage.records.length < 2} onClick={() => setPlaying(v => !v)}>{playing ? <Pause size={17}/> : <Play size={17}/>}</button><input aria-label={t("Exposure time on the globe")} type="range" min="0" max="1000" value={Math.round(frameTimeFraction(coverage.records, index) * 1000)} disabled={coverage.records.length < 2} onChange={e => { setPlaying(false); setIndex(nearestFrameIndexAtFraction(coverage.records, Number(e.target.value) / 1000)); }}/><span>{index + 1} / {coverage.records.length}</span></div><div className="atlas-exposure"><label>{t("Exposure")}<select value={index} onChange={e => { setPlaying(false); setIndex(Number(e.target.value)); }}>{coverage.records.map((r, i) => <option key={r.id} value={i}>{i + 1} · {skyObservationDate(r).replace("T", " ").slice(0, 19)} UTC</option>)}</select></label><a href={selected.url} target="_blank" rel="noreferrer">{t("Original FITS file ↗")}</a></div><p className="atlas-help">{polygon ? t("The blue outline is the area the selected exposure covers (from IRSA). Pixel quality is checked separately.") : t("No supported ICRS outline is available for this exposure, so none is drawn.")} {t("Playback shows one exposure per second, whatever the real time gaps.")}</p><label>{t("Compare with exposure")}<select value={referenceIndex} onChange={e => setReferenceIndex(Number(e.target.value))}>{coverage.records.map((r,i)=><option key={r.id} value={i}>{i+1} · {skyObservationDate(r).replace("T"," ").slice(0,19)} UTC</option>)}</select></label><button className="button atlas-primary" disabled={coverage.records.length<2 || index===referenceIndex} onClick={() => { setPlaying(false); onSearch({...coverage.query,comparisonUrls:[selected.url,coverage.records[referenceIndex].url]}); }}><ArrowDown size={16}/> {t("Open these two exposures side by side")}</button><p className="atlas-help">{t("We download the two chosen exposures and show them next to each other below. Measurements use the individual FITS files, not the background mosaic.")}</p></>}
          <details><summary>{t("Catalogue sources")}</summary><p>{t("Retrieved: {time}",{time:coverage.retrieved})}</p>{coverage.sources.map((source, i) => <a key={source} href={source} target="_blank" rel="noreferrer">{t("IRSA query {n} ↗",{n:i + 1})} </a>)}</details>
        </>}
      </div></div></div>
      <div className="atlas-bottom"><span>{t("1 Find a spot on the sky → 2 Watch its exposures change → 3 Judge what moved")}</span><button className="button" onClick={onCurrentSeries}><ArrowDown size={16}/> {t("Go to the exposure viewer")}</button></div>
    </div>
  </section>;
}
