#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel)
GIT_DIR=$(git -C "$REPO_ROOT" rev-parse --git-dir)
case "$GIT_DIR" in
  /*) ;;
  *) GIT_DIR="$REPO_ROOT/$GIT_DIR" ;;
esac
HOOK_PATH="$GIT_DIR/hooks/pre-commit"

mkdir -p "$(dirname -- "$HOOK_PATH")"

cp "$REPO_ROOT/.githooks/pre-commit" "$HOOK_PATH"
chmod +x "$HOOK_PATH"
echo "installed $HOOK_PATH"
