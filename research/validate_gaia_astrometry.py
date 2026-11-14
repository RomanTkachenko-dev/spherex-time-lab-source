"""Preliminary empirical astrometry check against Gaia DR3.

This script independently detects peaks in one calibrated SPHEREx IMAGE plane,
propagates Gaia DR3 reference positions to the exposure epoch, then compares
the two coordinate lists. It is a diagnostic for one exposure, not a mission-
wide accuracy or completeness result.
"""
from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen
import warnings

import numpy as np
from astropy import units as u
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS
from erfa import ErfaWarning
from PIL import Image, ImageDraw
from scipy.ndimage import maximum_filter, median_filter
from scipy.optimize import linear_sum_assignment


ROOT = Path(__file__).resolve().parents[1]
TAP_URL = "https://gea.esac.esa.int/tap-server/tap/sync"
DATA_URL = "https://www.cosmos.esa.int/web/gaia/dr3"
BAD_MASK = np.uint32(0xffffffff ^ ((1 << 21) | (1 << 12)))
MAG_LIMIT = 18.5
RUWE_LIMIT = 1.4
SNR_LIMIT = 5.0
BACKGROUND_FILTER_PIXELS = 11
PEAK_FILTER_PIXELS = 3


def footprint_cone(wcs: WCS, shape: tuple[int, int]) -> tuple[float, float, float]:
    ny, nx = shape
    cx, cy = (nx - 1) / 2, (ny - 1) / 2
    center = SkyCoord(*wcs.all_pix2world(cx, cy, 0), unit=u.deg, frame="icrs")
    corners_ra, corners_dec = wcs.all_pix2world(
        [0, nx - 1, nx - 1, 0], [0, 0, ny - 1, ny - 1], 0
    )
    corners = SkyCoord(corners_ra * u.deg, corners_dec * u.deg, frame="icrs")
    radius = float(np.max(center.separation(corners).deg) + 0.02)
    return float(center.ra.deg), float(center.dec.deg), radius


def fetch_gaia_catalogue(path: Path, ra: float, dec: float, radius: float) -> str:
    """Fetch and cache Gaia DR3 astrometry, exact request and response hash."""

    query = (
        "SELECT source_id, ra, dec, pmra, pmdec, parallax, radial_velocity, "
        "phot_g_mean_mag, ruwe, astrometric_params_solved "
        "FROM gaiadr3.gaia_source "
        f"WHERE 1=CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',{ra:.10f},{dec:.10f},{radius:.8f})) "
        "AND astrometric_params_solved >= 31 AND pmra IS NOT NULL AND pmdec IS NOT NULL"
    )
    url = TAP_URL + '?' + urlencode({"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": query})
    with urlopen(url, timeout=90) as response:
        raw = response.read()
    if not raw.decode('utf-8-sig').startswith("source_id,"):
        raise RuntimeError(f"Gaia TAP returned an unexpected response: {raw[:300]!r}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    path.with_suffix('.adql.txt').write_text(query+'\n', encoding='utf-8')
    path.with_suffix('.source.json').write_text(json.dumps({
        'source_url': url, 'source_sha256': sha256(raw).hexdigest(),
        'retrieved_at_utc': datetime.now(timezone.utc).isoformat(),
    }, indent=2)+'\n', encoding='utf-8')
    return query


def read_gaia(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8-sig") as stream:
        return list(csv.DictReader(stream))


def propagate_gaia(
    rows: list[dict[str, str]], observation_time: str,
    magnitude_limit: float | None = MAG_LIMIT,
) -> tuple[list[dict[str, str]], SkyCoord]:
    selected = [
        row for row in rows
        if row.get("ra") and row.get("dec") and row.get("pmra") and row.get("pmdec")
        and (magnitude_limit is None or row.get("phot_g_mean_mag"))
        and (magnitude_limit is None or float(row["phot_g_mean_mag"]) <= magnitude_limit)
        and (magnitude_limit is None or (row.get("ruwe") and float(row["ruwe"]) < RUWE_LIMIT))
    ]
    coordinates = SkyCoord(
        ra=np.asarray([float(row["ra"]) for row in selected]) * u.deg,
        dec=np.asarray([float(row["dec"]) for row in selected]) * u.deg,
        pm_ra_cosdec=np.asarray([float(row["pmra"]) for row in selected]) * u.mas / u.yr,
        pm_dec=np.asarray([float(row["pmdec"]) for row in selected]) * u.mas / u.yr,
        obstime=Time(2016.0, format="jyear", scale="tcb"),
        frame="icrs",
    )
    # This diagnostic omits parallax and radial-velocity perspective terms;
    # their contribution is not estimated by these residuals.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", ErfaWarning)
        propagated = coordinates.apply_space_motion(new_obstime=Time(observation_time, scale="utc"))
    return selected, propagated


def detect_peaks(image: np.ndarray, variance: np.ndarray, flags: np.ndarray) -> dict:
    valid = (
        np.isfinite(image) & np.isfinite(variance) & (variance > 0)
        & ((flags.astype(np.uint32) & BAD_MASK) == 0)
    )
    finite_image = image[np.isfinite(image)]
    fill = float(np.median(finite_image))
    background = median_filter(np.where(np.isfinite(image), image, fill), size=BACKGROUND_FILTER_PIXELS, mode="nearest")
    residual = image - background
    snr = residual / np.sqrt(np.maximum(variance, 0))
    is_peak = (
        valid & (snr > SNR_LIMIT)
        & (snr == maximum_filter(np.where(valid, snr, -np.inf), size=PEAK_FILTER_PIXELS, mode="constant", cval=-np.inf))
    )
    peak_y, peak_x = np.where(is_peak)
    centroids = []
    for x, y in zip(peak_x, peak_y):
        x0, x1 = max(0, x - 1), min(image.shape[1], x + 2)
        y0, y1 = max(0, y - 1), min(image.shape[0], y + 2)
        patch_valid = valid[y0:y1, x0:x1]
        weights = np.where(patch_valid, np.maximum(residual[y0:y1, x0:x1], 0), 0)
        total = float(weights.sum())
        if total <= 0:
            continue
        yy, xx = np.indices(weights.shape)
        centroids.append((float((xx + x0).ravel().dot(weights.ravel()) / total),
                          float((yy + y0).ravel().dot(weights.ravel()) / total)))
    return {
        "valid_pixels": int(np.count_nonzero(valid)),
        "candidate_peak_count": int(len(peak_x)),
        "peak_x": peak_x.astype(float), "peak_y": peak_y.astype(float),
        "centroids": np.asarray(centroids, dtype=float).reshape((-1, 2)),
        "snr": snr,
    }


def match_catalogues(
    detections: SkyCoord, references: SkyCoord, max_separation_arcsec: float
) -> list[dict[str, float | int]]:
    if not len(detections) or not len(references):
        return []
    dra = (detections.ra.deg[None, :] - references.ra.deg[:, None] + 180) % 360 - 180
    east = dra * np.cos(references.dec.rad[:, None]) * 3600
    north = (detections.dec.deg[None, :] - references.dec.deg[:, None]) * 3600
    separation = np.hypot(east, north)
    n_detections, n_references = separation.T.shape
    # Add a private unmatched column for each detection so the global
    # one-to-one assignment does not force distant or duplicate associations.
    costs = np.full((n_detections, n_references + n_detections), max_separation_arcsec)
    costs[:, :n_references] = np.where(
        separation.T <= max_separation_arcsec, separation.T, max_separation_arcsec + 1000
    )
    detection_indices, reference_indices = linear_sum_assignment(costs)
    matches = []
    for detection_index, reference_index in zip(detection_indices, reference_indices):
        if reference_index >= n_references or separation[reference_index, detection_index] > max_separation_arcsec:
            continue
        matches.append({
            "detection_index": int(detection_index),
            "reference_index": int(reference_index),
            "east_arcsec": float(east[reference_index, detection_index]),
            "north_arcsec": float(north[reference_index, detection_index]),
            "separation_arcsec": float(separation[reference_index, detection_index]),
        })
    return matches


def summarize(matches: list[dict], keep: np.ndarray | None = None) -> dict:
    subset = matches if keep is None else [m for m, use in zip(matches, keep) if use]
    if not subset:
        return {"count": 0}
    east = np.asarray([m["east_arcsec"] for m in subset])
    north = np.asarray([m["north_arcsec"] for m in subset])
    radius = np.hypot(east, north)
    return {
        "count": int(len(subset)),
        "median_radial_offset_arcsec": float(np.median(radius)),
        "p90_radial_offset_arcsec": float(np.percentile(radius, 90)),
        "rms_radial_offset_arcsec": float(np.sqrt(np.mean(radius**2))),
        "median_east_offset_arcsec": float(np.median(east)),
        "median_north_offset_arcsec": float(np.median(north)),
    }


def draw_overlay(image: np.ndarray, references: SkyCoord, detections: SkyCoord,
                 matches: list[dict], output_path: Path) -> None:
    low, high = np.nanpercentile(image, [1, 99.7])
    scaled = np.clip((image - low) / max(high - low, np.finfo(float).eps), 0, 1)
    gray = np.uint8(255 * np.arcsinh(np.nan_to_num(scaled) * 18) / np.arcsinh(18))
    canvas = Image.fromarray(np.flipud(gray), mode="L").convert("RGB")
    factor = 4
    canvas = canvas.resize((canvas.width * factor, canvas.height * factor), Image.Resampling.NEAREST)
    draw = ImageDraw.Draw(canvas)
    ny, nx = image.shape
    # Reference (red circles) and extracted centroid (green crosses).
    for match in matches:
        ri, di = match["reference_index"], match["detection_index"]
        # Caller attaches reference and detections pixels below as private keys.
        px, py = match["reference_pixel"]
        dx, dy = match["detection_pixel"]
        sx, sy = px * factor, (ny - 1 - py) * factor
        tx, ty = dx * factor, (ny - 1 - dy) * factor
        radius = 2 * factor
        draw.ellipse((sx - radius, sy - radius, sx + radius, sy + radius), outline=(255, 75, 75), width=2)
        arm = 3 * factor
        draw.line((tx - arm, ty, tx + arm, ty), fill=(70, 255, 120), width=2)
        draw.line((tx, ty - arm, tx, ty + arm), fill=(70, 255, 120), width=2)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output_path, format="PNG", optimize=True)


def validate(fits_path: Path, catalogue_path: Path, output_path: Path, overlay_path: Path) -> dict:
    with fits.open(fits_path, memmap=False) as hdul:
        image_hdu = hdul["IMAGE"]
        image = image_hdu.data.astype(float)
        variance = hdul["VARIANCE"].data.astype(float)
        flags = hdul["FLAGS"].data.astype(np.uint32)
        image *= u.Unit(image_hdu.header['BUNIT']).to(u.MJy / u.sr)
        variance *= u.Unit(hdul['VARIANCE'].header['BUNIT']).to((u.MJy / u.sr)**2)
        if image.ndim != 2 or image.shape != variance.shape or image.shape != flags.shape:
            raise ValueError('IMAGE, VARIANCE and FLAGS shapes do not agree.')
        if not np.isfinite(image).any():
            raise ValueError('IMAGE has no finite samples; astrometry cannot be measured.')
        wcs = WCS(image_hdu.header)
        observation_time = str(image_hdu.header["DATE-AVG"])
        center_ra, center_dec, cone_radius = footprint_cone(wcs, image.shape)
        plate_scale = np.linalg.norm(wcs.pixel_scale_matrix, axis=0) * 3600
        psf_fwhm = float(image_hdu.header["PSF_FWHM"])
        if not np.isfinite(psf_fwhm) or psf_fwhm <= 0:
            raise ValueError('PSF_FWHM must be finite and positive.')
        if str(image_hdu.header.get('TIMESYS', '')).upper() != 'UTC':
            raise ValueError('Only UTC FITS observation times are supported.')
        metadata = {
            "observation_id": str(image_hdu.header["OBSID"]),
            "detector": f"D{int(image_hdu.header['DETECTOR'])}",
            "date_avg_utc": observation_time,
            "mjd_avg": float(image_hdu.header["MJD-AVG"]),
            "image_shape_yx": list(image.shape),
            "psf_fwhm_arcsec": psf_fwhm,
            "pixel_scale_arcsec_per_pixel": [float(v) for v in plate_scale],
        }

    rows = read_gaia(catalogue_path)
    all_astrometric_rows, all_astrometric_positions = propagate_gaia(
        rows, observation_time, magnitude_limit=None
    )
    filtered_rows, propagated = propagate_gaia(rows, observation_time)
    quality_reference_count = len(filtered_rows)
    ref_x, ref_y = wcs.all_world2pix(propagated.ra.deg, propagated.dec.deg, 0)
    inside = ((ref_x >= 0) & (ref_x <= image.shape[1] - 1)
              & (ref_y >= 0) & (ref_y <= image.shape[0] - 1))
    filtered_rows = [row for row, keep in zip(filtered_rows, inside) if keep]
    propagated = propagated[inside]
    ref_x, ref_y = ref_x[inside], ref_y[inside]
    all_x, all_y = wcs.all_world2pix(all_astrometric_positions.ra.deg, all_astrometric_positions.dec.deg, 0)
    all_inside = ((all_x >= 0) & (all_x <= image.shape[1] - 1)
                  & (all_y >= 0) & (all_y <= image.shape[0] - 1))
    all_astrometric_rows = [row for row, keep in zip(all_astrometric_rows, all_inside) if keep]
    all_astrometric_positions = all_astrometric_positions[all_inside]

    extraction = detect_peaks(image, variance, flags)
    centroids = extraction["centroids"]
    det_ra, det_dec = wcs.all_pix2world(centroids[:, 0], centroids[:, 1], 0)
    detections = SkyCoord(det_ra * u.deg, det_dec * u.deg, frame="icrs")
    max_pair_separation = psf_fwhm
    broad_matches = match_catalogues(detections, propagated, 2 * psf_fwhm)
    matches = match_catalogues(detections, propagated, max_pair_separation)
    matched_detections = {match["detection_index"] for match in matches}
    matched_references = {match["reference_index"] for match in matches}
    broad_unconfirmed = [
        match for match in broad_matches
        if max_pair_separation < match["separation_arcsec"] <= 2 * psf_fwhm
        and match["detection_index"] not in matched_detections
        and match["reference_index"] not in matched_references
    ]
    peak_x, peak_y = extraction["peak_x"], extraction["peak_y"]
    for match in matches + broad_unconfirmed:
        di, ri = match["detection_index"], match["reference_index"]
        match["reference_pixel"] = [float(ref_x[ri]), float(ref_y[ri])]
        match["detection_pixel"] = [float(centroids[di, 0]), float(centroids[di, 1])]
        match["reference_ra_deg"] = float(propagated[ri].ra.deg)
        match["reference_dec_deg"] = float(propagated[ri].dec.deg)
        match["detection_ra_deg"] = float(detections[di].ra.deg)
        match["detection_dec_deg"] = float(detections[di].dec.deg)
        match["gaia_source_id"] = int(filtered_rows[ri]["source_id"])
        match["gaia_g_magnitude"] = float(filtered_rows[ri]["phot_g_mean_mag"])
        match["detection_snr"] = float(extraction["snr"][int(peak_y[di]), int(peak_x[di])])

    nearest_neighbor_by_source = {}
    if len(all_astrometric_positions) > 1:
        pair_separations = all_astrometric_positions[:, None].separation(all_astrometric_positions[None, :]).arcsec
        np.fill_diagonal(pair_separations, np.inf)
        nearest = np.min(pair_separations, axis=1)
        nearest_neighbor_by_source = {
            row["source_id"]: float(distance)
            for row, distance in zip(all_astrometric_rows, nearest)
        }
    isolated = np.asarray([
        nearest_neighbor_by_source.get(
            filtered_rows[m["reference_index"]]["source_id"], np.inf
        ) >= 2 * psf_fwhm for m in matches
    ], dtype=bool)
    for match, is_isolated in zip(matches, isolated):
        source_id = filtered_rows[match["reference_index"]]["source_id"]
        match["nearest_gaia_neighbor_arcsec"] = nearest_neighbor_by_source.get(source_id)
        match["isolated_at_2psf"] = bool(is_isolated)
    metrics_all = summarize(matches)
    metrics_isolated = summarize(matches, isolated)

    match_records = [{key: value for key, value in match.items()
                      if key not in ("reference_pixel", "detection_pixel")}
                     for match in matches]
    report = {
        "validation": "preliminary_single_exposure_astrometry",
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "input": {"fits_file": str(fits_path), "fits_sha256": sha256(fits_path.read_bytes()).hexdigest(), **metadata},
        "reference_catalogue": {
            "name": "Gaia DR3",
            "table": "gaiadr3.gaia_source",
            "data_url": DATA_URL,
            "tap_url": TAP_URL,
            "catalogue_file": str(catalogue_path),
            "catalogue_sha256": sha256(catalogue_path.read_bytes()).hexdigest(),
            "retrieval": json.loads(catalogue_path.with_suffix('.source.json').read_text(encoding='utf-8')) if catalogue_path.with_suffix('.source.json').exists() else None,
            "cone_center_icrs_deg": [center_ra, center_dec],
            "cone_radius_deg": cone_radius,
            "raw_row_count": len(rows),
            "quality_filtered_row_count": quality_reference_count,
            "in_frame_reference_count": len(filtered_rows),
            "in_frame_astrometric_sources_for_crowding": len(all_astrometric_rows),
            "proper_motion_epoch_jyear_tcb": 2016.0,
            "propagated_to": observation_time,
            "quality_cuts": {"astrometric_params_solved": ">=31", "ruwe_lt": RUWE_LIMIT,
                             "phot_g_mean_mag_lte": MAG_LIMIT},
            "propagation": "Astropy spherical proper-motion propagation; parallax and radial-velocity terms omitted.",
        },
        "extraction": {
            "variance_used_for_significance": True,
            "significance_formula": "(IMAGE - 11-pixel local median) / sqrt(VARIANCE); VARIANCE has units (MJy/sr)^2.",
            "flags_rejected": "All FLAGS bits except 12 and 21, matching display-kernel bad-pixel policy.",
            "local_background_median_filter_pixels": BACKGROUND_FILTER_PIXELS,
            "local_maximum_filter_pixels": PEAK_FILTER_PIXELS,
            "significance_threshold_sigma": SNR_LIMIT,
            "valid_pixel_count": extraction["valid_pixels"],
            "candidate_peak_count": extraction["candidate_peak_count"],
            "centroid": "Positive background-subtracted IMAGE weighted centroid in a 3x3 pixel patch around each local maximum.",
        },
        "association": {
            "method": "Global one-to-one minimum-separation assignment with unmatched detections allowed.",
            "maximum_pair_separation_arcsec": max_pair_separation,
            "maximum_pair_separation_rule": "One image-header PSF_FWHM; a second candidate pass to 2 x PSF_FWHM is reported separately and excluded from accuracy metrics.",
            "matched_count": len(matches),
            "unconfirmed_1_to_2_psf_candidate_count": len(broad_unconfirmed),
            "unconfirmed_1_to_2_psf_candidates": [
                {key: value for key, value in match.items()
                 if key not in ("reference_pixel", "detection_pixel")}
                for match in broad_unconfirmed
            ],
            "isolated_definition": (
                f"Nearest other in-frame Gaia source with an astrometric solution at least "
                f"{2 * psf_fwhm:.3f} arcsec away (2 x PSF_FWHM); crowding check has no magnitude or RUWE cut."
            ),
            "isolated_match_count": int(isolated.sum()),
            "metrics_all": metrics_all,
            "metrics_isolated": metrics_isolated,
            "matches": match_records,
        },
        "limitations": [
            "One detector and one exposure; this does not establish mission-wide WCS accuracy.",
            "The simple threshold-and-centroid extractor is diagnostic and is not a validated SPHEREx source catalogue.",
            "Gaia G-band magnitude is used only for reference selection; it is not an infrared flux prediction.",
            "Centroid residuals include SPHEREx undersampling, source confusion, chromatic effects, extraction error, and Gaia reference error; they are not pure WCS residuals.",
            "No PSF fitting, parallax propagation, radial-velocity perspective correction, or empirical completeness/false-positive analysis is included.",
        ],
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    draw_overlay(image, propagated, detections, matches, overlay_path)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fits", type=Path, default=ROOT / ".science-cache" / "field-first.fits")
    parser.add_argument("--catalogue", type=Path, default=ROOT / "research" / "data" / "gaia_dr3_qr2_2025-12-14.csv")
    parser.add_argument("--output", type=Path, default=ROOT / "research" / "results" / "gaia_astrometry_qr2_2025-12-14.json")
    parser.add_argument("--overlay", type=Path, default=ROOT / "research" / "results" / "gaia_astrometry_qr2_2025-12-14.png")
    parser.add_argument("--refresh-catalogue", action="store_true", help="Download a fresh Gaia DR3 cone catalogue.")
    args = parser.parse_args()
    with fits.open(args.fits, memmap=False) as hdul:
        wcs = WCS(hdul["IMAGE"].header)
        center_ra, center_dec, radius = footprint_cone(wcs, hdul["IMAGE"].data.shape)
    query = None
    if args.refresh_catalogue or not args.catalogue.exists():
        query = fetch_gaia_catalogue(args.catalogue, center_ra, center_dec, radius)
    report = validate(args.fits, args.catalogue, args.output, args.overlay)
    if query:
        sidecar = args.catalogue.with_suffix(".adql.txt")
        sidecar.write_text(query + "\n", encoding="utf-8")
    association = report["association"]
    print(json.dumps({
        "report": str(args.output),
        "overlay": str(args.overlay),
        "gaia_rows": report["reference_catalogue"]["raw_row_count"],
        "in_frame_references": report["reference_catalogue"]["in_frame_reference_count"],
        "detected_peaks": report["extraction"]["candidate_peak_count"],
        "matches": association["matched_count"],
        "all_metrics": association["metrics_all"],
        "isolated_metrics": association["metrics_isolated"],
    }, indent=2))


if __name__ == "__main__":
    main()
