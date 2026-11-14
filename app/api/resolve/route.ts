import { parseSesameXml, sesameUrl } from "@/lib/sesame";

export async function GET(request: Request) {
  const name = new URL(request.url).searchParams.get("name")?.trim() ?? "";
  if (!name || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name)) {
    return Response.json({ error: "Введіть назву астрономічного об’єкта (до 128 символів)." }, { status: 400 });
  }

  const source = sesameUrl(name);
  try {
    const response = await fetch(source, { signal: AbortSignal.timeout(10000), headers: { Accept: "application/xml, text/xml" } });
    const declaredLength = Number(response.headers.get("Content-Length"));
    if (!response.ok || (Number.isFinite(declaredLength) && declaredLength > 128_000)) {
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
