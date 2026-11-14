import { openDisplayDatabase } from "./frame-assets.ts";
import type { Manifest } from "./science.ts";
import { manifestSeriesIds, validateSavedSession, validateSessionManifest, validateSessionView, validateSessionViewShape, type SavedSession, type SessionSummary, type SessionView } from "./session-model.ts";
export type { SavedSession, SessionSummary, SessionView } from "./session-model.ts";

const requestValue = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error ?? Error("Не вдалося прочитати локальну сесію.")); });
const completed = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = transaction.onabort = () => reject(transaction.error?.name === "QuotaExceededError" ? Error("Недостатньо місця у сховищі браузера. Експортуйте й видаліть непотрібні сесії.") : transaction.error ?? Error("Запис локальної сесії перервано.")); });
const viewKey = (id: string) => `session-view:${id}`;
type ViewRecord = {key: string; view: SessionView; updated_at: string};
function applyView(session: SavedSession, record?: ViewRecord): SavedSession {
  if (!record) return session;
  if (!Number.isFinite(Date.parse(record.updated_at))) throw Error("Некоректний час збереження стану перегляду.");
  return {...session, view: validateSessionView(record.view, session.manifest), updated_at: record.updated_at};
}

export async function saveSession(manifestValue: Manifest, viewValue: SessionView, id = crypto.randomUUID(), importJobId?: string): Promise<SavedSession> {
  const manifest = validateSessionManifest(manifestValue), view = validateSessionView(viewValue, manifest);
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("Некоректний ідентифікатор сесії.");
  const db = await openDisplayDatabase();
  const transaction = db.transaction(["sessions", "meta", "jobs"], "readwrite"), done = completed(transaction);
  const sessions = transaction.objectStore("sessions");
  const now = new Date().toISOString();
  let saved: SavedSession;
  const previous = sessions.get(id);
  previous.onsuccess = () => {
    saved = {id, title: manifest.title, manifest, view, created_at: previous.result?.created_at ?? now, updated_at: now, asset_series_ids: manifestSeriesIds(manifest)};
    sessions.put(saved); transaction.objectStore("meta").put({key: "activeSession", value: id});
    transaction.objectStore("meta").delete(viewKey(id));
    if (importJobId) transaction.objectStore("jobs").delete(importJobId);
  };
  await done;
  return saved!;
}

export async function loadSession(id: string): Promise<SavedSession> {
  const db = await openDisplayDatabase();
  const reader = db.transaction(["sessions", "meta"], "readonly"), readDone = completed(reader);
  const [saved, view] = await Promise.all([requestValue(reader.objectStore("sessions").get(id)), requestValue(reader.objectStore("meta").get(viewKey(id))), readDone]);
  const session = applyView(validateSavedSession(saved), view);
  const transaction = db.transaction("meta", "readwrite"), done = completed(transaction);
  transaction.objectStore("meta").put({key: "activeSession", value: id}); await done;
  return session;
}

export async function restoreActiveSession(): Promise<SavedSession | null> {
  const db = await openDisplayDatabase();
  const active = await requestValue(db.transaction("meta", "readonly").objectStore("meta").get("activeSession"));
  return active?.value ? loadSession(active.value) : null;
}

export async function updateSessionView(id: string, view: SessionView): Promise<void> {
  const safeView = validateSessionViewShape(view);
  const db = await openDisplayDatabase();
  const transaction = db.transaction(["sessions", "meta"], "readwrite"), done = completed(transaction);
  // Count only checks existence; it never clones a potentially large manifest.
  // Frame membership is checked against that manifest when the session is loaded.
  const request = transaction.objectStore("sessions").count(id);
  request.onsuccess = () => {
    if (!request.result) return;
    transaction.objectStore("meta").put({key: viewKey(id), view: safeView, updated_at: new Date().toISOString()});
  };
  await done;
}

export async function listSessions(): Promise<SessionSummary[]> {
  const db = await openDisplayDatabase();
  return new Promise((resolve,reject) => {
    const summaries: SessionSummary[] = [], transaction = db.transaction(["sessions", "meta"],"readonly"), request = transaction.objectStore("sessions").openCursor();
    transaction.onabort = () => reject(transaction.error ?? Error("Читання бібліотеки перервано."));
    request.onerror = () => reject(request.error ?? Error("Не вдалося прочитати бібліотеку."));
    request.onsuccess = () => {
      const row = request.result; if(!row){resolve(summaries.sort((a,b)=>b.updated_at.localeCompare(a.updated_at)));return;}
      try {
        const session=validateSavedSession(row.value), view=transaction.objectStore("meta").get(viewKey(session.id));
        view.onerror=()=>reject(view.error);
        view.onsuccess=()=>{try {const {manifest,...summary}=applyView(session,view.result);summaries.push({...summary,frame_count:manifest.frames.length});row.continue();}catch(error){reject(error);}};
      }
      catch(error){reject(error);}
    };
  });
}

/** The same transaction protects every saved session and every resumable job while deleting unreferenced PNGs. */
export async function cleanupOrphanAssets(): Promise<{deleted: number; bytes: number}> {
  const db = await openDisplayDatabase();
  // A Web Lock spans each supported import. A lock-free import entry is abandoned;
  // browsers without Web Locks keep it protected rather than guessing from time.
  if (navigator.locks) {
    const importIds: string[] = [];
    const reader = db.transaction("jobs","readonly"), readDone = completed(reader), cursor = reader.objectStore("jobs").openCursor();
    cursor.onsuccess = () => { const row=cursor.result;if(!row)return;if(row.value.phase==="import"&&row.value.web_lock===true)importIds.push(String(row.key));row.continue(); };
    await readDone;
    for (const id of importIds) await navigator.locks.request(`spherex-import-${id}`,{ifAvailable:true},async lock=>{
      if(!lock)return;
      const transaction=db.transaction("jobs","readwrite"), done=completed(transaction), store=transaction.objectStore("jobs"), request=store.get(id);
      request.onsuccess=()=>{if(request.result?.phase==="import")store.delete(id);};await done;
    });
  }
  const transaction = db.transaction(["png", "sessions", "jobs"], "readwrite"), done = completed(transaction);
  const protectedIds = new Set<string>(); let pending = 2, deleted = 0, bytes = 0;
  const scan = () => {
    if (--pending !== 0) return;
    const cursor = transaction.objectStore("png").openCursor();
    cursor.onsuccess = () => { const row = cursor.result; if (!row) return; const series = String(row.key).split(":")[0]; if (!protectedIds.has(series)) { deleted++; bytes += Number(row.value.byte_length) || 0; row.delete(); } row.continue(); };
  };
  const sessions = transaction.objectStore("sessions").openCursor();
  sessions.onsuccess = () => { const row=sessions.result;if(!row){scan();return;}try {for(const series of manifestSeriesIds(row.value.manifest))protectedIds.add(series);row.continue();}catch{transaction.abort();} };
  const jobs = transaction.objectStore("jobs").openCursor();
  jobs.onsuccess = () => { const row=jobs.result;if(!row){scan();return;}if(typeof row.value.series_id==="string")protectedIds.add(row.value.series_id);row.continue(); };
  await done; return {deleted, bytes};
}

export async function deleteSession(id: string): Promise<void> {
  const db = await openDisplayDatabase();
  const transaction = db.transaction(["sessions", "meta"], "readwrite"), done = completed(transaction);
  transaction.objectStore("sessions").delete(id);
  const meta = transaction.objectStore("meta"), active = meta.get("activeSession");
  meta.delete(viewKey(id));
  active.onsuccess = () => { if (active.result?.value === id) meta.delete("activeSession"); };
  await done; await cleanupOrphanAssets();
}

export async function storageSummary(): Promise<{pngBytes: number; pngCount: number; usage?: number; quota?: number}> {
  const db = await openDisplayDatabase(); let pngBytes = 0, pngCount = 0;
  const transaction = db.transaction("png", "readonly"), done = completed(transaction), request = transaction.objectStore("png").openCursor();
  request.onsuccess = () => { const row = request.result; if (!row) return; pngCount++; pngBytes += Number(row.value.byte_length) || 0; row.continue(); };
  await done;
  const estimate = await navigator.storage?.estimate?.().catch(() => ({})) ?? {};
  return {pngBytes, pngCount, ...estimate};
}
