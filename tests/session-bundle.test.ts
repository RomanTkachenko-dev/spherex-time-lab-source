import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {buildSessionBundle, inspectSessionBundle, localizeBundleManifest, readBundleAsset, MAX_PNG_BYTES, type BundleHeader} from "../lib/bundle-format.ts";
import {manifestSeriesIds, validateSessionView, validateSavedSession, type SessionView} from "../lib/session-model.ts";

const dataset=JSON.parse(await readFile(new URL("../public/data/atlas/manifest.json",import.meta.url),"utf8"));
dataset.frames=dataset.frames.slice(0,2);
const view:SessionView={frame_id:dataset.frames[0].id,mode:"sky",compare:true,reference_id:dataset.frames[1].id,predicted_marker:true,quality_overlay:true};
const png=async(source:string)=>new Blob([await readFile(new URL(`../public${source}`,import.meta.url))],{type:"image/png"});
const packageBlob=await buildSessionBundle(dataset,view,png);
const {header,dataOffset}=await inspectSessionBundle(packageBlob);
const newSeries="12345678-1234-4234-8234-123456789abc";

async function alteredHeader(change:(value:BundleHeader)=>void) {
  const next=structuredClone(header);change(next);
  const bytes=new TextEncoder().encode(JSON.stringify(next)),prefix=new Uint8Array(44);
  prefix.set(new TextEncoder().encode("SPHEREX1"));new DataView(prefix.buffer).setUint32(8,bytes.length);
  prefix.set(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),12);
  return new Blob([prefix,bytes,packageBlob.slice(dataOffset)]);
}

test("portable package preserves scientific provenance and view, with every PNG verified",async()=>{
  assert.deepEqual(header.manifest,dataset);assert.deepEqual(header.view,validateSessionView(view,dataset));
  assert.equal(header.assets.length,8);
  let offset=dataOffset;
  for(const asset of header.assets){const blob=await readBundleAsset(packageBlob,asset,offset);assert.equal(blob.type,"image/png");assert.equal(blob.size,asset.size);offset+=asset.size;}
  assert.equal(offset,packageBlob.size);
  const local=localizeBundleManifest(header,newSeries);
  assert.deepEqual(manifestSeriesIds(local),[newSeries]);
  assert.equal(local.observation_table_sha256,dataset.observation_table_sha256);
  assert.equal(local.method_version,dataset.method_version);
  assert.deepEqual(local.frames.map(frame=>({mjd:frame.mjd,raw:frame.sha256_cutout,source:frame.source_url})),dataset.frames.map((frame:{mjd:number;sha256_cutout:string;source_url:string})=>({mjd:frame.mjd,raw:frame.sha256_cutout,source:frame.source_url})));
  for(const frame of local.frames){assert.match(frame.image,new RegExp(`^idb:${newSeries}:`));assert.equal(frame.display_asset_sha256?.image,frame.image.split(":").at(-1));}
});

test("imported package can be exported again under a fresh series identity",async()=>{
  const local=localizeBundleManifest(header,newSeries),blobs=new Map<string,Blob>();let offset=dataOffset;
  for(const asset of header.assets){blobs.set(asset.sha256,await readBundleAsset(packageBlob,asset,offset));offset+=asset.size;}
  const again=await buildSessionBundle(local,view,async source=>blobs.get(source.split(":").at(-1)!)!);
  const parsed=await inspectSessionBundle(again),next=localizeBundleManifest(parsed.header,"abcdefab-cdef-4abc-8abc-abcdefabcdef");
  assert.equal(next.frames[0].sha256_cutout,local.frames[0].sha256_cutout);
  assert.notEqual(next.frames[0].image,local.frames[0].image);
  assert.equal(next.frames[0].display_asset_sha256?.image,local.frames[0].display_asset_sha256?.image);
});

test("package rejects damaged header, truncated payload, and changed PNG bytes",async()=>{
  const bytes=new Uint8Array(await packageBlob.arrayBuffer());
  const damagedHeader=bytes.slice();damagedHeader[45]^=1;
  await assert.rejects(()=>inspectSessionBundle(new Blob([damagedHeader])),/SHA-256/);
  await assert.rejects(()=>inspectSessionBundle(packageBlob.slice(0,-1)),/Довжина/);
  const damagedPng=bytes.slice();damagedPng[damagedPng.length-1]^=1;
  const last=header.assets.at(-1)!;
  await assert.rejects(()=>readBundleAsset(new Blob([damagedPng]),last,packageBlob.size-last.size),/SHA-256/);
});

test("package rejects duplicate assets, excessive asset size, unsupported versions, and forged views",async()=>{
  await assert.rejects(()=>alteredHeader(value=>{value.assets[1].source=value.assets[0].source;}).then(inspectSessionBundle),/дубльований/);
  await assert.rejects(()=>alteredHeader(value=>{value.assets[0].size=MAX_PNG_BYTES+1;}).then(inspectSessionBundle),/Некоректний/);
  await assert.rejects(()=>alteredHeader(value=>{(value as {version:number}).version=2;}).then(inspectSessionBundle),/Непідтримуваний/);
  await assert.rejects(()=>alteredHeader(value=>{value.view.frame_id="missing";}).then(inspectSessionBundle),/перегляду/);
  await assert.rejects(()=>buildSessionBundle(dataset,view,async source=>{const bytes=await(await png(source)).arrayBuffer();new DataView(bytes).setUint32(16,4096);return new Blob([bytes]);}),/256×256/);
});

test("local session validates references and derives protected series ids from its manifest",()=>{
  const manifest=localizeBundleManifest(header,newSeries);
  const session=validateSavedSession({id:crypto.randomUUID(),title:manifest.title,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),manifest,view,asset_series_ids:["forged"]});
  assert.deepEqual(session.asset_series_ids,[newSeries]);
  assert.throws(()=>validateSavedSession({...session,view:{...view,reference_id:"missing"}}),/перегляду/);
  assert.throws(()=>validateSessionView({...view,compare:true,reference_id:null},manifest),/перегляду/);
});
