import { copyFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir('site', { recursive: true });
await build({
  entryPoints: ['client/app.js'],
  outfile: 'site/app.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  external: ['./deals-data.js'],
  sourcemap: false,
  minify: true,
  legalComments: 'none',
});
await Promise.all([
  copyFile('client/styles.css', 'site/styles.css'),
  copyFile('data/deals-data.js', 'site/deals-data.js'),
]);
console.log('Client bundle and static data built.');
