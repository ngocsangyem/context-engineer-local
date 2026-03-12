"""
One-time script to generate a quantized INT8 ONNX model from the FP32 baseline.

Usage:
    pip install onnxruntime onnx
    python scripts/quantize-model.py

Input:  models/all-MiniLM-L6-v2.onnx       (FP32, ~90MB)
Output: models/all-MiniLM-L6-v2-quantized.onnx  (INT8, ~23MB, 2-3x faster on CPU)

Notes:
- Dynamic quantization: no calibration dataset needed, weights only.
- Typical quality loss: <2% on cosine similarity benchmarks.
- FP16 is GPU-only; do NOT use QUInt8/QFloat16 for CPU inference.
"""

import os
import sys
from pathlib import Path


def main() -> None:
    # Resolve paths relative to this script's location (project root)
    script_dir = Path(__file__).parent
    models_dir = script_dir.parent / "models"

    input_path = models_dir / "all-MiniLM-L6-v2.onnx"
    output_path = models_dir / "all-MiniLM-L6-v2-quantized.onnx"

    if not input_path.exists():
        print(f"ERROR: Source model not found at {input_path}", file=sys.stderr)
        print("Download it first: see README.md for setup instructions.", file=sys.stderr)
        sys.exit(1)

    if output_path.exists():
        print(f"Quantized model already exists at {output_path}")
        print("Delete it first to re-quantize.")
        sys.exit(0)

    try:
        from onnxruntime.quantization import quantize_dynamic, QuantType
    except ImportError:
        print("ERROR: onnxruntime not installed.", file=sys.stderr)
        print("Run: pip install onnxruntime", file=sys.stderr)
        sys.exit(1)

    print(f"Quantizing {input_path} -> {output_path} ...")
    print(f"Source size: {input_path.stat().st_size / 1_048_576:.1f} MB")

    quantize_dynamic(
        str(input_path),
        str(output_path),
        weight_type=QuantType.QInt8,
    )

    out_size = output_path.stat().st_size / 1_048_576
    in_size = input_path.stat().st_size / 1_048_576
    ratio = in_size / out_size if out_size > 0 else 0

    print(f"Done. Output size: {out_size:.1f} MB (compression ratio: {ratio:.1f}x)")
    print(f"The server will auto-detect and prefer the quantized model on next start.")


if __name__ == "__main__":
    main()
