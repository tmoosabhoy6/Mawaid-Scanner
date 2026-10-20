import { build } from 'esbuild';
import { mkdirSync, copyFileSync } from 'node:fs';
mkdirSync('public/vendor', { recursive: true });
await build({ entryPoints: ['public/camera.js'], bundle: true, minify: true, outfile: 'public/vendor/camera.js' });
copyFileSync('node_modules/qz-tray/qz-tray.js', 'public/vendor/qz-tray.js');
console.log('Camera and printer libraries bundled locally.');
await build({entryPoints:['public/pdf.js'],bundle:true,minify:true,outfile:'public/vendor/pdf.js',platform:'browser'});
