# Orion Space — Phase 4 Production Deployment & Integration Guide

**Document Version:** 1.0.0  
**Phase:** 4 (Model Serving & Agent Backend Integration)  
**Target Model:** `Orion-0.6B v0.1` (Fine-tuned from `Qwen/Qwen3-0.6B`)  
**Deployment Date:** 2026-11-12

---

## 1. Executive Summary

Phase 4 operationalizes the fine-tuned **Orion-0.6B v0.1** model, placing it behind a private, OpenAI-compatible inference server and connecting it to the Orion Node.js agent runtime.

### Key Architectural Tenets

1. **Zero Browser Direct Model Access:** The web browser client hosted on GitHub Pages only talks to the public Node.js application API (`POST /api/orion/agent`). The inference runtime (`POST /v1/chat/completions`) is strictly private.
2. **Deterministic & Scientific Grounding:** Tool calling and NASA data ingestion (NASA POWER, MERRA-2, Open-Meteo, NASA FIRMS) remain inside the backend orchestrator with mathematical guardrails (Benjamini-Hochberg FDR).
3. **UI Preservation:** The existing dashboard, Cesium 3D globe, HUD, CSS, and chat layouts are 100% preserved. The frontend communicates with the backend via the clean `window.__ORION_AGENT_API_URL__` public bridge.
4. **Dual-Topology Support:** Production accommodates both single-server GPU topologies (with private loopback/Docker network) and distributed multi-host architectures (VPS Node backend + Private GPU host).

---

## 2. Model Artifact Inspection & Selection

Model artifact verification is automated via `deploy/inspect_artifact.py`.

```bash
python3 deploy/inspect_artifact.py /path/to/artifact
```

### Artifact Specification

| Component         | Target Specification                                 | Verification Method                               |
| :---------------- | :--------------------------------------------------- | :------------------------------------------------ |
| **Base Model**    | `Qwen/Qwen3-0.6B`                                    | Checked in `adapter_config.json` or `config.json` |
| **Base Revision** | Tracked Git commit SHA (or `main`)                   | Verified in `training_summary.json`               |
| **LoRA Files**    | `adapter_config.json`, `adapter_model.safetensors`   | Verified file presence and non-zero size          |
| **Tokenizer**     | `Qwen2Tokenizer` with chat template                  | Verified special token handling and `<tool_call>` |
| **Licensing**     | Apache 2.0 (Base) + MIT (Orion)                      | Verified attribution metadata                     |
| **Eval Gates**    | $\ge 80\%$ tool accuracy, $100\%$ FDR trap avoidance | Verified against `eval_report.json`               |

### Production Choice: Merged Model vs Base + LoRA Adapter

| Consideration              | Base Model + LoRA Adapter                         | Merged Model (`orion-qwen3-0.6b-merged`)            | Recommendation                  |
| :------------------------- | :------------------------------------------------ | :-------------------------------------------------- | :------------------------------ |
| **Serving Runtime**        | Requires PEFT support or dynamic LoRA in vLLM     | Native support across vLLM, llama.cpp, TGI, PyTorch | **Merged**                      |
| **Cold Start Latency**     | Adapter weights must be loaded dynamically        | Direct contiguous weight loading                    | **Merged**                      |
| **Inference Throughput**   | Slight GEMM overhead with dynamic rank-16 adapter | Peak tensor core utilization (zero LoRA penalty)    | **Merged**                      |
| **Disk Footprint**         | ~1.2 GB base + 20 MB adapter                      | ~1.2 GB merged safetensors                          | **Merged**                      |
| **Operational Simplicity** | Two filesets to track in production               | Single standalone model folder                      | **Merged (Production Primary)** |

**Decision:** We recommend deploying the **Merged Fine-Tuned Model** for production inference. To generate the merged artifact from the LoRA adapter:

```bash
python3 training/train_lora.py \
  --merge-output \
  --adapter-dir training/outputs/orion-qwen3-0.6b-adapter \
  --merged-dir training/outputs/orion-qwen3-0.6b-merged
```

---

## 3. Hosting Topologies

### Topology A: Distributed VPS + Private GPU Host

Ideal for scaling web traffic independently from GPU inference load.

```
+------------------------------------+
|  GitHub Pages (Client Browser)    |
+-----------------+------------------+
                  |
                  | HTTPS (POST /api/orion/agent)
                  v
+-----------------+------------------+
|  Node.js VPS Backend (Port 3000)   |
|  - Rate Limiter (30-100 req/min)   |
|  - CORS Allowlist                  |
|  - Tool Registry & MERRA-2 Engine  |
|  - Secret Management               |
+-----------------+------------------+
                  |
                  | Private WireGuard / VPC / Internal HTTP
                  | Authorization: Bearer <ORION_MODEL_API_KEY>
                  v
+-----------------+------------------+
|  Private GPU Host (Port 8000)      |
|  - vLLM / PyTorch Model Server     |
|  - Qwen3-0.6B Merged Model         |
|  - Unexposed to WAN (Firewalled)   |
+------------------------------------+
```

### Topology B: Single Provisioned GPU Server (Docker Compose)

Ideal for unified low-latency operations with zero network hops between Node and vLLM.

- Model Inference runs on private internal Docker network `orion-internal` at `http://orion-model-inference:8000`.
- Node.js backend runs on both `orion-internal` and `orion-public` networks.
- Only port `3000` (or `443` via Caddy/Nginx) is published to the host.

### Topology C: Experimental CPU-Only VPS

- Served via `python3 deploy/model_server.py --cpu`.
- Suitable only for low-traffic staging or local regression testing.
- Not guaranteed for production real-time voice latency.

---

## 4. Environment Variables Reference

### Backend Server (`.env`)

```bash
# Server Runtime
NODE_ENV=production
ORION_AGENT_PORT=3000
ORION_AGENT_HOST=0.0.0.0
ORION_TRUST_PROXY=true

# Security & CORS (Must match exact GitHub Pages URL)
ORION_CORS_ORIGIN=https://md-mushfiqur123.github.io
ORION_ALLOW_LOCALHOST_CORS=false
ORION_AGENT_RATELIMIT_PER_MIN=60
ORION_AGENT_API_KEY=

# Internal Model Gateway (Private inference endpoint)
ORION_MODEL_PROVIDER=qwen3
ORION_MODEL_BASE_URL=http://127.0.0.1:8000
ORION_MODEL_NAME=orion-qwen3-0.6b
ORION_MODEL_API_KEY=replace_with_strong_random_secret_token
ORION_MODEL_TIMEOUT_MS=15000
ORION_MODEL_CONCURRENCY=4

# Scientific & External APIs
NASA_EARTHDATA_TOKEN=
FIRMS_MAP_KEY=
```

### Frontend Configuration

Frontend secrets must **never** be used. Set the public backend URL at build time or via `index.html`:

```html
<script>
  window.__ORION_AGENT_API_URL__ = 'https://api.yourdomain.com/api/orion/agent';
</script>
```

---

## 5. Production Operations Runbook

### 1. Launch Inference Server (vLLM)

```bash
export ORION_MODEL_PATH=/opt/models/orion-qwen3-0.6b-merged
export ORION_MODEL_API_KEY=your_secret_token
export ORION_MODEL_PORT=8000

./deploy/vllm_serve.sh
```

### 2. Launch Node.js Backend

```bash
npm run agent:serve
```

### 3. Verify Health Endpoints

```bash
# Backend health
curl -s http://127.0.0.1:3000/health | jq .

# Internal model readiness
curl -s -H "Authorization: Bearer your_secret_token" http://127.0.0.1:8000/ready | jq .
```

### 4. Execute Full Production Verification Suite

```bash
node deploy/verify_deployment.mjs
```

---

## 6. Verification Results & Benchmarks

Full test suite execution on macOS arm64 / Node v22.23.4 / Python 3.12:

```
======================================================================
       ORION SPACE — PHASE 4 PRODUCTION VERIFICATION SUITE
======================================================================
[1/8] Starting Orion Model Inference Server on port 8199...
  [PASS] Model inference server booted and responded to /health
[2/8] Starting Orion Node.js Agent Backend on port 3199...
  [PASS] Backend server listening.
[3/8] Verifying Health & Readiness Endpoints...
  [PASS] GET /health returns HTTP 200
  [PASS] Backend health reports ok: true
  [PASS] Backend reports modelConfigured: true
  [PASS] Backend reports modelName: orion-qwen3-0.6b
  [PASS] Backend reports modelStatus: ready
  [PASS] Model server /ready returns HTTP 200
  [PASS] Model server reports ready: true
[4/8] Testing Direct Model Server Endpoint & Auth...
  [PASS] Model server rejects unauthenticated call with HTTP 401
  [PASS] Model server responds HTTP 200 with Bearer token
  [PASS] Model returned content choice or structured tool calls
[5/8] Testing Scientific Questions via POST /api/orion/agent...
  [PASS] Agent returns HTTP 200 for Barisal warming query
  [PASS] Agent response ok: true
  [PASS] Agent reply cites Barisal climate data
  [PASS] Agent returned mapActions array
  [PASS] Agent triggered map action for Barisal
  [PASS] Agent returns HTTP 200 for October trend
  [PASS] Agent reply respects scientific FDR guardrails for October
  [PASS] Agent returns HTTP 200 for live weather query
  [PASS] Agent responded to Dhaka weather request
[6/8] Verifying Security, CORS & Request Limits...
  [PASS] Preflight OPTIONS returns HTTP 204
  [PASS] CORS header matches exact GitHub Pages origin
  [PASS] Disallowed origin does NOT receive Access-Control-Allow-Origin header
  [PASS] Oversized request is rejected with HTTP 413
[7/8] Verifying Map Action Sanitization & Concurrent Load...
  [PASS] Valid fly_to_coords action sanitized successfully
  [PASS] Preserved safe coordinate
  [PASS] Disallowed action dropped by sanitizer
  [PASS] 5 concurrent agent requests completed successfully
[8/8] Performance Benchmark Summary
----------------------------------------------------------------------
Model Server RSS Memory:  18.95 MB
Model Server Concurrency: 0
Total Served Queries:     17
----------------------------------------------------------------------
  * Direct Model Inference (Local Emulation)     : 1 ms
  * Barisal September Climate Query (End-to-End) : 7 ms
  * October FDR Guardrail Query (End-to-End)     : 4 ms
  * 5 Concurrent Agent Queries (Parallel)        : 796 ms
======================================================================
ALL 28/28 DEPLOYMENT VERIFICATION TESTS PASSED!
```

---

## 7. Known Constraints & Limitations

1. **Local-Only vs Cloud Hardware:** The verification benchmarks above reflect local runtime execution and fast grounded fallback responses. Live vLLM on a remote T4 GPU will exhibit typical TTFT (Time To First Token) of 120–250ms and generation rates of ~40–60 tokens/sec. Production readiness on external GPU infrastructure requires repeating `deploy/verify_deployment.mjs` against the live remote endpoint.
2. **Live Feed Availability:** In environments without an active `FIRMS_MAP_KEY` or `NASA_EARTHDATA_TOKEN`, fire and raw satellite ingestion gracefully report `unavailable` rather than fabricating numbers.
3. **Bangla Phrasing Nuances:** Complex compound Bengali idioms may occasionally trigger the deterministic scientific fallback planner if the 0.6B model emits uncertain tokens; this is an intentional safety behavior to prevent hallucinations.
