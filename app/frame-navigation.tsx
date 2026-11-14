"use client";
import { useState, type FormEvent } from "react";
import { nearestFrameIndexAtMjd, type Frame } from "@/lib/science";

export default function FrameNavigation({frames,index,reference,compare,onSelect,onReference}:{frames:Frame[];index:number;reference:number;compare:boolean;onSelect:(index:number)=>void;onReference:(index:number)=>void}) {
  const [notice,setNotice]=useState("");
  function jump(event:FormEvent<HTMLFormElement>,target:"frame"|"reference"|"utc") {
    event.preventDefault();
    const value=String(new FormData(event.currentTarget).get("position")??"");
    if(target==="utc") {
      const milliseconds=Date.parse(value+"Z");
      if(!Number.isFinite(milliseconds)){setNotice("Введіть коректну дату й час UTC.");return;}
      const selected=nearestFrameIndexAtMjd(frames,milliseconds/86400000+40587);
      onSelect(selected);setNotice(`Найближчий кадр: ${selected+1} · ${frames[selected].date.replace(/Z$/,"")} UTC.`);
    } else {
      const selected=Number(value);
      if(!Number.isInteger(selected)||selected<1||selected>frames.length){setNotice(`Номер має бути від 1 до ${frames.length}.`);return;}
      if(target==="reference")onReference(selected-1);else onSelect(selected-1);
      setNotice("");
    }
  }
  return <div className="precise-navigation">
    <form onSubmit={event=>jump(event,"frame")}><label htmlFor="frame-number">Номер кадру</label><div><input key={`frame-${index}`} id="frame-number" name="position" type="number" min={1} max={frames.length} step={1} defaultValue={index+1} required/><button className="button" type="submit">Перейти</button></div></form>
    <form onSubmit={event=>jump(event,"utc")}><label htmlFor="frame-utc">Найближчий до часу UTC</label><div><input key={`utc-${index}`} id="frame-utc" name="position" type="datetime-local" step="0.001" defaultValue={frames[index].date.replace(/Z$/,"")} required/><button className="button" type="submit">Знайти</button></div></form>
    {compare&&<form onSubmit={event=>jump(event,"reference")}><label htmlFor="reference-number">Номер опорного кадру</label><div><input key={`reference-${reference}`} id="reference-number" name="position" type="number" min={1} max={frames.length} step={1} defaultValue={reference+1} required/><button className="button" type="submit">Обрати</button></div></form>}
    {notice&&<p role="status">{notice}</p>}
  </div>;
}
