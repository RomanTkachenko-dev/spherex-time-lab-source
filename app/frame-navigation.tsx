"use client";
import { useTranslation } from "@/lib/language";
import { useState, type FormEvent } from "react";
import { nearestFrameIndexAtMjd, type Frame } from "@/lib/science";

export default function FrameNavigation({frames,index,reference,compare,onSelect,onReference}:{frames:Frame[];index:number;reference:number;compare:boolean;onSelect:(index:number)=>void;onReference:(index:number)=>void}) {
  const t = useTranslation();
  const [notice,setNotice]=useState("");
  function jump(event:FormEvent<HTMLFormElement>,target:"frame"|"reference"|"utc") {
    event.preventDefault();
    const value=String(new FormData(event.currentTarget).get("position")??"");
    if(target==="utc") {
      const milliseconds=Date.parse(value+"Z");
      if(!Number.isFinite(milliseconds)){setNotice(t("Enter a valid UTC date and time."));return;}
      const selected=nearestFrameIndexAtMjd(frames,milliseconds/86400000+40587);
      onSelect(selected);setNotice(t("Nearest exposure: {n} · {date} UTC.",{n:selected+1,date:frames[selected].date.replace(/Z$/,"")}));
    } else {
      const selected=Number(value);
      if(!Number.isInteger(selected)||selected<1||selected>frames.length){setNotice(t("Enter a number from 1 to {max}.",{max:frames.length}));return;}
      if(target==="reference")onReference(selected-1);else onSelect(selected-1);
      setNotice("");
    }
  }
  return <div className="precise-navigation">
    <form onSubmit={event=>jump(event,"frame")}><label htmlFor="frame-number">{t("Exposure number")}</label><div><input key={`frame-${index}`} id="frame-number" name="position" type="number" min={1} max={frames.length} step={1} defaultValue={index+1} required/><button className="button" type="submit">{t("Go")}</button></div></form>
    <form onSubmit={event=>jump(event,"utc")}><label htmlFor="frame-utc">{t("Nearest to a UTC time")}</label><div><input key={`utc-${index}`} id="frame-utc" name="position" type="datetime-local" step="0.001" defaultValue={frames[index].date.replace(/Z$/,"")} required/><button className="button" type="submit">{t("Find")}</button></div></form>
    {compare&&<form onSubmit={event=>jump(event,"reference")}><label htmlFor="reference-number">{t("Reference exposure number")}</label><div><input key={`reference-${reference}`} id="reference-number" name="position" type="number" min={1} max={frames.length} step={1} defaultValue={reference+1} required/><button className="button" type="submit">{t("Select")}</button></div></form>}
    {notice&&<p role="status">{notice}</p>}
  </div>;
}
