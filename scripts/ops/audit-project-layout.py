#!/usr/bin/env python3
"""Audit a repository against its explicit project-structure contract."""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import sys
from dataclasses import dataclass, asdict
from pathlib import Path, PurePosixPath
from typing import Any, Iterable


CONFIG_NAME = ".project-structure.json"
TEMPORARY_SUFFIXES = {".tmp", ".temp", ".bak", ".old", ".orig", ".rej", ".swp", ".swo"}
TEMPORARY_NAMES = {".ds_store", "thumbs.db", "desktop.ini"}
TEST_PATTERNS = (
    "test_*.py",
    "*_test.py",
    "*.test.js",
    "*.test.jsx",
    "*.test.ts",
    "*.test.tsx",
    "*.spec.js",
    "*.spec.jsx",
    "*.spec.ts",
    "*.spec.tsx",
    "*_test.go",
    "*_test.rs",
)


@dataclass(frozen=True)
class Violation:
    code: str
    path: str
    message: str


class ContractError(ValueError):
    pass


def normalized(value: str | Path) -> str:
    return str(value).replace("\\", "/").strip("/")


def string_list(value: Any, field: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ContractError(f"{field} must be an array of strings")
    return [normalized(item) for item in value]


def load_contract(path: Path) -> dict[str, Any]:
    try:
        contract = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ContractError(f"contract not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ContractError(f"invalid JSON in {path}: {exc}") from exc

    if not isinstance(contract, dict):
        raise ContractError("contract root must be an object")
    if contract.get("schema_version") != 1:
        raise ContractError("schema_version must be 1")
    if not isinstance(contract.get("top_level_directories"), dict):
        raise ContractError("top_level_directories must be an object mapping paths to responsibilities")
    if not all(
        isinstance(key, str) and isinstance(value, str) and value.strip()
        for key, value in contract["top_level_directories"].items()
    ):
        raise ContractError("every top_level_directories entry must have a non-empty responsibility")
    if any(
        not normalized(key) or "/" in normalized(key)
        for key in contract["top_level_directories"]
    ):
        raise ContractError("top_level_directories keys must be single directory names")
    string_list(contract.get("root_files"), "root_files")
    root_patterns = string_list(contract.get("root_file_patterns"), "root_file_patterns")
    ignored_paths = string_list(contract.get("ignored_paths"), "ignored_paths")
    catch_all_patterns = {"*", "**", "*.*"}
    if any(pattern.casefold() in catch_all_patterns for pattern in root_patterns):
        raise ContractError("root_file_patterns must not contain a catch-all pattern")
    if any(pattern.casefold() in catch_all_patterns for pattern in ignored_paths):
        raise ContractError("ignored_paths must not contain a catch-all pattern")
    return contract


def matches_path_pattern(relative: PurePosixPath, pattern: str) -> bool:
    rel = relative.as_posix()
    pattern = normalized(pattern)
    if not pattern:
        return False
    if "/" not in pattern and any(fnmatch.fnmatchcase(part, pattern) for part in relative.parts):
        return True
    return fnmatch.fnmatchcase(rel, pattern)


def is_ignored(relative: PurePosixPath, patterns: Iterable[str]) -> bool:
    return any(matches_path_pattern(relative, pattern) for pattern in patterns)


def is_under(relative: PurePosixPath, roots: Iterable[str]) -> bool:
    rel = relative.as_posix()
    for root in roots:
        root = normalized(root)
        if root and (rel == root or rel.startswith(root + "/")):
            return True
    return False


def looks_like_test(relative: PurePosixPath) -> bool:
    if "__tests__" in {part.casefold() for part in relative.parts}:
        return True
    name = relative.name.casefold()
    return any(fnmatch.fnmatchcase(name, pattern) for pattern in TEST_PATTERNS)


def looks_temporary(relative: PurePosixPath) -> bool:
    name = relative.name.casefold()
    return (
        name in TEMPORARY_NAMES
        or name.endswith("~")
        or Path(name).suffix in TEMPORARY_SUFFIXES
    )


def audit(project: Path, contract: dict[str, Any]) -> list[Violation]:
    violations: list[Violation] = []
    root_files = set(string_list(contract.get("root_files"), "root_files"))
    root_patterns = string_list(contract.get("root_file_patterns"), "root_file_patterns")
    ignored = string_list(contract.get("ignored_paths"), "ignored_paths")
    allowed_directories = {normalized(path) for path in contract["top_level_directories"]}

    placement = contract.get("placement") or {}
    if not isinstance(placement, dict):
        raise ContractError("placement must be an object")
    test_roots = string_list(placement.get("test_roots"), "placement.test_roots")
    source_roots = string_list(placement.get("source_roots"), "placement.source_roots")
    generated_roots = string_list(placement.get("generated_roots"), "placement.generated_roots")
    colocated_tests = bool(placement.get("allow_colocated_tests", False))
    allowed_directories.update(root.split("/", 1)[0] for root in generated_roots if root)

    policies = contract.get("policies") or {}
    if not isinstance(policies, dict):
        raise ContractError("policies must be an object")
    forbidden_trees = {
        item.casefold()
        for item in string_list(
            policies.get("forbid_parallel_source_trees"),
            "policies.forbid_parallel_source_trees",
        )
    }
    forbid_temporary = bool(policies.get("forbid_temporary_files", True))
    file_rules = contract.get("file_rules") or []
    if not isinstance(file_rules, list):
        raise ContractError("file_rules must be an array")
    parsed_file_rules: list[tuple[str, list[str], list[str]]] = []
    for index, rule in enumerate(file_rules):
        field = f"file_rules[{index}]"
        if not isinstance(rule, dict) or not isinstance(rule.get("name"), str):
            raise ContractError(f"{field} must be an object with a name")
        patterns = string_list(rule.get("patterns"), f"{field}.patterns")
        allowed_roots_for_rule = string_list(
            rule.get("allowed_roots"), f"{field}.allowed_roots"
        )
        if not patterns or not allowed_roots_for_rule:
            raise ContractError(f"{field} requires patterns and allowed_roots")
        parsed_file_rules.append((rule["name"], patterns, allowed_roots_for_rule))

    for child in sorted(project.iterdir(), key=lambda item: item.name.casefold()):
        relative = PurePosixPath(child.name)
        if is_ignored(relative, ignored):
            continue
        if child.is_file():
            allowed = child.name in root_files or any(
                fnmatch.fnmatchcase(child.name, pattern) for pattern in root_patterns
            )
            if not allowed:
                violations.append(
                    Violation(
                        "ROOT_FILE_NOT_ALLOWED",
                        child.name,
                        "Root files must be explicitly allowlisted by the structure contract.",
                    )
                )
        elif child.is_dir():
            if child.name.casefold() in forbidden_trees:
                violations.append(
                    Violation(
                        "PARALLEL_SOURCE_TREE",
                        child.name,
                        "Do not maintain development/full copies of source; use branches and worktrees.",
                    )
                )
            if child.name not in allowed_directories:
                violations.append(
                    Violation(
                        "TOP_LEVEL_DIRECTORY_NOT_ALLOWED",
                        child.name,
                        "Top-level directories need an explicit responsibility in the structure contract.",
                    )
                )

    for current_root, directories, files in os.walk(project, topdown=True, followlinks=False):
        current = Path(current_root)
        rel_current = current.relative_to(project)
        directories[:] = [
            directory
            for directory in directories
            if not is_ignored(
                PurePosixPath(normalized(rel_current / directory)),
                ignored,
            )
        ]
        for file_name in files:
            relative = PurePosixPath(normalized((current / file_name).relative_to(project)))
            if is_ignored(relative, ignored):
                continue
            if forbid_temporary and looks_temporary(relative):
                violations.append(
                    Violation(
                        "TEMPORARY_FILE",
                        relative.as_posix(),
                        "Temporary/editor residue must not live in the project tree.",
                    )
                )
            if looks_like_test(relative):
                valid_location = is_under(relative, test_roots) or (
                    colocated_tests and is_under(relative, source_roots)
                )
                if not valid_location:
                    violations.append(
                        Violation(
                            "TEST_OUTSIDE_TEST_ROOT",
                            relative.as_posix(),
                            "Move the test into a declared test root or explicitly allow colocated tests.",
                        )
                    )
            for rule_name, patterns, allowed_roots_for_rule in parsed_file_rules:
                if not any(
                    fnmatch.fnmatchcase(relative.name.casefold(), pattern.casefold())
                    for pattern in patterns
                ):
                    continue
                is_allowlisted_root_file = (
                    len(relative.parts) == 1
                    and (
                        relative.name in root_files
                        or any(fnmatch.fnmatchcase(relative.name, pattern) for pattern in root_patterns)
                    )
                )
                if not is_allowlisted_root_file and not is_under(relative, allowed_roots_for_rule):
                    violations.append(
                        Violation(
                            "FILE_PLACEMENT_VIOLATION",
                            relative.as_posix(),
                            f"{rule_name} belong under: {', '.join(allowed_roots_for_rule)}.",
                        )
                    )

    return sorted(violations, key=lambda item: (item.path.casefold(), item.code))


def render_text(project: Path, contract_path: Path, violations: list[Violation]) -> str:
    if not violations:
        return f"PASS: {project} follows {contract_path.name} (0 violations)."
    lines = [f"FAIL: {project} has {len(violations)} project-layout violation(s):"]
    lines.extend(f"- [{item.code}] {item.path}: {item.message}" for item in violations)
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", type=Path, help="Project root to audit")
    parser.add_argument(
        "--config",
        type=Path,
        help=f"Contract path (default: PROJECT/{CONFIG_NAME})",
    )
    parser.add_argument("--format", choices=("text", "json"), default="text")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    project = args.project.resolve()
    config_path = (args.config or (project / CONFIG_NAME)).resolve()
    try:
        if not project.is_dir():
            raise ContractError(f"project root is not a directory: {project}")
        contract = load_contract(config_path)
        violations = audit(project, contract)
    except (ContractError, OSError) as exc:
        if args.format == "json":
            print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False))
        else:
            print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    if args.format == "json":
        print(
            json.dumps(
                {
                    "status": "pass" if not violations else "fail",
                    "project": str(project),
                    "contract": str(config_path),
                    "violations": [asdict(item) for item in violations],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        print(render_text(project, config_path, violations))
    return 0 if not violations else 1


if __name__ == "__main__":
    raise SystemExit(main())
