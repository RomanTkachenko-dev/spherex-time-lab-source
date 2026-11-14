export type SesameProperMotion = {
  pm_ra_masyr: number;
  pm_dec_masyr: number;
  /** SIMBAD publishes ICRS coordinates at epoch J2000.0; Sesame itself does not state the epoch. */
  epoch_jyear: 2000;
  reference: string | null;
};
export type SesameTarget = {
  canonical_name: string;
  ra: number;
  dec: number;
  object_type: string | null;
  reference_position: string | null;
  resolver: string;
  proper_motion: SesameProperMotion | null;
};

function xmlValue(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!match) return null;
  return match[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
}

/** First resolver block of a CDS Sesame XML reply (`-oxp`) with valid J2000 coordinates. */
export function parseSesameXml(xml: string, fallbackName: string): SesameTarget | null {
  for (const block of xml.matchAll(/<Resolver\b([^>]*)>([\s\S]*?)<\/Resolver>/gi)) {
    const rawRa = xmlValue(block[2], "jradeg"), rawDec = xmlValue(block[2], "jdedeg");
    if (!rawRa || !rawDec) continue;
    const ra = Number(rawRa), dec = Number(rawDec);
    if (!Number.isFinite(ra) || ra < 0 || ra >= 360 || !Number.isFinite(dec) || dec < -90 || dec > 90) continue;
    const resolver = block[1].match(/\bname\s*=\s*["']([^"']+)["']/i)?.[1]?.replace(/&amp;/g, "&") ?? "CDS Sesame";
    // Only SIMBAD documents the J2000.0 epoch of its coordinates; other resolvers are not propagated.
    const motion = /^S\w*=\s*Simbad/i.test(resolver) ? block[2].match(/<pm\b[^>]*>([\s\S]*?)<\/pm>/i)?.[1] : undefined;
    const rawPmRa = motion ? xmlValue(motion, "pmRA") : null, rawPmDec = motion ? xmlValue(motion, "pmDE") : null;
    const pmRa = Number(rawPmRa), pmDec = Number(rawPmDec);
    const proper_motion: SesameProperMotion | null = motion && rawPmRa && rawPmDec && Number.isFinite(pmRa) && Number.isFinite(pmDec)
      ? { pm_ra_masyr: pmRa, pm_dec_masyr: pmDec, epoch_jyear: 2000, reference: xmlValue(motion, "r") }
      : null;
    return {
      canonical_name: xmlValue(block[2], "oname") || xmlValue(block[2], "name") || fallbackName,
      ra, dec,
      object_type: xmlValue(block[2], "otype"),
      reference_position: xmlValue(block[2], "refPos"),
      resolver,
      proper_motion,
    };
  }
  return null;
}

/** Canonical Sesame query URL for an object name; provenance is derived, never client-supplied. */
export function sesameUrl(name: string) {
  return "https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SN?" + encodeURIComponent(name).replace(/%20/g, "+");
}
