export const DB_NAME = "spherex-time-lab-display-assets";
export const STORE_NAME = "png";
let database: Promise<IDBDatabase> | undefined;

export function openDisplayDatabase() {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 3);
    let blocked = false;
    request.onupgradeneeded = () => {
      for (const name of [STORE_NAME, "sessions", "jobs", "meta"]) {
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: name === "meta" ? "key" : "id" });
      }
    };
    request.onsuccess = () => { if(blocked){request.result.close();return;} request.result.onversionchange = () => { request.result.close(); database = undefined; }; resolve(request.result); };
    request.onblocked = () => { blocked = true; reject(Error("Сховище очікує оновлення. Закрийте інші вкладки цієї програми й повторіть дію.")); };
    request.onerror = () => reject(request.error ?? Error("Не вдалося відкрити локальне сховище кадрів."));
  }).catch(error => { database = undefined; throw error; });
  return database!;
}

export async function readDisplayAsset(reference: string): Promise<Blob> {
  const match = /^idb:([a-f0-9-]{36}):([a-f0-9]{64})$/.exec(reference);
  if (!match) throw Error("Некоректне посилання на локальне зображення.");
  const db = await openDisplayDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(`${match[1]}:${match[2]}`);
    request.onsuccess = () => {
      const value = request.result as { blob?: Blob } | undefined;
      if (value?.blob instanceof Blob && value.blob.type === "image/png") resolve(value.blob);
      else reject(Error("Зображення відсутнє в локальному сховищі. Повторно підготуйте часову серію."));
    };
    request.onerror = () => reject(request.error ?? Error("Не вдалося прочитати локальне зображення."));
  });
}

export async function deleteDisplaySeries(seriesId: string): Promise<void> {
  if (!/^[a-f0-9-]{36}$/.test(seriesId)) return;
  const db = await openDisplayDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(IDBKeyRange.bound(`${seriesId}:`, `${seriesId}:\uffff`));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? Error("Не вдалося очистити незавершену серію."));
    transaction.onabort = () => reject(transaction.error ?? Error("Очищення серії перервано."));
  });
}

export async function writeDisplayAsset(seriesId: string, sha256: string, blob: Blob): Promise<string> {
  if (!/^[a-f0-9-]{36}$/.test(seriesId) || !/^[a-f0-9]{64}$/.test(sha256) || blob.type !== "image/png") throw Error("Некоректне зображення для локального сховища.");
  const db = await openDisplayDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({id: `${seriesId}:${sha256}`, sha256, blob, byte_length: blob.size, stored_at: new Date().toISOString()});
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(transaction.error?.name === "QuotaExceededError" ? Error("Недостатньо місця у сховищі браузера. Видаліть непотрібні локальні сесії.") : transaction.error ?? Error("Не вдалося зберегти PNG."));
  });
  return `idb:${seriesId}:${sha256}`;
}
