import { assertProcessingCheckpoint, estimateRemainingPngBytes } from "./processing-state.mjs";
let apiOrigin = "";
const scienceAsset = path => self.location ? new URL(path, self.location.href).href : "/science/" + path;
// Pinned scientific runtime; numerical processing stays off the interface thread.
const RUNTIME = "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/";
const CACHE_NAME = "spherex-fits-0.3";
const ASSET_DB = "spherex-time-lab-display-assets";
let runtimePromise;
const progress = (stage, completed, total, detail, extra = {}) => self.postMessage({ type: "progress", stage, completed, total, detail, ...extra });
const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
function isScientificDataError(error) {
  // Only recognized Python FITS/WCS/data exceptions reject a record. Worker,
  // memory, JSON bridge and unknown Python failures must pause the calculation.
  if (error?.name !== "PythonError") return false;
  const kind = String(error.message || "").trim().match(/(?:^|\n)([A-Za-z_][\w.]*):[^\n]*$/)?.[1]?.split(".").at(-1);
  return ["ValueError", "KeyError", "OSError", "EOFError", "UnitConversionError", "UnitTypeError", "InconsistentAxisTypesError", "InvalidTransformError", "SingularMatrixError", "NoConvergence"].includes(kind);
}
function validateAnalysisResult(result, record, query, withFrame) {
  if (!result || typeof result.included !== "boolean" || (!result.included && (typeof result.reason !== "string" || !result.reason.trim()))) {
    throw Error("Обчислювальний модуль повернув некоректний результат перевірки кадру. Контрольну точку збережено.");
  }
  if (result.included && withFrame && (result.frame?.id !== record.observation + "D" + query.detector || !Number.isFinite(result.frame?.mjd) || !/^[a-f0-9]{64}$/.test(result.frame?.sha256_cutout || ""))) {
    throw Error("Результат перевірки не містить узгодженої ідентичності FITS. Контрольну точку збережено.");
  }
  return result;
}
async function runtime() {
  if (!runtimePromise) runtimePromise = (async () => {
    const { loadPyodide } = await import(RUNTIME + "pyodide.mjs");
    const py = await loadPyodide({ indexURL: RUNTIME });
    await py.loadPackage(["astropy", "scipy", "pillow"]);
    const response = await fetch(scienceAsset("field_pipeline.py"));
    if (!response.ok) throw Error("Не вдалося завантажити метод обробки.");
    const source = await response.text();
    const code_sha256 = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)));
    await py.runPythonAsync(source);
    return { py, code_sha256 };
  })().catch(error => { runtimePromise = null; throw error; });
  return runtimePromise;
}
async function getCutout(url) {
  let cache = null;
  try { cache = await caches.open(CACHE_NAME); } catch { /* Caching is optional. */ }
  if (cache) {
    const hit = await cache.match(url);
    if (hit && Date.now() - Date.parse(hit.headers.get("X-Retrieved-At") || "") < 86400000) return hit;
  }
  let response, failure;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(95000) });
      if (response.ok) break;
      const body = await response.clone().json().catch(() => null);
      failure = Error(body?.error || "Не вдалося отримати FITS-вирізку (HTTP " + response.status + ").");
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) { failure = error; }
    if (attempt < 2) {
      progress("network", attempt + 1, 3, "З’єднання перервано; повторюємо завантаження FITS. Контрольна точка збережена.");
      await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 1000));
    }
  }
  if (!response?.ok) throw Error("Завантаження FITS не завершено. Продовжіть обчислення після відновлення доступу до архіву. " + (failure?.message || ""));
  if (cache) try {
    await cache.put(url, response.clone());
    const keys = await cache.keys();
    for (const key of keys.slice(0, Math.max(0, keys.length - 60))) await cache.delete(key);
  } catch { /* Optional cache must not prevent processing. */ }
  return response;
}
function openAssetDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ASSET_DB, 3);
    request.onupgradeneeded = () => {
      for (const name of ["png", "sessions", "jobs", "meta"]) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: name === "meta" ? "key" : "id" });
    };
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = () => reject(request.error || Error("Не вдалося відкрити локальне сховище зображень."));
    request.onblocked = () => reject(Error("Оновлення сховища заблоковано іншою вкладкою. Закрийте старі вкладки SPHEREx і повторіть."));
  });
}
async function readCheckpoint(id) {
  const db = await openAssetDb();
  try { return await new Promise((resolve, reject) => {
    const request = db.transaction("jobs", "readonly").objectStore("jobs").get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || Error("Не вдалося прочитати контрольну точку."));
  }); } finally { db.close(); }
}
async function saveCheckpoint(checkpoint, assets = []) {
  checkpoint.heartbeat_at = new Date().toISOString();
  const db = await openAssetDb();
  try { await new Promise((resolve, reject) => {
    // The checkpoint and PNGs commit together, so interrupted writes cannot leave dangling frame references.
    const transaction = db.transaction(assets.length ? ["jobs", "png"] : ["jobs"], "readwrite");
    for (const entry of assets) transaction.objectStore("png").put({ id: entry.id, sha256: entry.sha256, blob: entry.blob, byte_length: entry.byteLength, stored_at: checkpoint.heartbeat_at });
    transaction.objectStore("jobs").put(checkpoint);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || Error("Не вдалося зберегти контрольну точку."));
    transaction.onabort = () => reject(transaction.error || Error("Сховище перервало запис контрольної точки."));
  }); } catch (error) {
    if (error?.name === "QuotaExceededError") throw Error("У браузері закінчилося місце. Попередня контрольна точка збережена. Видаліть непотрібні серії в бібліотеці та продовжіть обчислення.");
    throw error;
  } finally { db.close(); }
}
async function prepareFrameAssets(assets, seriesId) {
  const entries = [];
  for (const [name, uri] of Object.entries(assets)) {
    const blob = await (await fetch(uri)).blob();
    if (blob.type !== "image/png") throw Error("Обчислювальний модуль повернув зображення не у форматі PNG.");
    const bytes = await blob.arrayBuffer(), sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
    entries.push({ name, sha256, id: seriesId + ":" + sha256, blob, byteLength: bytes.byteLength });
  }
  return entries;
}
async function verifyStoredFrames(checkpoint) {
  const db = await openAssetDb();
  try {
    for (let index = 0; index < checkpoint.frames.length; index++) {
      for (const digest of Object.values(checkpoint.frames[index].display_asset_sha256)) {
        const row = await new Promise((resolve, reject) => {
          const request = db.transaction("png", "readonly").objectStore("png").get(checkpoint.id + ":" + digest);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        if (!(row?.blob instanceof Blob) || row.blob.type !== "image/png" || hex(await crypto.subtle.digest("SHA-256", await row.blob.arrayBuffer())) !== digest) {
          checkpoint.frames = checkpoint.frames.slice(0, index);
          checkpoint.stored_png_bytes = 0;
          await saveCheckpoint(checkpoint);
          return;
        }
      }
      if (index % 16 === 0) progress("restore", index + 1, checkpoint.frames.length, "Перевіряємо контрольні суми вже збережених PNG…");
    }
  } finally { db.close(); }
}
async function storageEstimate(checkpoint) {
  if (!navigator.storage?.estimate) return null;
  const estimate = await navigator.storage.estimate().catch(() => null);
  if (!estimate || !Number.isFinite(estimate.quota) || !Number.isFinite(estimate.usage)) return null;
  return { free_bytes: Math.max(0, estimate.quota - estimate.usage), usage_bytes: estimate.usage,
    estimated_remaining_bytes: estimateRemainingPngBytes(checkpoint.stored_png_bytes || 0, checkpoint.frames.length, checkpoint.accepted.length) };
}
async function fetchFits(py, record, query) {
  const url = apiOrigin + "/api/cutout?" + new URLSearchParams({ url: record.url, ra: String(query.ra), dec: String(query.dec), cutout_ra: String(record.target_ra ?? query.ra), cutout_dec: String(record.target_dec ?? query.dec), fov: String(query.fov), release: query.release, survey: query.survey });
  const response = await getCutout(url);
  py.FS.writeFile("/frame.fits", new Uint8Array(await response.arrayBuffer()));
  return { source_url: response.headers.get("X-Source-URL"), retrieved_at: response.headers.get("X-Retrieved-At") };
}
const unlinkFits = py => { try { py.FS.unlink("/frame.fits"); } catch { /* File may not exist. */ } };
async function runStreamed(checkpoint, py, codeSha256) {
  const { catalogue } = checkpoint, total = catalogue.records.length;
  py.globals.set("query_json", JSON.stringify(catalogue.query));
  if (checkpoint.phase === "analyze") {
    if (checkpoint.stream_state) {
      py.globals.set("stream_state_json", JSON.stringify(checkpoint.stream_state));
      await py.runPythonAsync("restore_stream_state(stream_state_json)");
    } else py.runPython("reset_stream()");
    for (let i = checkpoint.next_index; i < total; i++) {
      const record = { ...catalogue.records[i] };
      progress("analyze", i, total, "Перевірка " + (i + 1) + " із " + total + ": FITS, WCS і межі спільної шкали");
      // A failed fetch pauses the job; network outages are never scientific rejections.
      const source = await fetchFits(py, record, catalogue.query);
      record.cutout_url = source.source_url; record.retrieved_at = source.retrieved_at;
      try {
        py.globals.set("record_json", JSON.stringify(record));
        const result = validateAnalysisResult(JSON.parse(await py.runPythonAsync('add_stream_frame("/frame.fits", record_json, query_json)')), record, catalogue.query, true);
        if (result.included) checkpoint.accepted.push({ record, frame: result.frame });
        else checkpoint.excluded.push({ id: record.id, reason: result.reason });
      } catch (error) {
        if (!isScientificDataError(error)) throw error;
        checkpoint.excluded.push({ id: record.id, reason: String(error.message || error).slice(-1200) });
      }
      finally { unlinkFits(py); }
      checkpoint.next_index = i + 1;
      checkpoint.stream_state = JSON.parse(await py.runPythonAsync("export_stream_state()"));
      await saveCheckpoint(checkpoint);
      progress("analyze", i + 1, total, "Перевірено " + (i + 1) + " із " + total + "; придатних " + checkpoint.accepted.length + ", відхилено " + checkpoint.excluded.length);
    }
    if (checkpoint.accepted.length < 2) throw Error("Після перевірки залишилося кадрів: " + checkpoint.accepted.length + ". Для часової серії потрібно щонайменше два.");
    checkpoint.scale = JSON.parse(await py.runPythonAsync("json.dumps(stream_scale_limits(), allow_nan=False)"));
    checkpoint.phase = "render"; delete checkpoint.stream_state;
    await saveCheckpoint(checkpoint);
  }
  await verifyStoredFrames(checkpoint);
  let storage = await storageEstimate(checkpoint);
  for (let i = checkpoint.frames.length; i < checkpoint.accepted.length; i++) {
    const { record, frame } = checkpoint.accepted[i];
    progress("render", i, checkpoint.accepted.length, "Повторна перевірка й рендер кадру " + (i + 1) + " із " + checkpoint.accepted.length, { storage });
    const source = await fetchFits(py, record, catalogue.query);
    record.cutout_url = source.source_url; record.retrieved_at = source.retrieved_at;
    py.globals.set("record_json", JSON.stringify(record));
    py.globals.set("scale_json", JSON.stringify(checkpoint.scale));
    let rendered;
    try { rendered = JSON.parse(await py.runPythonAsync('render_stream_frame("/frame.fits", record_json, query_json, scale_json)')); }
    finally { unlinkFits(py); }
    if (rendered.frame.id !== frame.id || rendered.frame.sha256_cutout !== frame.sha256_cutout || rendered.frame.mjd !== frame.mjd) throw Error("Архівний FITS " + record.id + " змінився між проходами. Цю контрольну точку не можна продовжити; підготуйте нову серію.");
    const entries = await prepareFrameAssets(rendered.assets, checkpoint.id);
    const references = Object.fromEntries(entries.map(entry => [entry.name, "idb:" + entry.id]));
    checkpoint.frames.push({ ...frame, ...references, display_asset_sha256: Object.fromEntries(entries.map(entry => [entry.name, entry.sha256])) });
    checkpoint.stored_png_bytes = (checkpoint.stored_png_bytes || 0) + entries.reduce((sum, entry) => sum + entry.byteLength, 0);
    await saveCheckpoint(checkpoint, entries);
    if (i % 16 === 0 || i + 1 === checkpoint.accepted.length) storage = await storageEstimate(checkpoint);
    progress("render", i + 1, checkpoint.accepted.length, "Збережено " + (i + 1) + " із " + checkpoint.accepted.length + " зображень локально", { storage });
  }
  py.globals.set("catalogue_json", JSON.stringify(catalogue));
  py.globals.set("frames_json", JSON.stringify(checkpoint.frames));
  py.globals.set("excluded_json", JSON.stringify(checkpoint.excluded));
  py.globals.set("runtime_json", JSON.stringify({ pyodide: py.version, method_sha256: codeSha256, runtime_url: RUNTIME }));
  py.globals.set("scale_json", JSON.stringify(checkpoint.scale));
  return JSON.parse(await py.runPythonAsync("json.dumps(finish_stream(catalogue_json, frames_json, excluded_json, runtime_json, scale_json), ensure_ascii=False, allow_nan=False)"));
}
async function runLegacy(checkpoint, py, codeSha256) {
  const { catalogue } = checkpoint, total = catalogue.records.length;
  // Small-series exact percentile arrays live only in Python RAM; resume restarts this pass.
  checkpoint.excluded = []; checkpoint.next_index = 0;
  py.runPython("reset_series()");
  py.globals.set("query_json", JSON.stringify(catalogue.query));
  for (let i = 0; i < total; i++) {
    const record = { ...catalogue.records[i] };
    progress("frames", i, total, "Кадр " + (i + 1) + " із " + total + ": завантаження та перевірка");
    const source = await fetchFits(py, record, catalogue.query);
    record.cutout_url = source.source_url; record.retrieved_at = source.retrieved_at;
    try {
      py.globals.set("record_json", JSON.stringify(record));
      const result = validateAnalysisResult(JSON.parse(await py.runPythonAsync('add_frame("/frame.fits", record_json, query_json)')), record, catalogue.query, false);
      if (!result.included) checkpoint.excluded.push({ id: record.id, reason: result.reason });
    } catch (error) {
      if (!isScientificDataError(error)) throw error;
      checkpoint.excluded.push({ id: record.id, reason: String(error.message || error).slice(-1200) });
    }
    finally { unlinkFits(py); }
    checkpoint.next_index = i + 1;
    await saveCheckpoint(checkpoint);
    progress("frames", i + 1, total, "Оброблено " + (i + 1) + " із " + total + "; відхилено " + checkpoint.excluded.length);
  }
  progress("render", total, total, "Спільна шкала яскравості та підготовка перегляду…");
  py.globals.set("catalogue_json", JSON.stringify(catalogue));
  py.globals.set("excluded_json", JSON.stringify(checkpoint.excluded));
  py.globals.set("runtime_json", JSON.stringify({ pyodide: py.version, method_sha256: codeSha256, runtime_url: RUNTIME }));
  return JSON.parse(await py.runPythonAsync("finish_series(catalogue_json, excluded_json, runtime_json)"));
}
async function build(data) {
  apiOrigin = data.apiOrigin || "";
  try {
    const checkpoint = data.type === "resume" ? await readCheckpoint(data.assetSeriesId) : {
      version: 1, id: data.assetSeriesId, series_id: data.assetSeriesId, catalogue: data.catalogue,
      phase: data.catalogue.records.length > 120 ? "analyze" : "legacy", accepted: [], excluded: [], frames: [], next_index: 0, method_sha256: null,
    };
    assertProcessingCheckpoint(checkpoint);
    if (checkpoint.phase === "complete" && checkpoint.manifest) {
      self.postMessage({ type: "complete", manifest: checkpoint.manifest, assetSeriesId: checkpoint.id }); return;
    }
    await saveCheckpoint(checkpoint);
    progress("runtime", 0, checkpoint.catalogue.records.length, "Завантаження обчислювального модуля…");
    const { py, code_sha256 } = await runtime();
    assertProcessingCheckpoint(checkpoint, code_sha256);
    checkpoint.method_sha256 = code_sha256; checkpoint.error = null;
    await saveCheckpoint(checkpoint);
    const manifest = checkpoint.phase === "legacy" ? await runLegacy(checkpoint, py, code_sha256) : await runStreamed(checkpoint, py, code_sha256);
    checkpoint.manifest = manifest;
    // Legacy accepted metadata lives in the final manifest, without IDB display refs.
    checkpoint.phase = "complete"; checkpoint.legacy_complete = checkpoint.catalogue.records.length <= 120;
    await saveCheckpoint(checkpoint);
    self.postMessage({ type: "complete", manifest, assetSeriesId: checkpoint.id });
  } catch (error) {
    // Reload last committed state: a failed quota transaction must not persist uncommitted in-memory progress.
    const persisted = await readCheckpoint(data.assetSeriesId).catch(() => null);
    if (persisted) { persisted.error = String(error.message || error).slice(-1800); await saveCheckpoint(persisted).catch(() => {}); }
    self.postMessage({ type: "error", error: String(error.message || error).slice(-1800), excluded: persisted?.excluded || [], resumable: Boolean(persisted), assetSeriesId: data.assetSeriesId });
  }
}
self.onmessage = async ({ data }) => {
  if (!["build", "resume"].includes(data?.type)) return;
  if (navigator.locks) await navigator.locks.request("spherex-processing-" + data.assetSeriesId, { ifAvailable: true }, async lock => {
    if (!lock) { self.postMessage({ type: "error", error: "Це обчислення вже працює в іншій вкладці.", resumable: true }); return; }
    await build(data);
  });
  else await build(data);
};
