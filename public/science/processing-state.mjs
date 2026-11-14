// Shared, deterministic validation for durable worker checkpoints.
export function assertProcessingCheckpoint(value, methodSha256) {
  const fail = () => { throw Error("Контрольна точка пошкоджена або несумісна. Видаліть її та підготуйте серію знову."); };
  if (!value || value.version !== 1 || !/^[a-f0-9-]{36}$/.test(value.id || "") || value.id !== value.series_id || !["analyze", "render", "complete", "legacy"].includes(value.phase)) fail();
  if (!Array.isArray(value.catalogue?.records) || value.catalogue.records.length < 2 || value.catalogue.records.length > 15360 || !value.catalogue.query) fail();
  if (methodSha256 && value.method_sha256 && value.method_sha256 !== methodSha256) throw Error("Метод обробки оновився після збереження контрольної точки. Почніть нову серію, щоб не змішувати результати різних версій.");
  if (!Array.isArray(value.accepted) || !Array.isArray(value.excluded) || !Array.isArray(value.frames) || !Number.isInteger(value.next_index) || value.next_index < 0 || value.next_index > value.catalogue.records.length) fail();
  if (value.phase === "legacy" || (value.phase === "complete" && value.legacy_complete === true && value.catalogue.records.length <= 120 && value.manifest)) return value;
  if (value.accepted.length + value.excluded.length !== value.next_index || value.frames.length > value.accepted.length) fail();
  if (value.phase === "analyze" && value.next_index > 0 && !value.stream_state) fail();
  const expected = new Set(value.catalogue.records.slice(0, value.next_index).map(record => record.id));
  const seen = new Set();
  // IRSA record IDs are IVO URLs; scientific frame IDs are OBSID + detector.
  // Coverage is counted by catalogue identity, never by the display frame ID.
  for (const item of [...value.accepted.map(item => item.record), ...value.excluded]) {
    if (!expected.has(item?.id) || seen.has(item.id)) fail();
    seen.add(item.id);
  }
  for (const item of value.accepted) if (item.frame?.id !== item.record?.observation + "D" + value.catalogue.query.detector) fail();
  if (value.phase !== "analyze" && (value.next_index !== value.catalogue.records.length || !value.scale)) fail();
  for (let i = 0; i < value.frames.length; i++) {
    const frame = value.frames[i], original = value.accepted[i].frame;
    if (frame.id !== original.id || frame.sha256_cutout !== original.sha256_cutout || frame.mjd !== original.mjd) fail();
    for (const name of ["image", "object_image", "quality_mask_image", "object_quality_mask_image"]) {
      const digest = frame.display_asset_sha256?.[name];
      if (!/^[a-f0-9]{64}$/.test(digest || "") || frame[name] !== `idb:${value.series_id}:${digest}`) fail();
    }
  }
  return value;
}

// An estimate, not a capacity guarantee: compression and browser quota can change.
export function estimateRemainingPngBytes(storedBytes, renderedCount, acceptedCount) {
  if (![storedBytes, renderedCount, acceptedCount].every(Number.isFinite) || storedBytes < 0 || renderedCount < 1 || acceptedCount < renderedCount) return null;
  return Math.ceil(storedBytes / renderedCount * (acceptedCount - renderedCount));
}
