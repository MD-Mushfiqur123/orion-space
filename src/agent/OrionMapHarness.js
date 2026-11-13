/**
 * @file OrionMapHarness.js
 * @module agent/OrionMapHarness
 * @description Autonomous In-Console Map Harness Agent for Project Orion Space.
 *
 * Translates natural language (Bangla, Banglish, English) and microphone voice commands
 * directly into CesiumJS camera maneuvers, NASA GIBS cloud streams, tactical shaders,
 * sea level rise simulations, and multi-sensor planetary intelligence.
 *
 * Lead Architect: Md Mushfiqur Rahim (NASA Space Apps 2026 - Barisal)
 */

import * as Cesium from 'cesium';
import {
  classifyLocalCommand,
  escapeHtml,
  sanitizeEvidenceCard,
  sanitizeMapActions,
} from './agentContract.js';
import {
  BANGLADESH_DISTRICTS,
  findDistrictSector,
} from './bangladeshDistricts.js';
import { createOrionAgentClient } from './orionAgentClient.js';
import { findStaticKBAnswer } from './orionStaticKB.js';

// ============================================================================
// GEOSPATIAL SECTOR REGISTRY
// ============================================================================

export const SECTORS = {
  ...BANGLADESH_DISTRICTS,
  barisal: {
    ...BANGLADESH_DISTRICTS.barisal,
    id: 'barisal',
    name: 'Barisal Coastal Belt & Climate Hotspot',
    lat: 22.701,
    lon: 90.3535,
    altitude: 180000,
    heading: 0,
    pitch: -48,
    actionDesc:
      'September warming hotspot (+0.40°C/dec, p<0.001) & sea level surge sector',
    suggestedLayers: ['clouds', 'sea_level'],
    speech:
      'Maneuvering to Barisal sector. Displaying the September warming trend.',
  },
  dhaka: {
    id: 'dhaka',
    name: 'Dhaka Metropolitan & Central Corridor',
    lat: 23.8103,
    lon: 90.4125,
    altitude: 120000,
    heading: 0,
    pitch: -55,
    actionDesc: 'Urban heat island & atmospheric concentration corridor',
    suggestedLayers: ['clouds', 'satellites'],
    speech: 'Navigating to Dhaka central metropolitan corridor.',
  },
  chittagong: {
    id: 'chittagong',
    name: 'Chittagong Port & Karnaphuli Approach',
    lat: 22.3384,
    lon: 91.8048,
    altitude: 90000,
    heading: 330,
    pitch: -40,
    actionDesc: 'Primary national maritime port & coastal shipping approach',
    suggestedLayers: ['clouds', 'satellites'],
    speech: 'Navigating to Chittagong Port and maritime approach.',
  },
  sylhet: {
    id: 'sylhet',
    name: 'Sylhet Haor Basin & Flash Flood Corridor',
    lat: 24.8949,
    lon: 91.8687,
    altitude: 140000,
    heading: 10,
    pitch: -45,
    actionDesc: 'Sentinel-1 SAR radar flood extent & Haor wetland basin',
    suggestedLayers: ['clouds', 'satellites'],
    speech: 'Maneuvering to Sylhet Haor basin flood monitoring sector.',
  },
  feni: {
    id: 'feni',
    name: 'Feni-Muhuri River Surge Corridor',
    lat: 23.0159,
    lon: 91.3976,
    altitude: 80000,
    heading: 0,
    pitch: -45,
    actionDesc: 'August 2024 flash flood epicenter and embankment monitoring',
    suggestedLayers: ['clouds'],
    speech: 'Navigating to Feni Muhuri flash flood surge corridor.',
  },
  sundarbans: {
    id: 'sundarbans',
    name: 'Sundarbans Mangrove Delta & Coastal Front',
    lat: 21.9497,
    lon: 89.5403,
    altitude: 200000,
    heading: 350,
    pitch: -50,
    actionDesc: 'UNESCO Biosphere mangrove fringe & tidal barrier',
    suggestedLayers: ['sea_level', 'clouds'],
    speech: 'Arriving at Sundarbans mangrove biosphere.',
  },
  rajshahi: {
    id: 'rajshahi',
    name: 'Rajshahi & North Bengal Barind Tract',
    lat: 24.3745,
    lon: 88.6042,
    altitude: 160000,
    heading: 0,
    pitch: -50,
    actionDesc: 'NASA GRACE groundwater depletion & drought monitoring',
    suggestedLayers: ['clouds'],
    speech: 'Maneuvering to Rajshahi Barind tract groundwater depletion zone.',
  },
  kuakata: {
    id: 'kuakata',
    name: 'Payra Port & Kuakata Coastal Seawall',
    lat: 21.8167,
    lon: 90.1167,
    altitude: 70000,
    heading: 15,
    pitch: -35,
    actionDesc: 'Southernmost coastal delta, Payra Port, and sea level rise',
    suggestedLayers: ['sea_level', 'clouds'],
    speech: 'Navigating to Payra Port and Kuakata shoreline.',
  },
  coxsbazar: {
    id: 'coxsbazar',
    name: "Cox's Bazar & Kutubdia Coastal Fringe",
    lat: 21.4272,
    lon: 91.9676,
    altitude: 120000,
    heading: 340,
    pitch: -42,
    actionDesc: "World's longest unbroken sea beach & cyclone approach line",
    suggestedLayers: ['clouds'],
    speech: "Arriving at Cox's Bazar coastal sector.",
  },
  bay_of_bengal: {
    id: 'bay_of_bengal',
    name: 'Bay of Bengal EEZ Maritime Sector',
    lat: 20.2,
    lon: 89.8,
    altitude: 600000,
    heading: 0,
    pitch: -55,
    actionDesc:
      'Cyclone genesis basin, depression tracking & deep water passes',
    suggestedLayers: ['clouds', 'satellites'],
    speech: 'Framing Bay of Bengal cyclonic depression basin.',
  },
  bangladesh: {
    id: 'bangladesh',
    name: "People's Republic of Bangladesh",
    lat: 23.685,
    lon: 90.3563,
    altitude: 1500000,
    heading: 0,
    pitch: -65,
    actionDesc: 'Nationwide view of the 34 MERRA-2 grid cells over Bangladesh',
    suggestedLayers: ['clouds'],
    speech: 'Resetting to the nationwide Bangladesh grid view.',
  },
};

// ============================================================================
// ORION MAP HARNESS CLASS
// ============================================================================

export class OrionMapHarness {
  /**
   * @param {Cesium.Viewer} viewer
   * @param {Object} [options]
   * @param {Object} [options.cloudStream] - RealEarthCloudStream instance
   */
  constructor(viewer, options = {}) {
    this.viewer = viewer;
    this.cloudStream = options.cloudStream || null;
    this.speechEnabled = true;
    this.isListening = false;
    this.recognition = null;
    this.activeOrbit = null;
    this.orbitInterval = null;
    this.activeSector = SECTORS.bangladesh;
    this.history = [];
    this.agentTurns = [];
    this.agentClient = options.agentClient || createOrionAgentClient();
    this.activeShader = 'normal';
    this.isVisible = false;

    // Real NASA Climate Telemetry Storage
    this.spatialTrends = [];
    this.seasonalTrends = [];
    this.climateLoaded = false;
    this.evidenceCardEl = null;

    this._initSpeechRecognition();
    this._loadClimateData();
  }

  /** Initialize Web Speech API for voice commanding. */
  _initSpeechRecognition() {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.info(
        '[OrionHarness] Web Speech API not supported in this browser; text input available.',
      );
      return;
    }

    try {
      this.recognition = new SpeechRecognition();
      this.recognition.continuous = false;
      this.recognition.interimResults = false;
      this.recognition.lang = 'en-US'; // Handles English and phonetic Banglish accurately

      this.recognition.onstart = () => {
        this.isListening = true;
        this._updateMicButton(true);
        this._setStatus(
          '<span class="material-symbols-outlined" style="font-size: 14px; vertical-align: middle;">mic</span> LISTENING... SPEAK NOW (e.g. "Fly to Barisal", "Show real clouds")',
        );
      };

      this.recognition.onresult = (event) => {
        const transcript = event.results[0]?.[0]?.transcript;
        if (transcript) {
          const inputEl = document.getElementById('orion-harness-input');
          if (inputEl) inputEl.value = transcript;
          this.execute(transcript);
        }
      };

      this.recognition.onerror = (e) => {
        this.isListening = false;
        this._updateMicButton(false);
        this._setStatus(`Voice input error: ${e.error || 'unknown'}`);
      };

      this.recognition.onend = () => {
        this.isListening = false;
        this._updateMicButton(false);
      };
    } catch (err) {
      console.warn('[OrionHarness] Voice recognition setup failed:', err);
    }
  }

  /** Mount the Swiss Monochrome interactive Harness UI onto the page. */
  mount(parent = document.body) {
    if (document.getElementById('orion-map-harness-container')) return;

    const container = document.createElement('div');
    container.id = 'orion-map-harness-container';
    // Positioning, sizing and z-index are owned by orion-final-polish.css.
    // We only keep the Tailwind utilities that set display/font/visibility
    // state, since those are toggled by JS (hidden class) and aren't
    // overridden by the polish sheet.
    container.className = 'flex-col font-sans pointer-events-auto hidden';

    container.innerHTML = `
      <!-- Orion Agent Premium Intelligence UI -->
      <div class="flex flex-col w-full" style="font-family: 'Inter', -apple-system, sans-serif;">

        <!-- Header bar -->
        <div id="orion-harness-header" class="flex items-center justify-between px-4 py-3 border-b">
          <div class="flex items-center gap-2.5">
            <div class="relative flex-shrink-0 w-2 h-2">
              <span class="absolute flex h-2 w-2 rounded-full bg-emerald-400"></span>
              <span class="animate-ping absolute inline-flex h-full w-full top-0 left-0 rounded-full bg-emerald-400 opacity-60"></span>
            </div>
            <span class="text-[11px] font-semibold tracking-[0.1em] text-white uppercase" style="font-family: 'Space Grotesk', sans-serif;">Orion Intelligence Agent</span>
            <span class="text-[8px] font-bold text-zinc-600 border border-white/[0.06] px-1.5 py-0.5 rounded tracking-widest">VOICE + NLP</span>
          </div>
          <div class="flex items-center gap-2">
            <span id="orion-harness-sector-badge">AWAITING COMM</span>
            <button id="orion-harness-speech-btn" class="flex items-center gap-1 text-[9px] font-semibold tracking-wider text-zinc-500 hover:text-white bg-transparent px-2 py-1">
              <span class="material-symbols-outlined text-[13px]">volume_up</span>
              <span>AUDIO ON</span>
            </button>
            <button id="orion-harness-close-btn" class="flex items-center justify-center w-6 h-6 text-zinc-600 hover:text-white" title="Close">
              <span class="material-symbols-outlined text-[16px]">close</span>
            </button>
          </div>
        </div>

        <!-- Quick command chips -->
        <div class="flex flex-wrap items-center gap-1.5 px-4 py-2.5 border-b border-white/[0.04] bg-white/[0.01]">
          <button class="harness-chip flex items-center gap-1.5 px-2.5 py-1.5" data-cmd="live weather">
            <span class="material-symbols-outlined">partly_cloudy_day</span>WEATHER
          </button>
          <button class="harness-chip flex items-center gap-1.5 px-2.5 py-1.5" data-cmd="disaster rain">
            <span class="material-symbols-outlined">thunderstorm</span>RAIN RADAR
          </button>
          <button class="harness-chip flex items-center gap-1.5 px-2.5 py-1.5" data-cmd="cyclone">
            <span class="material-symbols-outlined">cyclone</span>CYCLONE
          </button>
          <button class="harness-chip flex items-center gap-1.5 px-2.5 py-1.5" data-cmd="crop advisory">
            <span class="material-symbols-outlined">psychiatry</span>CROP ADVISORY
          </button>
          <button class="harness-chip flex items-center gap-1.5 px-2.5 py-1.5" data-cmd="fly to barisal">
            <span class="material-symbols-outlined">my_location</span>BARISAL
          </button>
          <button class="harness-chip flex items-center gap-1.5 px-2.5 py-1.5" data-cmd="where is warming fastest">
            <span class="material-symbols-outlined">device_thermostat</span>WARMING
          </button>
          <button class="harness-chip flex items-center gap-1.5 px-2.5 py-1.5" data-cmd="is warming significant">
            <span class="material-symbols-outlined">bar_chart</span>PROOF
          </button>
          <button class="harness-chip flex items-center gap-1.5 px-2.5 py-1.5" data-cmd="sea level rise">
            <span class="material-symbols-outlined">water</span>SEA LEVEL
          </button>
          <button class="harness-chip flex items-center gap-1.5 px-2.5 py-1.5" data-cmd="orbit">
            <span class="material-symbols-outlined">360</span>ORBIT
          </button>
          <button class="harness-chip flex items-center gap-1.5 px-2.5 py-1.5" data-cmd="flir">
            <span class="material-symbols-outlined">thermostat</span>FLIR
          </button>
          <button class="harness-chip flex items-center gap-1.5 px-2.5 py-1.5" data-cmd="sylhet flood">
            <span class="material-symbols-outlined">flood</span>SYLHET
          </button>
        </div>

        <!-- Transcript -->
        <div id="orion-harness-transcript">
          <div id="orion-harness-empty">
            <div id="orion-harness-empty-glyph"><span class="material-symbols-outlined">radar</span></div>
            <p id="orion-harness-empty-title">Direct the intelligence agent</p>
            <p id="orion-harness-empty-sub">Ask about warming trends, monsoon floods, sectors, or sensor passes. Replies also surface as evidence cards on the globe.</p>
          </div>
          <div id="orion-harness-messages"></div>
        </div>

        <!-- Composer -->
        <div id="orion-composer-wrap">
          <div id="orion-composer">
            <textarea id="orion-harness-input" rows="1" placeholder="Ask Orion anything — warming, floods, sectors, passes..." autocomplete="off" spellcheck="false"></textarea>
            <div id="orion-composer-toolbar">
              <div class="orion-composer-tools">
                <button class="orion-tool-btn" data-cmd="live weather" title="Live Weather"><span class="material-symbols-outlined">partly_cloudy_day</span></button>
                <button class="orion-tool-btn" data-cmd="crop advisory" title="Crop Advisory for Farmers"><span class="material-symbols-outlined">psychiatry</span></button>
                <button class="orion-tool-btn" data-cmd="fly to barisal" title="Fly to Barisal"><span class="material-symbols-outlined">my_location</span></button>
                <button class="orion-tool-btn" data-cmd="orbit" title="Orbit globe"><span class="material-symbols-outlined">public</span></button>
                <button class="orion-tool-btn" data-cmd="sea level rise" title="Sea level rise"><span class="material-symbols-outlined">water</span></button>
                <button class="orion-tool-btn" data-cmd="flir" title="Thermal view"><span class="material-symbols-outlined">thermostat</span></button>
              </div>
              <div class="orion-composer-actions">
                <button id="orion-harness-mic-btn" title="Speak to Agent"><span class="material-symbols-outlined">mic</span></button>
                <button id="orion-harness-exec-btn" title="Send"><span class="material-symbols-outlined">arrow_upward</span></button>
              </div>
            </div>
          </div>
          <div id="orion-composer-hint">Replies also surface as evidence cards on the globe</div>
        </div>

        <!-- Status kept for agent state plumbing, visually hidden -->
        <div id="orion-harness-status" hidden>
          <span id="orion-harness-status-text">Ready.</span>
        </div>
      </div>
    `;

    parent.appendChild(container);

    this._msgList = container.querySelector('#orion-harness-messages');
    this._emptyState = container.querySelector('#orion-harness-empty');

    // Event Wire-ups
    const inputEl = container.querySelector('#orion-harness-input');
    const execBtn = container.querySelector('#orion-harness-exec-btn');
    const micBtn = container.querySelector('#orion-harness-mic-btn');
    const closeBtn = container.querySelector('#orion-harness-close-btn');
    const speechBtn = container.querySelector('#orion-harness-speech-btn');

    const autoGrow = () => {
      if (!inputEl) return;
      inputEl.style.height = 'auto';
      inputEl.style.height = `${Math.min(inputEl.scrollHeight, 120)}px`;
    };

    const submit = () => {
      const val = inputEl?.value?.trim();
      if (val) {
        this.execute(val);
        if (inputEl) inputEl.value = '';
        autoGrow();
      }
    };

    execBtn?.addEventListener('click', submit);

    inputEl?.addEventListener('input', autoGrow);

    inputEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape') {
        this.close();
      }
    });

    micBtn?.addEventListener('click', () => this.toggleVoice());

    closeBtn?.addEventListener('click', () => this.close());

    speechBtn?.addEventListener('click', () => {
      this.speechEnabled = !this.speechEnabled;
      const iconHtml =
        '<span class="material-symbols-outlined text-[13px]">volume_up</span>';
      const label = this.speechEnabled ? 'AUDIO ON' : 'AUDIO OFF';
      speechBtn.innerHTML = `${iconHtml}<span>${label}</span>`;
      this._setStatus(
        this.speechEnabled ? 'Agent voice enabled' : 'Agent voice muted',
      );
    });

    container.querySelectorAll('[data-cmd]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const cmd = chip.dataset.cmd;
        if (cmd) {
          this.execute(cmd);
          if (inputEl) inputEl.value = '';
          autoGrow();
        }
      });
    });

    // Global toggle hotkey: Pressing 'Escape' or custom shortcut
    window.addEventListener('keydown', (e) => {
      if (
        e.key === '`' &&
        !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)
      ) {
        e.preventDefault();
        this.toggle();
      }
    });
  }

  /** Toggle Harness Visibility. */
  toggle() {
    if (this.isVisible) this.close();
    else this.open();
  }

  /** Open the Harness. */
  open() {
    const el = document.getElementById('orion-map-harness-container');
    if (!el) {
      this.mount();
      return this.open();
    }
    el.classList.remove('hidden');
    el.style.display = 'flex';
    this.isVisible = true;
    const inputEl = document.getElementById('orion-harness-input');
    inputEl?.focus();
    this._playTone(520, 0.1);
  }

  /** Close the Harness. */
  close() {
    const el = document.getElementById('orion-map-harness-container');
    if (el) {
      el.classList.add('hidden');
      el.style.display = '';
    }
    this.isVisible = false;
    this.stopVoice();
  }

  /** Toggle real-time microphone listening. */
  toggleVoice() {
    if (this.isListening) {
      this.stopVoice();
    } else {
      this.startVoice();
    }
  }

  startVoice() {
    if (!this.recognition) {
      this._setStatus(
        'Microphone recognition not available in this browser. Please type.',
      );
      return;
    }
    try {
      this.recognition.start();
    } catch {
      // Already running
    }
  }

  stopVoice() {
    if (this.recognition && this.isListening) {
      try {
        this.recognition.stop();
      } catch {
        // Ignored
      }
    }
    this.isListening = false;
    this._updateMicButton(false);
  }

  _updateMicButton(active) {
    const btn = document.getElementById('orion-harness-mic-btn');
    if (btn) btn.classList.toggle('is-listening', !!active);
  }

  _setStatus(msg) {
    const textEl = document.getElementById('orion-harness-status-text');
    if (textEl) textEl.innerHTML = msg;

    const plain = String(msg)
      .replace(/<[^>]*>/g, '')
      .trim();
    if (
      plain &&
      plain !== this._lastAgentMsg &&
      this._msgList &&
      this._msgList.childElementCount > 0
    ) {
      this._lastAgentMsg = plain;
      this._addTranscriptMessage(plain, 'agent');
    }
  }

  _addTranscriptMessage(text, kind) {
    if (!this._msgList) return;
    if (this._emptyState) this._emptyState.style.display = 'none';
    const row = document.createElement('div');
    row.className = `orion-msg orion-msg-${kind}`;
    const bubble = document.createElement('div');
    bubble.className = 'orion-msg-bubble';
    bubble.textContent = text;
    row.appendChild(bubble);
    this._msgList.appendChild(row);
    this._scrollTranscript();
  }

  _scrollTranscript() {
    const t = document.getElementById('orion-harness-transcript');
    if (t) t.scrollTop = t.scrollHeight;
  }

  /**
   * Shows a Claude/ChatGPT-style thinking animation then reveals the final
   * hard-coded KB answer. All CSS is injected inline — no stylesheet edits.
   * @param {object} entry  — one item from ORION_STATIC_KB
   */
  async _showThinkingThenAnswer(entry) {
    if (!this._msgList) return;
    if (this._emptyState) this._emptyState.style.display = 'none';

    // ── Inject animation CSS once ────────────────────────────────────────────
    if (!document.getElementById('orion-thinking-style')) {
      const s = document.createElement('style');
      s.id = 'orion-thinking-style';
      s.textContent = `
        .orion-thinking-bubble {
          display: flex; flex-direction: column; gap: 4px;
          padding: 10px 14px; border-radius: 16px; border-bottom-left-radius: 6px;
          max-width: 84%; background: rgba(255,255,255,0.065);
          border: 1px solid rgba(255,255,255,0.11);
          font-family: var(--font-body, monospace); font-size: 12px;
          color: rgba(255,255,255,0.6); animation: orionMsgIn 0.28s ease;
        }
        .orion-thinking-label {
          font-size: 10px; color: #a1a1aa; letter-spacing: 0.08em; text-transform: uppercase;
          display: flex; align-items: center; gap: 6px;
        }
        .orion-thinking-label::before {
          content: ''; display: inline-block; width: 6px; height: 6px;
          border-radius: 50%; background: #3b82f6;
          animation: orionThinkPulse 1s ease-in-out infinite;
        }
        .orion-thinking-step {
          font-size: 11px; color: rgba(255,255,255,0.45);
          padding-left: 12px; opacity: 0;
          animation: orionStepIn 0.3s ease forwards;
        }
        .orion-thinking-step.done { color: rgba(255,255,255,0.65); }
        .orion-evidence-row {
          font-size: 10px; color: #71717a; padding-left: 10px;
          border-left: 2px solid #3b82f6; margin-top: 6px;
          line-height: 1.5;
        }
        @keyframes orionThinkPulse {
          0%,100% { opacity:1; transform:scale(1); }
          50%      { opacity:0.3; transform:scale(0.7); }
        }
        @keyframes orionStepIn {
          from { opacity:0; transform:translateX(-6px); }
          to   { opacity:1; transform:translateX(0); }
        }
      `;
      document.head.appendChild(s);
    }

    // ── Build thinking bubble ────────────────────────────────────────────────
    const row = document.createElement('div');
    row.className = 'orion-msg orion-msg-agent';
    const bubble = document.createElement('div');
    bubble.className = 'orion-thinking-bubble';
    bubble.innerHTML = '<div class="orion-thinking-label">Reasoning…</div>';
    row.appendChild(bubble);
    this._msgList.appendChild(row);
    this._scrollTranscript();

    // ── Animate reasoning steps one by one ──────────────────────────────────
    const steps = entry.reasoningSteps || [];
    for (let i = 0; i < steps.length; i++) {
      await new Promise((r) => setTimeout(r, 400 + i * 160));
      const stepEl = document.createElement('div');
      stepEl.className = 'orion-thinking-step';
      stepEl.textContent = `↳ ${steps[i]}`;
      bubble.appendChild(stepEl);
      this._scrollTranscript();
      await new Promise((r) => setTimeout(r, 60));
      stepEl.classList.add('done');
    }

    // ── Pause, then reveal final answer ─────────────────────────────────────
    await new Promise((r) => setTimeout(r, 480));

    bubble.className = 'orion-msg-bubble';
    bubble.innerHTML = '';

    const answerText = document.createElement('div');
    answerText.style.cssText = 'white-space:pre-wrap; word-break:break-word;';
    answerText.textContent = entry.answer;
    bubble.appendChild(answerText);

    if (entry.evidence) {
      const evRow = document.createElement('div');
      evRow.className = 'orion-evidence-row';
      evRow.textContent = `📡 ${entry.evidence}`;
      bubble.appendChild(evRow);
    }

    this._scrollTranscript();
    this.speak(entry.answer);

    // Optional: fly map to relevant sector
    if (entry.sectorId) {
      const target = SECTORS[entry.sectorId];
      if (target) await this.flyToSector(target, { silent: true });
    }
  }

  /** Speak message via native Web Speech synthesis. */
  speak(text) {
    if (!this.speechEnabled || !window.speechSynthesis) return;
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = 1.05;
      utter.pitch = 1.0;
      window.speechSynthesis.speak(utter);
    } catch (e) {
      console.warn('[OrionHarness] Speech error:', e);
    }
  }

  /** Play subtle procedural audio chime. */
  _playTone(freq = 440, durationSec = 0.08) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      gain.gain.setValueAtTime(0.04, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(
        0.001,
        ctx.currentTime + durationSec,
      );
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + durationSec);
    } catch {
      // Audio autoplay policy
    }
  }

  // ==========================================================================
  // NATURAL LANGUAGE COMMAND EXECUTION (NLP)
  // ==========================================================================

  /**
   * Main entry point: Routes instant local map commands locally and sends
   * natural-language / scientific queries to POST /api/orion/agent.
   * @param {string} rawCommand
   */
  async execute(rawCommand) {
    if (!rawCommand || typeof rawCommand !== 'string') return;
    const trimmed = rawCommand.trim();
    if (!trimmed) return;
    this.history.push(trimmed);
    this._playTone(660, 0.06);
    this._addTranscriptMessage(trimmed, 'user');

    // ── Static Knowledge Base: hard-coded scientific Q&A (no backend call) ──
    const kbEntry = findStaticKBAnswer(trimmed);
    if (kbEntry) {
      return this._showThinkingThenAnswer(kbEntry);
    }

    const route = classifyLocalCommand(trimmed, {
      findSector: (q) => this._resolveSector(q),
    });

    if (route.kind === 'ignore') return;
    if (route.kind === 'local') {
      switch (route.action) {
        case 'orbit':
          return this.startOrbit();
        case 'stop_orbit':
          return this.stopOrbit();
        case 'clouds':
          return this.triggerClouds();
        case 'shader':
          return this.triggerShader(route.style, route.announcement);
        case 'sea_level':
          return this.triggerSeaLevelRise();
        case 'coords':
          return this.flyToCoords(
            route.lat,
            route.lon,
            120000,
            `Coordinates [${route.lat.toFixed(4)}, ${route.lon.toFixed(4)}]`,
          );
        case 'sector':
          return this.flyToSector(route.sector);
      }
    }

    const statusEl = document.getElementById('orion-harness-status-text');
    if (statusEl) statusEl.textContent = 'Querying Orion Intelligence Agent...';

    const response = await this.agentClient.ask({
      message: trimmed,
      history: this.agentTurns.slice(-6),
      activeSectorId: this.activeSector?.id || 'barisal',
      clientContext: {
        cloudsActive: Boolean(this.cloudStream?.active),
        shader: this.activeShader || 'normal',
      },
    });

    if (response && response.ok && response.answer) {
      return this._applyAgentResponse(trimmed, response);
    }

    return this._executeLocalFallback(trimmed);
  }

  /** Apply validated backend answer, evidence card, and allowlisted map actions. */
  async _applyAgentResponse(userPrompt, response) {
    const validIds = new Set(Object.keys(SECTORS));
    const actions = sanitizeMapActions(response.mapActions, validIds);
    const card = sanitizeEvidenceCard(response.evidenceCard);
    let wantsEvidenceCard = false;

    for (const action of actions) {
      switch (action.type) {
        case 'fly_to_sector': {
          const target = SECTORS[action.sectorId];
          if (target) await this.flyToSector(target, { silent: true });
          break;
        }
        case 'fly_to_coords':
          await this.flyToCoords(
            action.lat,
            action.lon,
            action.altitude,
            action.label,
            { silent: true },
          );
          break;
        case 'toggle_clouds':
          this.triggerClouds({ silent: true, active: action.active });
          break;
        case 'set_shader':
          this.triggerShader(action.style, '', { silent: true });
          break;
        case 'start_orbit':
          this.startOrbit({ silent: true });
          break;
        case 'stop_orbit':
          this.stopOrbit({ silent: true });
          break;
        case 'show_evidence_card':
          wantsEvidenceCard = true;
          break;
      }
    }

    if (wantsEvidenceCard && card) {
      this.showEvidenceCard({
        ...card,
        speech: response.speech || response.answer,
      });
    }

    this.agentTurns.push(
      { role: 'user', content: userPrompt },
      { role: 'assistant', content: response.answer },
    );
    if (this.agentTurns.length > 12) {
      this.agentTurns = this.agentTurns.slice(-12);
    }

    const statusEl = document.getElementById('orion-harness-status-text');
    if (statusEl) statusEl.textContent = response.answer;
    this._lastAgentMsg = response.answer;
    this._addTranscriptMessage(response.answer, 'agent');
    this.speak(response.speech || response.answer);
  }

  /** Deterministic local fallback when the backend agent endpoint is unreachable. */
  async _executeLocalFallback(rawCommand) {
    const lower = rawCommand.toLowerCase().trim();

    // 1. Orbit command
    if (
      lower.includes('orbit') ||
      lower.includes('ghuro') ||
      lower.includes('ঘুরো') ||
      lower.includes('rotate') ||
      lower.includes('360')
    ) {
      return this.startOrbit();
    }
    if (
      lower.includes('stop') ||
      lower.includes('thamo') ||
      lower.includes('থামো') ||
      lower.includes('halt')
    ) {
      return this.stopOrbit();
    }

    // 2. Clouds command
    if (
      lower.includes('cloud') ||
      lower.includes('megh') ||
      lower.includes('মেঘ') ||
      lower.includes('gibs')
    ) {
      return this.triggerClouds();
    }

    // 3. Shaders / Visual styles
    if (
      lower.includes('thermal') ||
      lower.includes('flir') ||
      lower === 'gorom'
    ) {
      return this.triggerShader(
        'thermal',
        'FLIR Thermal (Ironbow) Mode activated.',
      );
    }
    if (
      lower.includes('nvg') ||
      lower.includes('night') ||
      lower.includes('raat') ||
      lower.includes('rat')
    ) {
      return this.triggerShader(
        'surveillance',
        'Night Vision Sensor Pass activated.',
      );
    }
    if (
      lower.includes('noir') ||
      lower.includes('monochrome') ||
      lower.includes('black and white')
    ) {
      return this.triggerShader(
        'noir',
        'Swiss Monochrome Noir Style activated.',
      );
    }
    if (
      lower.includes('normal') ||
      lower.includes('optical') ||
      lower.includes('reset style')
    ) {
      return this.triggerShader('normal', 'Standard Optical Globe restored.');
    }

    // 4. Sea Level Rise Simulator
    if (
      lower.includes('sea level') ||
      lower.includes('slr') ||
      lower.includes('surge') ||
      lower.includes('pani') ||
      lower.includes('জলস্তর')
    ) {
      return this.triggerSeaLevelRise();
    }

    // 4.1. Farmer Crop Advisory Query (Bangla + Banglish + English)
    if (
      lower.includes('crop') ||
      lower.includes('fosol') ||
      lower.includes('ফসল') ||
      lower.includes('chash') ||
      lower.includes('চাষ') ||
      lower.includes('farmer') ||
      lower.includes('krishok') ||
      lower.includes('কৃষক') ||
      lower.includes('agriculture') ||
      lower.includes('krishi') ||
      lower.includes('কৃষি') ||
      (lower.includes('uchit') &&
        (lower.includes('weather') ||
          lower.includes('abohawa') ||
          lower.includes('আবহাওয়া')))
    ) {
      return this.handleCropAdvisoryQuery();
    }

    // 4.2. Disaster Rain & Precipitation Radar (NASA GPM)
    if (
      lower.includes('disaster rain') ||
      lower.includes('heavy rain') ||
      lower.includes('prochol brishti') ||
      lower.includes('প্রচণ্ড বৃষ্টি') ||
      lower.includes('radar') ||
      lower.includes('gpm')
    ) {
      return this.triggerDisasterRain();
    }

    // 4.3. Cyclone & Storm Surge (Bay of Bengal)
    if (
      lower.includes('cyclone') ||
      lower.includes('ghurnijhor') ||
      lower.includes('ঘূর্ণিঝড়') ||
      lower.includes('storm') ||
      lower.includes('depression')
    ) {
      return this.triggerCycloneStorm();
    }

    // 4.4. Flash Flood & Haor Inundation (Sylhet / Feni)
    if (
      lower.includes('flood') ||
      lower.includes('bonna') ||
      lower.includes('বন্যা') ||
      lower.includes('haor') ||
      lower.includes('sar')
    ) {
      return this.triggerSylhetFlood();
    }

    // 4.5. Live Weather Query (Bangla + Banglish + English)
    if (
      lower.includes('weather') ||
      lower.includes('abohawa') ||
      lower.includes('abohaoa') ||
      lower.includes('আবহাওয়া') ||
      lower.includes('temperature') ||
      lower.includes('tapmatra') ||
      lower.includes('তাপমাত্রা') ||
      lower.includes('rain') ||
      lower.includes('brishti') ||
      lower.includes('বৃষ্টি') ||
      lower.includes('humidity') ||
      lower.includes('batash') ||
      lower.includes('বাতাস')
    ) {
      return this.handleLiveWeatherQuery();
    }

    // 5. NASA Earth System Trend Detective (Climate Evidence Queries)
    if (
      lower.includes('fastest') ||
      lower.includes('where is warming') ||
      lower.includes('hotspot') ||
      lower.includes('shobcheye beshi gorom') ||
      lower.includes('সবচেয়ে বেশি গরম') ||
      lower.includes('warming fastest')
    ) {
      return this.handleFastestWarmingQuery();
    }
    if (
      lower.includes('barisal evidence') ||
      lower.includes('বরিশাল প্রমাণ') ||
      (lower.includes('barisal') &&
        (lower.includes('evidence') ||
          lower.includes('trend') ||
          lower.includes('stat') ||
          lower.includes('data')))
    ) {
      return this.handleBarisalEvidenceQuery();
    }
    if (
      lower.includes('significant') ||
      lower.includes('statistical proof') ||
      lower.includes('mann kendall') ||
      lower.includes('p value') ||
      lower.includes('প্রমাণ') ||
      lower.includes('detective') ||
      lower.includes('proof')
    ) {
      return this.handleStatisticalSignificanceQuery();
    }
    if (
      lower.includes('october') ||
      lower.includes('অক্টোবর') ||
      lower.includes('seasonal') ||
      lower.includes('post-monsoon')
    ) {
      return this.handleSeasonalDissociationQuery();
    }

    // 6. Geographic Sectors (Bangla + Banglish + English)
    const targetSector = this._resolveSector(lower);
    if (targetSector) {
      return this.flyToSector(targetSector);
    }

    // 6. Direct Latitude/Longitude Coordinates match: "22.5, 90.3"
    const coordMatch = lower.match(/(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)/);
    if (coordMatch) {
      const lat = parseFloat(coordMatch[1]);
      const lon = parseFloat(coordMatch[2]);
      if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
        return this.flyToCoords(
          lat,
          lon,
          120000,
          `Coordinates [${lat.toFixed(4)}, ${lon.toFixed(4)}]`,
        );
      }
    }

    // Fallback: Unknown command
    const msg = `Agent did not recognize "${rawCommand}". Try any Bangladesh district (e.g., "Pirojpur", "Barisal", "Sylhet", "Dhaka") or layers ("Clouds", "Sea level", "FLIR").`;
    this._setStatus(msg);
    this.speak('Command not recognized. Please specify a location or layer.');
  }

  /** Resolves geographic sector from natural language query. */
  _resolveSector(text) {
    // 1. First consult comprehensive 64 districts & divisions registry
    const matchedDistrict = findDistrictSector(text);
    if (matchedDistrict) {
      return matchedDistrict;
    }

    if (
      text.includes('barisal') ||
      text.includes('barishal') ||
      text.includes('বরিশাল') ||
      text.includes('bhola') ||
      text.includes('patuakhali')
    ) {
      return SECTORS.barisal;
    }
    if (
      text.includes('dhaka') ||
      text.includes('ঢাকা') ||
      text.includes('dacca') ||
      text.includes('gazipur')
    ) {
      return SECTORS.dhaka;
    }
    if (
      text.includes('chittagong') ||
      text.includes('ctg') ||
      text.includes('chattogram') ||
      text.includes('চট্টগ্রাম')
    ) {
      return SECTORS.chittagong;
    }
    if (
      text.includes('sylhet') ||
      text.includes('সিলেট') ||
      text.includes('haor') ||
      text.includes('bonna') ||
      text.includes('flood') ||
      text.includes('বন্যা')
    ) {
      return SECTORS.sylhet;
    }
    if (
      text.includes('feni') ||
      text.includes('ফেনী') ||
      text.includes('muhuri')
    ) {
      return SECTORS.feni;
    }
    if (
      text.includes('sundarban') ||
      text.includes('সুন্দরবন') ||
      text.includes('mangrove') ||
      text.includes('khulna')
    ) {
      return SECTORS.sundarbans;
    }
    if (
      text.includes('rajshahi') ||
      text.includes('রাজশাহী') ||
      text.includes('barind') ||
      text.includes('বরেন্দ্র') ||
      text.includes('groundwater') ||
      text.includes('drought')
    ) {
      return SECTORS.rajshahi;
    }
    if (
      text.includes('kuakata') ||
      text.includes('কুয়াকাটা') ||
      text.includes('payra') ||
      text.includes('পায়রা')
    ) {
      return SECTORS.kuakata;
    }
    if (text.includes('cox') || text.includes('কক্সবাজার')) {
      return SECTORS.coxsbazar;
    }
    if (
      text.includes('bay') ||
      text.includes('bengal') ||
      text.includes('বঙ্গোপসাগর') ||
      text.includes('cyclone') ||
      text.includes('ঘূর্ণিঝড়')
    ) {
      return SECTORS.bay_of_bengal;
    }
    if (
      text.includes('bangladesh') ||
      text.includes('বাংলাদেশ') ||
      text.includes('home') ||
      text.includes('reset')
    ) {
      return SECTORS.bangladesh;
    }
    return null;
  }

  // ==========================================================================
  // CESIUM CAMERA EXECUTION ACTIONS
  // ==========================================================================

  /** Fly camera to targeted sector. */
  async flyToSector(sector, { silent = false } = {}) {
    this.activeSector = sector;
    this.stopOrbit({ silent: true });

    if (!this.viewer?.camera) {
      if (!silent) {
        this._setStatus(`Camera unavailable. Navigating to ${sector.name}`);
      }
      return;
    }

    const badge = document.getElementById('orion-harness-sector-badge');
    if (badge)
      badge.textContent = `${sector.id.toUpperCase()} [${Math.round(sector.altitude / 1000)}KM]`;

    if (!silent) {
      this._setStatus(
        `🚀 Maneuvering to ${sector.name} (${sector.actionDesc})...`,
      );
      const speechText =
        sector.speech || `Navigating to ${sector.name}. Sector live.`;
      this.speak(speechText);
    }

    const dest = Cesium.Cartesian3.fromDegrees(
      sector.lon,
      sector.lat,
      sector.altitude,
    );
    const heading = Cesium.Math.toRadians(sector.heading);
    const pitch = Cesium.Math.toRadians(sector.pitch);

    this.viewer.camera.flyTo({
      destination: dest,
      orientation: { heading, pitch, roll: 0.0 },
      duration: 2.8,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
      complete: () => {
        if (!silent) {
          this._setStatus(`✓ Arrived at ${sector.name}. Sector live.`);
        }
        this._briefSectorHighlight(sector);
      },
    });
  }

  /** Fly camera to explicit coordinates. */
  async flyToCoords(
    lat,
    lon,
    altitude = 100000,
    label = 'Target',
    { silent = false } = {},
  ) {
    this.stopOrbit({ silent: true });
    if (!silent) {
      this._setStatus(`🚀 Maneuvering to ${label}...`);
      this.speak(`Navigating to ${label}`);
    }

    const dest = Cesium.Cartesian3.fromDegrees(lon, lat, altitude);
    this.viewer?.camera?.flyTo({
      destination: dest,
      orientation: {
        heading: Cesium.Math.toRadians(0),
        pitch: Cesium.Math.toRadians(-50),
        roll: 0.0,
      },
      duration: 3.0,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
      complete: () => {
        if (!silent) this._setStatus(`✓ Arrived at ${label}.`);
      },
    });
  }

  /** Continuous 360-degree tactical camera orbit around active sector. */
  startOrbit({ silent = false } = {}) {
    this.stopOrbit({ silent: true });
    const sector = this.activeSector || SECTORS.barisal;
    if (!silent) {
      this._setStatus(
        `Engaging continuous 360° tactical orbit around ${sector.name}...`,
      );
      this.speak(`Engaging 360 degree orbit around ${sector.name}`);
    }

    const center = Cesium.Cartesian3.fromDegrees(sector.lon, sector.lat, 0);
    const distance = sector.altitude * 0.85;

    let heading = 0;
    this.orbitInterval = setInterval(() => {
      if (!this.viewer?.camera) return;
      heading += 0.003;
      this.viewer.camera.lookAt(
        center,
        new Cesium.HeadingPitchRange(
          heading,
          Cesium.Math.toRadians(sector.pitch),
          distance,
        ),
      );
    }, 25);
  }

  /** Stop camera orbit and unlock controls. */
  stopOrbit({ silent = false } = {}) {
    if (this.orbitInterval) {
      clearInterval(this.orbitInterval);
      this.orbitInterval = null;
      if (this.viewer?.camera) {
        this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      }
      if (!silent) {
        this._setStatus(`Orbit disengaged. Free camera active.`);
      }
    }
  }

  /** Toggle NASA GIBS Real Clouds. */
  triggerClouds({ silent = false, active } = {}) {
    const dockBtn = document.getElementById('real-earth-clouds-dock-btn');
    if (dockBtn) {
      const current = dockBtn.getAttribute('aria-pressed') === 'true';
      if (typeof active !== 'boolean' || current !== active) {
        dockBtn.click();
      }
      const isActive = dockBtn.getAttribute('aria-pressed') === 'true';
      if (!silent) {
        const msg = isActive
          ? 'NASA GIBS live cloud imagery online.'
          : 'NASA GIBS cloud overlay deactivated.';
        this._setStatus(msg);
        this.speak(msg);
      }
    } else if (!silent) {
      this._setStatus('Real clouds toggle triggered.');
    }
  }

  /** Trigger shader style mode. */
  triggerShader(styleKey, announcement, { silent = false } = {}) {
    this.activeShader = styleKey;
    const btn = document.querySelector(`.style-btn[data-style="${styleKey}"]`);
    if (btn) {
      btn.click();
      if (!silent) {
        this._setStatus(announcement);
        this.speak(announcement);
      }
    } else if (!silent) {
      this._setStatus(`Shader mode ${styleKey} triggered.`);
    }
  }

  /** Trigger Sea Level Rise simulation over Barisal. */
  triggerSeaLevelRise() {
    this.flyToSector(SECTORS.barisal);
    const msg =
      'Activating coastal Sea Level Rise & Surge Inundation simulation for Barisal and Bhola.';
    this._setStatus(`🌊 ${msg}`);
    this.speak(msg);
  }

  /** Offline fallback: Disaster rain & precipitation status */
  triggerDisasterRain() {
    this._setStatus('🌧️ Precipitation backend feed unavailable offline.');
    const speech =
      'Live precipitation telemetry requires the Orion backend service, which is currently unreachable.';
    this.showEvidenceCard({
      title: 'PRECIPITATION TELEMETRY STATUS',
      sector: 'Bay of Bengal & Coastal Delta',
      slope: 'Backend live weather unavailable',
      senSlope: 'N/A (offline fallback)',
      pValue: 'NASA GPM / Open-Meteo proxy offline',
      significance: 'LIVE FEED UNAVAILABLE',
      narrative:
        'Cannot fetch live precipitation intensity while the Orion agent backend is offline. Reconnect backend or toggle NASA GIBS cloud imagery for visual cloud cover.',
      speech,
    });
    this.speak(speech);
  }

  /** Offline fallback: Cyclone & Bay of Bengal monitoring */
  triggerCycloneStorm() {
    this.flyToSector(SECTORS.bay_of_bengal, { silent: true });
    this._setStatus(
      '🌀 Positioned on Bay of Bengal; cyclone live feed unavailable offline.',
    );
    const speech =
      'Positioned on the Bay of Bengal sector. Live depression and weather telemetry requires the Orion backend connection.';
    this.showEvidenceCard({
      title: 'BAY OF BENGAL CYCLONE MONITOR',
      sector: 'Bay of Bengal [20.2°N, 89.8°E]',
      slope: 'Live telemetry unavailable offline',
      senSlope: 'NHC proxy covers Atlantic/N.Pacific only',
      pValue: 'Backend offline',
      significance: 'LIVE FEED UNAVAILABLE',
      narrative:
        'Camera moved to the Bay of Bengal sector. Live meteorological readings are unavailable while the backend service is unreachable.',
      speech,
    });
    this.speak(speech);
  }

  /** Offline fallback: Sylhet flood sector */
  triggerSylhetFlood() {
    this.flyToSector(SECTORS.sylhet, { silent: true });
    this._setStatus(
      '🌊 Positioned on Sylhet Haor basin; live flood feed unavailable offline.',
    );
    const speech =
      'Positioned on Sylhet Haor Basin. Live meteorological and flood telemetry requires the Orion backend connection.';
    this.showEvidenceCard({
      title: 'SYLHET HAOR FLOOD MONITOR',
      sector: 'Sylhet Haor Basin [24.89°N, 91.87°E]',
      slope: 'Live flood telemetry unavailable offline',
      senSlope: 'N/A (offline fallback)',
      pValue: 'Backend offline',
      significance: 'LIVE FEED UNAVAILABLE',
      narrative:
        'Camera moved to Sylhet Haor Basin. Live rainfall and flood conditions are unavailable while the backend service is unreachable.',
      speech,
    });
    this.speak(speech);
  }

  /** Brief visual beacon pulse at arrival sector. */
  _briefSectorHighlight(sector) {
    if (!this.viewer?.entities) return;
    try {
      const beacon = this.viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(sector.lon, sector.lat, 100),
        ellipse: {
          semiMinorAxis: 15000.0,
          semiMajorAxis: 15000.0,
          material: new Cesium.ColorMaterialProperty(
            Cesium.Color.WHITE.withAlpha(0.25),
          ),
          outline: true,
          outlineColor: Cesium.Color.WHITE.withAlpha(0.8),
          outlineWidth: 2.0,
        },
      });
      setTimeout(() => {
        try {
          this.viewer.entities.remove(beacon);
        } catch {}
      }, 4500);
    } catch {}
  }

  // ==========================================================================
  // NASA CLIMATE TELEMETRY & EVIDENCE HUD CARD
  // ==========================================================================

  /** Hydrate MERRA-2 (via NASA POWER) trend results for the 34 grid cells over Bangladesh. */
  async _loadClimateData() {
    try {
      const [spatialRes, seasonalRes] = await Promise.all([
        fetch('/data/climate/bangladesh_t2m_spatial_trends_filtered.csv').catch(
          () => null,
        ),
        fetch('/data/climate/bangladesh_t2m_seasonal_trends.csv').catch(
          () => null,
        ),
      ]);

      if (spatialRes && spatialRes.ok) {
        const text = await spatialRes.text();
        this.spatialTrends = this._parseCSV(text);
      }
      if (seasonalRes && seasonalRes.ok) {
        const text = await seasonalRes.text();
        this.seasonalTrends = this._parseCSV(text);
      }
      this.climateLoaded = true;
      console.info(
        `[OrionHarness] Climate data hydrated: ${this.spatialTrends.length} spatial stations, ${this.seasonalTrends.length} seasonal records.`,
      );
    } catch (e) {
      console.warn('[OrionHarness] Climate data load error:', e);
    }
  }

  /** Simple CSV parser. */
  _parseCSV(text) {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return [];
    const headers = lines[0].split(',').map((h) => h.trim());
    const records = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',').map((p) => p.trim());
      if (parts.length === headers.length) {
        const obj = {};
        headers.forEach((h, idx) => {
          const val = parts[idx];
          obj[h] = !isNaN(val) && val !== '' ? parseFloat(val) : val;
        });
        records.push(obj);
      }
    }
    return records;
  }

  /** Show floating Swiss Monochrome Evidence Card HUD over Cesium. */
  showEvidenceCard(data) {
    let card = document.getElementById('orion-evidence-card');
    if (!card) {
      card = document.createElement('div');
      card.id = 'orion-evidence-card';
      card.style.cssText = `
        position: fixed;
        top: 68px;
        right: 24px;
        width: 390px;
        max-width: calc(100vw - 48px);
        background: rgba(9, 9, 11, 0.95);
        border: 1px solid #27272a;
        border-radius: 8px;
        box-shadow: 0 20px 48px rgba(0, 0, 0, 0.85), 0 0 0 1px rgba(255, 255, 255, 0.08);
        backdrop-filter: blur(16px);
        z-index: 1400;
        font-family: 'JetBrains Mono', monospace;
        color: #ffffff;
        font-size: 11px;
        line-height: 1.5;
        overflow: hidden;
        animation: fadeInCard 0.25s ease forwards;
      `;
      document.body.appendChild(card);

      const style = document.createElement('style');
      style.textContent = `
        @keyframes fadeInCard {
          from { opacity: 0; transform: translateY(-8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `;
      document.head.appendChild(style);
    }

    card.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid #27272a; background: rgba(255, 255, 255, 0.03);">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #ffffff; box-shadow: 0 0 8px rgba(255, 255, 255, 0.8);"></span>
          <span style="font-weight: 700; font-size: 11px; letter-spacing: 0.8px;">${escapeHtml(data.title || 'CLIMATE EVIDENCE DOSSIER')}</span>
        </div>
        <button id="orion-evidence-close-btn" style="background: transparent; border: none; color: #a1a1aa; font-size: 14px; cursor: pointer;">✕</button>
      </div>

      <div style="padding: 12px 14px; display: flex; flex-direction: column; gap: 10px;">
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 10px; background: rgba(0, 0, 0, 0.4); padding: 8px 10px; border-radius: 6px; border: 1px solid #18181b;">
          <div><span style="color: #71717a;">SECTOR:</span> <span style="color: #ffffff; font-weight: 600;">${escapeHtml(data.sector || 'Barisal Coastal Belt')}</span></div>
          <div><span style="color: #71717a;">TIMEFRAME:</span> <span style="color: #ffffff;">2001 - 2025 (25 Yrs)</span></div>
          <div><span style="color: #71717a;">DATASET:</span> <span style="color: #ffffff;">NASA MERRA-2 (T2M)</span></div>
          <div><span style="color: #71717a;">API:</span> <span style="color: #ffffff;">NASA POWER</span></div>
        </div>

        <div style="background: rgba(255, 255, 255, 0.02); border: 1px solid #27272a; border-radius: 6px; padding: 10px;">
          <div style="font-size: 9.5px; color: #a1a1aa; letter-spacing: 0.5px; margin-bottom: 6px; text-transform: uppercase;">STATISTICAL METRICS (THEIL-SEN &amp; MANN-KENDALL)</div>
          <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
            <span style="color: #a1a1aa;">Seasonal Slope:</span>
            <span style="color: #ffffff; font-weight: 700;">${escapeHtml(data.slope || '+0.40°C / decade')}</span>
          </div>
          <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
            <span style="color: #a1a1aa;">Sen's Slope β:</span>
            <span style="color: #ffffff;">${escapeHtml(data.senSlope || '+0.040°C / year')}</span>
          </div>
          <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
            <span style="color: #a1a1aa;">Mann-Kendall p-value:</span>
            <span style="color: #ffffff; font-weight: 700;">${escapeHtml(data.pValue || 'p < 0.001')}</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span style="color: #a1a1aa;">Significance Verdict:</span>
            <span style="color: #ffffff; border: 1px solid #52525b; padding: 1px 6px; border-radius: 3px; font-size: 9.5px;">${escapeHtml(data.significance || 'STATISTICALLY SIGNIFICANT')}</span>
          </div>
        </div>

        <div style="font-size: 10.5px; color: #d4d4d8; background: rgba(0, 0, 0, 0.3); border-left: 2px solid #ffffff; padding: 8px 10px;">
          ${escapeHtml(data.narrative || 'September warming on the Barisal coast is strong and significant, while the annual mean shows no significant trend: annual averages hide the seasonal signal.')}
        </div>

        <div style="display: flex; gap: 8px;">
          <button id="orion-evidence-speak-btn" style="flex: 1; background: #18181b; border: 1px solid #27272a; color: #ffffff; padding: 6px 10px; border-radius: 4px; font-size: 10px; cursor: pointer; font-family: inherit;">READ EVIDENCE</button>
          <button id="orion-evidence-orbit-btn" style="background: #ffffff; color: #000000; border: none; padding: 6px 12px; border-radius: 4px; font-size: 10px; font-weight: 700; cursor: pointer; font-family: inherit;">360° SURVEY</button>
        </div>
      </div>
    `;

    card
      .querySelector('#orion-evidence-close-btn')
      ?.addEventListener('click', () => {
        card.remove();
      });

    card
      .querySelector('#orion-evidence-speak-btn')
      ?.addEventListener('click', () => {
        this.speak(data.speech || data.narrative);
      });

    card
      .querySelector('#orion-evidence-orbit-btn')
      ?.addEventListener('click', () => {
        this.startOrbit();
      });
  }

  /** Query 1: Fastest Warming Hotspot (Barisal) */
  async handleFastestWarmingQuery() {
    await this.flyToSector(SECTORS.barisal);
    const speech =
      'NASA MERRA-2 data via NASA POWER shows the Barisal coast warming by about 0.40 degrees Celsius per decade in September between 2001 and 2025. The Mann-Kendall test gives p below 0.001, and the trend survives a false discovery rate correction.';
    this.showEvidenceCard({
      title: 'SEPTEMBER WARMING HOTSPOT',
      sector: 'Barisal Coastal Belt [22.5°N, 90.0°E]',
      slope: '+0.40°C / decade (September, 2001–2025)',
      senSlope: '+0.040°C / year (Theil-Sen)',
      pValue: 'p = 0.00007 (Mann-Kendall)',
      significance: 'SIGNIFICANT AFTER FDR (q = 0.05)',
      narrative:
        'Across the 34 MERRA-2 grid cells over Bangladesh, September warms in every cell (median +0.36°C/decade). On the Barisal coast the rate is +0.40°C/decade, while the annual mean shows no significant trend.',
      speech,
    });
    this.speak(speech);
  }

  /** Query 2: Detailed Barisal Evidence */
  async handleBarisalEvidenceQuery() {
    return this.handleFastestWarmingQuery();
  }

  /** Query 3: Statistical Significance Proof (Mann-Kendall & Theil-Sen) */
  async handleStatisticalSignificanceQuery() {
    this._setStatus('Analyzing Mann-Kendall tests for 34 grid cells...');
    const speech =
      'September warming is significant in all thirty-four grid cells over Bangladesh, and thirty-one remain significant after a false discovery rate correction. October warms at a similar rate, but those trends do not survive the correction.';
    this.showEvidenceCard({
      title: 'MANN-KENDALL STATISTICAL PROOF',
      sector: 'All Bangladesh, 34 MERRA-2 grid cells',
      slope: 'September: 34 of 34 cells p < 0.05 (31 after FDR)',
      senSlope: "Median Sen's slope: +0.036°C / year",
      pValue: 'Benjamini-Hochberg FDR, q = 0.05',
      significance: 'ROBUST IN SEPTEMBER',
      narrative:
        'Mann-Kendall tests on 442 cell-month series, corrected for multiple testing. September warming is robust nationwide. October looks similar (29 of 34 cells p < 0.05) but none survive FDR, and the annual mean is flat. Reproduce with analysis/trend_analysis.py.',
      speech,
    });
    this.speak(speech);
  }

  /** Query 4: Seasonal Dissociation (Why annual avg masks September warming) */
  async handleSeasonalDissociationQuery() {
    const speech =
      'Annual averages mask the seasonal signal: across 34 Bangladesh grid cells, the annual mean has zero significant cells, while September warms significantly in 31 of 34 cells after FDR correction. October shows warming at p below 0.05 in 29 cells, but zero survive FDR.';
    this.showEvidenceCard({
      title: 'SEASONAL DISSOCIATION (MERRA-2)',
      sector: 'Bangladesh (34 MERRA-2 grid cells)',
      slope: 'Sep: +0.360°C/dec | Oct: +0.389°C/dec | Annual: +0.021°C/dec',
      senSlope: 'p<0.05: Sep 34/34 | Oct 29/34 | Annual 0/34',
      pValue: 'BH FDR (q=0.05): Sep 31/34 | Oct 0/34 | Annual 0/34',
      significance: 'ROBUST SEPTEMBER SIGNAL ONLY',
      narrative:
        'Evaluating only the annual mean misses the late-monsoon warming peak in September (+0.360°C/decade median, 31/34 cells FDR-significant). October trends do not survive FDR (0/34).',
      speech,
    });
    this.speak(speech);
  }

  /** Query 5: Offline Live Weather fallback */
  async handleLiveWeatherQuery() {
    const sec = this.activeSector || SECTORS.barisal;
    const speech = `Live weather telemetry for ${sec.name} requires the Orion backend service, which is currently unreachable.`;
    this._setStatus(`📡 Live weather unavailable offline for ${sec.name}.`);
    this.showEvidenceCard({
      title: 'LIVE WEATHER TELEMETRY',
      sector: sec.name,
      slope: 'Backend live weather unavailable',
      senSlope: 'N/A (offline fallback)',
      pValue: 'Status: FEED UNAVAILABLE',
      significance: 'LIVE FEED UNAVAILABLE',
      narrative: `Live Open-Meteo conditions for ${sec.name} could not be retrieved while the Orion agent backend is offline.`,
      speech,
    });
    this.speak(speech);
  }

  /** Query 6: Offline Crop Advisory fallback (uses verified climate baseline only) */
  async handleCropAdvisoryQuery() {
    this._setStatus(
      '🌱 Offline crop advisory (using MERRA-2 baseline only)...',
    );
    const sec = this.activeSector || SECTORS.barisal;
    const speech = `Offline agricultural guidance for ${sec.name}: observed September MERRA-2 warming across Bangladesh (median +0.36°C per decade, Barisal +0.40°C per decade) supports maintaining controlled Aman irrigation and heat-resilient Rabi scheduling. Live weather is currently offline.`;

    this.showEvidenceCard({
      title: 'CROP ADVISORY (CLIMATE BASELINE)',
      sector: `${sec.name} (Agricultural Sector)`,
      slope: 'Aman Rice: Maintain 2–3 cm standing water in grain filling',
      senSlope:
        'Rabi Season: Adjust sowing window for prolonged post-monsoon warmth',
      pValue: 'Live Weather: UNAVAILABLE (offline fallback)',
      significance: 'RULE-BASED CLIMATE GUIDANCE',
      narrative: `Based on verified NASA MERRA-2 September warming trends for Bangladesh (+0.36°C/decade median): farmers can reduce heat stress using heat-tolerant varieties (e.g. BRRI dhan 75/87). Reconnect backend for live local weather.`,
      speech,
    });
    this.speak(speech);
  }
}
