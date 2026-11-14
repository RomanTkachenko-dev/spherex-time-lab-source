import { selectAcrossTime, validateFieldQuery } from "@/lib/field-query";
import { parseMostBrief } from "@/lib/most";
import { MAX_CATALOGUE_CHUNK_FRAMES, MAX_SERIES_FRAMES } from "@/lib/catalogue-batches";

function dateMjd(value: string, end = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Укажіть дати у форматі РРРР-ММ-ДД.");
  const millis = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 10) !== value) throw new Error("Укажіть коректні календарні дати UTC.");
  return millis / 86400000 + 40587 + (end ? 1 : 0);
}

function digest(text: string) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then(hash => [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, "0")).join(""));
}

async function search(input: unknown) {
  const p = input as Record<string, unknown>;
  if (!p || typeof p !== "object") return Response.json({ error: "Не вказано параметри пошуку рухомої цілі." }, { status: 400 });
  try {
    const name = typeof p.name === "string" ? p.name.trim() : "";
    if (!name || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("Уведіть назву або NAIF ID об’єкта (до 128 символів).");
    const start = typeof p.start === "string" ? p.start : "";
    const end = typeof p.end === "string" ? p.end : "";
    const startMjd = dateMjd(start), endMjd = dateMjd(end, true);
    if (end < start) throw new Error("Кінцева дата передує початковій.");
    if (endMjd - startMjd > 90) throw new Error("Для контрольованого пошуку MOST оберіть період не довший за 90 днів.");
    const detector = Number(p.detector), maxFrames = Number(p.max_frames);
    if (!Number.isInteger(detector) || detector < 1 || detector > 6) throw new Error("Оберіть детектор D1–D6.");
    if (!Number.isInteger(maxFrames) || maxFrames < 2 || maxFrames > MAX_SERIES_FRAMES) throw new Error(`Кількість кадрів: від 2 до ${MAX_SERIES_FRAMES}.`);
    const release = p.release === "dr1" ? "dr1" : p.release === "qr3" ? "qr3" : p.release === "qr2" ? "qr2" : null;
    if (!release) throw new Error("Оберіть реліз DR1 або QR3.");
    const fov = Number(p.fov);
    if (!Number.isFinite(fov) || fov < 0.03 || fov > 0.3) throw new Error("Ширина поля має бути від 0,03° до 0,30°.");
    for (const key of ["wavelength_min", "wavelength_max"]) if (p[key] !== undefined && p[key] !== null && p[key] !== "" && !Number.isFinite(Number(p[key]))) throw new Error("Межі довжини хвилі мають бути числами.");
    const wavelengthMin = p.wavelength_min == null || p.wavelength_min === "" ? null : Number(p.wavelength_min);
    const wavelengthMax = p.wavelength_max == null || p.wavelength_max === "" ? null : Number(p.wavelength_max);
    if ((wavelengthMin === null) !== (wavelengthMax === null) || (wavelengthMin !== null && wavelengthMax !== null && (wavelengthMin <= 0 || wavelengthMax < wavelengthMin))) throw new Error("Укажіть обидві межі довжини хвилі у зростаючому порядку або залиште їх порожніми.");
    const naif = /^\d{7,9}$/.test(name) && Number(name) >= 2_000_000;
    const params = new URLSearchParams({
      catalog: "spherex", input_type: naif ? "naifid_input" : "name_input",
      [naif ? "obj_naifid" : "obj_name"]: name,
      obs_begin: start, obs_end: end, output_mode: "Brief",
    });
    const sourceUrl = `https://irsa.ipac.caltech.edu/cgi-bin/MOST/nph-most?${params}`;
    const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(60000), headers: { Accept: "text/plain" } });
    const contentLength = Number(response.headers.get("Content-Length"));
    if (!response.ok || (Number.isFinite(contentLength) && contentLength > 3_000_000)) throw new Error("Служба IRSA MOST не повернула обмежену таблицю результатів.");
    const table = await response.text();
    if (table.length > 3_000_000) throw new Error("Відповідь MOST перевищила ліміт 3 MB. Скоротіть період пошуку.");
    let allMatches;
    try { allMatches = parseMostBrief(table); }
    catch (error) { throw new Error(error instanceof Error ? error.message : "MOST не повернув таблицю збігів."); }
    const seen = new Set<string>();
    const matches = allMatches.filter(record => {
      if (record.detector !== detector || record.release !== `spherex_${release}` || record.mjd_start < startMjd || record.mjd_start >= endMjd) return false;
      const key = record.url;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => (a.mjd_start + a.mjd_end) - (b.mjd_start + b.mjd_end) || a.url.localeCompare(b.url));
    const catalogueTruncated = allMatches.length >= 1000;
    const allRequested = maxFrames >= MAX_CATALOGUE_CHUNK_FRAMES;
    if (allRequested && catalogueTruncated) return Response.json({ error: "IRSA MOST повернув щонайменше 1000 записів; часовий інтервал потрібно розбити." }, { status: 413 });
    if (allRequested && matches.length > MAX_CATALOGUE_CHUNK_FRAMES) return Response.json({ error: `Знайдено ${matches.length} збігів за інтервал. Архівне вікно перевищило ліміт ${MAX_CATALOGUE_CHUNK_FRAMES} кадрів і потребує розбиття.` }, { status: 413 });
    const allowSparse = p.allow_sparse === true;
    if (!allowSparse && (matches.length < 2 || new Set(matches.map(row => (row.mjd_start + row.mjd_end) / 2)).size < 2)) {
      const otherReleaseCount = allMatches.filter(record => record.detector === detector).length;
      const hint = otherReleaseCount > 0 && release === "qr3" ? " MOST повернув продукти іншого релізу; перевірте їхню доступність у каталозі." : " Звузьте період до дат із повторними спостереженнями або змініть детектор.";
      return Response.json({ error: `Для цієї цілі, періоду, релізу й детектора знайдено менше двох різних кадрів.${hint}`, matched_count: matches.length }, { status: 404 });
    }
    const retrievedAt = new Date().toISOString();
    const sourceSha256 = await digest(table);
    const timeMatches = matches.map(record => ({ ...record, mjd: (record.mjd_start + record.mjd_end) / 2 }));
    const chosen = allRequested ? timeMatches : selectAcrossTime(timeMatches, Math.min(maxFrames * 3, 72));
    const selected = chosen.map(record => ({
      id: record.observation + "D" + detector,
      observation: record.observation,
      detector,
      mjd: record.mjd,
      band: `D${detector}`,
      exposure_s: record.exposure_s,
      url: record.url,
      release: record.release,
      target_ra: record.target_ra,
      target_dec: record.target_dec,
    }));
    const centre = selected[Math.floor(selected.length / 2)];
    const most = { source: "IRSA MOST", source_url: sourceUrl, source_sha256: sourceSha256, target_name: name, catalog: "spherex", retrieved_at: retrievedAt, match_count: matches.length };
    const query = centre ? validateFieldQuery({
      ra: centre.target_ra, dec: centre.target_dec, start, end, detector,
      fov: p.fov, max_frames: maxFrames, wavelength_min: p.wavelength_min, wavelength_max: p.wavelength_max,
      release, survey: "most", most,
    }) : null;
    return Response.json({
      query, records: selected, matched_count: matches.length, candidate_count: selected.length,
      catalogue_truncated: catalogueTruncated, source_url: sourceUrl, source_sha256: sourceSha256,
      retrieved_at: retrievedAt,
      selection: allRequested ? "All deduplicated IRSA MOST matches for the selected period, detector and product release. Per-row ra_obj/dec_obj are retained as service-reported matched positions; the response does not provide a separate coordinate epoch or uncertainty." : "IRSA MOST SPHEREx matches restricted to the selected detector and product release, deduplicated by FITS URI and sampled across MJD. Per-row ra_obj/dec_obj are retained as the service-reported matched positions; the response does not provide a separate coordinate epoch or uncertainty.",
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Не вдалося виконати пошук IRSA MOST.";
    const inputError = /Уведіть|Укажіть|Оберіть|період не довший|Кінцева дата|90 днів|ширина поля|межі довжини хвилі/i.test(message);
    return Response.json({ error: message }, { status: inputError ? 400 : 502 });
  }
}

export async function POST(request: Request) {
  try { return await search(await request.json()); }
  catch { return Response.json({ error: "Не вдалося прочитати параметри IRSA MOST." }, { status: 400 }); }
}
