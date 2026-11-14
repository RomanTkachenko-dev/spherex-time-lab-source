// Deliberately limited to the TABLEDATA encoding returned by IRSA SIA.
// No XML entity expansion, external documents, or executable content are accepted.
function decode(s:string){return s.replace(/&(?:amp|lt|gt|quot|apos);/g,e=>({"&amp;":"&","&lt;":"<","&gt;":">","&quot;":'"',"&apos;":"'"}[e]!)).replace(/&#(x[\da-f]+|\d+);/gi,(_,n)=>{const v=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):parseInt(n,10);return v>=0&&v<=0x10ffff?String.fromCodePoint(v):""})}
export function parseVOTable(xml:string){
  if(xml.length>5_000_000||/<!DOCTYPE|<!ENTITY/i.test(xml))throw Error("Непідтримувана відповідь архіву.");
  const statuses=[...xml.matchAll(/<INFO\b([^>]*)>/gi)].filter(m=>/\bname=["']QUERY_STATUS["']/i.test(m[1])).map(m=>m[1].match(/\bvalue=["']([^"']+)["']/i)?.[1].toUpperCase());
  if(statuses.includes("ERROR"))throw Error("Архів не зміг виконати цей запит.");
  const table=xml.match(/<TABLE(?:\s[^>]*)?>([\s\S]*?)<\/TABLE>/i)?.[1];
  if(!table||!/<TABLEDATA\b/i.test(table))throw Error("Архів повернув непідтримуваний формат.");
  const fields=[...table.matchAll(/<FIELD\b([^>]*)>/gi)].map(m=>decode(m[1].match(/\bname=["']([^"']+)["']/i)?.[1]||m[1].match(/\bID=["']([^"']+)["']/i)?.[1]||""));
  if(!fields.length||fields.some(f=>!f)||new Set(fields).size!==fields.length)throw Error("У метаданих відсутні або повторюються назви полів.");
  const rows=[...table.matchAll(/<TR\b[^>]*>([\s\S]*?)<\/TR>/gi)].map(m=>{
    const values=[...m[1].matchAll(/<TD(?:\s[^>]*)?\s*\/>|<TD(?:\s[^>]*)?>([\s\S]*?)<\/TD>/gi)].map(v=>decode((v[1]||"").trim()));
    if(values.length!==fields.length)throw Error("Рядок архіву містить неузгоджені поля.");
    return Object.fromEntries(fields.map((f,i)=>[f,values[i]]));
  });
  return {rows,overflow:statuses.includes("OVERFLOW")};
}
