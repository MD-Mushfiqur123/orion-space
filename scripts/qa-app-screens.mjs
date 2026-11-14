import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import fs from 'node:fs';

const OUT = '/workspace/orion-space/qa-shots/app-screens';
fs.mkdirSync(OUT, { recursive: true });

const executablePath = await chromium.executablePath();

const browser = await puppeteer.launch({
  headless: 'shell',
  executablePath,
  args: [...chromium.args, '--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });

page.on('pageerror', (e) => console.log('pageerror:', e.message.slice(0, 120)));

await page.goto('http://localhost:5199/', { waitUntil: 'domcontentloaded', timeout: 60000 });

// Wait for the app boot (loading screen -> globe). Cap at 45s.
await page.waitForFunction(
  () => {
    const loader = document.getElementById('loading-screen');
    const done = !loader || loader.hidden || getComputedStyle(loader).display === 'none' || loader.style.opacity === '0';
    return done && document.querySelector('#cesiumContainer canvas');
  },
  { timeout: 45000 },
).catch(() => console.log('boot wait timed out; shooting anyway'));

await new Promise((r) => setTimeout(r, 8000));
await page.screenshot({ path: `${OUT}/1-globe-overview.png` });
console.log('shot 1: globe overview');

// Welcome/first-run dialog, if present.
const hasWelcome = await page.$('#welcome-dialog:not([hidden])').catch(() => null);
if (hasWelcome) {
  await page.screenshot({ path: `${OUT}/2-welcome.png` });
  console.log('shot 2: welcome dialog');
  await page.keyboard.press('Escape').catch(() => {});
  await new Promise((r) => setTimeout(r, 1000));
}

// Expand the layer panel / context rail regions.
await page.evaluate(() => {
  document.getElementById('data-panel')?.classList.add('active');
  document.getElementById('data-panel')?.classList.remove('collapsed');
  document.getElementById('climate-detective-panel')?.classList.add('active');
}).catch(() => {});
await new Promise((r) => setTimeout(r, 1500));
await page.screenshot({ path: `${OUT}/2-panels.png` });
console.log('shot 2: panels');

// Open the command dock tray (control panel) if present.
await page.evaluate(() => {
  const toggle = document.getElementById('control-panel-toggle');
  if (toggle) toggle.click();
}).catch(() => {});
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: `${OUT}/3-command-dock.png` });
console.log('shot 3: command dock');

// Mobile viewport.
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: `${OUT}/4-mobile.png` });
console.log('shot 4: mobile');

await browser.close();
console.log('done');
