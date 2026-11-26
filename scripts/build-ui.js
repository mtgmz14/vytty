// Assembles the UI that the Tauri app serves: src/renderer plus the xterm.js
// files from node_modules, into ui/ (frontendDist in src-tauri/tauri.conf.json).
// Run by `cargo tauri build` / CI before compiling; `npm run build:ui` by hand.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'src', 'renderer');
const out = path.join(root, 'ui');

const VENDOR = {
  'xterm.css': '@xterm/xterm/css/xterm.css',
  'xterm.js': '@xterm/xterm/lib/xterm.js',
  'addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js',
  'addon-search.js': '@xterm/addon-search/lib/addon-search.js',
  'addon-web-links.js': '@xterm/addon-web-links/lib/addon-web-links.js',
  'addon-unicode11.js': '@xterm/addon-unicode11/lib/addon-unicode11.js',
};

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'vendor'), { recursive: true });
for (const f of fs.readdirSync(src)) {
  if (/\.(js|css|html|svg|png)$/.test(f)) fs.copyFileSync(path.join(src, f), path.join(out, f));
}
for (const [name, mod] of Object.entries(VENDOR)) {
  const from = require.resolve(mod, { paths: [root] });
  fs.copyFileSync(from, path.join(out, 'vendor', name));
}

let html = fs.readFileSync(path.join(src, 'index.html'), 'utf8');
html = html.replace(/\.\.\/\.\.\/node_modules\/@xterm\/xterm\/css\/xterm\.css/, 'vendor/xterm.css');
html = html.replace(/\.\.\/\.\.\/node_modules\/@xterm\/[\w-]+\/lib\/([\w-]+\.js)/g, 'vendor/$1');
// The content security policy is set by Tauri (it adds what its IPC needs).
html = html.replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
if (!html.includes('bridge.js')) html = html.replace(/(\s*)<script src="vendor\/xterm\.js"><\/script>/, '$1<script src="bridge.js"></script>$&');
if (/node_modules/.test(html)) throw new Error('index.html still points into node_modules');
fs.writeFileSync(path.join(out, 'index.html'), html);
console.log(`ui/ ready (${fs.readdirSync(out).length} entries)`);
