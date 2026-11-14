import test, {beforeEach, afterEach} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import "fake-indexeddb/auto";
import {IDBObjectStore} from "fake-indexeddb";
import {buildSessionBundle, inspectSessionBundle, localizeBundleManifest} from "../lib/bundle-format.ts";
import {DB_NAME, openDisplayDatabase, readDisplayAsset, writeDisplayAsset} from "../lib/frame-assets.ts";
import {cleanupOrphanAssets, deleteSession, listSessions, loadSession, restoreActiveSession, saveSession, storageSummary, updateSessionView} from "../lib/sessions.ts";
import {exportSessionBundle, importSessionBundle} from "../lib/session-bundle.ts";
import type {SessionView} from "../lib/session-model.ts";

const dataset=JSON.parse(await readFile(new URL("../public/data/atlas/manifest.json",import.meta.url),"utf8"));
dataset.frames=dataset.frames.slice(0,2);
const view:SessionView={frame_id:dataset.frames[0].id,mode:"sky",compare:true,reference_id:dataset.frames[1].id,quality_overlay:true};
const packageBlob=await buildSessionBundle(dataset,view,async source=>new Blob([await readFile(new URL(`../public${source}`,import.meta.url))],{type:"image/png"}));
const {header,dataOffset}=await inspectSessionBundle(packageBlob);
const png=packageBlob.slice(dataOffset,dataOffset+header.assets[0].size,"image/png");
const series="12345678-1234-4234-8234-123456789abc", otherSeries="abcdefab-cdef-4abc-8abc-abcdefabcdef", orphanSeries="99999999-9999-4999-8999-999999999999";

function result<T>(request:IDBRequest<T>):Promise<T> {return new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
function done(transaction:IDBTransaction):Promise<void> {return new Promise((resolve,reject)=>{transaction.oncomplete=()=>resolve();transaction.onerror=transaction.onabort=()=>reject(transaction.error??Error("Aborted"));});}
async function rows(store:string) {const db=await openDisplayDatabase();return result(db.transaction(store,"readonly").objectStore(store).getAll());}
async function put(store:string,value:unknown) {const db=await openDisplayDatabase(),tx=db.transaction(store,"readwrite"),completed=done(tx);tx.objectStore(store).put(value);await completed;}
async function freshDatabase() {await result(indexedDB.deleteDatabase(DB_NAME));}

beforeEach(async()=>{
  Object.defineProperty(navigator,"locks",{value:undefined,configurable:true});
  Object.defineProperty(navigator,"storage",{value:{estimate:async()=>({usage:200,quota:1000})},configurable:true});
  await freshDatabase();
});
afterEach(freshDatabase);

test("compact view autosave restores after reopening without reading or rewriting the manifest",async()=>{
  const saved=await saveSession(dataset,view),before=await rows("sessions"),next={...view,frame_id:dataset.frames[1].id,compare:false,reference_id:null};
  const originalGet=IDBObjectStore.prototype.get,originalPut=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.get=function(...args){assert.notEqual(this.name,"sessions","autosave must not clone the large manifest");return originalGet.apply(this,args);};
  IDBObjectStore.prototype.put=function(...args){assert.notEqual(this.name,"sessions","autosave must only update compact metadata");return originalPut.apply(this,args);};
  try {await updateSessionView(saved.id,next);} finally {IDBObjectStore.prototype.get=originalGet;IDBObjectStore.prototype.put=originalPut;}
  assert.deepEqual(await rows("sessions"),before);
  assert.equal((await loadSession(saved.id)).view.frame_id,next.frame_id);
  assert.equal((await restoreActiveSession())?.view.frame_id,next.frame_id);
  assert.equal((await listSessions())[0].view.frame_id,next.frame_id);
  await saveSession(dataset,view,saved.id);
  assert.equal((await loadSession(saved.id)).view.frame_id,view.frame_id,"explicit save supersedes an older compact view");
  assert.equal((await rows("meta")).some(row=>row.key===`session-view:${saved.id}`),false);
  await updateSessionView(saved.id,next);await deleteSession(saved.id);
  assert.equal(await restoreActiveSession(),null);assert.deepEqual(await rows("meta"),[]);
  await updateSessionView(saved.id,next);assert.deepEqual(await rows("meta"),[],"late autosave cannot resurrect a deleted session");
});

test("aborted session commit rolls back manifest, active pointer, compact view and job acknowledgement together",async()=>{
  const saved=await saveSession(dataset,view),next={...view,frame_id:dataset.frames[1].id};
  await updateSessionView(saved.id,next);
  await put("jobs",{id:series,series_id:series,phase:"import"});
  const previousSessions=await rows("sessions"),previousMeta=await rows("meta"),previousJobs=await rows("jobs");
  const original=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(...args){const request=original.apply(this,args);if(this.name==="meta"&&(args[0] as {key?:string}).key==="activeSession")queueMicrotask(()=>this.transaction.abort());return request;};
  try {await assert.rejects(()=>saveSession(dataset,view,saved.id,series),/перервано|Abort/i);} finally {IDBObjectStore.prototype.put=original;}
  assert.deepEqual(await rows("sessions"),previousSessions);assert.deepEqual(await rows("meta"),previousMeta);assert.deepEqual(await rows("jobs"),previousJobs);
});

test("orphan cleanup protects shared saved sessions and resumable jobs in the same transaction",async()=>{
  const local=localizeBundleManifest(header,series),first=await saveSession(local,view),second=await saveSession(local,view);
  const savedRef=await writeDisplayAsset(series,header.assets[0].sha256,png),jobRef=await writeDisplayAsset(otherSeries,header.assets[0].sha256,png);
  await writeDisplayAsset(orphanSeries,header.assets[0].sha256,png);await put("jobs",{id:otherSeries,series_id:otherSeries,phase:"render"});
  assert.deepEqual(await cleanupOrphanAssets(),{deleted:1,bytes:png.size});
  assert.equal((await readDisplayAsset(savedRef)).size,png.size);assert.equal((await readDisplayAsset(jobRef)).size,png.size);
  await deleteSession(first.id);assert.equal((await readDisplayAsset(savedRef)).size,png.size);
  await deleteSession(second.id);await assert.rejects(()=>readDisplayAsset(savedRef),/відсутнє/);
  assert.equal((await readDisplayAsset(jobRef)).size,png.size);
  assert.deepEqual(await storageSummary(),{pngBytes:png.size,pngCount:1,usage:200,quota:1000});
});

test("cleanup removes abandoned imports only when their Web Lock is free",async()=>{
  const held=new Set([`spherex-import-${series}`]);
  Object.defineProperty(navigator,"locks",{value:{request:async(name:string,_options:unknown,callback:(lock:unknown)=>Promise<void>)=>callback(held.has(name)?null:{name})},configurable:true});
  const protectedRef=await writeDisplayAsset(series,header.assets[0].sha256,png),abandonedRef=await writeDisplayAsset(otherSeries,header.assets[0].sha256,png);
  await put("jobs",{id:series,series_id:series,phase:"import",web_lock:true});await put("jobs",{id:otherSeries,series_id:otherSeries,phase:"import",web_lock:true});
  assert.equal((await cleanupOrphanAssets()).deleted,1);assert.equal((await readDisplayAsset(protectedRef)).size,png.size);
  await assert.rejects(()=>readDisplayAsset(abandonedRef),/відсутнє/);assert.equal((await rows("jobs"))[0].id,series);
  held.clear();assert.equal((await cleanupOrphanAssets()).deleted,1);assert.deepEqual(await rows("jobs"),[]);
});

test("corrupted and cancelled imports clean partial PNGs and jobs without touching existing sessions",async()=>{
  const existing=await importSessionBundle(packageBlob),beforePng=await rows("png"),beforeSessions=await rows("sessions");
  const bytes=new Uint8Array(await packageBlob.arrayBuffer());bytes[bytes.length-1]^=1;
  let written=0;await assert.rejects(()=>importSessionBundle(new Blob([bytes]),{onProgress:p=>{written=p.completed;}}),/SHA-256/);
  assert.ok(written>0,"corruption must be encountered after earlier valid assets were committed");
  assert.deepEqual(await rows("png"),beforePng);assert.deepEqual(await rows("sessions"),beforeSessions);assert.deepEqual(await rows("jobs"),[]);
  const controller=new AbortController();await assert.rejects(()=>importSessionBundle(packageBlob,{signal:controller.signal,onProgress:()=>controller.abort()}),{name:"AbortError"});
  assert.deepEqual(await rows("png"),beforePng);assert.deepEqual(await rows("sessions"),beforeSessions);assert.deepEqual(await rows("jobs"),[]);
  assert.equal((await restoreActiveSession())?.id,existing.id);
});

test("portable transfer into an empty IndexedDB verifies every PNG and restores scientific metadata and view",async()=>{
  const source=await importSessionBundle(packageBlob),exported=await exportSessionBundle(source.manifest,source.view),originalReference=source.manifest.frames[0].image;
  const original=await(await readDisplayAsset(originalReference)).arrayBuffer();
  await freshDatabase();assert.deepEqual(await rows("png"),[]);assert.deepEqual(await rows("sessions"),[]);
  const imported=await importSessionBundle(exported),restored=await restoreActiveSession();
  assert.notEqual(imported.manifest.frames[0].image,originalReference);assert.equal(restored?.id,imported.id);
  assert.deepEqual(imported.view,source.view);assert.equal(imported.manifest.observation_table_sha256,source.manifest.observation_table_sha256);
  for(let index=0;index<source.manifest.frames.length;index++){
    assert.equal(imported.manifest.frames[index].sha256_cutout,source.manifest.frames[index].sha256_cutout);
    assert.deepEqual(imported.manifest.frames[index].display_asset_sha256,source.manifest.frames[index].display_asset_sha256);
  }
  assert.deepEqual(await(await readDisplayAsset(imported.manifest.frames[0].image)).arrayBuffer(),original);
  assert.equal((await rows("png")).length,new Set(header.assets.map(asset=>asset.sha256)).size);assert.deepEqual(await rows("jobs"),[]);
});
