import { build } from 'esbuild';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'site');
const generated = path.resolve(site, 'assets/smile-lab');
const read = name => readFile(path.join(root, name), 'utf8');

// This directory contains only this builder's generated bundles and atlas.
if (path.relative(site, generated).replaceAll('\\', '/') !== 'assets/smile-lab') throw new Error('Unexpected output directory');
await rm(generated, { recursive: true, force: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: { smile: 'tools/smile-lab/preview.js', controls: 'tools/smile-lab/preview.css' },
  outdir: generated,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  metafile: true,
  legalComments: 'eof',
  entryNames: '[name]-[hash]',
  chunkNames: 'chunks/[name]-[hash]',
  assetNames: '[name]-[hash]',
  loader: { '.png': 'file' },
});
function entryHref(source) {
  const entry = Object.entries(result.metafile.outputs).find(([, info]) => info.entryPoint?.replaceAll('\\', '/') === source);
  if (!entry) throw new Error('Missing bundle for ' + source);
  return './' + path.relative(site, path.resolve(root, entry[0])).replaceAll('\\', '/');
}

const portrait = await read('tools/smile-lab/smile-fallback.txt');
if (portrait.split('\n').length !== 68 || portrait.split('\n').some(line => line.length !== 120)) throw new Error('Unexpected still portrait');
let html = await read('tools/smile-lab/index.html');
html = html
  .replace('<meta name="robots" content="noindex, nofollow">', '<meta name="description" content="Clint Jansen. An interactive Braille portrait that turns toward you and smiles.">\n  <meta name="theme-color" content="#d8371d">')
  .replace('<title>Clint Jansen — smile preview</title>', '<title>Clint Jansen — Smile lab</title>')
  .replace('href="/site/favicon.svg"', 'href="./favicon.svg"')
  .replace('href="/site/styles.css"', 'href="./styles.css"')
  .replace('href="./preview.css"', 'href="' + entryHref('tools/smile-lab/preview.css') + '"')
  .replace('src="./preview.js"', 'src="' + entryHref('tools/smile-lab/preview.js') + '"')
  .replace('href="/tools/smile-lab/"', 'href="./"')
  .replace('href="../../src/braille/image-to-braille.html"', 'href="./image-to-braille/"')
  .replace('label="Clint Jansen smile preview"', 'label="Clint Jansen smile lab"')
  .replace('LOCAL PREVIEW', 'SMILE LAB')
  .replace('aria-label="Portrait preview"', 'aria-label="Portrait study"')
  .replace('Local experiment only. AI-authored portrait keyframes, animated with a facial landmark mesh. Nothing here is published.', 'AI-authored portrait keyframes. A study in character and expression.')
  .replace(/(<pre\b[^>]*id="braille-art"[^>]*>)(<\/pre>)/, (_, opening, closing) => opening.replace(/aria-label="[^"]*"/, 'aria-label="Front-facing Braille portrait with a broad confident smile"') + portrait + closing)
  .replace('</head>', '<noscript><style>#loader.brand-loader,.preview-toolbar,.motion-timeline,.footer-actions,#back-to-controls{display:none}.preview-main{height:calc(100dvh - 180px)}.art-frame{width:calc(100vw - 40px);height:100%}.preview-art{font-size:min(1vw,.95vh)}</style></noscript>\n</head>')
  .replace('<body>', '<body>\n  <noscript><p style="text-align:center;font:12px monospace">Enable JavaScript to play the portrait and use the controls.</p></noscript>');
if (/href="(?:\/site|\/tools|\.\.\/\.\.\/src)/.test(html)) throw new Error('Local-only link in public HTML');
await writeFile(path.join(site, 'index.html'), html);

await import('./build-braille-page.mjs');
const converter = (await read('src/braille/image-to-braille.html'))
  .replace('href="../../tools/smile-lab/"', 'href="../"')
  .replace('← Smile preview', '← Smile lab');
await mkdir(path.join(site, 'image-to-braille'), { recursive: true });
await writeFile(path.join(site, 'image-to-braille/index.html'), converter);

const licenses = [
  ['Three.js', 'node_modules/three/LICENSE'],
  ['textmode.js', 'tools/smile-lab/node_modules/textmode.js/LICENSE'],
  ['Delaunator', 'tools/smile-lab/node_modules/delaunator/LICENSE'],
  ['robust-predicates', 'tools/smile-lab/node_modules/robust-predicates/LICENSE'],
];
await writeFile(path.join(site, 'licenses/smile-lab-dependencies.txt'), (await Promise.all(licenses.map(async ([name, source]) => name + '\n\n' + await read(source)))).join('\n\n----------\n\n'));
console.log('Built the public smile lab, lazy renderer bundles, portrait atlas and local image converter in site/.');
