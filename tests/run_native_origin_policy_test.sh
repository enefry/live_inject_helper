#!/bin/sh
set -eu
HELPER_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PROJECT_ROOT=${1:-$(CDPATH= cd -- "$HELPER_ROOT/../.." && pwd)}
NATIVE="$PROJECT_ROOT/Modules/MaterialStudio/MaterialStudio/WebWidget"
ARTIFACTS="$PROJECT_ROOT/.noindex/artifacts/web-widget-origin"
MODULE_CACHE="$PROJECT_ROOT/.noindex/DerivedData/$(basename "$PROJECT_ROOT")/ModuleCache.noindex"
mkdir -p "$ARTIFACTS" "$MODULE_CACHE"
python3 "$HELPER_ROOT/scripts/sync_native_security.py" --native-root "$PROJECT_ROOT" --check
xcrun swiftc -module-cache-path "$MODULE_CACHE" "$NATIVE/WidgetManifest.swift" "$NATIVE/WidgetOriginPolicy.swift" \
  "$NATIVE/WidgetPublicSuffixRules.swift" "$NATIVE/WidgetWebSDK.swift" \
  "$HELPER_ROOT/tests/native_origin_policy_test.swift" -o "$ARTIFACTS/native-origin-policy-test"
"$ARTIFACTS/native-origin-policy-test" "$HELPER_ROOT/tests/origin_policy_cases.json" "$ARTIFACTS/native-vectors.json"
node "$HELPER_ROOT/tests/origin_policy_parity_test.js" "$ARTIFACTS/native-vectors.json"
