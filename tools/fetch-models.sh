#!/usr/bin/env bash
# The one model too big for git: DWPose (134 MB, Apache-2.0), used by the
# "Best" tracking setting. Run once on a fresh copy of cermin.
set -euo pipefail
cd "$(dirname "$0")/../web/models"
URL="https://huggingface.co/yzd-v/DWPose/resolve/main/dw-ll_ucoco_384.onnx"
if [[ -f dwpose.onnx && $(stat -f%z dwpose.onnx) -eq 134399116 ]]; then
  echo "dwpose.onnx is already here."; exit 0
fi
echo "Downloading DWPose (134 MB)…"
curl -fL --progress-bar -o dwpose.onnx.part "$URL"
mv dwpose.onnx.part dwpose.onnx
echo "Done. Reload cermin and pick Best."
