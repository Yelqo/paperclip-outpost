import { build } from 'esbuild';
await build({entryPoints:['plugin/worker.ts','plugin/manifest.ts'],outdir:'dist',bundle:true,platform:'node',format:'esm',target:'node24',sourcemap:true});
