import esbuild from 'esbuild';
const minify = process.argv.includes('--dev') ? false : true;
await esbuild.build({
    entryPoints: ['./glue.mjs'],
    bundle: true,
    format: 'iife',
    globalName: '__DRPY3__',
    platform: 'browser',
    target: 'es2022',
    outfile: minify ? './drpy3-muhai.bundle.js' : './drpy3-muhai.dev.js',
    minify,
    legalComments: 'none',
    logLevel: 'info',
});
