import test from "node:test";
import assert from "node:assert/strict";
import { parseSesameXml, sesameUrl } from "../lib/sesame.ts";
import { angularSeparationDeg, interpolateEphemeris, julianYearToMjd, properMotionTrack, propagateProperMotion } from "../lib/ephemeris.ts";
import { validateFieldQuery } from "../lib/field-query.ts";

const barnardXml = `<?xml version="1.0" encoding="UTF-8"?>
<Sesame><Target option="SN"><name>Barnard's Star</name>
<Resolver name="S=Simbad, IDIA (via url)"><INFO>from cache</INFO>
  <otype>BY*</otype><jpos>17:57:48.49 +04:41:36.1</jpos>
  <jradeg>269.4520769586187</jradeg><jdedeg>4.69336496657667</jdedeg>
  <refPos>2020yCat.1350....0G</refPos>
  <pm>
    <v>10393.349</v><e>0.048</e><q>A</q><r>2020yCat.1350....0G</r>
    <pa>355.577</pa>
    <pmRA>-801.551</pmRA><epmRA>0.032</epmRA>
    <pmDE>10362.394</pmDE><epmDE>0.036</epmDE>
  </pm>
  <oname>NAME Barnard's star</oname>
</Resolver></Target></Sesame>`;
const reference = { ra: 269.4520769586187, dec: 4.69336496657667, pm_ra_masyr: -798.6, pm_dec_masyr: 10328, epoch_jyear: 2000 };
const dates = { start: "2025-08-01", end: "2026-02-28" };
const model = { reference, model: "linear-proper-motion-v1", frame: "ICRS", time_scale: "UTC" };
const sesame = { ...model, source: "Proper motion (CDS Sesame)", source_url: sesameUrl("Barnard's Star"), target_name: "NAME Barnard's star", query_name: "Barnard's Star", resolver: "S=Simbad, IDIA (via url)", motion_reference: "2020yCat.1350....0G", retrieved_at: "2026-11-14T18:00:00Z" };
const field = { ...dates, detector: 5, fov: 0.12, max_frames: 4, release: "dr1", survey: "wide" };

test("Sesame parser returns SIMBAD proper motion at epoch J2000 and ignores it for other resolvers", () => {
  const target = parseSesameXml(barnardXml, "Barnard's Star");
  assert.equal(target?.canonical_name, "NAME Barnard's star");
  assert.deepEqual(target?.proper_motion, { pm_ra_masyr: -801.551, pm_dec_masyr: 10362.394, epoch_jyear: 2000, reference: "2020yCat.1350....0G" });
  assert.equal(target?.reference_position, "2020yCat.1350....0G");
  assert.equal(parseSesameXml(barnardXml.replace("S=Simbad, IDIA (via url)", "N=NED"), "x")?.proper_motion, null);
  assert.equal(parseSesameXml(barnardXml.replace(/<pm>[\s\S]*<\/pm>/, ""), "x")?.proper_motion, null);
  assert.equal(parseSesameXml(barnardXml.replace("<pmRA>-801.551</pmRA>", "<pmRA>fast</pmRA>"), "x")?.proper_motion, null);
  assert.equal(parseSesameXml("<Sesame><INFO>Nothing found</INFO></Sesame>", "x"), null);
  assert.equal(sesameUrl("Barnard's Star"), "https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SN?Barnard's+Star");
});

test("proper motion of (-798.6, +10328) mas/yr over 26 years moves the star about 268 arcsec in Dec", () => {
  const moved = propagateProperMotion(reference, julianYearToMjd(2026));
  assert.ok(Math.abs((moved.dec - reference.dec) * 3600 - 268.5) < 0.1);
  assert.ok(Math.abs((moved.ra - reference.ra) * Math.cos(reference.dec * Math.PI / 180) * 3600 + 20.76) < 0.1);
  assert.ok(Math.abs(angularSeparationDeg(reference, moved) * 3600 - Math.hypot(798.6, 10328) * 26 / 1000) < 0.01);
  assert.ok(angularSeparationDeg(propagateProperMotion(reference, julianYearToMjd(2000)), reference) < 1e-9);
  const polar = propagateProperMotion({ ra: 10, dec: 89.9999, pm_ra_masyr: 0, pm_dec_masyr: 20000, epoch_jyear: 2000 }, julianYearToMjd(2026));
  assert.ok(polar.dec <= 90 && Math.abs(polar.ra - 190) < 1e-6);
});

test("daily proper-motion track covers the inclusive UTC interval and validates as a field query", () => {
  const points = properMotionTrack(reference, dates.start, dates.end);
  assert.equal(points.length, 213);
  assert.equal(points[0].mjd, 60888);
  assert.equal(points.at(-1)!.mjd, 61100);
  const between = interpolateEphemeris(points, 60900.37)!;
  assert.ok(angularSeparationDeg(between, propagateProperMotion(reference, 60900.37)) * 3600 < 1e-3);
  assert.ok(properMotionTrack(reference, "2020-01-01", "2029-12-31").length <= 1001);
  const query = validateFieldQuery({ ...field, ephemeris: { ...sesame, points, source_url: sesameUrl("Barnard's Star") } });
  assert.equal(validateFieldQuery({ ...field, ephemeris: { ...sesame, points, source_url: sesameUrl("Barnard's Star", 2) } }).ephemeris?.source_url, "https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-oxp/SN?Barnard's+Star", "a mirror that answered is kept as provenance");
  for (const source_url of ["https://attacker.invalid/", sesameUrl("Other star"), undefined]) assert.throws(() => validateFieldQuery({ ...field, ephemeris: { ...sesame, points, source_url } }), /Sesame/);
  assert.ok(angularSeparationDeg(query, reference) * 3600 > 260, "field centre follows the star, not its J2000 position");
  assert.ok(query.ephemeris?.source === "Proper motion (CDS Sesame)" && query.ephemeris.source_url === sesameUrl("Barnard's Star"));
  assert.deepEqual(query.ephemeris.reference, reference);
  const user = validateFieldQuery({ ...field, ephemeris: { ...model, source: "Proper motion (user-supplied)", target_name: "WISE 0855", points } }).ephemeris;
  assert.ok(user?.source === "Proper motion (user-supplied)" && user.source_url === null && user.resolver === null);
});

test("proper-motion queries reject tampered tracks, missing provenance and out-of-range motion", () => {
  const points = properMotionTrack(reference, dates.start, dates.end);
  const shifted = points.map((point, i) => i === 5 ? { ...point, dec: point.dec + 1e-5 } : point);
  const invalid: Record<string, unknown>[] = [
    { ...sesame, points: shifted },
    { ...sesame, points, query_name: "" },
    { ...sesame, points, retrieved_at: "yesterday" },
    { ...sesame, points, model: "orbit" },
    { ...sesame, points, target_name: "" },
    { ...sesame, points: points.slice(1) },
    { ...sesame, points, reference: { ...reference, epoch_jyear: 1800 } },
    { ...sesame, points, reference: { ...reference, pm_dec_masyr: 1e6 } },
    { ...sesame, points, reference: { ...reference, pm_ra_masyr: "" } },
    { ...sesame, points: properMotionTrack({ ...reference, pm_ra_masyr: 0, pm_dec_masyr: 0 }, dates.start, dates.end), reference: { ...reference, pm_ra_masyr: 0, pm_dec_masyr: 0 } },
  ];
  for (const ephemeris of invalid) assert.throws(() => validateFieldQuery({ ...field, ephemeris }), JSON.stringify(ephemeris).slice(0, 120));
  assert.throws(() => validateFieldQuery({ ...field, target_name: "Barnard's Star", ephemeris: { ...sesame, points } }));
});
