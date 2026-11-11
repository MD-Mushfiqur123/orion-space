#!/usr/bin/env python3
"""
LoRA SFT training script for Orion-0.6B v0.1 (Base: Qwen/Qwen3-0.6B).
Designed for Kaggle T4 GPU (16 GB VRAM) or equivalent CUDA GPUs.

Saves LoRA adapter weights and training metadata outside git-tracked source paths
(default: training/outputs/orion-qwen3-0.6b-lora, gitignored).
"""

from __future__ import annotations

import argparse
import inspect
import json
import os
from pathlib import Path
from typing import Any

DEFAULT_CONFIG = Path(__file__).resolve().parent / "orion_qwen3_config.json"
DEFAULT_ARTIFACTS = Path(__file__).resolve().parent / "artifacts"
DEFAULT_OUTPUT = Path(__file__).resolve().parent / "outputs" / "orion-qwen3-0.6b-lora"


def render_chat_example(tokenizer: Any, example: dict[str, Any], enable_thinking: bool = False) -> str:
    """Format multi-turn tool-calling example using the Qwen3 chat template."""
    messages = example["messages"]
    tools = example.get("tools")
    kwargs: dict[str, Any] = {
        "tokenize": False,
        "add_generation_prompt": False,
    }
    if tools:
        kwargs["tools"] = tools

    sig = inspect.signature(tokenizer.apply_chat_template)
    if "enable_thinking" in sig.parameters:
        kwargs["enable_thinking"] = enable_thinking

    try:
        return tokenizer.apply_chat_template(messages, **kwargs)
    except TypeError:
        kwargs.pop("enable_thinking", None)
        return tokenizer.apply_chat_template(messages, **kwargs)


def load_jsonl_dataset(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--train-file", type=Path, default=DEFAULT_ARTIFACTS / "train.jsonl")
    parser.add_argument("--val-file", type=Path, default=DEFAULT_ARTIFACTS / "val.jsonl")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--merge-output", type=Path, default=None, help="Optional directory to save merged 16-bit model.")
    parser.add_argument("--push-to-hub", type=str, default="", help="Optional private HF repo id (uses HF_TOKEN env var).")
    parser.add_argument("--max-steps", type=int, default=-1, help="Override steps for quick smoke training.")
    args = parser.parse_args()

    import torch
    from datasets import Dataset
    from peft import LoraConfig
    from transformers import AutoModelForCausalLM, AutoTokenizer, set_seed
    from trl import SFTConfig, SFTTrainer

    cfg = json.loads(args.config.read_text(encoding="utf-8"))
    set_seed(cfg.get("seed", 42))

    base_model_id = cfg["base_model"]
    enable_thinking = bool(cfg.get("enable_thinking", False))

    tokenizer = AutoTokenizer.from_pretrained(base_model_id, trust_remote_code=False)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "right"

    raw_train = load_jsonl_dataset(args.train_file)
    raw_val = load_jsonl_dataset(args.val_file)

    train_texts = [
        {"text": render_chat_example(tokenizer, ex, enable_thinking=enable_thinking)}
        for ex in raw_train
    ]
    val_texts = [
        {"text": render_chat_example(tokenizer, ex, enable_thinking=enable_thinking)}
        for ex in raw_val
    ]

    train_ds = Dataset.from_list(train_texts)
    val_ds = Dataset.from_list(val_texts)

    use_bf16 = torch.cuda.is_available() and torch.cuda.is_bf16_supported()
    dtype = torch.bfloat16 if use_bf16 else (torch.float16 if torch.cuda.is_available() else torch.float32)

    model = AutoModelForCausalLM.from_pretrained(
        base_model_id,
        torch_dtype=dtype,
        device_map="auto" if torch.cuda.is_available() else None,
        trust_remote_code=False,
    )
    model.config.use_cache = False

    lora_cfg = LoraConfig(**cfg["lora"])

    t_args = dict(cfg["training_args"])
    t_args["bf16"] = use_bf16
    t_args["fp16"] = torch.cuda.is_available() and not use_bf16
    if args.max_steps > 0:
        t_args["max_steps"] = args.max_steps

    args.output_dir.mkdir(parents=True, exist_ok=True)
    sft_config = SFTConfig(
        output_dir=str(args.output_dir),
        dataset_text_field="text",
        max_length=cfg.get("max_seq_length", 2048),
        packing=False,
        report_to="none",
        **t_args,
    )

    trainer = SFTTrainer(
        model=model,
        processing_class=tokenizer,
        train_dataset=train_ds,
        eval_dataset=val_ds,
        peft_config=lora_cfg,
        args=sft_config,
    )

    train_result = trainer.train()
    eval_metrics = trainer.evaluate()

    adapter_dir = args.output_dir / "adapter"
    adapter_dir.mkdir(parents=True, exist_ok=True)
    trainer.model.save_pretrained(str(adapter_dir))
    tokenizer.save_pretrained(str(adapter_dir))

    summary = {
        "model_identity": cfg["model_identity"],
        "base_model": base_model_id,
        "base_model_revision": getattr(model.config, "_commit_hash", None),
        "train_examples": len(raw_train),
        "val_examples": len(raw_val),
        "train_metrics": train_result.metrics,
        "eval_metrics": eval_metrics,
        "adapter_dir": str(adapter_dir),
    }

    if args.merge_output:
        merged_dir = args.merge_output
        merged_dir.mkdir(parents=True, exist_ok=True)
        merged_model = trainer.model.merge_and_unload()
        merged_model.save_pretrained(str(merged_dir), safe_serialization=True)
        tokenizer.save_pretrained(str(merged_dir))
        summary["merged_dir"] = str(merged_dir)

    summary_path = args.output_dir / "training_summary.json"
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))

    if args.push_to_hub:
        token = os.environ.get("HF_TOKEN", "").strip()
        if not token:
            raise RuntimeError("HF_TOKEN environment variable is required for --push-to-hub")
        from huggingface_hub import HfApi

        api = HfApi(token=token)
        api.create_repo(repo_id=args.push_to_hub, private=True, exist_ok=True)
        upload_folder = args.merge_output if args.merge_output else adapter_dir
        api.upload_folder(
            folder_path=str(upload_folder),
            repo_id=args.push_to_hub,
            commit_message="Upload Orion-0.6B v0.1 evaluated artifact",
        )
        api.upload_file(
            path_or_fileobj=str(summary_path),
            path_in_repo="training_summary.json",
            repo_id=args.push_to_hub,
            commit_message="Upload Orion-0.6B v0.1 training summary",
        )


if __name__ == "__main__":
    main()
