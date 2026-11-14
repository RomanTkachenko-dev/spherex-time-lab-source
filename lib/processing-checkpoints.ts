import { openDisplayDatabase } from "./frame-assets";

export type ProcessingCheckpointSummary = {
  id: string; phase: "analyze" | "render" | "complete" | "legacy"; updatedAt: string;
  total: number; analyzed: number; rendered: number; release: string; survey: string;
  detector: number; start: string; end: string; ra: number; dec: number; error: string | null;
};

export async function listProcessingCheckpoints(): Promise<ProcessingCheckpointSummary[]> {
  const db = await openDisplayDatabase();
  return new Promise((resolve, reject) => {
    const results: ProcessingCheckpointSummary[] = [];
    const request = db.transaction("jobs", "readonly").objectStore("jobs").openCursor();
    request.onerror = () => reject(request.error ?? Error("Не вдалося прочитати незавершені обчислення."));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { resolve(results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))); return; }
      const value = cursor.value;
      if (value.version === 1 && ["analyze", "render", "complete", "legacy"].includes(value.phase) && value.catalogue?.query) {
        const query = value.catalogue.query;
        results.push({ id: value.id, phase: value.phase, updatedAt: value.heartbeat_at, total: value.catalogue.records.length,
          analyzed: value.next_index ?? 0, rendered: value.frames?.length ?? 0, release: query.release,
          survey: query.survey, detector: query.detector, start: query.start, end: query.end, ra: query.ra, dec: query.dec,
          error: typeof value.error === "string" ? value.error : null });
      }
      cursor.continue();
    };
  });
}

/** Call only after the completed manifest has been durably saved as a session. */
export async function completeProcessingCheckpoint(id: string): Promise<void> {
  const db = await openDisplayDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("jobs", "readwrite");
    transaction.objectStore("jobs").delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? Error("Не вдалося завершити контрольну точку."));
    transaction.onabort = transaction.onerror;
  });
}

/** Explicit user deletion removes both an unfinished job and its PNGs atomically. */
export async function deleteProcessingCheckpoint(id: string): Promise<void> {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("Некоректний ідентифікатор обчислення.");
  const remove = async () => {
    const db = await openDisplayDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(["jobs", "png", "sessions"], "readwrite");
      const sessions = transaction.objectStore("sessions").getAll();
      sessions.onsuccess = () => {
        // A successful session save can precede interruption of checkpoint removal.
        // Deleting that stale checkpoint must never delete the saved session's assets.
        const saved = sessions.result.some(session => Array.isArray(session.asset_series_ids) && session.asset_series_ids.includes(id));
        transaction.objectStore("jobs").delete(id);
        if (!saved) transaction.objectStore("png").delete(IDBKeyRange.bound(`${id}:`, `${id}:\uffff`));
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? Error("Не вдалося видалити незавершене обчислення."));
      transaction.onabort = transaction.onerror;
    });
  };
  if (navigator.locks) await navigator.locks.request(`spherex-processing-${id}`, { ifAvailable: true }, async lock => {
    if (!lock) throw Error("Це обчислення зараз працює в іншій вкладці. Спочатку призупиніть його.");
    await remove();
  });
  else await remove();
}
