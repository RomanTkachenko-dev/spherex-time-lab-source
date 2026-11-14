import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, webcrypto } from "node:crypto";
import vm from "node:vm";
import { IDBFactory } from "fake-indexeddb";
import * as processingState from "../public/science/processing-state.mjs";

// Execute the shipped worker's real fetch/checkpoint/render control flow. Only
// Pyodide's numerical output and external I/O are mocked; this is not evidence
// of astronomical accuracy or a live archive/browser performance measurement.
const source = (await readFile(new URL("../public/science/field-worker.mjs", import.meta.url), "utf8"))
  .replace(/^import .*processing-state\.mjs";\r?\n/, "const { assertProcessingCheckpoint, estimateRemainingPngBytes } = __processingState;\n");
const jobId = "22222222-2222-4222-8222-222222222222";
const methodHash = "a".repeat(64);
const assetNames = ["image", "object_image", "quality_mask_image", "object_quality_mask_image"];
const digest = text => createHash("sha256").update(text).digest("hex");
const catalogue = () => ({
  query: { ra: 270, dec: 66.56, fov: 0.3, detector: 1, release: "qr3", survey: "deep" },
  records: Array.from({ length: 121 }, (_, index) => ({
    id: `ivo://test/${index}`, observation: `test_${index}`, mjd: 61000 + index / 100,
    url: `https://archive.invalid/${index}.fits`,
  })),
});

async function rows(factory, store) {
  const database = await new Promise((resolve, reject) => {
    const request = factory.open("spherex-time-lab-display-assets", 3);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(store, "readonly").objectStore(store).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally { database.close(); }
}

async function putRow(factory, store, value) {
  const request = factory.open("spherex-time-lab-display-assets", 3);
  const database = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(store, "readwrite");
      transaction.objectStore(store).put(value);
      transaction.oncomplete = resolve;
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
  } finally { database.close(); }
}

function harness(factory, options = {}) {
  const values = new Map(), messages = [], fetched = [], analyzed = [], rendered = [];
  let phase = "analyze", histogramIds = [], quotaAborted = false;
  const frameFor = record => ({ id: record.observation + "D1", mjd: record.mjd, sha256_cutout: digest(record.id) });
  const py = {
    version: "mock-for-control-flow-test",
    globals: { set: (name, value) => values.set(name, value) },
    FS: { writeFile() {}, unlink() {} },
    runPython(command) {
      assert.equal(command, "reset_stream()");
      phase = "analyze"; histogramIds = [];
    },
    async runPythonAsync(command) {
      const record = values.has("record_json") ? JSON.parse(values.get("record_json")) : null;
      if (command === "restore_stream_state(stream_state_json)") {
        histogramIds = JSON.parse(values.get("stream_state_json")).ids;
        return "{}";
      }
      if (command.startsWith("add_stream_frame(")) {
        analyzed.push(record.id);
        if (record.id === options.pythonError?.id) throw Object.assign(Error(`Traceback (most recent call last):\n  Mock numerical operation\n${options.pythonError.kind}: injected test error`), { name: "PythonError" });
        if (record.id === options.invalidResult?.id) return JSON.stringify(options.invalidResult.result);
        if (record.id === options.rejectId) return JSON.stringify({ included: false, reason: "Synthetic scientific rejection" });
        histogramIds.push(record.id);
        return JSON.stringify({ included: true, frame: frameFor(record) });
      }
      if (command === "export_stream_state()") return JSON.stringify({ ids: histogramIds });
      if (command.includes("stream_scale_limits()")) { phase = "render"; return JSON.stringify({ low: 0, high: 1 }); }
      if (command.startsWith("render_stream_frame(")) {
        phase = "render"; rendered.push(record.id);
        const frame = frameFor(record);
        if (record.id === options.changedFitsId) frame.sha256_cutout = "f".repeat(64);
        return JSON.stringify({ frame, assets: Object.fromEntries(assetNames.map(name => [name,
          "data:image/png;base64," + Buffer.from(`synthetic-png:${record.id}:${name}`).toString("base64")])) });
      }
      if (command.includes("finish_stream(")) {
        const frames = JSON.parse(values.get("frames_json")), excluded = JSON.parse(values.get("excluded_json"));
        return JSON.stringify({ test_only: true, frames, excluded_frames: excluded, selected_count: 121, processed_count: frames.length });
      }
      throw Error("Unexpected mocked Python call: " + command);
    },
  };
  const indexedDB = {
    open(...args) {
      const request = factory.open(...args);
      request.addEventListener("success", () => {
        const database = request.result, transaction = database.transaction.bind(database);
        database.transaction = (...transactionArgs) => {
          const tx = transaction(...transactionArgs);
          if (options.quotaAtFrame && !quotaAborted && transactionArgs[1] === "readwrite" && Array.isArray(transactionArgs[0]) && transactionArgs[0].includes("png")) {
            const objectStore = tx.objectStore.bind(tx);
            tx.objectStore = name => {
              const store = objectStore(name);
              if (name === "jobs") {
                const put = store.put.bind(store);
                store.put = value => {
                  const write = put(value);
                  if (!quotaAborted && value.frames.length === options.quotaAtFrame) write.addEventListener("success", () => {
                    quotaAborted = true;
                    // Abort after PNG and job puts have succeeded, before commit:
                    // fake-indexeddb rolls back both stores like IndexedDB.
                    tx.abort();
                    Object.defineProperty(tx, "error", { value: new DOMException("Injected full storage", "QuotaExceededError") });
                  });
                  return write;
                };
              }
              return store;
            };
          }
          return tx;
        };
      });
      return request;
    },
  };
  const worker = { postMessage: message => messages.push(structuredClone(message)) };
  const context = vm.createContext({
    __processingState: processingState, __runtime: { py, code_sha256: options.methodHash || methodHash },
    self: worker, indexedDB, navigator: {}, crypto: webcrypto, Blob, TextEncoder, URLSearchParams, AbortSignal,
    // Retry delays are skipped; the same retry branches execute.
    setTimeout: callback => setTimeout(callback, 0),
    caches: { open: async () => { throw Error("Test intentionally disables optional FITS cache"); } },
    fetch: async url => {
      if (url.startsWith("data:")) return fetch(url);
      const parsed = new URL(url, "http://localhost");
      const index = Number(new URL(parsed.searchParams.get("url")).pathname.match(/\d+/)[0]);
      // A restored render checkpoint skips stream_scale_limits().
      const effectivePhase = options.resumePhase || phase;
      fetched.push({ phase: effectivePhase, index });
      if (options.networkFailure?.phase === effectivePhase && options.networkFailure.index === index) throw Error("Injected network outage");
      return new Response(new Uint8Array([index % 256]), { headers: { "X-Source-URL": "https://archive.invalid/cutout", "X-Retrieved-At": "2026-01-01T00:00:00Z" } });
    },
  });
  vm.runInContext(source + "\nruntimePromise = Promise.resolve(__runtime);", context, { filename: "field-worker.mjs" });
  return {
    messages, fetched, analyzed, rendered,
    run: type => worker.onmessage({ data: { type, assetSeriesId: jobId, ...(type === "build" ? { catalogue: catalogue() } : {}) } }),
    histogramIds: () => histogramIds,
  };
}

test("worker pauses a first-pass network outage without scientific exclusion, then restores the histogram and exact catalogue position", async () => {
  const factory = new IDBFactory();
  const first = harness(factory, { networkFailure: { phase: "analyze", index: 3 }, rejectId: "ivo://test/1" });
  await first.run("build");
  const [saved] = await rows(factory, "jobs");
  assert.equal(first.messages.at(-1).type, "error");
  assert.equal(first.messages.at(-1).resumable, true);
  assert.equal(saved.next_index, 3);
  assert.equal(saved.accepted.length, 2);
  assert.deepEqual(saved.excluded.map(item => item.id), ["ivo://test/1"]);
  assert.equal(first.fetched.filter(item => item.index === 3).length, 3);
  const resumed = harness(factory);
  await resumed.run("resume");
  assert.equal(resumed.messages.at(-1).type, "complete");
  assert.equal(resumed.analyzed[0], "ivo://test/3");
  const [complete] = await rows(factory, "jobs");
  assert.equal(complete.next_index, 121);
  assert.equal(complete.accepted.length, 120);
  assert.equal(new Set(complete.accepted.map(item => item.record.id)).size, 120);
  assert.equal(complete.frames.length, 120);
  assert.equal(resumed.histogramIds().length, 120);
  assert.equal(new Set(resumed.histogramIds()).size, 120);
  assert.equal(complete.manifest.selected_count, complete.manifest.processed_count + complete.excluded.length);
});

test("worker preserves committed render frames across a second-pass outage and does not repeat analysis or completed renders", async () => {
  const factory = new IDBFactory();
  const first = harness(factory, { networkFailure: { phase: "render", index: 2 } });
  await first.run("build");
  const [saved] = await rows(factory, "jobs");
  assert.equal(saved.phase, "render");
  assert.equal(saved.frames.length, 2);
  assert.equal(saved.excluded.length, 0);
  assert.equal(saved.next_index, 121);
  const resumed = harness(factory, { resumePhase: "render" });
  await resumed.run("resume");
  assert.equal(resumed.messages.at(-1).type, "complete");
  assert.equal(resumed.analyzed.length, 0);
  assert.equal(resumed.rendered[0], "ivo://test/2");
  const [complete] = await rows(factory, "jobs");
  assert.equal(complete.frames.length, 121);
  assert.equal(new Set(complete.frames.map(frame => frame.id)).size, 121);
  assert.equal(complete.excluded.length, 0);
});

test("quota abort rolls back PNGs and the in-memory appended frame; resume starts at the last committed frame", async () => {
  const factory = new IDBFactory();
  const first = harness(factory, { quotaAtFrame: 2 });
  await first.run("build");
  assert.equal(first.messages.at(-1).type, "error");
  assert.match(first.messages.at(-1).error, /закінчилося місце/);
  const [saved] = await rows(factory, "jobs");
  const pngs = await rows(factory, "png");
  assert.equal(saved.frames.length, 1);
  assert.equal(pngs.length, 4);
  assert.equal(saved.stored_png_bytes, pngs.reduce((sum, row) => sum + row.byte_length, 0));
  assert.deepEqual(new Set(pngs.map(row => row.sha256)), new Set(Object.values(saved.frames[0].display_asset_sha256)));
  const resumed = harness(factory, { resumePhase: "render" });
  await resumed.run("resume");
  assert.equal(resumed.messages.at(-1).type, "complete");
  assert.equal(resumed.rendered[0], "ivo://test/1");
  const [complete] = await rows(factory, "jobs");
  assert.equal(complete.frames.length, 121);
  assert.equal(new Set(complete.frames.map(frame => frame.id)).size, 121);
  assert.equal((await rows(factory, "png")).length, 121 * 4);
});

test("worker rejects changed method or second-pass FITS identity without overwriting accepted provenance", async () => {
  const factory = new IDBFactory();
  await harness(factory, { networkFailure: { phase: "render", index: 1 } }).run("build");
  const wrongMethod = harness(factory, { methodHash: "b".repeat(64) });
  await wrongMethod.run("resume");
  assert.equal(wrongMethod.messages.at(-1).type, "error");
  assert.match(wrongMethod.messages.at(-1).error, /Метод обробки оновився/);
  assert.equal(wrongMethod.fetched.length, 0);
  const changedFits = harness(factory, { resumePhase: "render", changedFitsId: "ivo://test/1" });
  await changedFits.run("resume");
  assert.equal(changedFits.messages.at(-1).type, "error");
  assert.match(changedFits.messages.at(-1).error, /змінився між проходами/);
  const [saved] = await rows(factory, "jobs");
  assert.equal(saved.method_sha256, methodHash);
  assert.equal(saved.frames.length, 1);
  assert.equal(saved.excluded.length, 0);
  assert.equal(saved.accepted[1].frame.sha256_cutout, digest("ivo://test/1"));
});

test("worker detects corrupted persisted PNG bytes and regenerates from the first damaged frame", async () => {
  const factory = new IDBFactory();
  await harness(factory, { networkFailure: { phase: "render", index: 3 } }).run("build");
  const [saved] = await rows(factory, "jobs");
  const targetDigest = saved.frames[1].display_asset_sha256.image;
  const original = (await rows(factory, "png")).find(row => row.sha256 === targetDigest);
  await putRow(factory, "png", { ...original, blob: new Blob(["corrupt storage bytes"], { type: "image/png" }) });
  const resumed = harness(factory, { resumePhase: "render" });
  await resumed.run("resume");
  assert.equal(resumed.messages.at(-1).type, "complete");
  assert.equal(resumed.rendered[0], "ivo://test/1");
  assert.equal(resumed.analyzed.length, 0);
  const recovered = (await rows(factory, "png")).find(row => row.sha256 === targetDigest);
  assert.equal(createHash("sha256").update(Buffer.from(await recovered.blob.arrayBuffer())).digest("hex"), targetDigest);
  const [complete] = await rows(factory, "jobs");
  assert.equal(complete.frames.length, 121);
  assert.equal(new Set(complete.frames.map(frame => frame.id)).size, 121);
});

test("Python memory/runtime failures pause rather than becoming scientific exclusions; known data errors remain traceable rejections", async t => {
  for (const kind of ["MemoryError", "RuntimeError", "TypeError"]) await t.test(kind, async () => {
    const factory = new IDBFactory();
    const first = harness(factory, { pythonError: { id: "ivo://test/3", kind } });
    await first.run("build");
    const [saved] = await rows(factory, "jobs");
    assert.equal(first.messages.at(-1).type, "error");
    assert.equal(saved.next_index, 3);
    assert.equal(saved.excluded.length, 0);
    assert.equal(saved.accepted.length, 3);
    const resumed = harness(factory);
    await resumed.run("resume");
    assert.equal(resumed.messages.at(-1).type, "complete");
    assert.equal(resumed.analyzed[0], "ivo://test/3");
    assert.equal(new Set(resumed.histogramIds()).size, 121);
  });
  const factory = new IDBFactory();
  const dataError = harness(factory, { pythonError: { id: "ivo://test/3", kind: "ValueError" } });
  await dataError.run("build");
  assert.equal(dataError.messages.at(-1).type, "complete");
  const [complete] = await rows(factory, "jobs");
  assert.equal(complete.excluded.length, 1);
  assert.equal(complete.excluded[0].id, "ivo://test/3");
  assert.match(complete.excluded[0].reason, /ValueError/);
  assert.equal(complete.frames.length, 120);
});

test("malformed Python result cannot silently reject or accept an unsupported frame", async t => {
  for (const result of [{}, { included: false }, { included: "false", reason: "bad boolean" }, { included: true, frame: { id: "wrong" } }]) await t.test(JSON.stringify(result), async () => {
    const factory = new IDBFactory();
    const worker = harness(factory, { invalidResult: { id: "ivo://test/3", result } });
    await worker.run("build");
    assert.equal(worker.messages.at(-1).type, "error");
    const [saved] = await rows(factory, "jobs");
    assert.equal(saved.next_index, 3);
    assert.equal(saved.excluded.length, 0);
    assert.equal(saved.accepted.length, 3);
  });
});
