#!/usr/bin/env python3
"""Dependency-free checks for the v1 schema and PandaLive Manifest."""

from __future__ import annotations

import base64
import copy
import hashlib
import json
from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = ROOT / "schema" / "web-widget-manifest-v1.schema.json"
MANIFEST_PATH = ROOT / "pandalive" / "pandalive.json"
INTEGRITY_RE = re.compile(r"^sha256-[A-Za-z0-9+/]{43}=$")
CONFIG_KEY_RE = re.compile(r"^(?:default|[a-z][a-z0-9._-]{0,63})$")
DEBUG_HTTP_URL_RE = re.compile(
    r"^http://(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?(?:/|$)"
)


def fail(message: str) -> None:
    raise AssertionError(message)


def digest(path: Path) -> str:
    encoded = base64.b64encode(hashlib.sha256(path.read_bytes()).digest()).decode("ascii")
    return f"sha256-{encoded}"


def validate_page(name: str, page: dict, is_config: bool = False) -> None:
    if not isinstance(page, dict):
        fail(f"{name} must be an object")
    if not isinstance(page.get("url"), str) or not (
        page["url"].startswith("https://") or DEBUG_HTTP_URL_RE.fullmatch(page["url"])
    ):
        fail(f"{name}.url must be an absolute HTTP(S) URL")
    if is_config and not isinstance(page.get("title"), str):
        fail(f"{name}.title is required")
    injection = page.get("inject", {})
    if not isinstance(injection, dict):
        fail(f"{name}.inject must be an object")
    for resource_type in ("js", "css"):
        resources = injection.get(resource_type, [])
        if not isinstance(resources, list) or len(resources) > 32:
            fail(f"{name}.inject.{resource_type} is invalid")
        ids = set()
        for resource in resources:
            if not isinstance(resource, dict):
                fail(f"{name}.{resource_type} resource must be an object")
            if not isinstance(resource.get("id"), str) or resource["id"] in ids:
                fail(f"{name}.{resource_type} resource id is invalid or duplicated")
            ids.add(resource["id"])
            if not INTEGRITY_RE.fullmatch(resource.get("integrity", "")):
                fail(f"{name}.{resource['id']} integrity is invalid")
            if resource.get("injectionTime", "documentEnd") not in ("documentStart", "documentEnd"):
                fail(f"{name}.{resource['id']} injectionTime is invalid")


def validate_manifest(manifest: dict) -> None:
    required = ("schemaVersion", "apiVersion", "id", "revision", "name", "main")
    for key in required:
        if key not in manifest:
            fail(f"missing {key}")
    if manifest["schemaVersion"] != 1 or manifest["apiVersion"] != 1:
        fail("unsupported version")
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", manifest["id"]):
        fail("invalid id")
    validate_page("main", manifest["main"])
    runtime = manifest["main"].get("runtime", {})
    if not isinstance(runtime, dict) or not all(isinstance(item, str) for item in runtime.get("methods", [])):
        fail("invalid main runtime")
    configs = manifest.get("configs")
    if configs is not None:
        if not isinstance(configs, dict) or "default" not in configs or not configs:
            fail("configs must contain default")
        if len(configs) > 16:
            fail("too many configs")
        for key, config in configs.items():
            if not CONFIG_KEY_RE.fullmatch(key):
                fail(f"invalid ConfigKey: {key}")
            validate_page(f"configs.{key}", config, is_config=True)
            # Config runtime is intentionally ignored even when present.
            if "runtime" in config and not isinstance(config["runtime"], dict):
                pass


def assert_fixture_integrity(manifest: dict) -> None:
    pages = [("main", manifest["main"])]
    pages.extend((f"configs.{key}", value) for key, value in manifest.get("configs", {}).items())
    for page_name, page in pages:
        for resource_type in ("js", "css"):
            for resource in page.get("inject", {}).get(resource_type, []):
                url = resource["url"]
                local_name = url.rsplit("/", 1)[-1]
                local_path = ROOT / "pandalive" / local_name
                if not local_path.is_file():
                    fail(f"{page_name} resource is not present locally: {local_name}")
                expected = digest(local_path)
                if resource["integrity"] != expected:
                    fail(f"{page_name}.{resource_type}.{resource['id']} digest mismatch")


def test_rejections_and_ignored_extensions(manifest: dict) -> None:
    missing_default = copy.deepcopy(manifest)
    del missing_default["configs"]["default"]
    try:
        validate_manifest(missing_default)
    except AssertionError:
        pass
    else:
        fail("configs without default must be rejected")

    invalid_key = copy.deepcopy(manifest)
    invalid_key["configs"]["BadKey"] = invalid_key["configs"]["default"]
    try:
        validate_manifest(invalid_key)
    except AssertionError:
        pass
    else:
        fail("invalid ConfigKey must be rejected")

    unsupported = copy.deepcopy(manifest)
    unsupported["schemaVersion"] = 2
    try:
        validate_manifest(unsupported)
    except AssertionError:
        pass
    else:
        fail("unsupported schemaVersion must be rejected")

    lan_http = copy.deepcopy(manifest)
    lan_http["main"]["url"] = "http://192.168.1.20/live"
    try:
        validate_manifest(lan_http)
    except AssertionError:
        pass
    else:
        fail("LAN HTTP must be rejected by the v1 URL policy")

    ignored_runtime = copy.deepcopy(manifest)
    ignored_runtime["configs"]["default"]["runtime"] = "reserved-for-future"
    validate_manifest(ignored_runtime)


def main() -> int:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    if schema.get("$schema") != "https://json-schema.org/draft/2020-12/schema":
        fail("schema draft is not 2020-12")
    manifest_text = MANIFEST_PATH.read_text(encoding="utf-8")
    manifest = json.loads(manifest_text)
    validate_manifest(manifest)
    assert_fixture_integrity(manifest)
    test_rejections_and_ignored_extensions(manifest)
    if any(token in manifest_text for token in ("checkJS", "injectJS", "injectCSS", "sha256\"", "bridgeVersion")):
        fail("legacy Manifest fields must not be present")
    print("manifest_test: ok")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (AssertionError, json.JSONDecodeError) as error:
        print(f"manifest_test: {error}", file=sys.stderr)
        raise SystemExit(1)
