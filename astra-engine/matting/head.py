"""Finds the author's head box on a talking-head recording from the matting silhouette.

Samples a few frames, cuts the author out with RobustVideoMatting and reads the silhouette
profile: the head is the part above the neck, the neck is the narrowest row between the
head and the shoulders. Prints {"x","y","w","h"} (median over frames) as JSON.
"""
import argparse
import json
import subprocess

import numpy as np
import onnxruntime as ort


def frame_at(video: str, t: float, width: int, height: int) -> np.ndarray:
    raw = subprocess.check_output(["ffmpeg", "-v", "error", "-ss", f"{t:.3f}", "-i", video, "-frames:v", "1",
                                   "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
    return np.frombuffer(raw, dtype=np.uint8).reshape(height, width, 3)


def head_box(alpha: np.ndarray):
    mask = alpha > 0.5
    rows = np.where(mask.any(axis=1))[0]
    if len(rows) < 50:
        return None
    top = int(rows[0])
    widths = mask.sum(axis=1).astype(float)
    # Look for the neck between 20% and 60% of the frame below the top of the head.
    span = range(top + int(alpha.shape[0] * 0.12), min(alpha.shape[0] - 1, top + int(alpha.shape[0] * 0.45)))
    head_width = widths[top:top + int(alpha.shape[0] * 0.12)].max()
    neck = min(span, key=lambda y: widths[y] if widths[y] > head_width * 0.35 else 1e9)
    head_rows = mask[top:neck]
    cols = np.where(head_rows.any(axis=0))[0]
    # The widest band of the head (ears) sets the horizontal extent.
    band = head_rows[int((neck - top) * 0.3):int((neck - top) * 0.7)]
    band_cols = np.where(band.any(axis=0))[0] if band.size else cols
    x0, x1 = int(band_cols[0]), int(band_cols[-1])
    # A collar can hide the neck and end the box at the mouth; a head is ~1.38x taller than wide.
    return x0, top, x1 - x0, max(neck - top, round((x1 - x0) * 1.38))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--duration", type=float, required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--samples", type=int, default=7)
    args = parser.parse_args()

    probe = subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                                     "-of", "csv=p=0", args.video]).decode().strip().split(",")
    width, height = int(probe[0]), int(probe[1])
    session = ort.InferenceSession(args.model, providers=["CPUExecutionProvider"])
    ratio = np.array([0.3], dtype=np.float32)
    boxes = []
    for i in range(args.samples):
        t = args.duration * (i + 0.5) / args.samples
        rgb = frame_at(args.video, t, width, height)
        src = (rgb.astype(np.float32) / 255.0).transpose(2, 0, 1)[None]
        rec = [np.zeros([1, 1, 1, 1], dtype=np.float32)] * 4
        # A few passes on the same frame let the recurrent state settle.
        for _ in range(3):
            _, pha, *rec = session.run(None, {"src": src, "r1i": rec[0], "r2i": rec[1], "r3i": rec[2], "r4i": rec[3], "downsample_ratio": ratio})
        box = head_box(pha[0, 0])
        if box:
            boxes.append(box)
    if not boxes:
        raise SystemExit("head not found")
    x, y, w, h = (int(np.median([b[k] for b in boxes])) for k in range(4))
    print(json.dumps({"x": x, "y": y, "w": w, "h": h}))


if __name__ == "__main__":
    main()
