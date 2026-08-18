// The diff2html and highlight.js layer: parsing a patch, turning it into HTML, and the two
// stylesheets and one browser bundle that come out of node_modules. Every npm dependency the
// plugin has is required here and nowhere else, which is what keeps the rest of the plugin, and
// its tests, runnable in a checkout where the plugin has not been installed.
//
// highlight.js is never called from the server: the browser does the highlighting through
// diff2html's own bundle. The package is here for its theme stylesheets.

const { readFileSync, statSync, copyFileSync, mkdirSync } = require('fs');
const { join, dirname } = require('path');
const d2h = require('diff2html');

// diffMaxChanges is a parse-time option and applies per file, so it caps one enormous file. The
// whole-diff guard is a separate check on the counts this returns.
function parsePatch(patch, maxChanges) {
  return d2h.parse(patch, {
    diffMaxChanges: maxChanges,
    diffTooBigMessage: () => 'File has too many changes to display',
  });
}

function renderHtml(parsed, layout) {
  return d2h.html(parsed, {
    outputFormat: layout === 'line-by-line' ? 'line-by-line' : 'side-by-side',
    drawFileList: true,
    colorScheme: 'dark',
    matching: 'words',
    renderNothingWhenEmpty: false,
  });
}

// diff2html's browser bundle does the highlighting. Only files under the plugin's public/
// folder can be served (plugin-loader.js resolveFile), so the bundle is copied out of
// node_modules on startup. Copying beats committing a megabyte of minified third-party code,
// and beats sending it over the WebSocket, which the browser could not cache.
const VENDOR_BUNDLE = 'diff2html-ui.min.js';

function installBrowserBundle(pluginDir, log) {
  try {
    const source = require.resolve(`diff2html/bundles/js/${VENDOR_BUNDLE}`);
    const targetDir = join(pluginDir, 'public', 'vendor');
    const target = join(targetDir, VENDOR_BUNDLE);
    // Size is enough to spot a version change; the file is only ever replaced wholesale.
    let current = -1;
    try { current = statSync(target).size; } catch { /* not copied yet */ }
    const wanted = statSync(source).size;
    if (current === wanted) return true;
    mkdirSync(targetDir, { recursive: true });
    copyFileSync(source, target);
    log(`copied ${VENDOR_BUNDLE} (${Math.round(wanted / 1024)} KB) for the browser`);
    return true;
  } catch (e) {
    log(`could not install the highlighter bundle, syntax highlighting is off: ${e.message}`);
    return false;
  }
}

// The chosen highlight.js theme, read from the installed package. Only the token colours are
// wanted, so the theme's own background is neutralised in git-diff.css.
const themeCache = new Map();
function highlightStyles(theme) {
  const name = /^[a-z0-9-]+$/.test(String(theme || '')) ? theme : 'github-dark';
  if (themeCache.has(name)) return themeCache.get(name);
  let css = '';
  for (const candidate of [name, 'github-dark']) {
    try {
      css = readFileSync(require.resolve(`highlight.js/styles/${candidate}.min.css`), 'utf8');
      break;
    } catch { /* try the fallback theme */ }
  }
  themeCache.set(name, css);
  return css;
}

let stylesCache = null;
function diff2htmlStyles() {
  if (stylesCache !== null) return stylesCache;
  try {
    // No "exports" field in diff2html's package.json, so the deep path resolves.
    stylesCache = readFileSync(require.resolve('diff2html/bundles/css/diff2html.min.css'), 'utf8');
  } catch {
    // Fall back to walking up from the module entry point.
    try {
      const pkgDir = dirname(dirname(require.resolve('diff2html')));
      stylesCache = readFileSync(join(pkgDir, 'bundles', 'css', 'diff2html.min.css'), 'utf8');
    } catch {
      stylesCache = '';
    }
  }
  return stylesCache;
}

module.exports = {
  VENDOR_BUNDLE,
  parsePatch,
  renderHtml,
  installBrowserBundle,
  highlightStyles,
  diff2htmlStyles,
};
