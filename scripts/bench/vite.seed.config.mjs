// Bundles scripts/bench/seed-workspace.ts (and the app modules it uses) for Node.
export default {
  logLevel: 'warn',
  publicDir: false,
  build: {
    ssr: 'scripts/bench/seed-workspace.ts',
    outDir: process.env.CANVINK_BENCH_BUILD ?? 'node_modules/.cache/canvink-bench',
    emptyOutDir: true,
    target: 'node22',
    rollupOptions: { output: { format: 'es', entryFileNames: 'seed-workspace.js' } },
  },
  ssr: { external: ['@automerge/automerge', '@automerge/automerge-repo'] },
};
