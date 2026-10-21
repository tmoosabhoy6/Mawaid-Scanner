import { build } from 'esbuild';
import { mkdirSync, copyFileSync, cpSync } from 'node:fs';
mkdirSync('public/vendor/fonts', { recursive: true });
await build({ entryPoints: ['public/camera.js'], bundle: true, minify: true, outfile: 'public/vendor/camera.js' });
copyFileSync('node_modules/qz-tray/qz-tray.js', 'public/vendor/qz-tray.js');
// Self-hosted interface font (SIL Open Font License); the strict CSP allows same-origin fonts only.
for (const subset of ['latin', 'arabic']) copyFileSync(`node_modules/@fontsource-variable/readex-pro/files/readex-pro-${subset}-wght-normal.woff2`, `public/vendor/fonts/readex-pro-${subset}.woff2`);
console.log('Camera, printer and font assets bundled locally.');
await build({entryPoints:['public/pdf.js'],bundle:true,minify:true,outfile:'public/vendor/pdf.js',platform:'browser'});
// Direct Zebra printing draws each saved PDF page with pdf.js; its worker and standard fonts are served from this site.
await build({entryPoints:['public/zebra.js'],bundle:true,minify:true,outfile:'public/vendor/zebra.js',platform:'browser'});
copyFileSync('node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs','public/vendor/pdf.worker.mjs');
cpSync('node_modules/pdfjs-dist/standard_fonts','public/vendor/standard_fonts',{recursive:true});
