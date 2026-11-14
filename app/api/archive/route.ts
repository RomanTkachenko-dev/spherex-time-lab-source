import { fetchIrsaCatalogue, irsaCatalogueErrorResponse } from "@/lib/irsa-catalogue";
import { validateArchiveScope, type ArchiveScope } from "@/lib/field-query";
export async function GET(request:Request){
  const input=new URL(request.url).searchParams;
  let scope: ArchiveScope;
  try{scope=validateArchiveScope(Object.fromEntries(input));}
  catch(e){return Response.json({error:e instanceof Error?e.message:"Некоректний реліз або огляд."},{status:400})}
  if (scope.release === "qr2") return Response.json({error:"QR2 більше не доступний для пошуку IRSA. Оберіть DR1 або QR3; збережені серії QR2 залишаються доступними.",code:"RELEASE_RETIRED"},{status:410});
  const ra=Number(input.get("ra")),dec=Number(input.get("dec"));
  if(!input.get("ra")?.trim()||!input.get("dec")?.trim()||!Number.isFinite(ra)||!Number.isFinite(dec)||ra<0||ra>=360||dec< -90||dec>90)return Response.json({error:"RA має бути від 0° включно до 360° виключно, Dec — від −90° до 90°."},{status:400});
  const params=new URLSearchParams({POS:`CIRCLE ${ra} ${dec} 0.005`,COLLECTION:scope.collection,MAXREC:"60"});
  const start=input.get("start"),end=input.get("end");
  if(start||end){
    if(!start||!end||!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end))return Response.json({error:"Укажіть обидві дати у форматі РРРР-ММ-ДД."},{status:400});
    const a=Date.parse(start+"T00:00:00Z"),b=Date.parse(end+"T00:00:00Z");
    if(!Number.isFinite(a)||!Number.isFinite(b)||b<a||new Date(a).toISOString().slice(0,10)!==start||new Date(b).toISOString().slice(0,10)!==end)return Response.json({error:"Некоректний інтервал дат."},{status:400});
    params.set("TIME",`${a/86400000+40587} ${b/86400000+40588}`);
  }
  const url="https://irsa.ipac.caltech.edu/SIA?"+params;
  try{
    const {parsed}=await fetchIrsaCatalogue(url,{timeoutMs:25000});
    const optionalNumber=(s:string|undefined)=>s?.trim()&&Number.isFinite(Number(s))?Number(s):null;
    const urlPattern=new RegExp(`^https:\\/\\/irsa\\.ipac\\.caltech\\.edu\\/ibe\\/data\\/spherex\\/${scope.release}\\/level2\\/.+\\.fits$`);
    const records=parsed.rows.filter(r=>r.obs_collection===scope.collection && optionalNumber(r.t_min)!==null && typeof r.access_url==='string'&&urlPattern.test(r.access_url)).map(r=>({
      id:r.obs_publisher_did,observation:r.obs_id,release:r.obs_collection,
      mjd:Number(r.t_min),mjd_end:optionalNumber(r.t_max),
      wavelength_min_um:optionalNumber(r.em_min)===null?null:Number(r.em_min)*1e6,wavelength_max_um:optionalNumber(r.em_max)===null?null:Number(r.em_max)*1e6,
      band:r.energy_bandpassname,exposure_s:optionalNumber(r.t_exptime),
      url:r.access_url,format:r.access_format
    })).filter(r=>Number.isFinite(r.mjd)&&r.url.startsWith("https://irsa.ipac.caltech.edu/")).sort((a,b)=>a.mjd-b.mjd);
    return Response.json({records,truncated:parsed.overflow||records.length>=60,source_url:url,query:{ra,dec,radius_deg:0.005,release:scope.release,survey:scope.survey,collection:scope.collection},retrieved_at:new Date().toISOString()},{headers:{"Cache-Control":"public, max-age=300"}});
  }catch(e){return irsaCatalogueErrorResponse(e)}
}
