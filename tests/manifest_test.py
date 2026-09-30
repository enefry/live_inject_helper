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
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = ROOT / "schema" / "web-widget-manifest-v1.schema.json"
MANIFEST_PATH = ROOT / "pandalive" / "pandalive.json"
INTEGRITY_RE = re.compile(r"^sha256-[A-Za-z0-9+/]{43}=$")
CONFIG_KEY_RE = re.compile(r"^(?:default|[a-z][a-z0-9._-]{0,63})$")
DEBUG_HTTP_URL_RE = re.compile(
    r"^http://(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?(?:/|$)"
)
SUFFIX_RULES = json.loads((ROOT / "security" / "public-suffix-rules.json").read_text(encoding="utf-8"))
EXACT_SUFFIXES = set(SUFFIX_RULES["exact"])
WILDCARD_SUFFIXES = set(SUFFIX_RULES["wildcard"])
SUFFIX_EXCEPTIONS = set(SUFFIX_RULES["exception"])
DNS_HOST_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$")


def registrable_domain(host: str) -> str | None:
    labels = host.lower().split(".")
    suffix_count = 1
    for index in range(len(labels)):
        suffix = ".".join(labels[index:])
        if suffix in SUFFIX_EXCEPTIONS:
            suffix_count = len(labels) - index - 1
            break
        if suffix in EXACT_SUFFIXES or ".".join(labels[index + 1:]) in WILDCARD_SUFFIXES:
            suffix_count = max(suffix_count, len(labels) - index)
    return ".".join(labels[-suffix_count - 1:]) if len(labels) > suffix_count else None


def validate_origins(page: dict) -> None:
    if "allowedOrigins" not in page:
        return
    origins = page["allowedOrigins"]
    if not isinstance(origins, list) or not 1 <= len(origins) <= 16:
        fail("allowedOrigins must contain 1...16 entries")
    base = urlsplit(page["url"])
    if (not DNS_HOST_RE.fullmatch(base.hostname or "") or len(base.hostname or "") > 253 or
            not re.search(r"[a-z]", (base.hostname or "").split(".")[-1])):
        fail("allowedOrigins requires a DNS page host")
    seen = set()
    for origin in origins:
        if not isinstance(origin, str) or len(origin) > 512 or not origin.startswith("https://"):
            fail("invalid allowedOrigins entry")
        wildcard = origin.startswith("https://*.")
        candidate = "https://" + origin[len("https://*."):] if wildcard else origin
        if not re.fullmatch(r"https://[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?::[0-9]{1,5})?", candidate):
            fail("invalid allowedOrigins syntax")
        if any(character in candidate for character in ("*", "%", "\\", " ", "\n", "\t", "?", "#")):
            fail("invalid allowedOrigins entry")
        parsed = urlsplit(candidate)
        try:
            port = parsed.port or 443
        except ValueError:
            fail("invalid allowedOrigins port")
        host = parsed.hostname or ""
        if (parsed.username is not None or parsed.password is not None or parsed.path or
                not DNS_HOST_RE.fullmatch(host) or len(host) > 253 or
                not re.search(r"[a-z]", host.split(".")[-1]) or parsed.port == 0 or
                parsed.scheme != base.scheme or port != (base.port or 443)):
            fail("invalid allowedOrigins entry")
        site = registrable_domain(host)
        if site is None or site != registrable_domain(base.hostname or ""):
            fail("public suffix or unrelated site in allowedOrigins")
        normalized = (host, port, wildcard)
        if normalized in seen:
            fail("normalized duplicate in allowedOrigins")
        seen.add(normalized)


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
    validate_origins(page)
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
    cases = json.loads((ROOT / "tests" / "origin_policy_cases.json").read_text(encoding="utf-8"))
    for case in cases["policies"]:
        page = {"url": case["pageURL"]}
        if "allowedOrigins" in case:
            page["allowedOrigins"] = case["allowedOrigins"]
        validate_origins(page)
    for entries in cases["invalidDeclarations"] + [None, "https://pandalive.co.kr"]:
        try:
            validate_origins({"url": manifest["main"]["url"], "allowedOrigins": entries})
        except AssertionError:
            pass
        else:
            fail(f"invalid origin declaration accepted: {entries}")
    for case in cases["invalidPublicSuffixes"]:
        try:
            validate_origins({"url": case["pageURL"], "allowedOrigins": case["allowedOrigins"]})
        except AssertionError:
            pass
        else:
            fail("public suffix declaration accepted")
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
