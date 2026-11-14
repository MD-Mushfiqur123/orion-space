import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { expandApplicationHtml } from '../../build/application-html.js';
import { createBrowserViteConfig } from '../../build/vite.js';
import { R820T_GAIN_STEPS_DB, normalizeSdrGain } from '../sdr/gain.js';

const html = expandApplicationHtml(
  readFileSync(new URL('../../index.html', import.meta.url), 'utf8'),
);
const css = readFileSync(
  new URL('./styles/radio.css', import.meta.url),
  'utf8',
);

test('the redesigned Radio panel ships its station controls; the SDR card stays markup-optional', () => {
  // The premium redesign replaced the old Radio panel (and its embedded local
  // RTL-SDR card) with a station list in the Context rail. The SDR controller
  // tolerates missing elements, so it stays inert until the card ships again.
  const radioStart = html.indexOf('id="global-radio-panel"');
  assert.ok(radioStart >= 0, 'the Live Radio panel ships in the Context rail');
  for (const id of [
    'radio-country-input',
    'live-radio-selector',
    'radio-play-toggle-btn',
    'radio-stop-toggle-btn',
    'radio-now-playing',
    'global-radio-audio-player',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} is missing`);
  }
  assert.doesNotMatch(html, /id="sdr-radio-card"/);
  assert.doesNotMatch(html, /id="sdr-gain-select"/);
  assert.match(css, /\.sdr-radio-card\s*\{/);
});

test('the gain contract offers AUTO plus every R820T step', () => {
  // The markup select is gone with the old Radio panel; the option list the
  // card must render is still owned by the gain module.
  assert.equal(normalizeSdrGain('auto'), 'auto');
  for (const step of R820T_GAIN_STEPS_DB) {
    assert.equal(normalizeSdrGain(step), step);
    assert.equal(normalizeSdrGain(step.toFixed(1)), step);
  }
  assert.equal(normalizeSdrGain(''), null);
  assert.equal(normalizeSdrGain('not-a-number'), null);
});

test('worker-reached SDR dependencies are pre-bundled and builds keep a separate cache', () => {
  const serve = createBrowserViteConfig();
  for (const dependency of [
    '@jtarrio/signals/demod/demodulator.js',
    '@jtarrio/signals/demod/modes.js',
    '@jtarrio/webrtlsdr/rtlsdr.js',
  ]) {
    assert.ok(serve.optimizeDeps.include.includes(dependency), dependency);
  }
  assert.equal(serve.cacheDir, undefined);
  assert.equal(
    createBrowserViteConfig({ command: 'build' }).cacheDir,
    'node_modules/.vite-build',
  );
});
