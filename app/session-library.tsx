"use client";
import { useTranslation } from "@/lib/language";
import {useCallback, useEffect, useRef, useState} from "react";
import {Download, FolderOpen, LoaderCircle, Save, Trash2, Upload, X} from "lucide-react";
import {Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger} from "@/components/ui/dialog";
import {cleanupOrphanAssets, deleteSession, listSessions, loadSession, saveSession, storageSummary, type SavedSession, type SessionSummary, type SessionView} from "@/lib/sessions";
import {exportSessionBundle, importSessionBundle} from "@/lib/session-bundle";
import type {Manifest} from "@/lib/science";

type Props = {manifest: Manifest|null; view: SessionView|null; currentSessionId: string|null; onLoad: (session: SavedSession) => void|Promise<void>; onSaved?: (session: SavedSession)=>void; refreshKey?:number};
const bytesLabel = (value:number) => value >= 1024**3 ? `${(value/1024**3).toFixed(2)} GiB` : `${(value/1024**2).toFixed(1)} MiB`;

export default function SessionLibrary({manifest,view,currentSessionId,onLoad,onSaved,refreshKey}: Props) {
  const t = useTranslation();
  const [open,setOpen] = useState(false), [sessions,setSessions] = useState<SessionSummary[]>([]);
  const [usage,setUsage] = useState<Awaited<ReturnType<typeof storageSummary>>|null>(null);
  const [busy,setBusy] = useState(false), [error,setError] = useState(""), [status,setStatus] = useState("");
  const controller = useRef<AbortController|null>(null), importer = useRef<HTMLInputElement>(null);
  const refresh = useCallback(async () => {const [saved,storage]=await Promise.all([listSessions(),storageSummary()]);setSessions(saved);setUsage(storage);},[]);
  useEffect(() => {
    if(!open)return;
    let active=true;
    Promise.all([listSessions(),storageSummary()]).then(([saved,storage])=>{
      if(active){setSessions(saved);setUsage(storage);}
    }).catch(e=>{if(active)setError(e instanceof Error?e.message:t("Не вдалося прочитати бібліотеку."));});
    return()=>{active=false;};
  },[open,refreshKey]);
  useEffect(() => () => controller.current?.abort(),[]);
  async function action(operation: (signal:AbortSignal)=>Promise<void>) {
    if(busy)return;
    const current = new AbortController(); controller.current=current;setBusy(true);setError("");setStatus("");
    try {await operation(current.signal);await refresh();}
    catch(e) {setError(e instanceof Error&&e.name==="AbortError"?t("Дію скасовано."):e instanceof Error?e.message:t("Не вдалося виконати дію."));}
    finally {controller.current=null;setBusy(false);}
  }
  async function exportCurrent(signal:AbortSignal) {
    if(!manifest||!view)return;
    const blob=await exportSessionBundle(manifest,view,{signal,onProgress:p=>setStatus(`${t(p.detail)}: ${p.completed} / ${p.total}`)});
    signal.throwIfAborted();
    const url=URL.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download=`spherex-${manifest.frames[0].id}.spherex`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    setStatus(t("Пакет підготовлено: {0}. Він містить паспорт і всі PNG-шари.", bytesLabel(blob.size)));
  }
  async function importFile(file?:File) {
    if(!file)return;
    await action(async signal=>{const saved=await importSessionBundle(file,{signal,onProgress:p=>setStatus(`${t(p.detail)}: ${p.completed} / ${p.total}`)});await onLoad(saved);setStatus(t("Імпортовано {0} кадрів із перевіркою SHA-256.", saved.manifest.frames.length));});
  }
  return <Dialog open={open} onOpenChange={value=>{if(!value)controller.current?.abort();setOpen(value);}}>
    <DialogTrigger asChild><button type="button" className="button session-library-trigger"><FolderOpen size={17}/>{t("Локальні сесії")}</button></DialogTrigger>
    <DialogContent className="archive-dialog session-library-dialog" showCloseButton={false}>
      <DialogClose className="dialog-close" aria-label={t("Закрити")}><X size={18}/></DialogClose>
      <DialogHeader><DialogTitle>{t("Локальні сесії")}</DialogTitle><DialogDescription>{t("Серії та стан перегляду зберігаються у цьому браузері. Пакет .spherex переносить паспорт і PNG на інший пристрій; вихідні FITS залишаються за посиланнями в паспорті.")}</DialogDescription></DialogHeader>
      <div className="session-library-actions">
        <button className="button" disabled={busy||!manifest||!view} onClick={()=>void action(async()=>{if(manifest&&view){const saved=await saveSession(manifest,view,currentSessionId??undefined);onSaved?.(saved);setStatus(t("Поточну сесію збережено."));}})}><Save size={16}/>{t("Зберегти поточну")}</button>
        <button className="button" disabled={busy||!manifest||!view} onClick={()=>void action(exportCurrent)}><Download size={16}/>{t("Експорт пакета")}</button>
        <button className="button" disabled={busy} onClick={()=>importer.current?.click()}><Upload size={16}/>{t("Імпорт пакета")}</button>
        <input ref={importer} type="file" accept=".spherex,application/x-spherex-session" hidden aria-label={t("Імпорт пакета SPHEREx")} onChange={event=>{const file=event.currentTarget.files?.[0];event.currentTarget.value="";void importFile(file);}}/>
      </div>
      {busy&&<p className="session-library-progress" role="status"><LoaderCircle className="animate-spin" size={16}/>{status||t("Обробка локальної сесії…")}<button className="button" onClick={()=>controller.current?.abort()}>{t("Скасувати")}</button></p>}
      {!busy&&status&&<p className="session-library-status" role="status">{t(status)}</p>}
      {error&&<p className="error-message" role="alert">{t(error)}</p>}
      <div className="saved-sessions" aria-label={t("Збережені сесії")}>
        {sessions.length===0?<p>{t("Збережених сесій поки немає.")}</p>:sessions.map(session=><div key={session.id} className={`saved-session ${session.id===currentSessionId?"is-current":""}`}>
          <div><strong>{t(session.title)}</strong><small>{session.frame_count} {t("кадрів ·")} {session.updated_at.slice(0,19).replace("T"," ")} UTC{session.id===currentSessionId?t(" · відкрита"):""}</small></div>
          <button className="button" disabled={busy||session.id===currentSessionId} onClick={()=>void action(async()=>{await onLoad(await loadSession(session.id));setStatus(t("Сесію відкрито."));})}><FolderOpen size={15}/>{t("Відкрити")}</button>
          <button className="button" disabled={busy||session.id===currentSessionId} title={session.id===currentSessionId?t("Спочатку відкрийте іншу сесію"):t("Видалити сесію та її зображення, якщо вони більше ніде не використовуються")} aria-label={t("Видалити сесію {0}", session.title)} onClick={()=>void action(async()=>{await deleteSession(session.id);setStatus(t("Сесію видалено."));})}><Trash2 size={15}/></button>
        </div>)}
      </div>
      {usage&&<p className="session-storage">{t("PNG у бібліотеці:")} {bytesLabel(usage.pngBytes)} · {usage.pngCount} {t("унікальних файлів.")}{usage.usage!==undefined&&<> {t("Усі дані сайту:")} {bytesLabel(usage.usage)}{usage.quota!==undefined&&" "+t("з доступної квоти {0}", bytesLabel(usage.quota))}{t(". Квоту визначає браузер.")}</>}</p>}
      <button className="button session-cleanup" disabled={busy} onClick={()=>void action(async()=>{const result=await cleanupOrphanAssets();setStatus(t("Прибрано {0} незв’язаних PNG ({1}). Збережені сесії та незавершені обчислення захищені.", result.deleted, bytesLabel(result.bytes)));})}><Trash2 size={15}/>{t("Прибрати незв’язані зображення")}</button>
      <p className="detail-note">{t("JSON-паспорт описує походження даних. Пакет .spherex додатково містить зображення для повторного перегляду. Контрольні суми виявляють пошкодження; вони не засвідчують авторство файлу. Ліміт пакета: 2 GiB.")}</p>
    </DialogContent>
  </Dialog>;
}
