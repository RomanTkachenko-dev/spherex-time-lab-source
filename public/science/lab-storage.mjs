export async function labStore(action, value) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('spherex-science-lab', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('runs');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onblocked = () => reject(Error('Сховище лабораторії заблоковане іншою вкладкою.'));
  });
  try { return await new Promise((resolve, reject) => {
    const tx = db.transaction('runs', action === 'get' ? 'readonly' : 'readwrite');
    const store = tx.objectStore('runs');
    const request = action === 'get' ? store.get('latest') : store.put(value, 'latest');
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  }); } finally { db.close(); }
}
