#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
command -v node >/dev/null
python -m pip install -r ml/requirements.txt
python -m ml.scripts.build_v3_cloud_runtime
