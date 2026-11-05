import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
// Distribution build (harness/bundle.py sets ONLYREAD_DIST=1): no dev sink (which also disables the
// localhost control channel), minified, no source maps. A normal build keeps the dev defaults.
const dist = process.env.ONLYREAD_DIST === '1';
// A development build's Pro service to start on: the local mock (default), or with ONLYREAD_DEV_SERVICE=production the
// real one, as a release uses it. Either can still be switched on the settings page (Security, "Pro service").
const devService = process.env.ONLYREAD_DEV_SERVICE === 'production' ? 'production' : 'local';

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: {
    background: 'extension/src/background/index.ts',
    popup: 'extension/src/popup/popup.ts',
    options: 'extension/src/options/options.ts',
    setup: 'extension/src/setup/setup.ts',
    content: 'extension/src/content/actions.ts',
  },
  bundle: true,
  format: 'esm',
  target: ['chrome120'],
  outdir: 'extension/dist',
  sourcemap: !dist,
  minify: dist,
  define: { __ONLYREAD_DIST__: JSON.stringify(dist), __ONLYREAD_DEV_SERVICE__: JSON.stringify(devService) },
  // The in-page notice carries OnlyRead's icon inline (a 2 KB data URL): the extension's files are not web-accessible,
  // so a page cannot probe for them.
  loader: { '.png': 'dataurl' },
  logLevel: 'info',
  metafile: true,
};

// The stanza guard runs in a site's own page and workers (put there by the debugger, background/socket-guard.ts), not
// as a module: one self-contained script.
/** @type {import('esbuild').BuildOptions} */
const inpage = {
  entryPoints: { 'whatsapp-socket': 'extension/src/inpage/whatsapp-socket.ts', 'telegram-worker': 'extension/src/inpage/telegram-worker.ts' },
  bundle: true,
  format: 'iife',
  target: ['chrome120'],
  outdir: 'extension/dist',
  minify: dist,
  logLevel: 'info',
  metafile: true,
};

const mit = (holder) => `MIT License (the package ships no license file; this is the text its package.json declares)

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

/** Writes extension/dist/THIRD_PARTY_NOTICES.txt: the name, version, license and license text (and NOTICE, if any) of
 *  every npm package bundled into the extension's scripts, as their licenses (MIT, Apache-2.0 and the like) require
 *  for a copy that ships them. harness/bundle.py puts it in the release next to LICENSE. */
function writeNotices(metafiles) {
  const dirs = new Set();
  for (const meta of metafiles)
    for (const input of Object.keys(meta.inputs)) {
      const m = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
      if (m) dirs.add(m[1]);
    }
  const parts = [...dirs].sort().map((dir) => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const files = readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(f)).sort();
    const texts = files.map((f) => readFileSync(join(dir, f), 'utf8').trim());
    // A package can declare MIT in package.json without shipping the file (standardwebhooks): the MIT text, with the
    // holder its package.json names. Any other license must ship its own text, or the build stops.
    if (!texts.length && pkg.license === 'MIT') texts.push(mit(typeof pkg.author === 'string' ? pkg.author : pkg.author?.name ?? pkg.name));
    if (!texts.length) throw new Error(`${pkg.name} is bundled but ships no license file: add its text by hand`);
    return [`${pkg.name} ${pkg.version} (${pkg.license ?? 'see below'})`, '-'.repeat(60), ...texts].join('\n\n');
  });
  const head = 'OnlyRead is licensed under the GNU Affero General Public License v3.0 (LICENSE).\n'
    + 'Its scripts include the following third-party packages, under their own licenses:';
  writeFileSync('extension/dist/THIRD_PARTY_NOTICES.txt', [head, ...parts].join('\n\n\n') + '\n');
}

if (watch) {
  const ctx = await esbuild.context(options);
  const inpageCtx = await esbuild.context(inpage);
  await Promise.all([ctx.watch(), inpageCtx.watch()]);
  console.log('watching…');
} else {
  const results = await Promise.all([esbuild.build(options), esbuild.build(inpage)]);
  writeNotices(results.map((r) => r.metafile));
}
