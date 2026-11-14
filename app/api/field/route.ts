import { fetchIrsaCatalogue, irsaCatalogueErrorResponse } from "@/lib/irsa-catalogue";
import { containsSRegion, interpolateEphemeris, summarizeTrack } from "@/lib/ephemeris";
import { selectAcrossTime, validateArchiveScope, validateFieldQuery } from "@/lib/field-query";
import { MAX_CATALOGUE_CHUNK_FRAMES } from "@/lib/catalogue-batches";

async function search(input: unknown) {
  let query;
  try { query = validateFieldQuery(input); }
  catch(e) { return Response.json({ error: e instanceof Error ? e.message : "Некоректний запит." }, { status: 400 }); }
  if (query.release === "qr2") return Response.json({error:"QR2 більше не доступний для пошуку IRSA. Оберіть DR1 або QR3; збережені серії QR2 залишаються доступними.",code:"RELEASE_RETIRED"},{status:410});
  if (query.most) return Response.json({ error: "Для ефемериди IRSA MOST використовуйте маршрут пошуку рухомих об’єктів." }, { status: 400 });
  const a = Date.parse(query.start + "T00:00:00Z") / 86400000 + 40587;
  const b = Date.parse(query.end + "T00:00:00Z") / 86400000 + 40588;
  const scope = validateArchiveScope(query);
  const track = query.ephemeris;
  const radius = track ? summarizeTrack(track.points).radius_deg + 0.000001 : 0.000001;
  const params = new URLSearchParams({ POS: `CIRCLE ${query.ra} ${query.dec} ${radius}`, COLLECTION: scope.collection, MAXREC: "1000", TIME: `${a} ${b}` });
  if (query.wavelength_min !== null && query.wavelength_max !== null) params.set("BAND", `${query.wavelength_min * 1e-6} ${query.wavelength_max * 1e-6}`);
  const source_url = "https://irsa.ipac.caltech.edu/SIA?" + params;
  try {
    const { xml, parsed } = await fetchIrsaCatalogue(source_url);
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(xml));
    const source_sha256 = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2,"0")).join("");
    const seen = new Set<string>();
    const urlPattern = new RegExp(`^https:\\/\\/irsa\\.ipac\\.caltech\\.edu\\/ibe\\/data\\/spherex\\/${query.release}\\/level2\\/.+\\.fits$`);
    const records = parsed.rows.filter(r => r.energy_bandpassname === "SPHEREx-D" + query.detector && r.obs_collection === scope.collection && r.t_min?.trim() && Number.isFinite(Number(r.t_min)) && typeof r.access_url === "string" && urlPattern.test(r.access_url)).flatMap(r => {
      const t0 = Number(r.t_min), t1 = r.t_max?.trim() && Number.isFinite(Number(r.t_max)) ? Number(r.t_max) : t0;
      const mjd = (t0 + t1) / 2;
      const target = track ? interpolateEphemeris(track.points, mjd) : null;
      if (track && (!target || !containsSRegion(r.s_region, target.ra, target.dec))) return [];
      const key = String(r.obs_id) + "/D" + query.detector;
      if (seen.has(key)) return [];
      seen.add(key);
      const record = { id: r.obs_publisher_did, observation: r.obs_id, detector: query.detector, mjd, url: r.access_url, release: r.obs_collection, s_region: r.s_region };
      return target ? [{ ...record, target_ra: target.ra, target_dec: target.dec }] : [record];
    }).sort((a,b) => a.mjd - b.mjd || a.id.localeCompare(b.id));
    const catalogueTruncated = parsed.overflow || parsed.rows.length >= 1000;
    const allRequested = query.max_frames >= MAX_CATALOGUE_CHUNK_FRAMES;
    if (allRequested && catalogueTruncated) return Response.json({ error: "IRSA обмежив відповідь 1000 записами; часовий інтервал потрібно розбити." }, { status: 413 });
    if (allRequested && records.length > MAX_CATALOGUE_CHUNK_FRAMES) return Response.json({ error: `Знайдено ${records.length} збігів за інтервал. Архівне вікно перевищило ліміт ${MAX_CATALOGUE_CHUNK_FRAMES} кадрів і потребує розбиття.` }, { status: 413 });
    const candidateLimit = allRequested ? records.length : track ? Math.min(query.max_frames * 2, 48) : query.max_frames;
    const selected = allRequested ? records : selectAcrossTime(records, candidateLimit);
    const selection = allRequested
      ? "All deduplicated catalogue matches for the selected dates, release, survey, detector and spatial criterion; FITS/WCS/wavelength failures are reported separately during processing."
      : track
        ? "Candidate exposures sampled across MJD from the SIA cone enclosing the supplied ephemeris; exact target position is interpolated at catalogue exposure midpoint and rechecked against FITS DATE-AVG/WCS before inclusion."
        : "nearest observations to linearly spaced MJD targets across the chronological, release- and survey-filtered catalogue; ties resolved by catalogue order; wavelength-at-centre filter applied after download";
    return Response.json({ query, records: selected, matched_count: records.length, candidate_count: selected.length, catalogue_truncated: catalogueTruncated, source_url, source_sha256, retrieved_at: new Date().toISOString(), selection }, { headers: { "Cache-Control": "public, max-age=300" } });
  } catch (error) { return irsaCatalogueErrorResponse(error); }
}

export async function GET(request: Request) { return search(Object.fromEntries(new URL(request.url).searchParams)); }
export async function POST(request: Request) {
  try { return await search(await request.json()); }
  catch { return Response.json({ error: "Не вдалося прочитати параметри часового ряду." }, { status: 400 }); }
}
