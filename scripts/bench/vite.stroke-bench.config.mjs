// Bundles scripts/bench/stroke-format-bench.ts (and the app modules it uses) for Node.
export default {
  logLevel: 'warn',
  publicDir: false,
  build: {
    ssr: 'scripts/bench/stroke-format-bench.ts',
    outDir: process.env.CANVINK_BENCH_BUILD ?? 'node_modules/.cache/canvink-stroke-bench',
    emptyOutDir: true,
    target: 'node22',
    rollupOptions: { output: { format: 'es', entryFileNames: 'stroke-format-bench.js' } },
  },
  ssr: { external: ['@automerge/automerge', '@automerge/automerge-repo'] },
};
