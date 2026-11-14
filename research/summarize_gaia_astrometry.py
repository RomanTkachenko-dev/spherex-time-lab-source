"""Summarize per-exposure Gaia DR3 / SPHEREx astrometry diagnostics."""
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]


def metrics(matches: list[dict]) -> dict:
    if not matches:
        return {"count": 0}
    east = np.asarray([match["east_arcsec"] for match in matches], dtype=float)
    north = np.asarray([match["north_arcsec"] for match in matches], dtype=float)
    radius = np.hypot(east, north)
    return {
        "count": int(len(matches)),
        "median_radial_offset_arcsec": float(np.median(radius)),
        "p90_radial_offset_arcsec": float(np.percentile(radius, 90)),
        "rms_radial_offset_arcsec": float(np.sqrt(np.mean(radius**2))),
        "median_east_offset_arcsec": float(np.median(east)),
        "median_north_offset_arcsec": float(np.median(north)),
    }


def summarize(results_dir: Path) -> tuple[dict, list[dict]]:
    reports = []
    for path in sorted(results_dir.glob("gaia_astrometry_2025W*.json")):
        report = json.loads(path.read_text(encoding="utf-8"))
        detector = report["input"]["detector"]
        if detector not in {"D2", "D5"}:
            continue
        reports.append((path, report))
    if not reports:
        raise FileNotFoundError(f"No per-exposure D2/D5 astrometry reports found under {results_dir}")

    frame_rows = []
    groups = {}
    all_matches = []
    for path, report in reports:
        association = report["association"]
        matches = association["matches"]
        isolated = [match for match in matches if match["isolated_at_2psf"]]
        all_matches.extend(matches)
        detector = report["input"]["detector"]
        group = groups.setdefault(detector, {"reports": [], "matches": []})
        group["reports"].append(report)
        group["matches"].extend(matches)
        frame_rows.append({
            "report": path.name,
            "observation_id": report["input"]["observation_id"],
            "detector": detector,
            "date_avg_utc": report["input"]["date_avg_utc"],
            "mjd_avg": report["input"]["mjd_avg"],
            "psf_fwhm_arcsec": report["input"]["psf_fwhm_arcsec"],
            "in_frame_gaia_references": report["reference_catalogue"]["in_frame_reference_count"],
            "candidate_peaks": report["extraction"]["candidate_peak_count"],
            "matched_sources": len(matches),
            "isolated_matches": len(isolated),
            "unconfirmed_1_to_2_psf_candidates": association["unconfirmed_1_to_2_psf_candidate_count"],
            "all_metrics": metrics(matches),
            "isolated_metrics": metrics(isolated),
        })

    group_rows = []
    for detector, group in sorted(groups.items()):
        frame_matches = group["matches"]
        isolated = [match for match in frame_matches if match["isolated_at_2psf"]]
        sources = {match["gaia_source_id"] for match in frame_matches}
        per_frame = [row for row in frame_rows if row["detector"] == detector]
        group_rows.append({
            "detector": detector,
            "frame_count": len(group["reports"]),
            "matched_measurements_across_frames": len(frame_matches),
            "isolated_measurements_across_frames": len(isolated),
            "unique_gaia_sources": len(sources),
            "all_measurement_metrics": metrics(frame_matches),
            "isolated_measurement_metrics": metrics(isolated),
            "per_frame_median_offset_arcsec_min_max": [
                float(min(row["all_metrics"]["median_radial_offset_arcsec"] for row in per_frame)),
                float(max(row["all_metrics"]["median_radial_offset_arcsec"] for row in per_frame)),
            ],
            "per_frame_p90_offset_arcsec_min_max": [
                float(min(row["all_metrics"]["p90_radial_offset_arcsec"] for row in per_frame)),
                float(max(row["all_metrics"]["p90_radial_offset_arcsec"] for row in per_frame)),
            ],
        })

    isolated_all = [match for match in all_matches if match["isolated_at_2psf"]]
    unique_sources = {match["gaia_source_id"] for match in all_matches}
    outliers = []
    for row, (_, report) in zip(frame_rows, reports):
        for match in report["association"]["matches"]:
            if match["separation_arcsec"] >= 3.0:
                outliers.append({
                    "observation_id": report["input"]["observation_id"],
                    "detector": report["input"]["detector"],
                    "gaia_source_id": match["gaia_source_id"],
                    "separation_arcsec": match["separation_arcsec"],
                    "east_arcsec": match["east_arcsec"],
                    "north_arcsec": match["north_arcsec"],
                    "gaia_g_magnitude": match["gaia_g_magnitude"],
                    "detection_snr": match["detection_snr"],
                    "isolated_at_2psf": match["isolated_at_2psf"],
                })
    outliers.sort(key=lambda row: row["separation_arcsec"], reverse=True)

    result = {
        "validation": "preliminary_multi_exposure_astrometry",
        "scope": "16 calibrated QR2 spectral images from two sky fields and two detectors.",
        "frame_count": len(reports),
        "matched_measurements_across_frames": len(all_matches),
        "isolated_measurements_across_frames": len(isolated_all),
        "unique_gaia_sources": len(unique_sources),
        "all_measurement_metrics": metrics(all_matches),
        "isolated_measurement_metrics": metrics(isolated_all),
        "groups": group_rows,
        "frames": frame_rows,
        "matches_at_or_above_3_arcsec": outliers,
        "interpretation": [
            "The frame-level residuals are small relative to the ~5-6 arcsec PSF FWHM in these sampled products.",
            "Pooled measurements repeat many of the same Gaia sources across wavelength/exposure frames, so the pooled count is not an independent-source sample size.",
            "This targeted QR2 validation does not establish all-sky, QR3, Deep Survey, or mission-wide astrometric performance.",
            "Residuals include image centroiding, blending, PSF undersampling/chromatic effects, and Gaia reference uncertainties; they are not pure WCS errors.",
        ],
    }
    return result, frame_rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results-dir", type=Path, default=ROOT / "research" / "results")
    parser.add_argument("--json", type=Path, default=ROOT / "research" / "results" / "gaia_astrometry_series_2025-12.json")
    parser.add_argument("--csv", type=Path, default=ROOT / "research" / "results" / "gaia_astrometry_series_2025-12.csv")
    args = parser.parse_args()
    report, rows = summarize(args.results_dir)
    args.json.parent.mkdir(parents=True, exist_ok=True)
    args.json.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    columns = [
        "report", "observation_id", "detector", "date_avg_utc", "mjd_avg",
        "psf_fwhm_arcsec", "in_frame_gaia_references", "candidate_peaks",
        "matched_sources", "isolated_matches", "unconfirmed_1_to_2_psf_candidates",
        "all_metrics", "isolated_metrics",
    ]
    with args.csv.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=columns)
        writer.writeheader()
        for row in rows:
            serialized = dict(row)
            for field in ("all_metrics", "isolated_metrics"):
                serialized[field] = json.dumps(serialized[field], separators=(",", ":"))
            writer.writerow(serialized)
    print(json.dumps({
        "summary_json": str(args.json),
        "per_frame_csv": str(args.csv),
        "frames": report["frame_count"],
        "matches": report["matched_measurements_across_frames"],
        "unique_sources": report["unique_gaia_sources"],
        "all_metrics": report["all_measurement_metrics"],
        "isolated_metrics": report["isolated_measurement_metrics"],
    }, indent=2))


if __name__ == "__main__":
    main()
