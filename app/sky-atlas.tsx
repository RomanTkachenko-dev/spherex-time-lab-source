"use client";
import { useTranslation } from "@/lib/language";
import { apiUrl, liveArchive } from "@/lib/site-mode";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Globe2, Search, Crosshair, Plus, Minus, Pause, Play, ArrowDown, LoaderCircle } from "lucide-react";
import { loadAladin, type AladinApi, type SkyOverlay, type SkyViewer, type SkyImage } from "@/lib/aladin";
import hipsSnapshot from "@/lib/spherex-hips.json";
import { cubeMetadata, cubeRenderFrequency, SPHEREX_HIPS, DSS_HIPS } from "@/lib/hips";
import { readAtlasLink, parseSkyCoordinates, parseSkyFootprint, skyObservationDate, type SkyObservation, type SkySearchTarget } from "@/lib/sky-atlas";
import { collectCatalogueParts, MAX_CATALOGUE_CHUNK_FRAMES } from "@/lib/catalogue-batches";
import { validateFieldQuery } from "@/lib/field-query";
import { propagateProperMotion } from "@/lib/ephemeris";
import { frameTimeFraction, nearestFrameIndexAtFraction, type Manifest } from "@/lib/science";
import "./sky-atlas.css";

type Coverage = { query: SkySearchTarget; records: SkyObservation[]; sources: string[]; retrieved: string };
const hipsMeta = cubeMetadata(hipsSnapshot.properties);

export default function SkyAtlas({ manifest, onSearch, onCurrentSeries, link, language }: {
  language: "en" | "uk"; link?: ReturnType<typeof readAtlasLink>;
  manifest: Manifest | null; onSearch: (target: SkySearchTarget) => void; onCurrentSeries: () => void;
}) {
  const t = useTranslation();
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
    const timer = setTimeout(() => { if (!disposed) setMapError("Карта завантажується довше, ніж очікувалось. Перевірте з’єднання або повторіть запуск."); }, 25000);
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
      const overlay = api.graphicOverlay({ name: "Межа експозиції SPHEREx", color: "#c4f477", lineWidth: 2 });
      viewer.addOverlay(overlay);
      viewer.on("positionChanged", p => { if (!disposed && Number.isFinite(p.ra) && Number.isFinite(p.dec)) setCenter([p.ra, p.dec]); });
      viewer.on("click", p => { if (!disposed && !p.isDragging && Number.isFinite(p.ra) && Number.isFinite(p.dec)) { viewer.gotoRaDec(p.ra, p.dec); setCenter([p.ra, p.dec]); } });
      engine.current = { viewer, api, overlay }; clearTimeout(timer); setMapError(""); setReady(true);
    }).catch(error => { if (!disposed) { console.error('Sky viewer initialization failed', error); clearTimeout(timer); setMapError("Не вдалося відкрити небесну сферу. Потрібні WebGL2 і доступ до мережі. Переглядач кадрів нижче залишається доступним."); } });
    return () => { disposed = true; clearTimeout(timer); engine.current = null; container.replaceChildren(); };
  }, [attempt]);
  useEffect(() => {
    const current = engine.current;
    if (!current || !ready) return;
    let active = true;
    cubeLayer.current = null;
    void Promise.resolve().then(() => { if(active){setBackgroundError('');setBackgroundStatus('Завантаження вибраного огляду…');} });
    const timer = setTimeout(() => { if (active) { setBackgroundStatus(''); setBackgroundError('Огляд не відповідає. Змініть фон або повторіть запуск карти.'); } }, 25000);
    const layer = current.api.imageHiPS(background === 'spherex' ? SPHEREX_HIPS : DSS_HIPS, {
      successCallback: image => {
        if (!active) return;
        clearTimeout(timer);
        if (background === 'spherex') { cubeLayer.current = image; image.setFrequency({value:cubeRenderFrequency(cubeIndexRef.current, hipsMeta),unit:'Hz'}); }
        setBackgroundStatus(''); setBackgroundError('');
      },
      errorCallback: () => { if (active) { clearTimeout(timer); setBackgroundStatus(''); setBackgroundError('Не вдалося завантажити вибраний фон.'); } },
    });
    Promise.resolve(current.viewer.setBaseImageLayer(layer)).catch(() => {
      if (active) { clearTimeout(timer); setBackgroundStatus(''); setBackgroundError('Не вдалося завантажити вибраний фон.'); }
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

  function goto(ra: number, dec: number, fov?: number) {
    engine.current?.viewer.gotoRaDec(ra, dec); if (fov) engine.current?.viewer.setFoV(fov);
    setCenter([ra, dec]);
  }
  async function resolve(event: FormEvent) {
    event.preventDefault(); if (!target.trim()) return;
    resolver.current?.abort(); const controller = new AbortController(); resolver.current = controller;
    const coordinates = parseSkyCoordinates(target);
    if (coordinates) { goto(...coordinates, 8); setError(""); return; }
    if (!liveArchive) { setError("Введіть RA і Dec у градусах. Пошук за назвою потребує серверної версії."); return; }
    setNameBusy(true); setError("");
    try {
      const response = await fetch(apiUrl(`/api/resolve?name=${encodeURIComponent(target.trim())}`), { signal: controller.signal });
      const body = await response.json() as { ra: number; dec: number; error?: string; proper_motion?: { pm_ra_masyr: number; pm_dec_masyr: number; epoch_jyear: number } | null };
      if (!response.ok) throw Error(body.error || "Назву не знайдено.");
      if (!parseSkyCoordinates(`${body.ra} ${body.dec}`)) throw Error("Служба повернула некоректні координати.");
      // Catalogue positions are J2000: move high proper-motion stars to the first search date.
      const mjd = Date.parse(start + "T00:00:00Z") / 86400000 + 40587, motion = body.proper_motion;
      const now = motion && Number.isFinite(mjd) && [motion.pm_ra_masyr, motion.pm_dec_masyr, motion.epoch_jyear].every(Number.isFinite)
        ? propagateProperMotion({ ra: body.ra, dec: body.dec, ...motion }, mjd) : body;
      if (!controller.signal.aborted) goto(now.ra, now.dec, 8);
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Не вдалося знайти об’єкт."); }
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
      setBusy(true); setProgress("Шукаємо експозиції, що охоплюють центр карти…");
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
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Не вдалося перевірити архів."); }
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

  return <section className="sky-atlas" aria-label={t("Небесна сфера")}>
    <div className="atlas-heading"><div><span className="section-label">{t("ОГЛЯД НЕБА · ICRS")}</span><h2><Globe2 size={25}/> {t("Небесна сфера")}</h2><p>{t("Оберніть небо. Оберіть ділянку. Знайдіть її спостереження.")}</p></div><button className="button" onClick={() => setCollapsed(v => !v)} aria-expanded={!collapsed}>{collapsed ? t("Розгорнути карту") : t("Згорнути карту")}</button></div>
    <div hidden={collapsed}>
      <div className="atlas-layout"><aside className="atlas-controls">
        <form onSubmit={resolve}><label htmlFor="atlas-target">{!liveArchive ? t("Координати RA, Dec") : t("Об’єкт або координати")}</label><div className="atlas-search"><input id="atlas-target" value={target} onChange={e => setTarget(e.target.value)} placeholder={!liveArchive ? "210.80227, 54.34895" : "M101 або 210.80227, 54.34895"} disabled={!ready || nameBusy}/><button className="button" disabled={!ready || nameBusy || !target.trim()} aria-label={t("Знайти на сфері")}>{nameBusy ? <LoaderCircle size={17} className="animate-spin"/> : <Search size={17}/>}</button></div></form>
        <p className="atlas-help">{t("Перетягуйте небо для обертання, прокручуйте для масштабу. Натисніть на точку, щоб поставити її в центр.")}</p>
        <label>{t("Фон неба")}<select value={background} onChange={e => setBackground(e.target.value)} disabled={!ready}><option value="spherex">{t("SPHEREx DR1 · інфрачервона мозаїка")}</option><option value="dss">{t("DSS2 · оптичний огляд")}</option></select></label>
        {background === 'spherex' && <label>{t("Спектральний канал мозаїки")}<select value={cubeIndex} onChange={e => setCubeIndex(Number(e.target.value))}>{hipsMeta.wavelengths.map((wave,i) => <option key={i} value={i}>D{Math.floor(i/17)+1} · {language === "uk" ? "канал" : "channel"} {i%17+1} · {wave.toFixed(3)} {t("мкм")}{[50,51].includes(i) ? (language === "uk" ? " · порожній" : " · blank") : ""}</option>)}</select></label>}
        {backgroundStatus && <p role="status" className="atlas-help">{backgroundStatus}</p>}{backgroundError && <p role="alert" className="error-message">{backgroundError}</p>}
        {background === 'spherex' && [50,51].includes(cubeIndex) && <p className="atlas-help">{t("Цей канал порожній в опублікованій мозаїці IRSA. Це не відсутність об’єктів.")}</p>}
        <div className="atlas-coordinate"><span>{t("Центр карти · ICRS")}</span><strong>RA {center[0].toFixed(5)}°<br/>Dec {center[1].toFixed(5)}°</strong></div>
        <button className="button" disabled={!ready || !manifest} onClick={useCurrent}><Crosshair size={15}/> {t("Поле відкритої серії")}</button>
        <form onSubmit={searchCoverage} className="atlas-filters">
          <div className="atlas-pair"><label>{t("Від · UTC")}<input type="date" required value={start} onChange={e => setStart(e.target.value)} disabled={busy}/></label><label>{t("До · UTC")}<input type="date" required value={end} min={start} onChange={e => setEnd(e.target.value)} disabled={busy}/></label></div>
          <div className="atlas-pair"><label>{t("Реліз")}<select value={release} onChange={e => setRelease(e.target.value as "qr2" | "qr3" | "dr1")} disabled={busy}><option value="dr1">DR1</option><option value="qr3">QR3</option></select></label><label>{t("Огляд")}<select value={survey} onChange={e => setSurvey(e.target.value as "wide" | "deep")} disabled={busy}><option value="wide">Wide</option><option value="deep">Deep</option></select></label></div>
          <label>{t("Детектор")}<select value={detector} onChange={e => setDetector(Number(e.target.value))} disabled={busy}>{[1,2,3,4,5,6].map(d => <option key={d} value={d}>D{d}</option>)}</select></label>
          <button className="button atlas-primary" disabled={!liveArchive || !ready || busy || nameBusy}>{busy ? <LoaderCircle size={16} className="animate-spin"/> : <Search size={16}/>} {busy ? t("Перевіряємо архів…") : t("Покриття центра SPHEREx")}</button>
        </form>
        {busy && <><p role="status" className="atlas-help">{progress}</p><button className="button" onClick={() => { request.current?.abort(); setBusy(false); setProgress(""); }}>{t("Скасувати пошук")}</button></>}
        {link?.invalidCoordinates && <p role="status">{t("Некоректні координати в URL. Використано початкове поле.")}</p>}
        {error && <p className="error-message" role="alert">{error}</p>}
      </aside><div className="atlas-map-column"><div className="atlas-map-wrap">
        <div className="atlas-crosshair" aria-hidden="true">+</div><div ref={host} className="atlas-canvas" aria-label={t("Інтерактивна карта неба з контурами SPHEREx")}/>
        {!ready && !mapError && <p className="atlas-loading" role="status">{t("Завантаження небесної сфери…")}</p>}
        {mapError && <div className="atlas-loading" role="alert"><p>{mapError}</p><button className="button" onClick={() => { setReady(false); setMapError(""); setAttempt(n => n + 1); }}>{t("Повторити запуск карти")}</button></div>}
        {ready && <div className="atlas-map-tools"><button className="button" aria-label={t("Наблизити небо")} onClick={() => engine.current!.viewer.setFoV(Math.max(0.03, engine.current!.viewer.getFov()[0] / 2))}><Plus size={17}/></button><button className="button" aria-label={t("Віддалити небо")} onClick={() => engine.current!.viewer.setFoV(Math.min(180, engine.current!.viewer.getFov()[0] * 2))}><Minus size={17}/></button><button className="button" onClick={() => engine.current!.viewer.setFoV(180)}>{t("Півсфера")}</button></div>}
      </div><p className="atlas-credit">{background === 'spherex' ? <>Фон: <a href={SPHEREX_HIPS} target="_blank" rel="noreferrer">SPHEREx DR1 / NASA · Caltech/IPAC</a>, оглядова мозаїка · {hipsMeta.wavelengths[cubeIndex].toFixed(3)} мкм. Мозаїка об’єднує різні епохи й призначена для огляду, не для вимірювань.</> : <>Фон: <a href={DSS_HIPS} target="_blank" rel="noreferrer">DSS2 / STScI · CDS · ESA HiPS</a>, оптичний огляд різних епох.</>} Повзунок часу змінює контур експозиції, а не фонове зображення. Сфера показує напрямки без відстаней до зір.</p>
      <div className="atlas-results" aria-live="polite">
        {!coverage && <p>{t("Перевірте покриття центра карти, щоб побачити контур експозиції та її час. Відсутність контуру до запиту не означає відсутності спостережень.")}</p>}
        {coverage && <><div className="atlas-result-heading"><strong>{coverage.records.length} {language === "uk" ? "експозицій" : "exposures"} · {coverage.query.release.toUpperCase()} {coverage.query.survey} · D{coverage.query.detector}</strong><button className="button" onClick={() => goto(coverage.query.ra, coverage.query.dec, 12)}>{t("До знайденого поля")}</button></div><p className="atlas-help">Для RA {coverage.query.ra.toFixed(5)}°, Dec {coverage.query.dec.toFixed(5)}° · {coverage.query.start}—{coverage.query.end} UTC. Це покриття вибраної точки, не повна карта місії.</p>
          {!selected && <p>{t("За цими умовами каталог не повернув експозицій. Змініть період, детектор або ділянку.")}</p>}
          {selected && <><div className="atlas-timeline"><button className="button" aria-label={playing ? t("Зупинити часову послідовність") : t("Відтворити часову послідовність")} disabled={coverage.records.length < 2} onClick={() => setPlaying(v => !v)}>{playing ? <Pause size={17}/> : <Play size={17}/>}</button><input aria-label={t("Час експозицій на сфері")} type="range" min="0" max="1000" value={Math.round(frameTimeFraction(coverage.records, index) * 1000)} disabled={coverage.records.length < 2} onChange={e => { setPlaying(false); setIndex(nearestFrameIndexAtFraction(coverage.records, Number(e.target.value) / 1000)); }}/><span>{index + 1} / {coverage.records.length}</span></div><div className="atlas-exposure"><label>{t("Експозиція")}<select value={index} onChange={e => { setPlaying(false); setIndex(Number(e.target.value)); }}>{coverage.records.map((r, i) => <option key={r.id} value={i}>{i + 1} · {skyObservationDate(r).replace("T", " ").slice(0, 19)} UTC</option>)}</select></label><a href={selected.url} target="_blank" rel="noreferrer">{t("Вихідний FITS ↗")}</a></div><p className="atlas-help">{polygon ? t("Зелений контур — геометрична межа вибраної експозиції з IRSA; придатність пікселів перевіряється окремо.") : t("Для цієї експозиції немає підтримуваного контуру ICRS. Межі не домальовуються.")} Анімація змінює експозиції щосекунди, незалежно від реальних проміжків.</p><label>{t("Порівняти з експозицією")}<select value={referenceIndex} onChange={e => setReferenceIndex(Number(e.target.value))}>{coverage.records.map((r,i)=><option key={r.id} value={i}>{i+1} · {skyObservationDate(r).replace("T"," ").slice(0,19)} UTC</option>)}</select></label><button className="button atlas-primary" disabled={coverage.records.length<2 || index===referenceIndex} onClick={() => { setPlaying(false); onSearch({...coverage.query,comparisonUrls:[selected.url,coverage.records[referenceIndex].url]}); }}><ArrowDown size={16}/> {t("Відкрити порівняння реальних кадрів")}</button><p className="atlas-help">{t("Завантажимо два вибрані кадри та відкриємо їх поруч. Вимірювання виконуються на окремих FITS, не на фоновій мозаїці.")}</p></>}
          <details><summary>{t("Джерела каталогу")}</summary><p>Отримано: {coverage.retrieved}</p>{coverage.sources.map((source, i) => <a key={source} href={source} target="_blank" rel="noreferrer">Запит IRSA {i + 1} ↗ </a>)}</details>
        </>}
      </div></div></div>
      <div className="atlas-bottom"><span>{t("Сферична навігація → експозиції → вимірювання")}</span><button className="button" onClick={onCurrentSeries}><ArrowDown size={16}/> {t("До відкритої часової серії")}</button></div>
    </div>
  </section>;
}
