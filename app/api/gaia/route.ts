import { parseGaiaCsv, type GaiaReference } from "@/lib/gaia";

const SOURCE_LIMIT = 1200;

function finiteParameter(params: URLSearchParams, name: string) {
  const raw = params.get(name) ?? "";
  const value = Number(raw);
  if (!raw.trim() || !Number.isFinite(value)) throw new Error(`Параметр ${name} має бути скінченним числом.`);
  return value;
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const ra = finiteParameter(params, "ra"), dec = finiteParameter(params, "dec"), radius = finiteParameter(params, "radius");
    if (ra < 0 || ra >= 360 || dec < -90 || dec > 90 || radius < 0.01 || radius > 1.5) throw new Error("Координати Gaia DR3 поза дозволеними межами пошуку.");
    // Fetch one extra row so exactly 1,200 matches are not mislabeled as truncated.
    const query = `SELECT TOP ${SOURCE_LIMIT + 1} source_id,ra,dec,ra_error,dec_error,pmra,pmdec,pmra_error,pmdec_error,ref_epoch,phot_g_mean_mag FROM gaia_dr3_source WHERE phot_g_mean_mag IS NOT NULL AND CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',${ra.toFixed(8)},${dec.toFixed(8)},${radius.toFixed(8)}))=1 ORDER BY phot_g_mean_mag ASC`;
    const source = new URL("https://irsa.ipac.caltech.edu/TAP/sync");
    source.searchParams.set("QUERY", query);
    source.searchParams.set("FORMAT", "CSV");
    const response = await fetch(source, { signal: AbortSignal.timeout(45000), headers: { Accept: "text/csv" } });
    const contentLength = Number(response.headers.get("Content-Length"));
    if (!response.ok || (Number.isFinite(contentLength) && contentLength > 2_000_000)) throw new Error("IRSA TAP не повернув обмежену таблицю Gaia DR3.");
    const csv = await response.text();
    if (csv.length > 2_000_000) throw new Error("Відповідь Gaia DR3 перевищила ліміт 2 MB.");
    const rows = parseGaiaCsv(csv);
    const truncated = rows.length > SOURCE_LIMIT;
    const sources = rows.slice(0, SOURCE_LIMIT);
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(csv));
    const source_sha256 = [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, "0")).join("");
    const result: GaiaReference = {
      service: "IRSA TAP · Gaia DR3", table: "gaia_dr3_source", source_url: source.toString(), source_sha256,
      retrieved_at: new Date().toISOString(), center_ra: ra, center_dec: dec, radius_deg: radius,
      record_count: sources.length, truncated, sources,
    };
    return Response.json(result, { headers: { "Cache-Control": "public, max-age=300" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Не вдалося виконати запит IRSA TAP.";
    const invalid = /Параметр|поза дозволеними/.test(message);
    return Response.json({ error: message }, { status: invalid ? 400 : 502 });
  }
}
