#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel)

exec python3 "$REPO_ROOT/scripts/update_manifest_sha256.py" \
  --manifest "$REPO_ROOT/pandalive/pandalive.json" \
  "$@"
