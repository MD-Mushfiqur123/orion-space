#!/usr/bin/env bash
# ==============================================================================
# Orion Space — Phase 4 vLLM Production Inference Launcher
# Serves the fine-tuned Orion Qwen3-0.6B model behind a private OpenAI API
# ==============================================================================

set -euo pipefail

MODEL_PATH="${1:-${ORION_MODEL_PATH:-training/outputs/orion-qwen3-0.6b-merged}}"
HOST="${ORION_MODEL_HOST:-127.0.0.1}"
PORT="${ORION_MODEL_PORT:-8000}"
SERVED_MODEL_NAME="${ORION_MODEL_NAME:-orion-qwen3-0.6b}"
MAX_MODEL_LEN="${ORION_MAX_MODEL_LEN:-2048}"
GPU_MEMORY_UTILIZATION="${ORION_GPU_MEM:-0.85}"
MAX_NUM_SEQS="${ORION_MAX_CONCURRENCY:-16}"
API_KEY="${ORION_MODEL_API_KEY:-}"

echo "======================================================================"
echo "          ORION SPACE — PRODUCTION vLLM INFERENCE SERVER              "
echo "======================================================================"
echo "Target Model:             ${MODEL_PATH}"
echo "Served Model Name:        ${SERVED_MODEL_NAME}"
echo "Binding Host/Port:        ${HOST}:${PORT} (Private internal networking)"
echo "Max Model Length:         ${MAX_MODEL_LEN}"
echo "GPU Memory Utilization:   ${GPU_MEMORY_UTILIZATION}"
echo "Max Concurrent Sequences: ${MAX_NUM_SEQS}"
echo "======================================================================"

# 1. GPU Check
if command -v nvidia-smi &> /dev/null; then
  echo "[+] Detected GPU:"
  nvidia-smi --query-gpu=name,memory.total,memory.free,driver_version --format=csv,noheader
else
  echo "[!] WARNING: nvidia-smi not detected. vLLM requires a supported GPU (NVIDIA T4 / A10 / L4)."
  echo "    For CPU-only local verification or staging, use: python3 deploy/model_server.py --cpu"
fi

# 2. Inspect Artifact Pre-check
if [ -d "${MODEL_PATH}" ] && [ -f "deploy/inspect_artifact.py" ]; then
  echo "[+] Running pre-flight artifact inspection..."
  python3 deploy/inspect_artifact.py "${MODEL_PATH}" || {
    echo "[!] Artifact inspection flagged warnings. Proceeding with caution..."
  }
fi

# 3. Assemble vLLM CLI arguments
VLLM_ARGS=(
  "--model" "${MODEL_PATH}"
  "--served-model-name" "${SERVED_MODEL_NAME}"
  "--host" "${HOST}"
  "--port" "${PORT}"
  "--max-model-len" "${MAX_MODEL_LEN}"
  "--gpu-memory-utilization" "${GPU_MEMORY_UTILIZATION}"
  "--max-num-seqs" "${MAX_NUM_SEQS}"
  "--trust-remote-code"
  "--disable-log-requests"
)

if [ -n "${API_KEY}" ]; then
  VLLM_ARGS+=("--api-key" "${API_KEY}")
  echo "[+] Model endpoint authentication enabled via Bearer token."
fi

# Handle LoRA adapter path vs merged model
if [ -f "${MODEL_PATH}/adapter_config.json" ]; then
  echo "[+] LoRA adapter detected. Enabling dynamic LoRA serving in vLLM..."
  BASE_MODEL=$(python3 -c "import json; print(json.load(open('${MODEL_PATH}/adapter_config.json')).get('base_model_name_or_path', 'Qwen/Qwen3-0.6B'))")
  VLLM_ARGS[1]="${BASE_MODEL}"
  VLLM_ARGS+=("--enable-lora" "--lora-modules" "${SERVED_MODEL_NAME}=${MODEL_PATH}")
fi

echo "[+] Starting vLLM OpenAI API Server..."
exec python3 -m vllm.entrypoints.openai.api_server "${VLLM_ARGS[@]}"

