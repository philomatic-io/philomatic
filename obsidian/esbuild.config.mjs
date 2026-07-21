/**
 * Bundle the plugin for Obsidian: one CJS `main.js` beside manifest.json (the load-unpacked
 * shape Obsidian expects). `obsidian`/`electron`/editor internals stay external — the app
 * provides them at runtime. `production` builds once; default watches for the dev loop.
 */
import esbuild from 'esbuild';

const prod = process.argv.includes('production');

const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  outfile: 'main.js',
  bundle: true,
  format: 'cjs',
  target: 'es2020',
  platform: 'browser',
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'],
  sourcemap: prod ? false : 'inline',
  logLevel: 'info',
});

if (prod) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
}
