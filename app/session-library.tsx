"use client";
import {useCallback, useEffect, useRef, useState} from "react";
import {Download, FolderOpen, LoaderCircle, Save, Trash2, Upload, X} from "lucide-react";
import {Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger} from "@/components/ui/dialog";
import {cleanupOrphanAssets, deleteSession, listSessions, loadSession, saveSession, storageSummary, type SavedSession, type SessionSummary, type SessionView} from "@/lib/sessions";
import {exportSessionBundle, importSessionBundle} from "@/lib/session-bundle";
import type {Manifest} from "@/lib/science";
import {useMessage, useTranslation} from "@/lib/language";

type Props = {manifest: Manifest|null; view: SessionView|null; currentSessionId: string|null; onLoad: (session: SavedSession) => void|Promise<void>; onSaved?: (session: SavedSession)=>void; refreshKey?:number};
const bytesLabel = (value:number) => value >= 1024**3 ? `${(value/1024**3).toFixed(2)} GiB` : `${(value/1024**2).toFixed(1)} MiB`;

export default function SessionLibrary({manifest,view,currentSessionId,onLoad,onSaved,refreshKey}: Props) {
  const t = useTranslation(), msg = useMessage();
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
    }).catch(e=>{if(active)setError(e instanceof Error?e.message:t("Could not read the library."));});
    return()=>{active=false;};
    // t only changes with the language; reloading the list is not needed for that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[open,refreshKey]);
  useEffect(() => () => controller.current?.abort(),[]);
  async function action(operation: (signal:AbortSignal)=>Promise<void>) {
    if(busy)return;
    const current = new AbortController(); controller.current=current;setBusy(true);setError("");setStatus("");
    try {await operation(current.signal);await refresh();}
    catch(e) {setError(e instanceof Error&&e.name==="AbortError"?t("Cancelled."):e instanceof Error?e.message:t("Something went wrong. Please try again."));}
    finally {controller.current=null;setBusy(false);}
  }
  async function exportCurrent(signal:AbortSignal) {
    if(!manifest||!view)return;
    const blob=await exportSessionBundle(manifest,view,{signal,onProgress:p=>setStatus(`${p.detail}: ${p.completed} / ${p.total}`)});
    signal.throwIfAborted();
    const url=URL.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download=`spherex-${manifest.frames[0].id}.spherex`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    setStatus(t("Bundle ready: {size}. It contains the metadata and all PNG layers.",{size:bytesLabel(blob.size)}));
  }
  async function importFile(file?:File) {
    if(!file)return;
    await action(async signal=>{const saved=await importSessionBundle(file,{signal,onProgress:p=>setStatus(`${p.detail}: ${p.completed} / ${p.total}`)});await onLoad(saved);setStatus(t("Imported {n} exposures; SHA-256 checksums verified.",{n:saved.manifest.frames.length}));});
  }
  return <Dialog open={open} onOpenChange={value=>{if(!value)controller.current?.abort();setOpen(value);}}>
    <DialogTrigger asChild><button type="button" className="button session-library-trigger"><FolderOpen size={17}/>{t("Saved sessions")}</button></DialogTrigger>
    <DialogContent className="archive-dialog session-library-dialog" showCloseButton={false}>
      <DialogClose className="dialog-close" aria-label={t("Close")}><X size={18}/></DialogClose>
      <DialogHeader><DialogTitle>{t("Saved sessions")}</DialogTitle><DialogDescription>{t("Series and your view settings are saved in this browser. A .spherex bundle moves the metadata and images to another device; the original FITS files stay online, linked from the metadata.")}</DialogDescription></DialogHeader>
      <div className="session-library-actions">
        <button className="button" disabled={busy||!manifest||!view} onClick={()=>void action(async()=>{if(manifest&&view){const saved=await saveSession(manifest,view,currentSessionId??undefined);onSaved?.(saved);setStatus(t("Current session saved."));}})}><Save size={16}/>{t("Save current")}</button>
        <button className="button" disabled={busy||!manifest||!view} onClick={()=>void action(exportCurrent)}><Download size={16}/>{t("Export bundle")}</button>
        <button className="button" disabled={busy} onClick={()=>importer.current?.click()}><Upload size={16}/>{t("Import bundle")}</button>
        <input ref={importer} type="file" accept=".spherex,application/x-spherex-session" hidden aria-label={t("Import a SPHEREx bundle")} onChange={event=>{const file=event.currentTarget.files?.[0];event.currentTarget.value="";void importFile(file);}}/>
      </div>
      {busy&&<p className="session-library-progress" role="status"><LoaderCircle className="animate-spin" size={16}/>{msg(status)||t("Working on the local session…")}<button className="button" onClick={()=>controller.current?.abort()}>{t("Cancel")}</button></p>}
      {!busy&&status&&<p className="session-library-status" role="status">{msg(status)}</p>}
      {error&&<p className="error-message" role="alert">{msg(error)}</p>}
      <div className="saved-sessions" aria-label={t("Saved sessions")}>
        {sessions.length===0?<p>{t("No saved sessions yet. Open an example or build a series; it is saved here automatically.")}</p>:sessions.map(session=><div key={session.id} className={`saved-session ${session.id===currentSessionId?"is-current":""}`}>
          <div><strong>{msg(session.title)}</strong><small>{t("{n} exposures",{n:session.frame_count})} · {session.updated_at.slice(0,19).replace("T"," ")} UTC{session.id===currentSessionId?" · "+t("open now"):""}</small></div>
          <button className="button" disabled={busy||session.id===currentSessionId} onClick={()=>void action(async()=>{await onLoad(await loadSession(session.id));setStatus(t("Session opened."));})}><FolderOpen size={15}/>{t("Open")}</button>
          <button className="button" disabled={busy||session.id===currentSessionId} title={session.id===currentSessionId?t("Open another session first"):t("Delete this session and any images no other session uses")} aria-label={t("Delete session {title}",{title:msg(session.title)})} onClick={()=>void action(async()=>{await deleteSession(session.id);setStatus(t("Session deleted."));})}><Trash2 size={15}/></button>
        </div>)}
      </div>
      {usage&&<p className="session-storage">{t("Images in the library: {size} · {n} unique files.",{size:bytesLabel(usage.pngBytes),n:usage.pngCount})}{usage.usage!==undefined&&<> {t("All site data: {size}",{size:bytesLabel(usage.usage)})}{usage.quota!==undefined&&t(" of an available {quota}",{quota:bytesLabel(usage.quota)})}. {t("The browser sets the quota.")}</>}</p>}
      <button className="button session-cleanup" disabled={busy} onClick={()=>void action(async()=>{const result=await cleanupOrphanAssets();setStatus(t("Removed {n} unused PNGs ({size}). Saved sessions and unfinished jobs are protected.",{n:result.deleted,size:bytesLabel(result.bytes)}));})}><Trash2 size={15}/>{t("Remove unused images")}</button>
      <p className="detail-note">{t("The JSON metadata records where the data came from. A .spherex bundle also contains the images, so the session can be reopened. Checksums detect damage; they don't prove who made the file. Bundle limit: 2 GiB.")}</p>
    </DialogContent>
  </Dialog>;
}
