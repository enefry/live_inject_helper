#!/usr/bin/env python3
"""Update local JS/CSS resource hashes referenced by a Widget Manifest.

The pre-commit mode hashes the version that is actually in the Git index. This
is important when a developer has an unrelated, unstaged edit in the worktree:
the committed Manifest must never contain a hash for bytes that are not in the
same commit.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import unquote, urlparse


RESOURCE_LIST_KEYS = (
    "injectJS",
    "injectCSS",
    "mainInjectJS",
    "mainInjectCSS",
    "configInjectJS",
    "configInjectCSS",
)
CHECK_KEYS = ("checkJS", "checkJSResource")


def git(repo_root: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["git", "-C", str(repo_root), *args],
        check=check,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def relative_path(path: Path, repo_root: Path) -> str | None:
    try:
        return path.resolve().relative_to(repo_root.resolve()).as_posix()
    except ValueError:
        return None


def repository_candidates(repo_root: Path) -> list[str]:
    tracked = git(repo_root, "ls-files", "-co", "--exclude-standard").stdout.decode().splitlines()
    return sorted(
        {
            item.strip().lstrip("./")
            for item in tracked
            if item.strip() and not item.startswith(".git/")
        },
        key=lambda item: (len(item), item),
        reverse=True,
    )


def resolve_local_path(url: str, repo_root: Path, candidates: Iterable[str]) -> Path | None:
    parsed = urlparse(url)
    if parsed.scheme in ("", "file"):
        raw_path = unquote(parsed.path)
        if parsed.scheme == "file" and os.path.isabs(raw_path):
            candidate = Path(raw_path)
        else:
            candidate = repo_root / raw_path.lstrip("/")
        return candidate if candidate.is_file() else None

    remote_path = unquote(parsed.path).lstrip("/")
    matches = [
        repo_root / candidate
        for candidate in candidates
        if remote_path == candidate or remote_path.endswith("/" + candidate)
    ]
    existing = [candidate for candidate in matches if candidate.is_file()]
    if len(existing) == 1:
        return existing[0]
    return None


def index_bytes(repo_root: Path, path: Path, mode: str) -> bytes | None:
    rel = relative_path(path, repo_root)
    if rel is None:
        return None

    if mode == "staged":
        staged = git(repo_root, "diff", "--cached", "--name-only", "--", rel, check=False)
        if staged.returncode == 0 and staged.stdout.decode().strip():
            result = git(repo_root, "show", f":{rel}", check=False)
            if result.returncode == 0:
                return result.stdout
        # A tracked resource that is not staged must be hashed from HEAD, not
        # from an unstaged worktree edit that will not be part of this commit.
        head = git(repo_root, "cat-file", "-e", f"HEAD:{rel}", check=False)
        if head.returncode == 0:
            result = git(repo_root, "show", f"HEAD:{rel}", check=False)
            if result.returncode == 0:
                return result.stdout
        return None

    try:
        return path.read_bytes()
    except OSError:
        return None


def sha256_base64(data: bytes) -> str:
    return base64.b64encode(hashlib.sha256(data).digest()).decode("ascii")


def read_manifest_source(manifest_path: Path, repo_root: Path, mode: str) -> tuple[str, str]:
    """Read the Manifest from the worktree or the version being committed.

    In pre-commit mode the index is authoritative.  Reading the worktree here
    would allow an unrelated, unstaged Manifest edit to be staged accidentally
    when the hook adds the generated hash update.
    """

    if mode == "staged":
        rel_manifest = relative_path(manifest_path, repo_root)
        if rel_manifest:
            index_result = git(repo_root, "show", f":{rel_manifest}", check=False)
            if index_result.returncode == 0:
                return index_result.stdout.decode("utf-8"), "index"

            head_result = git(repo_root, "show", f"HEAD:{rel_manifest}", check=False)
            if head_result.returncode == 0:
                return head_result.stdout.decode("utf-8"), "head"

    return manifest_path.read_text(encoding="utf-8"), "worktree"


def update_index_file(repo_root: Path, rel_path: str, content: str) -> None:
    """Replace one index entry without staging unrelated worktree changes."""

    blob = subprocess.run(
        ["git", "-C", str(repo_root), "hash-object", "-w", "--stdin"],
        input=content.encode("utf-8"),
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    ).stdout.decode("ascii").strip()
    subprocess.run(
        ["git", "-C", str(repo_root), "update-index", "--add", "--cacheinfo", f"100644,{blob},{rel_path}"],
        check=True,
    )


def resource_nodes(manifest: dict[str, Any]) -> Iterable[tuple[Any, Any, str]]:
    """Yield (parent, key/index, description) for resource values in the manifest."""

    pages: list[dict[str, Any]] = []
    for key in ("main", "config"):
        page = manifest.get(key)
        if isinstance(page, dict):
            pages.append(page)

    containers = pages + [manifest]
    for container in containers:
        for key in RESOURCE_LIST_KEYS:
            resources = container.get(key)
            if not isinstance(resources, list):
                continue
            for index in range(len(resources)):
                yield resources, index, key
        for key in CHECK_KEYS:
            if key in container:
                yield container, key, key


def get_node(parent: Any, key: Any) -> Any:
    return parent[key]


def set_node(parent: Any, key: Any, value: Any) -> None:
    parent[key] = value


def update_manifest(manifest: dict[str, Any], repo_root: Path, mode: str) -> tuple[int, list[str], bool]:
    candidates = repository_candidates(repo_root)
    changed = 0
    messages: list[str] = []
    staged_resource_found = False
    seen: set[int] = set()

    for parent, key, description in resource_nodes(manifest):
        resource = get_node(parent, key)
        if id(resource) in seen:
            continue
        seen.add(id(resource))

        if isinstance(resource, str):
            url = resource
            resource_object: dict[str, Any] = {"url": url}
            replace_string = True
        elif isinstance(resource, dict):
            url = resource.get("url")
            if not isinstance(url, str) or not url.strip():
                continue
            resource_object = resource
            replace_string = False
        else:
            continue

        local_path = resolve_local_path(url, repo_root, candidates)
        if local_path is None:
            messages.append(f"skip {description}: no local file mapping for {url}")
            continue

        if mode == "staged":
            rel_path = relative_path(local_path, repo_root)
            if rel_path:
                staged = git(repo_root, "diff", "--cached", "--name-only", "--", rel_path, check=False)
                staged_resource_found = staged_resource_found or bool(staged.stdout.decode().strip())

        data = index_bytes(repo_root, local_path, mode)
        if data is None:
            messages.append(
                f"skip {description}: {relative_path(local_path, repo_root) or local_path} is not available in {mode}"
            )
            continue

        digest = sha256_base64(data)
        if resource_object.get("sha256") != digest:
            resource_object["sha256"] = digest
            changed += 1
        if replace_string:
            set_node(parent, key, resource_object)
            changed += 1
        messages.append(f"{description}: {relative_path(local_path, repo_root)} -> {digest}")

    return changed, messages, staged_resource_found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument(
        "--source",
        choices=("worktree", "staged"),
        default="worktree",
        help="Hash worktree files, or the staged/HEAD bytes used by pre-commit.",
    )
    parser.add_argument(
        "--stage",
        action="store_true",
        help="Stage the Manifest after changing it.",
    )
    args = parser.parse_args()

    manifest_path = args.manifest.resolve()
    repo_root_result = subprocess.run(
        ["git", "-C", str(manifest_path.parent), "rev-parse", "--show-toplevel"],
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    repo_root = Path(repo_root_result.stdout.strip()).resolve()

    try:
        original, manifest_source = read_manifest_source(manifest_path, repo_root, args.source)
        manifest = json.loads(original)
    except (OSError, json.JSONDecodeError) as error:
        print(f"update_manifest_sha256: cannot read Manifest: {error}", file=sys.stderr)
        return 1
    if not isinstance(manifest, dict):
        print("update_manifest_sha256: Manifest root must be an object", file=sys.stderr)
        return 1

    changed, messages, staged_resource_found = update_manifest(manifest, repo_root, args.source)
    for message in messages:
        print(message)

    rendered = json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    rel_manifest = relative_path(manifest_path, repo_root)
    if rendered != original:
        if args.source == "staged" and rel_manifest and manifest_source in ("index", "head"):
            try:
                worktree = manifest_path.read_text(encoding="utf-8")
            except OSError:
                worktree = None
            if worktree == original:
                manifest_path.write_text(rendered, encoding="utf-8")
                print(f"updated {rel_manifest}")
            else:
                update_index_file(repo_root, rel_manifest, rendered)
                print(f"updated index {rel_manifest} (worktree left untouched)")
        else:
            manifest_path.write_text(rendered, encoding="utf-8")
            print(f"updated {rel_manifest or manifest_path}")

    if changed == 0:
        print("update_manifest_sha256: no hash changes")

    should_stage = args.stage and (changed > 0 or staged_resource_found)
    if should_stage:
        if rel_manifest is None:
            print("update_manifest_sha256: Manifest must be inside the repository", file=sys.stderr)
            return 1
        index_manifest = git(repo_root, "show", f":{rel_manifest}", check=False)
        if index_manifest.returncode != 0 or index_manifest.stdout.decode("utf-8") != rendered:
            if args.source == "staged" and manifest_source in ("index", "head"):
                update_index_file(repo_root, rel_manifest, rendered)
            else:
                subprocess.run(["git", "-C", str(repo_root), "add", "--", rel_manifest], check=True)
            print(f"staged {rel_manifest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
