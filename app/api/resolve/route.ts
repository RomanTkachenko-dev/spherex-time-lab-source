import { parseSesameXml, SESAME_MIRRORS, sesameUrl } from "@/lib/sesame";

export async function GET(request: Request) {
  const name = new URL(request.url).searchParams.get("name")?.trim() ?? "";
  if (!name || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name)) {
    return Response.json({ error: "Введіть назву астрономічного об’єкта (до 128 символів)." }, { status: 400 });
  }

  let source = sesameUrl(name), response: Response | null = null, reachable = false;
  for (let mirror = 0; mirror < SESAME_MIRRORS.length; mirror++) {
    source = sesameUrl(name, mirror);
    try {
      const attempt = await fetch(source, { signal: AbortSignal.timeout(3000), headers: { Accept: "application/xml, text/xml", "User-Agent": "SPHEREx-Time-Lab/1.0 (+https://github.com/RomanTkachenko-dev/spherex-time-lab-source)" } });
      reachable = true;
      if (attempt.ok) { response = attempt; break; }
      await attempt.body?.cancel();
    } catch { /* try the next mirror */ }
  }
  if (!response) {
    return Response.json({ error: reachable ? "Служба астрономічних назв тимчасово недоступна." : "Не вдалося зв’язатися зі службою астрономічних назв. Спробуйте ще раз або введіть RA та Dec вручну." }, { status: 502 });
  }
  try {
    const declaredLength = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(declaredLength) && declaredLength > 128_000) {
      return Response.json({ error: "Служба астрономічних назв тимчасово недоступна." }, { status: 502 });
    }
    const xml = await response.text();
    if (xml.length > 128_000) return Response.json({ error: "Відповідь служби назв перевищує ліміт." }, { status: 502 });
    const target = parseSesameXml(xml, name);
    if (target) {
      return Response.json({
        query_name: name,
        ...target,
        resolver_url: source,
        service: "CDS Sesame",
        retrieved_at: new Date().toISOString(),
      }, { headers: { "Cache-Control": "public, max-age=3600" } });
    }
    return Response.json({ error: `Не вдалося розпізнати «${name}». Перевірте написання або введіть RA та Dec вручну.` }, { status: 404 });
  } catch {
    return Response.json({ error: "Не вдалося зв’язатися зі службою астрономічних назв. Спробуйте ще раз або введіть RA та Dec вручну." }, { status: 502 });
  }
}
