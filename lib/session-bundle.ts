import { publicAsset } from "./site-mode.ts";
import { buildSessionBundle, inspectSessionBundle, localizeBundleManifest, readBundleAsset, type BundleProgress } from "./bundle-format.ts";
import { deleteDisplaySeries, openDisplayDatabase, readDisplayAsset, writeDisplayAsset } from "./frame-assets.ts";
import { saveSession, type SavedSession, type SessionView } from "./sessions.ts";
import type { Manifest } from "./science.ts";

export async function exportSessionBundle(manifest: Manifest, view: SessionView, options: {signal?: AbortSignal; onProgress?: (progress: BundleProgress) => void} = {}): Promise<Blob> {
  return buildSessionBundle(manifest,view,async source => {
    if (source.startsWith("idb:")) return readDisplayAsset(source);
    if (!/^data:image\/png;base64,/.test(source) && !/^\/data\/atlas\/[a-z]+-\d{2}(?:-mask)?\.png$/.test(source)) throw Error("Непідтримуване джерело PNG для пакета.");
    const response = await fetch(publicAsset(source),{signal:options.signal}); if (!response.ok) throw Error("Не вдалося прочитати зображення для експорту."); return response.blob();
  },options);
}

async function importJob(series: string, active: boolean) {
  const db = await openDisplayDatabase();
  await new Promise<void>((resolve,reject) => {
    const transaction = db.transaction("jobs","readwrite"), store = transaction.objectStore("jobs");
    if (active) store.put({id:series,series_id:series,phase:"import",web_lock:!!navigator.locks,heartbeat_at:new Date().toISOString()}); else store.delete(series);
    transaction.oncomplete = () => resolve(); transaction.onerror = transaction.onabort = () => reject(transaction.error ?? Error("Не вдалося зареєструвати імпорт."));
  });
}

export async function importSessionBundle(file: Blob, options: {signal?: AbortSignal; onProgress?: (progress: BundleProgress)=>void} = {}): Promise<SavedSession> {
  const {header,dataOffset} = await inspectSessionBundle(file), series = crypto.randomUUID();
  const execute = async () => {
  await importJob(series,true);
  try {
    let offset = dataOffset, count = 0;
    for (const asset of header.assets) {
      options.signal?.throwIfAborted();
      const blob = await readBundleAsset(file,asset,offset); await writeDisplayAsset(series,asset.sha256,blob);
      offset += asset.size; count++;
      options.onProgress?.({completed:count,total:header.assets.length,detail:"Перевірка та збереження зображень"});
    }
    options.signal?.throwIfAborted();
    return await saveSession(localizeBundleManifest(header,series),header.view,undefined,series);
  } catch(error) {
    await deleteDisplaySeries(series).catch(()=>{}); await importJob(series,false).catch(()=>{}); throw error;
  }
  };
  return navigator.locks ? navigator.locks.request(`spherex-import-${series}`,{signal:options.signal},execute) : execute();
}
