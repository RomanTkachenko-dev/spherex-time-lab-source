"""Independently verify exported bundle hashes and decode every PNG with Pillow.

This checks the saved display artifact, not astronomical detection accuracy.
The application's TypeScript validator separately checks the science schema.
"""
import argparse
from datetime import datetime, timezone
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import struct

from PIL import Image


def verify(path):
    data = Path(path).read_bytes()
    if data[:8] != b"SPHEREX1" or len(data) < 44:
        raise ValueError("Invalid bundle prefix")
    header_size = struct.unpack(">I", data[8:12])[0]
    encoded = data[44:44 + header_size]
    if len(encoded) != header_size or sha256(encoded).digest() != data[12:44]:
        raise ValueError("Header hash/length mismatch")
    header = json.loads(encoded)
    if header["format"] != "spherex-session" or header["version"] != 1:
        raise ValueError("Unsupported format")
    manifest = header["manifest"]
    fields = ("image", "object_image", "quality_mask_image", "object_quality_mask_image")
    references = {}
    for frame in manifest["frames"]:
        for field in fields:
            source = frame[field]
            digest = frame.get("display_asset_sha256", {}).get(field)
            if source.startswith("idb:"):
                if digest and digest != source.rsplit(":", 1)[1]:
                    raise ValueError("Frame hash conflicts with its storage reference")
                digest = source.rsplit(":", 1)[1]
            if source in references and references[source] != digest:
                raise ValueError("Conflicting repeated PNG reference")
            references[source] = digest
    offset, seen, png_bytes = 44 + header_size, set(), 0
    for asset in header["assets"]:
        source = asset["source"]
        if source not in references or source in seen:
            raise ValueError("Unexpected or duplicate asset")
        seen.add(source)
        payload = data[offset:offset + asset["size"]]
        digest = sha256(payload).hexdigest()
        if len(payload) != asset["size"] or digest != asset["sha256"]:
            raise ValueError("PNG hash/length mismatch")
        if references[source] and digest != references[source]:
            raise ValueError("PNG does not match frame provenance")
        with Image.open(BytesIO(payload)) as image:
            if image.format != "PNG" or image.size != (256, 256):
                raise ValueError("Unexpected image format/dimensions")
            image.verify()
        with Image.open(BytesIO(payload)) as image:
            image.load()
        offset += asset["size"]
        png_bytes += asset["size"]
    if seen != set(references) or offset != len(data):
        raise ValueError("Missing images or trailing/truncated data")
    return {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "file_bytes": len(data), "bundle_sha256": sha256(data).hexdigest(),
        "schema_version": manifest["schema_version"],
        "frames": len(manifest["frames"]), "layer_references": len(manifest["frames"]) * 4,
        "unique_png_files": len(seen), "png_bytes": png_bytes,
        "all_hashes_valid": True, "all_pngs_decoded": True,
        "first_frame": manifest["frames"][0]["id"],
        "last_frame": manifest["frames"][-1]["id"],
        "first_utc": manifest["frames"][0]["date"],
        "last_utc": manifest["frames"][-1]["date"],
        "processed_at": manifest.get("processed_at"),
        "software": manifest.get("software"), "query": manifest.get("query"),
        "completeness": manifest.get("completeness"), "view": header["view"],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    report = verify(args.bundle)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("frames", "unique_png_files", "file_bytes", "all_hashes_valid", "all_pngs_decoded")}))
