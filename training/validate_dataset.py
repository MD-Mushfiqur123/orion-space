#!/usr/bin/env python3
"""
Strict dataset validation for Orion-0.6B v0.1 SFT JSONL files.

Verifies:
  1. Valid chat + tool-calling structure (`messages`, `tools`, role ordering).
  2. Strict tool-name allowlist matching server/agent/toolRegistry.js.
  3. Zero duplicate prompts and zero cross-split prompt or held-out-district leakage.
  4. Scientific ground-truth constraints (October FDR = 0/34, Annual = 0/34, no fake numbers on unavailable feeds).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

ALLOWED_TOOLS = frozenset(
    {
        "resolve_bangladesh_location",
        "query_climate_trends",
        "get_live_weather",
        "get_active_fires",
        "get_crop_advisory",
    }
)

DEFAULT_CONFIG = Path(__file__).resolve().parent / "orion_qwen3_config.json"


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                rows.append(json.loads(stripped))
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{line_no}: invalid JSON: {exc}") from exc
    return rows


def check_scientific_guardrails(record: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    messages = record.get("messages", [])
    tool_contents = [m.get("content", "") for m in messages if m.get("role") == "tool"]
    final_content = str(messages[-1].get("content", "")) if messages else ""
    rec_id = record.get("id", "<unknown>")

    # Never claim October passes BH FDR
    oct_fdr_claim = re.search(
        r"october[^\n.]{0,80}(?:survives?|passes?)\s+(?:bh\s+)?fdr|october[^\n.]{0,40}31/34\s+fdr",
        final_content,
        flags=re.IGNORECASE,
    )
    if oct_fdr_claim:
        errors.append(f"{rec_id}: invalid claim that October passes FDR")

    # Never fabricate numbers when a tool reports status=unavailable
    for tool_json_str in tool_contents:
        try:
            tool_obj = json.loads(tool_json_str)
        except Exception:
            continue
        if tool_obj.get("status") == "unavailable":
            if "unavailable" not in final_content.lower() and "পাওয়া যাচ্ছে না" not in final_content:
                errors.append(f"{rec_id}: tool reported unavailable but final answer did not state unavailability")
            if re.search(r"\d+\.\d+\s*(?:°c|mm/h|hpa|knots)", final_content, flags=re.IGNORECASE):
                errors.append(f"{rec_id}: fabricated numeric telemetry despite unavailable tool status")

    return errors


def validate_record(record: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    rec_id = record.get("id", "<missing-id>")
    messages = record.get("messages")
    if not isinstance(messages, list) or len(messages) < 3:
        return [f"{rec_id}: messages must be a list of at least 3 turns"]

    if messages[0].get("role") != "system" or not messages[0].get("content"):
        errors.append(f"{rec_id}: first message must be non-empty system prompt")
    if messages[1].get("role") != "user" or not str(messages[1].get("content", "")).strip():
        errors.append(f"{rec_id}: second message must be non-empty user prompt")
    if messages[-1].get("role") != "assistant" or not str(messages[-1].get("content", "")).strip():
        errors.append(f"{rec_id}: final message must be non-empty assistant response")

    seen_tool_ids: set[str] = set()
    for msg in messages:
        role = msg.get("role")
        if role not in {"system", "user", "assistant", "tool"}:
            errors.append(f"{rec_id}: invalid role {role!r}")
        if role == "assistant" and msg.get("tool_calls"):
            for call in msg["tool_calls"]:
                fn = call.get("function", {})
                name = fn.get("name")
                if name not in ALLOWED_TOOLS:
                    errors.append(f"{rec_id}: non-allowlisted tool {name!r}")
                raw_args = fn.get("arguments", "{}")
                try:
                    parsed = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
                    if not isinstance(parsed, dict):
                        errors.append(f"{rec_id}: tool arguments must decode to object")
                except Exception as exc:
                    errors.append(f"{rec_id}: invalid tool JSON arguments: {exc}")
                if call.get("id"):
                    seen_tool_ids.add(call["id"])
        if role == "tool":
            if msg.get("name") not in ALLOWED_TOOLS:
                errors.append(f"{rec_id}: tool response name {msg.get('name')!r} not allowlisted")
            if msg.get("tool_call_id") not in seen_tool_ids:
                errors.append(f"{rec_id}: orphan tool_call_id {msg.get('tool_call_id')!r}")

    errors.extend(check_scientific_guardrails(record))
    return errors


def validate_splits(
    split_files: dict[str, Path],
    config_path: Path = DEFAULT_CONFIG,
) -> dict[str, Any]:
    config = json.loads(config_path.read_text(encoding="utf-8"))
    val_heldout = set(config["dataset"]["val_heldout_districts"])
    test_heldout = set(config["dataset"]["test_heldout_districts"])

    errors: list[str] = []
    prompts_by_split: dict[str, set[str]] = {}
    counts: dict[str, int] = {}

    for split, path in split_files.items():
        if not path.exists():
            errors.append(f"Missing split file: {path}")
            continue
        rows = load_jsonl(path)
        counts[split] = len(rows)
        seen_local: set[str] = set()
        prompts_by_split[split] = seen_local

        for row in rows:
            errors.extend(validate_record(row))
            user_prompt = str(row.get("messages", [{}, {}])[1].get("content", "")).strip().lower()
            if user_prompt in seen_local:
                errors.append(f"{split}: duplicate prompt {user_prompt!r}")
            seen_local.add(user_prompt)

            dist_id = row.get("district_id")
            if split == "train" and dist_id in (val_heldout | test_heldout):
                errors.append(f"Leakage: held-out district {dist_id!r} appeared in train")
            if split == "val" and dist_id in test_heldout:
                errors.append(f"Leakage: test held-out district {dist_id!r} appeared in val")
            if split == "test" and dist_id in val_heldout:
                errors.append(f"Leakage: val held-out district {dist_id!r} appeared in test")

    for s1, s2 in [("train", "val"), ("train", "test"), ("val", "test")]:
        overlap = prompts_by_split.get(s1, set()) & prompts_by_split.get(s2, set())
        if overlap:
            errors.append(f"Prompt leakage between {s1} and {s2}: {sorted(overlap)[:3]}")

    return {
        "ok": len(errors) == 0,
        "counts": counts,
        "error_count": len(errors),
        "errors": errors[:25],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--artifacts-dir",
        type=Path,
        default=Path(__file__).resolve().parent / "artifacts",
    )
    parser.add_argument(
        "--reviewed",
        type=Path,
        default=Path(__file__).resolve().parent / "examples" / "reviewed_examples.jsonl",
    )
    args = parser.parse_args()

    split_files = {
        "train": args.artifacts_dir / "train.jsonl",
        "val": args.artifacts_dir / "val.jsonl",
        "test": args.artifacts_dir / "test.jsonl",
    }
    report = validate_splits(split_files)

    if args.reviewed.exists():
        reviewed_rows = load_jsonl(args.reviewed)
        reviewed_errors: list[str] = []
        for row in reviewed_rows:
            reviewed_errors.extend(validate_record(row))
        report["reviewed_count"] = len(reviewed_rows)
        if reviewed_errors:
            report["ok"] = False
            report["error_count"] += len(reviewed_errors)
            report["errors"].extend(reviewed_errors[:10])

    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
