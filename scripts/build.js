import { build } from 'esbuild';
import { mkdirSync, copyFileSync } from 'node:fs';
mkdirSync('public/vendor/fonts', { recursive: true });
await build({ entryPoints: ['public/camera.js'], bundle: true, minify: true, outfile: 'public/vendor/camera.js' });
copyFileSync('node_modules/qz-tray/qz-tray.js', 'public/vendor/qz-tray.js');
// Self-hosted interface font (SIL Open Font License); the strict CSP allows same-origin fonts only.
for (const subset of ['latin', 'arabic']) copyFileSync(`node_modules/@fontsource-variable/readex-pro/files/readex-pro-${subset}-wght-normal.woff2`, `public/vendor/fonts/readex-pro-${subset}.woff2`);
console.log('Camera, printer and font assets bundled locally.');
await build({entryPoints:['public/pdf.js'],bundle:true,minify:true,outfile:'public/vendor/pdf.js',platform:'browser'});
