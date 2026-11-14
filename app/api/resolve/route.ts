function xmlValue(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!match) return null;
  return match[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
}

export async function GET(request: Request) {
  const name = new URL(request.url).searchParams.get("name")?.trim() ?? "";
  if (!name || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name)) {
    return Response.json({ error: "Введіть назву астрономічного об’єкта (до 128 символів)." }, { status: 400 });
  }

  const source = new URL("https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SN");
  source.search = encodeURIComponent(name).replace(/%20/g, "+");
  try {
    const response = await fetch(source, { signal: AbortSignal.timeout(10000), headers: { Accept: "application/xml, text/xml" } });
    const declaredLength = Number(response.headers.get("Content-Length"));
    if (!response.ok || (Number.isFinite(declaredLength) && declaredLength > 128_000)) {
      return Response.json({ error: "Служба астрономічних назв тимчасово недоступна." }, { status: 502 });
    }
    const xml = await response.text();
    if (xml.length > 128_000) return Response.json({ error: "Відповідь служби назв перевищує ліміт." }, { status: 502 });
    const blocks = [...xml.matchAll(/<Resolver\b([^>]*)>([\s\S]*?)<\/Resolver>/gi)];
    for (const block of blocks) {
      const rawRa = xmlValue(block[2], "jradeg");
      const rawDec = xmlValue(block[2], "jdedeg");
      if (!rawRa || !rawDec) continue;
      const ra = Number(rawRa);
      const dec = Number(rawDec);
      if (!Number.isFinite(ra) || ra < 0 || ra >= 360 || !Number.isFinite(dec) || dec < -90 || dec > 90) continue;
      const resolver = block[1].match(/\bname\s*=\s*["']([^"']+)["']/i)?.[1];
      return Response.json({
        query_name: name,
        canonical_name: xmlValue(block[2], "oname") || xmlValue(block[2], "name") || name,
        ra, dec,
        object_type: xmlValue(block[2], "otype"),
        reference_position: xmlValue(block[2], "refPos"),
        resolver: resolver?.replace(/&amp;/g, "&") ?? "CDS Sesame",
        resolver_url: source.toString(),
        service: "CDS Sesame",
      }, { headers: { "Cache-Control": "public, max-age=3600" } });
    }
    return Response.json({ error: `Не вдалося розпізнати «${name}». Перевірте написання або введіть RA та Dec вручну.` }, { status: 404 });
  } catch {
    return Response.json({ error: "Не вдалося зв’язатися зі службою астрономічних назв. Спробуйте ще раз або введіть RA та Dec вручну." }, { status: 502 });
  }
}
