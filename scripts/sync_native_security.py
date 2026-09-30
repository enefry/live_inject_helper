#!/usr/bin/env python3

import argparse
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def replace_payload(path: Path, marker: str, payload: str, check: bool) -> None:
    original = path.read_text(encoding="utf-8")
    start = original.index(marker) + len(marker)
    end = original.index('\n"""#', start)
    current = original[start:end]
    if current == payload:
        return
    if check:
        raise SystemExit(f"Native security payload is out of sync: {path}")
    path.write_text(original[:start] + payload + original[end:], encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--native-root", type=Path, default=ROOT.parents[1])
    parser.add_argument("--check", action="store_true")
    options = parser.parse_args()
    native = options.native_root / "Modules/MaterialStudio/MaterialStudio/WebWidget"
    sdk = (ROOT / "sdk/yycamwidget.js").read_text(encoding="utf-8").rstrip("\n")
    suffixes = json.loads((ROOT / "security/public-suffix-rules.json").read_text(encoding="utf-8"))
    replace_payload(native / "WidgetWebSDK.swift", 'private static let canonicalSource = #"""\n', sdk, options.check)
    replace_payload(native / "WidgetPublicSuffixRules.swift", 'private static let source = #"""\n',
                    json.dumps(suffixes, ensure_ascii=True, separators=(",", ":")), options.check)


if __name__ == "__main__":
    main()
