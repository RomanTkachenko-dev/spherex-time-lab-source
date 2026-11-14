import { cutoutRequest } from "@/lib/field-query";
export async function GET(request: Request) {
  let url: string;
  try { url = cutoutRequest(Object.fromEntries(new URL(request.url).searchParams)); }
  catch (e) { return Response.json({ error: e instanceof Error ? e.message : "Некоректний запит." }, { status: 400 }); }
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(90000), headers: { Accept: "application/fits" } });
    if (!response.ok || !response.body) return Response.json({ error: "IRSA не повернув FITS-вирізку. Спробуйте пізніше." }, { status: 502 });
    const limit = 20 * 1024 * 1024;
    if (Number(response.headers.get("Content-Length")) > limit) return Response.json({ error: "Вирізка завелика для цієї версії. Зменште поле." }, { status: 413 });
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > limit) { await reader.cancel(); return Response.json({ error: "Вирізка завелика. Зменште поле." }, { status: 413 }); } chunks.push(value); }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    if (new TextDecoder().decode(bytes.subarray(0,9)) !== "SIMPLE  =") return Response.json({ error: "Відповідь архіву не є FITS-файлом." }, { status: 502 });
    return new Response(bytes, { headers: { "Content-Type": "application/fits", "Cache-Control": "public, max-age=86400", "X-Source-URL": url, "X-Retrieved-At": new Date().toISOString(), "X-Content-Type-Options": "nosniff" } });
  } catch (error) { console.error("IRSA cutout request failed", error); return Response.json({ error: "Не вдалося завантажити вирізку з IRSA. Запит можна повторити." }, { status: 502 }); }
}
