import {createHash} from 'node:crypto';
import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const here = new URL('./', import.meta.url);
const dist = new URL('dist/', here);
const papers = new URL('../../../papers/', here);

await mkdir(new URL('assets/', dist), {recursive: true});
await build({
  absWorkingDir: fileURLToPath(here),
  entryPoints: ['index.tsx'],
  outfile: 'dist/assets/app.js',
  format: 'esm',
  bundle: true,
  jsx: 'automatic',
  minify: true,
});

let html = (await readFile(new URL('index.html', here), 'utf8')).replaceAll('\r\n', '\n');
for (const name of ['app.js', 'app.css']) {
  const asset = `assets/${name}`;
  const hash = createHash('sha256').update(await readFile(new URL(asset, dist))).digest('hex').slice(0, 12);
  const path = '/papers/add/' + asset;
  html = html.replace(`${path}"`, `${path}?v=${hash}"`);
}
await writeFile(new URL('index.html', dist), html);

const resources = ['classification.mjs', 'keyword-vocabulary.json', 'keywords.mjs'];
for (const file of resources) {
  await copyFile(new URL('public/' + file, here), new URL(file, dist));
}

if (process.argv.includes('--release')) {
  for (const file of ['index.html', 'assets/app.js', 'assets/app.css', ...resources]) {
    await copyFile(new URL(file, dist), new URL('add/' + file, papers));
  }
  await copyFile(new URL('index.html', dist), new URL('index.html', papers));
}
