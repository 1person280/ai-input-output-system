import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
  external: ['vscode'],
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('[esbuild] watching for changes...');
} else {
  await build(options);
  console.log('[esbuild] build complete: dist/extension.js');
}