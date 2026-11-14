/** Read the laboratory's independent checkpoint without importing a public asset. */
import type { LabReport } from './laboratory';
export async function saveLabAssociations(report:LabReport):Promise<void>{
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{
    const request=indexedDB.open('spherex-science-lab',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('runs');
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
  try { await new Promise<void>((resolve,reject)=>{
    const tx=db.transaction('runs','readwrite'),store=tx.objectStore('runs'),request=store.get('latest');
    request.onsuccess=()=>{
      const value=request.result;
      // An asynchronous catalogue response must not overwrite a newer scientific run.
      if(value?.report?.created_at===report.created_at&&value.report.code_sha256===report.code_sha256&&
        JSON.stringify(value.report.frames.map((f:{id:string})=>f.id))===JSON.stringify(report.frames.map(f=>f.id)))
        store.put({...value,report:{...value.report,catalogue_crossmatch:report.catalogue_crossmatch}},'latest');
    };
    tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  }); } finally {db.close();}
}
export async function readLatestLab():Promise<unknown>{
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{
    const request=indexedDB.open('spherex-science-lab',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('runs');
    request.onerror=()=>reject(request.error);request.onsuccess=()=>resolve(request.result);
    request.onblocked=()=>reject(Error('Сховище лабораторії заблоковане іншою вкладкою.'));
  });
  try{return await new Promise((resolve,reject)=>{
    const tx=db.transaction('runs','readonly'),request=tx.objectStore('runs').get('latest');
    tx.oncomplete=()=>resolve(request.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });}finally{db.close();}
}
