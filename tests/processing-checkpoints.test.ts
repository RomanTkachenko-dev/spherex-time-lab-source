import test from "node:test";
import assert from "node:assert/strict";
import { assertProcessingCheckpoint, estimateRemainingPngBytes } from "../public/science/processing-state.mjs";

const id = "11111111-1111-4111-8111-111111111111", hash = "a".repeat(64);
function checkpoint() {
  const frame = { id: "obs_aD1", mjd: 60000, sha256_cutout: hash };
  const references = Object.fromEntries(["image", "object_image", "quality_mask_image", "object_quality_mask_image"].map(name => [name, `idb:${id}:${hash}`]));
  return { version: 1, id, series_id: id, method_sha256: hash, phase: "render", next_index: 2,
    catalogue: { records: [{ id: "ivo://irsa/a", observation: "obs_a" }, { id: "b", observation: "obs_b" }], query: { ra: 0, dec: 0, detector: 1 } },
    accepted: [{ record: { id: "ivo://irsa/a", observation: "obs_a" }, frame }], excluded: [{ id: "b", reason: "No finite pixels" }],
    scale: { low: 0, high: 1 }, frames: [{ ...frame, ...references, display_asset_sha256: Object.fromEntries(Object.keys(references).map(name => [name, hash])) }],
  };
}

test("resumable checkpoint preserves exact identities and binds every PNG to the original series", () => {
  const value = checkpoint();
  assert.equal(assertProcessingCheckpoint(value, hash), value);
  const wrongFits = structuredClone(value);wrongFits.frames[0].sha256_cutout = "b".repeat(64);
  assert.throws(() => assertProcessingCheckpoint(wrongFits), /пошкоджена/);
  const wrongSeries = structuredClone(value);Object.assign(wrongSeries.frames[0], { image: `idb:22222222-2222-4222-8222-222222222222:${hash}` });
  assert.throws(() => assertProcessingCheckpoint(wrongSeries), /пошкоджена/);
  const wrongEpoch = structuredClone(value);wrongEpoch.frames[0].mjd++;
  assert.throws(() => assertProcessingCheckpoint(wrongEpoch), /пошкоджена/);
});

test("resumption refuses mixed method versions, missing histogram state and mismatched coverage counts", () => {
  const value = checkpoint();
  assert.throws(() => assertProcessingCheckpoint(value, "b".repeat(64)), /Метод обробки оновився/);
  const incomplete = { ...value, phase: "analyze", frames: [] };
  assert.throws(() => assertProcessingCheckpoint(incomplete), /пошкоджена/);
  assert.equal(assertProcessingCheckpoint({ ...incomplete, stream_state: { version: 1, sample_count: 3 } }).next_index, 2);
  const duplicate = { ...value, excluded: [{ id: "ivo://irsa/a", reason: "duplicate" }] };
  assert.throws(() => assertProcessingCheckpoint(duplicate), /пошкоджена/);
  assert.throws(() => assertProcessingCheckpoint({ ...value, next_index: 1 }), /пошкоджена/);
});

test("legacy checkpoint can reopen a completed exact-scale result without pretending to retain Python arrays", () => {
  const value = { ...checkpoint(), phase: "complete", legacy_complete: true, accepted: [], frames: [], manifest: { frames: [{ id: "a" }, { id: "b" }] } };
  assert.equal(assertProcessingCheckpoint(value), value);
});

test("storage forecast uses observed PNG bytes and never invents a capacity before a frame is rendered", () => {
  assert.equal(estimateRemainingPngBytes(0, 0, 286), null);
  assert.equal(estimateRemainingPngBytes(1000, 2, 10), 4000);
  assert.equal(estimateRemainingPngBytes(1000, 10, 10), 0);
  assert.equal(estimateRemainingPngBytes(1000, 11, 10), null);
});
