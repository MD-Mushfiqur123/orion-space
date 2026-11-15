import { readFileSync } from 'node:fs';

export const APPLICATION_TEMPLATES = Object.freeze([
  'scene-chrome',
  'cockpit',
  'display-controls',
  'command-dock',
  'layer-panels',
  'context',
  'welcome',
  'provider-settings',
  'hud-loading',
]);
const allowed = new Set(APPLICATION_TEMPLATES);

/** Expand only known component templates; markers cannot name filesystem paths. */
export function expandApplicationHtml(html) {
  return html.replace(
    /^[ \t]*<!-- gev:template ([^\s]+) -->\r?\n?/gm,
    (_, name) => {
      if (!allowed.has(name))
        throw new Error(`Unknown application template: ${name}`);
      return readFileSync(
        new URL(`../src/ui/templates/${name}.html`, import.meta.url),
        'utf8',
      );
    },
  );
}

/**
 * `vite-plugin-cesium` injects its 1.7 MB global build as a plain classic head
 * script, which makes it render-blocking: no pixel of the app could be painted
 * until that whole file had downloaded and executed (measured: first paint at
 * 775 ms, Cesium itself arriving at 281 ms). Build mode externalises the
 * `cesium` import to that global, so the script still has to run before the
 * module entry — `defer` preserves that ordering (deferred classic scripts and
 * module scripts share one in-order execution queue) while taking the file off
 * the render-blocking path.
 */
export function deferCesiumScript(html) {
  return html.replace(
    /<script src="([^"]*Cesium\.js)"><\/script>/,
    '<script defer src="$1"></script>',
  );
}

/** Assemble static application markup and take Cesium off the blocking path. */
export function applicationHtmlPlugin() {
  return {
    name: 'application-component-templates',
    transformIndexHtml: {
      // Post-order: the Cesium script tag is only in the document once the
      // cesium plugin has injected it. The templates themselves carry no
      // Vite-managed assets (only the public /logo.svg), so expanding them
      // here loses nothing the pre-order hook would have processed.
      order: 'post',
      handler: (html) => deferCesiumScript(expandApplicationHtml(html)),
    },
  };
}
