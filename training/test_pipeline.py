#!/usr/bin/env python3
"""Unit tests for Phase 3 Orion-0.6B v0.1 dataset, validator, and evaluator."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

TRAINING_DIR = Path(__file__).resolve().parent
if str(TRAINING_DIR) not in sys.path:
    sys.path.insert(0, str(TRAINING_DIR))

import build_dataset  # noqa: E402
import evaluate  # noqa: E402
import validate_dataset  # noqa: E402


class OrionTrainingPipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.splits = build_dataset.build_splits(seed=42)

    def test_splits_are_non_empty_and_leak_free(self) -> None:
        self.assertGreaterEqual(len(self.splits["train"]), 500)
        self.assertGreaterEqual(len(self.splits["val"]), 30)
        self.assertGreaterEqual(len(self.splits["test"]), 30)

        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            split_files = {}
            for name, rows in self.splits.items():
                path = tmp_dir / f"{name}.jsonl"
                build_dataset.write_jsonl(path, rows)
                split_files[name] = path

            report = validate_dataset.validate_splits(split_files)
            self.assertTrue(report["ok"], f"Validation errors: {report['errors']}")
            self.assertEqual(report["error_count"], 0)

    def test_validator_catches_october_fdr_hallucination_and_unavailable_fabrication(self) -> None:
        bad_oct = {
            "id": "bad_oct",
            "messages": [
                {"role": "system", "content": build_dataset.SYSTEM_PROMPT},
                {"role": "user", "content": "Is October FDR significant?"},
                {
                    "role": "assistant",
                    "content": '{"answer": "Yes, October survives BH FDR across 31/34 FDR cells."}',
                },
            ],
        }
        errs = validate_dataset.validate_record(bad_oct)
        self.assertTrue(any("October passes FDR" in e for e in errs), errs)

        bad_unavail = {
            "id": "bad_unavail",
            "messages": [
                {"role": "system", "content": build_dataset.SYSTEM_PROMPT},
                {"role": "user", "content": "Live weather in Dhaka?"},
                build_dataset.make_tool_call_msg("c1", "get_live_weather", {"districtId": "dhaka"}),
                build_dataset.make_tool_response_msg(
                    "c1",
                    "get_live_weather",
                    {"ok": True, "status": "unavailable", "reason": "upstream down"},
                ),
                {
                    "role": "assistant",
                    "content": '{"answer": "Dhaka is 31.2°C right now with heavy rain 42.8 mm/h."}',
                },
            ],
        }
        errs2 = validate_dataset.validate_record(bad_unavail)
        self.assertGreaterEqual(len(errs2), 1)

    def test_offline_evaluator_scores_oracle_predictions_at_100_percent(self) -> None:
        preds = []
        for ex in self.splits["test"]:
            call = ex["messages"][2]["tool_calls"][0]["function"]
            preds.append(
                {
                    "id": ex["id"],
                    "tool_raw": f'<tool_call>{json.dumps({"name": call["name"], "arguments": json.loads(call["arguments"])})}</tool_call>',
                    "final_response": ex["messages"][-1]["content"],
                }
            )
        scored = [evaluate.score_prediction(ex, p) for ex, p in zip(self.splits["test"], preds)]
        summary = evaluate.summarize_scores(scored)
        self.assertEqual(summary["tool_selection_accuracy"], 1.0)
        self.assertEqual(summary["tool_argument_accuracy"], 1.0)
        self.assertEqual(summary["numeric_fidelity"], 1.0)
        self.assertEqual(summary["scientific_trap_pass_rate"], 1.0)

    def test_config_and_tool_names_match_server_contract(self) -> None:
        cfg = json.loads((TRAINING_DIR / "orion_qwen3_config.json").read_text(encoding="utf-8"))
        self.assertEqual(cfg["base_model"], "Qwen/Qwen3-0.6B")
        self.assertEqual(cfg["model_identity"], "Orion-0.6B v0.1")
        schema_names = {t["function"]["name"] for t in build_dataset.TOOLS_SCHEMA}
        self.assertEqual(schema_names, set(validate_dataset.ALLOWED_TOOLS))


if __name__ == "__main__":
    unittest.main()
