"""Cuts the author out of the background for a time range (RobustVideoMatting, CPU).

Output is a WebM (VP9 with alpha) aligned to `--start`: frame 0 of the file is the video
frame at `--start` seconds. Text placed behind the author is drawn under this layer.

RobustVideoMatting is GPL-3.0; it runs here as an internal tool and is not distributed.
"""
import argparse
import subprocess
import sys
import time

import numpy as np
import onnxruntime as ort


def probe(video: str) -> tuple[int, int, float]:
    out = subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate", "-of", "csv=p=0", video,
    ]).decode().strip().split(",")
    num, den = out[2].split("/")
    return int(out[0]), int(out[1]), float(num) / float(den)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--start", type=float, required=True)
    parser.add_argument("--end", type=float, required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--ratio", type=float, default=0.3, help="RVM downsample ratio")
    parser.add_argument("--warmup", type=float, default=0.6, help="seconds processed before start to settle the recurrent state")
    args = parser.parse_args()

    width, height, fps = probe(args.video)
    begin = max(0.0, args.start - args.warmup)
    skip = round((args.start - begin) * fps)
    total = round((args.end - begin) * fps)

    options = ort.SessionOptions()
    options.intra_op_num_threads = 6
    session = ort.InferenceSession(args.model, options, providers=["CPUExecutionProvider"])
    rec = [np.zeros([1, 1, 1, 1], dtype=np.float32)] * 4
    ratio = np.array([args.ratio], dtype=np.float32)

    reader = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-ss", f"{begin:.3f}", "-i", args.video, "-frames:v", str(total),
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE,
    )
    writer = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{width}x{height}",
         "-r", f"{fps}", "-i", "-", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "28",
         "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-auto-alt-ref", "0", args.out],
        stdin=subprocess.PIPE,
    )
    frame_bytes = width * height * 3
    started = time.time()
    written = 0
    for index in range(total):
        raw = reader.stdout.read(frame_bytes)
        if len(raw) < frame_bytes:
            break
        rgb = np.frombuffer(raw, dtype=np.uint8).reshape(height, width, 3)
        src = (rgb.astype(np.float32) / 255.0).transpose(2, 0, 1)[None]
        fgr, pha, *rec = session.run(None, {"src": src, "r1i": rec[0], "r2i": rec[1], "r3i": rec[2], "r4i": rec[3], "downsample_ratio": ratio})
        if index < skip:
            continue
        alpha = (np.clip(pha[0, 0], 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
        writer.stdin.write(np.dstack([rgb, alpha]).tobytes())
        written += 1
    writer.stdin.close()
    writer.wait()
    reader.wait()
    elapsed = time.time() - started
    print(f"cutout {args.start:.2f}-{args.end:.2f}s: {written} frames in {elapsed:.1f}s ({total / max(elapsed, 1e-6):.1f} fps)")
    if writer.returncode != 0 or written == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
