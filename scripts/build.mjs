// Builds the static site into docs/ (publish that folder with GitHub Pages). All asset URLs are relative.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';

mkdirSync('docs', { recursive: true });
await build({ entryPoints: ['web/main.ts'], bundle: true, format: 'iife', target: 'es2020', minify: true, sourcemap: false, outfile: 'docs/app.js', logLevel: 'info' });
copyFileSync('web/index.html', 'docs/index.html');
copyFileSync('web/styles.css', 'docs/styles.css');
writeFileSync('docs/.nojekyll', '');
