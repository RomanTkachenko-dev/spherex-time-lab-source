import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fetchIrsaCatalogue, IRSA_ATTEMPTS, IrsaCatalogueError, irsaCatalogueErrorResponse } from "../lib/irsa-catalogue.ts";

const xml = readFileSync(new URL("./fixtures/irsa-sia.vot", import.meta.url), "utf8");
const url = "https://irsa.ipac.caltech.edu/SIA?POS=CIRCLE+167.2+5.15+0.000001&COLLECTION=spherex_qr2&MAXREC=1000&TIME=61023+61024";

test("IRSA transient gateway failure retries the identical query and preserves the raw catalogue", async () => {
  const calls: string[] = [];
  const signals: AbortSignal[] = [];
  const result = await fetchIrsaCatalogue(url, { retryDelayMs: 0, fetcher: async (input, init) => {
    calls.push(String(input)); signals.push(init!.signal!);
    assert.equal(init?.cache, "no-store");
    return calls.length === 1 ? new Response("Proxy Error", { status: 502 }) : new Response(xml);
  } });
  assert.deepEqual(calls, [url, url]);
  assert.equal(signals[0], signals[1]);
  assert.equal(result.xml, xml);
  assert.equal(result.parsed.rows.length, 30);
});

test("persistent gateway outage stops after the bounded attempts and explains the service failure", async () => {
  let calls = 0;
  await assert.rejects(fetchIrsaCatalogue(url, { retryDelayMs: 0, fetcher: async () => {
    calls++; return new Response("private upstream HTML", { status: 502 });
  } }), (error: unknown) => {
    assert.ok(error instanceof IrsaCatalogueError);
    assert.equal(error.code, "IRSA_UNAVAILABLE");
    assert.equal(error.upstreamStatus, 502);
    assert.match(error.message, /звуження дат його не усуне/);
    assert.doesNotMatch(error.message, /private upstream HTML/);
    return true;
  });
  assert.equal(calls, IRSA_ATTEMPTS);
});

test("a short burst of gateway errors is ridden out with growing pauses", async () => {
  const statuses = [502, 503, 502];
  let calls = 0;
  const result = await fetchIrsaCatalogue(url, { retryDelayMs: 0, fetcher: async () => {
    const status = statuses[calls++];
    return status ? new Response("busy", { status }) : new Response(xml);
  } });
  assert.equal(calls, 4); assert.equal(result.parsed.rows.length, 30);
});

test("network failure may recover on the bounded retry", async () => {
  let calls = 0;
  const result = await fetchIrsaCatalogue(url, { retryDelayMs: 0, fetcher: async () => {
    if (++calls === 1) throw new TypeError("fetch failed");
    return new Response(xml);
  } });
  assert.equal(calls, 2); assert.equal(result.parsed.rows.length, 30);
});

test("malformed catalogue and query rejection are never mistaken for empty results or retried", async () => {
  for (const response of [() => new Response("<html>not a table</html>"), () => new Response("query rejected", { status: 400 })]) {
    let calls = 0;
    await assert.rejects(fetchIrsaCatalogue(url, { retryDelayMs: 0, fetcher: async () => { calls++; return response(); } }),
      (error: unknown) => error instanceof IrsaCatalogueError && error.code === "IRSA_RESPONSE" && !error.retryable);
    assert.equal(calls, 1);
  }
});

test("deadline terminates the request without starting a second full timeout", async () => {
  let calls = 0;
  await assert.rejects(fetchIrsaCatalogue(url, { timeoutMs: 5, retryDelayMs: 0, fetcher: async (_input, init) => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 20));
    init!.signal!.throwIfAborted();
    return new Response(xml);
  } }), (error: unknown) => error instanceof IrsaCatalogueError && error.code === "IRSA_TIMEOUT");
  assert.equal(calls, 1);
});

test("successful overflow response retains the completeness flag", async () => {
  const result = await fetchIrsaCatalogue(url, { fetcher: async () => new Response(xml.replace('value="OK"', 'value="OVERFLOW"')) });
  assert.equal(result.parsed.overflow, true);
});

test("API error includes machine-readable cause and is not cached", async () => {
  const response = irsaCatalogueErrorResponse(new IrsaCatalogueError("IRSA_UNAVAILABLE", 503));
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Retry-After"), "30");
  const body = await response.json() as { code: string; upstream_status: number; retryable: boolean };
  assert.equal(body.code, "IRSA_UNAVAILABLE"); assert.equal(body.upstream_status, 503); assert.equal(body.retryable, true);
  assert.equal(irsaCatalogueErrorResponse(new IrsaCatalogueError("IRSA_TIMEOUT")).status, 504);
  assert.equal(irsaCatalogueErrorResponse(new Error("internal details")).headers.get("Retry-After"), null);
});
