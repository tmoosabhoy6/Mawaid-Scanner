import { bindings, defineConfig } from 'cf/config';
export default defineConfig({
 worker:{
  name:'mawayid-karbala',
  entrypoint:'./cloudflare/worker.js',
  compatibilityDate:'2026-10-20',
  workersDev:true,
  previewUrls:false,
  assets:{htmlHandling:'none',runWorkerFirst:['/','/api/*','/scanner']},
  env:{DB:bindings.d1({name:'mawayid-karbala'}),ASSETS:bindings.assets(),ADMIN_PASSWORD:bindings.secret(),SCANNER_PASSWORD:bindings.secret(),SYNC_TOKEN:bindings.secret()},
  observability:{enabled:true,redactQueryString:true,logs:{enabled:true,headSamplingRate:1},traces:{enabled:true,headSamplingRate:0.01}}
 }
});
