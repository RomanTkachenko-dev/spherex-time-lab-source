import manifest from "@/public/data/atlas/manifest.json";
import { validateManifest } from "@/lib/science";

export async function POST(request: Request) {
  const reader=request.body?.getReader();
  if(!reader)return Response.json({error:"Паспорт відсутній."},{status:400});
  const maximumBytes=64*1024*1024;
  let size=0;const chunks:Uint8Array[]=[];
  try {
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maximumBytes){await reader.cancel();return Response.json({error:"Паспорт перевищив ліміт 64 MiB."},{status:413});}chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const text=new TextDecoder().decode(bytes);
    const contentType=request.headers.get("content-type")||"";
    const payload=contentType.includes("application/json")?JSON.parse(text):Object.fromEntries(new URLSearchParams(text));
    const dataset=validateManifest(typeof payload.manifest==="string"?JSON.parse(payload.manifest):payload.manifest);
    const view=typeof payload.view==="string"?JSON.parse(payload.view):payload.view;
    if(!view||!["sky","object"].includes(view.mode)||typeof view.compare!=="boolean"||!dataset.frames.some(f=>f.id===view.frame_id)||(view.compare&&!dataset.frames.some(f=>f.id===view.reference_id))||(dataset.kind==="field"&&view.mode==="object"&&!dataset.query?.most&&!dataset.query?.ephemeris))throw Error("Некоректний стан перегляду.");
    const report={exported_at:new Date().toISOString(),...((dataset.schema_version===4||dataset.display.asset_storage==="indexeddb-sha256-v1")?{display_assets:{embedded:false,storage:"IndexedDB у браузері, де побудовано серію",note:"Кожне посилання idb містить SHA-256 PNG. Вихідні FITS URL та SHA-256 залишаються у кадрах для повторної обробки."}}:{}),view:{frame_id:view.frame_id,mode:view.mode,compare:view.compare,reference_id:view.compare?view.reference_id:null,predicted_marker:dataset.kind!=="field"&&view.predicted_marker===true,centre_marker:dataset.kind==="field"&&view.centre_marker===true,quality_overlay:view.quality_overlay===true},dataset};
    return new Response(JSON.stringify(report),{headers:{"Content-Type":"application/json; charset=utf-8","Content-Disposition":`attachment; filename="spherex-${view.frame_id}.json"`,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
  } catch {return Response.json({error:"Не вдалося перевірити паспорт або параметри перегляду."},{status:400});}
  finally {reader.releaseLock();}
}

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const frame = manifest.frames.find(f => f.id === p.get("frame"));
  const reference = manifest.frames.find(f => f.id === p.get("reference"));
  const mode = p.get("mode"), compare = p.get("compare"), marker = p.get("marker"), quality = p.get("quality");
  if (!frame || !["sky", "object"].includes(mode ?? "") || !["true", "false"].includes(compare ?? "") || !["true", "false"].includes(marker ?? "") || !["true", "false"].includes(quality ?? "") || (compare === "true" && !reference)) {
    return Response.json({ error: "Некоректні параметри паспорта." }, { status: 400 });
  }
  const report = {
    exported_at: new Date().toISOString(),
    view: { frame_id: frame.id, mode, compare: compare === "true", reference_id: compare === "true" ? reference!.id : null, predicted_marker: marker === "true", quality_overlay: quality === "true" },
    dataset: manifest
  };
  return new Response(JSON.stringify(report, null, 2), { headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="spherex-${frame.id}.json"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  } });
}
