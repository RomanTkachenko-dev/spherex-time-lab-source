import type { Frame, Manifest } from "./science.ts";
import { validateSessionManifest, validateSessionView, type SessionView } from "./session-model.ts";

const MAGIC = new TextEncoder().encode("SPHEREX1");
const PREFIX_BYTES = 44;
export const MAX_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_BUNDLE_HEADER_BYTES = 64 * 1024 * 1024;
export const MAX_PNG_BYTES = 1024 * 1024;
export const ASSET_FIELDS = ["image", "object_image", "quality_mask_image", "object_quality_mask_image"] as const;
export type AssetField = typeof ASSET_FIELDS[number];
export type BundleAsset = {source: string; sha256: string; size: number};
export type BundleHeader = {format: "spherex-session"; version: 1; exported_at: string; manifest: Manifest; view: SessionView; assets: BundleAsset[]};
export type BundleProgress = {completed: number; total: number; detail: string};
type Options = {signal?: AbortSignal; onProgress?: (value: BundleProgress) => void};
export function assetSources(frame: Frame): Record<AssetField, string> {
  return {image: frame.image, object_image: frame.object_image, quality_mask_image: frame.quality_mask_image ?? frame.image.replace(/\.png$/, "-mask.png"), object_quality_mask_image: frame.object_quality_mask_image ?? frame.quality_mask_image ?? frame.object_image.replace(/\.png$/, "-mask.png")};
}
export async function sha256(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2,"0")).join("");
}
function assertPng(bytes: ArrayBuffer) {
  const data = new Uint8Array(bytes), expected = [137,80,78,71,13,10,26,10];
  const view = new DataView(bytes);
  if (data.length < 33 || data.length > MAX_PNG_BYTES || expected.some((value,index) => data[index] !== value) || view.getUint32(8) !== 13 || new TextDecoder().decode(data.slice(12,16)) !== "IHDR" || view.getUint32(16) !== 256 || view.getUint32(20) !== 256) throw Error("Пакет містить некоректне PNG; очікується зображення 256×256 розміром до 1 MiB.");
}
function expectedSources(manifest: Manifest) {
  const result = new Map<string,string | undefined>();
  for (const frame of manifest.frames) for (const [field, source] of Object.entries(assetSources(frame))) {
    const hash = source.startsWith("idb:") ? source.split(":").at(-1) : frame.display_asset_sha256?.[field];
    if (result.has(source) && result.get(source) !== hash) throw Error("Паспорт містить суперечливі контрольні суми одного PNG.");
    result.set(source, hash);
  }
  return result;
}

/** Blob composition retains binary assets without encoding the full series in base64. */
export async function buildSessionBundle(manifestValue: Manifest, viewValue: SessionView, readAsset: (source: string) => Promise<Blob>, options: Options = {}): Promise<Blob> {
  const manifest = validateSessionManifest(manifestValue), view = validateSessionView(viewValue,manifest);
  const sources = expectedSources(manifest), assets: BundleAsset[] = [], blobs: Blob[] = [];
  let totalBytes = PREFIX_BYTES;
  for (const [source, expectedHash] of sources) {
    options.signal?.throwIfAborted();
    const blob = await readAsset(source);
    if (blob.size > MAX_PNG_BYTES) throw Error("Зображення перевищує ліміт 1 MiB.");
    const bytes = await blob.arrayBuffer(); assertPng(bytes);
    const hash = await sha256(bytes);
    if (expectedHash && hash !== expectedHash) throw Error("Контрольна сума PNG не відповідає паспорту. Експорт припинено.");
    assets.push({source,sha256:hash,size:blob.size}); blobs.push(blob); totalBytes += blob.size;
    if (totalBytes > MAX_BUNDLE_BYTES) throw Error("Пакет перевищує локальний ліміт 2 GiB.");
    options.onProgress?.({completed:assets.length,total:sources.size,detail:"Перевірка зображень для експорту"});
  }
  const header: BundleHeader = {format:"spherex-session",version:1,exported_at:new Date().toISOString(),manifest,view,assets};
  const bytes = new TextEncoder().encode(JSON.stringify(header));
  if (bytes.length > MAX_BUNDLE_HEADER_BYTES || totalBytes + bytes.length > MAX_BUNDLE_BYTES) throw Error("Індекс пакета перевищує ліміт розміру.");
  const prefix = new Uint8Array(PREFIX_BYTES); prefix.set(MAGIC); new DataView(prefix.buffer).setUint32(8,bytes.length); prefix.set(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),12);
  return new Blob([prefix,bytes,...blobs],{type:"application/x-spherex-session"});
}

export async function inspectSessionBundle(file: Blob): Promise<{header: BundleHeader; dataOffset: number}> {
  if (file.size < PREFIX_BYTES || file.size > MAX_BUNDLE_BYTES) throw Error("Некоректний розмір пакета (ліміт 2 GiB).");
  const prefix = new Uint8Array(await file.slice(0,PREFIX_BYTES).arrayBuffer());
  if (MAGIC.some((value,index) => prefix[index] !== value)) throw Error("Це не пакет SPHEREx Session версії 1.");
  const size = new DataView(prefix.buffer).getUint32(8);
  if (size < 2 || size > MAX_BUNDLE_HEADER_BYTES || PREFIX_BYTES+size>file.size) throw Error("Некоректна довжина індексу пакета.");
  const bytes = await file.slice(PREFIX_BYTES,PREFIX_BYTES+size).arrayBuffer();
  const expected = [...prefix.slice(12)].map(value=>value.toString(16).padStart(2,"0")).join("");
  if (await sha256(bytes) !== expected) throw Error("Пошкоджений індекс пакета: SHA-256 не збігається.");
  const header = JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)) as BundleHeader;
  if (header.format !== "spherex-session" || header.version !== 1 || !Number.isFinite(Date.parse(header.exported_at))) throw Error("Непідтримуваний формат пакета.");
  const manifest = validateSessionManifest(header.manifest); header.view = validateSessionView(header.view,manifest);
  const sources = expectedSources(manifest), seen = new Set<string>();
  if (!Array.isArray(header.assets) || header.assets.length !== sources.size) throw Error("Пакет не містить усіх шарів зображень.");
  let expectedBytes = PREFIX_BYTES + size;
  for (const asset of header.assets) {
    if (!asset || !sources.has(asset.source) || seen.has(asset.source) || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size < 33 || asset.size > MAX_PNG_BYTES || (sources.get(asset.source) && sources.get(asset.source) !== asset.sha256)) throw Error("Некоректний або дубльований запис зображення в пакеті.");
    seen.add(asset.source); expectedBytes += asset.size;
  }
  if (expectedBytes !== file.size) throw Error("Довжина пакета не відповідає індексу зображень.");
  return {header, dataOffset:PREFIX_BYTES+size};
}

export async function readBundleAsset(file: Blob, asset: BundleAsset, offset: number): Promise<Blob> {
  const blob = file.slice(offset,offset+asset.size,"image/png"), bytes = await blob.arrayBuffer();
  assertPng(bytes);
  if (await sha256(bytes) !== asset.sha256) throw Error("Пошкоджений PNG у пакеті: SHA-256 не збігається.");
  return blob;
}

export function localizeBundleManifest(header: BundleHeader, seriesId: string): Manifest {
  if (!/^[a-f0-9-]{36}$/.test(seriesId)) throw Error("Некоректний ідентифікатор імпортованої серії.");
  const hashes = new Map(header.assets.map(asset=>[asset.source,asset.sha256]));
  const manifest = structuredClone(header.manifest);
  manifest.display.asset_storage = "indexeddb-sha256-v1";
  for (const frame of manifest.frames) {
    const sources = assetSources(frame); frame.display_asset_sha256 = {};
    for (const field of ASSET_FIELDS) {
      const hash = hashes.get(sources[field]); if (!hash) throw Error("Відсутній шар зображення.");
      frame[field] = `idb:${seriesId}:${hash}`; frame.display_asset_sha256[field] = hash;
    }
  }
  return validateSessionManifest(manifest);
}
