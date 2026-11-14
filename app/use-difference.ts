"use client";
import { useEffect, useState } from "react";
import { publicAsset } from "@/lib/site-mode";
import { readDisplayAsset } from "@/lib/frame-assets";
import type { Frame, Manifest } from "@/lib/science";
import { selectAcrossTime } from "@/lib/field-query";
import { decodeDisplay, differenceSummary, displayStretch, medianFrame, renderDifference, robustSigma, subtractFrames, type DecodedFrame, type Stretch } from "@/lib/difference";

export type DifferenceReference = "reference" | "median" | "previous";
export type DifferenceState = {
  status: "idle" | "loading" | "ready" | "error";
  url: string; error: string;
  sigma: number; k: number; median_offset: number; clipped_fraction: number;
  reference_frames: Frame[];
};
/** Bounded median stack keeps memory and decode time predictable for long series. */
export const MEDIAN_SAMPLE = 31;
const IDLE: DifferenceState = { status: "idle", url: "", error: "", sigma: NaN, k: 5, median_offset: NaN, clipped_fraction: 0, reference_frames: [] };

const pixelCache = new Map<string, Promise<ImageData>>();
const medianCache = new Map<string, DecodedFrame>();
function remember<K, V>(cache: Map<K, V>, key: K, value: V, limit: number) {
  cache.delete(key); cache.set(key, value);
  while (cache.size > limit) cache.delete(cache.keys().next().value as K);
  return value;
}
async function pixels(reference: string): Promise<ImageData> {
  const cached = pixelCache.get(reference);
  if (cached) return remember(pixelCache, reference, cached, 160);
  const load = (async () => {
    const blob = reference.startsWith("idb:") ? await readDisplayAsset(reference) : await (await fetch(publicAsset(reference))).blob();
    const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw Error("Браузер не надав 2D-полотно для декодування кадру.");
    context.drawImage(bitmap, 0, 0); bitmap.close();
    return context.getImageData(0, 0, canvas.width, canvas.height);
  })();
  load.catch(() => pixelCache.delete(reference));
  return remember(pixelCache, reference, load, 160);
}

export function imageReference(frame: Frame, mode: "sky" | "object") { return mode === "sky" ? frame.image : frame.object_image; }
function maskReference(frame: Frame, mode: "sky" | "object") {
  const image = imageReference(frame, mode);
  const mask = mode === "object" ? frame.object_quality_mask_image ?? frame.quality_mask_image ?? image.replace(/\.png$/, "-mask.png") : frame.quality_mask_image ?? image.replace(/\.png$/, "-mask.png");
  return mask === image ? null : mask;
}
async function decode(frame: Frame, mode: "sky" | "object", stretch: Stretch, size: { width: number; height: number }) {
  const image = await pixels(imageReference(frame, mode));
  const maskRef = stretch.checkerboard ? maskReference(frame, mode) : null;
  const mask = maskRef ? await pixels(maskRef) : null;
  if (image.width !== size.width || image.height !== size.height) throw Error("Розмір PNG кадру не відповідає паспорту серії.");
  return decodeDisplay(image.data, mask?.data ?? null, image.width, image.height, stretch);
}

export function differenceReferenceFrames(frames: Frame[], index: number, reference: number, kind: DifferenceReference): Frame[] {
  if (kind === "previous") return index > 0 ? [frames[index - 1]] : [];
  if (kind === "median") return selectAcrossTime(frames, MEDIAN_SAMPLE);
  return frames[reference] ? [frames[reference]] : [];
}

/** Current minus reference (frame, previous frame or series median), rendered with a symmetric ±k·σ (MAD) scale. */
export function useDifference({ enabled, manifest, index, reference, kind, mode, k }: { enabled: boolean; manifest: Manifest | null; index: number; reference: number; kind: DifferenceReference; mode: "sky" | "object"; k: number }): DifferenceState {
  const [state, setState] = useState<DifferenceState & { key: string }>({ ...IDLE, key: "" });
  const frames = manifest?.frames ?? [];
  const current = frames[index];
  const references = enabled && current ? differenceReferenceFrames(frames, index, reference, kind) : [];
  const key = enabled && current ? [mode, kind, k, imageReference(current, mode), ...references.map(f => imageReference(f, mode))].join("|") : "";
  useEffect(() => {
    if (!key || !manifest || !current) return;
    let active = true, url = "";
    const fail = (error: string) => { if (active) setState({ ...IDLE, status: "error", error, key, k, reference_frames: references }); };
    const stretch = displayStretch(manifest.display as Parameters<typeof displayStretch>[0]);
    if (!stretch) { void Promise.resolve().then(() => fail("Ця серія не має відомої шкали asinh; різницю з PNG відновити не можна.")); return () => { active = false; }; }
    if (kind === "reference" && references[0]?.id === current.id) { void Promise.resolve().then(() => fail("Опорний кадр збігається з поточним. Виберіть інший опорний кадр.")); return () => { active = false; }; }
    if (!references.length) { void Promise.resolve().then(() => fail(kind === "previous" ? "Для першого кадру немає попереднього." : "Опорний кадр не вибрано.")); return () => { active = false; }; }
    (async () => {
      const size = { width: manifest.display.width, height: manifest.display.height };
      const now = await decode(current, mode, stretch, size);
      let base: DecodedFrame;
      if (kind === "median") {
        const medianKey = [mode, ...references.map(f => imageReference(f, mode))].join("|");
        const cached = medianCache.get(medianKey);
        base = cached ?? remember(medianCache, medianKey, medianFrame(await Promise.all(references.map(f => decode(f, mode, stretch, size)))), 4);
      } else base = await decode(references[0], mode, stretch, size);
      const result = subtractFrames(now, base);
      const scale = robustSigma(result);
      if (!scale) throw Error("Недостатньо скінченних необрізаних пікселів, щоб оцінити σ різниці.");
      const canvas = document.createElement("canvas");
      canvas.width = result.width; canvas.height = result.height;
      const context = canvas.getContext("2d");
      if (!context) throw Error("Браузер не надав 2D-полотно для рендерингу різниці.");
      context.putImageData(new ImageData(renderDifference(result, scale.sigma, k, scale.median), result.width, result.height), 0, 0);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw Error("Не вдалося сформувати зображення різниці.");
      if (!active) return;
      url = URL.createObjectURL(blob);
      setState({ status: "ready", url, error: "", sigma: scale.sigma, k, median_offset: scale.median, clipped_fraction: differenceSummary(result).clipped_fraction, reference_frames: references, key });
    })().catch(error => fail(error instanceof Error ? error.message : String(error)));
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
    // `key` captures every input that changes the rendered pixels.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!key) return IDLE;
  return state.key === key ? state : { ...IDLE, status: "loading", k, reference_frames: references };
}
