"""Pre-download the FaceFusion models Clipy uses (run by setup.ps1 so the first job does not stall).

    python ff_download.py [--providers cpu]
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
FF_DIR = (HERE.parent.parent.parent / "engines" / "facefusion").resolve()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--providers", nargs="+", default=["cpu"])
    a = ap.parse_args()
    os.chdir(FF_DIR)
    sys.path.insert(0, str(FF_DIR))
    from facefusion import content_analyser, face_classifier, face_detector, face_landmarker, face_masker, face_recognizer, logger, state_manager
    from facefusion.args import apply_args
    from facefusion.processors.core import get_processors_modules
    from facefusion.program import create_program

    dummy = FF_DIR / ".assets" / "examples"
    dummy.mkdir(parents=True, exist_ok=True)
    ok = True
    for swapper, pixel_boost in (("hyperswap_1a_256", "256x256"), ("inswapper_128_fp16", "128x128")):
        argv = [
            "headless-run", "--target-path", str(dummy / "x.mp4"), "--output-path", str(dummy / "y.mp4"),
            "--execution-providers", *a.providers,
            "--processors", "face_swapper", "face_enhancer",
            "--face-swapper-model", swapper, "--face-swapper-pixel-boost", pixel_boost,
            "--face-enhancer-model", "gfpgan_1.4",
            "--face-detector-model", "yolo_face", "--face-landmarker-model", "2dfan4",
            "--face-occluder-model", "xseg_2", "--face-parser-model", "bisenet_resnet_34",
            "--face-mask-types", "box", "occlusion", "region",
            "--log-level", "info",
        ]
        # the pixel-boost choices are derived from sys.argv when the program is created
        sys.argv = ["facefusion.py", *argv]
        program = create_program()
        args = vars(program.parse_args(argv))
        apply_args(args, state_manager.init_item)
        logger.init("info")
        modules = [content_analyser, face_detector, face_landmarker, face_recognizer, face_classifier, face_masker]
        for m in modules + list(get_processors_modules(["face_swapper", "face_enhancer"])):
            name = getattr(m, "__name__", str(m))
            print(f"checking {name} ...", flush=True)
            if not m.pre_check():
                print(f"FAILED: {name}", flush=True)
                ok = False
    print("models ready" if ok else "some models failed to download", flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
