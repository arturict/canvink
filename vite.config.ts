// @ts-expect-error -- The app deliberately has no Node runtime types; this build-only import stays in Vite.
import { execFileSync } from 'node:child_process';
// @ts-expect-error -- Build-only Node import, see above.
import { createHash } from 'node:crypto';
// @ts-expect-error -- Build-only Node import, see above.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
// @ts-expect-error -- Build-only Node import, see above.
import { join } from 'node:path';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import packageJson from './package.json';

const BUILD_ID_TOKEN = '__CANVINK_BUILD_ID__';
const PRECACHE_TOKEN = '__CANVINK_PRECACHE__';

export default defineConfig(({ mode }) => {
  let buildId = '';
  let precache: string[] = [];
  let viewerOutDir = 'dist';
  const env = loadEnv(mode, '.', '');
  const configuredCommit = env.VERCEL_GIT_COMMIT_SHA || env.GITHUB_SHA;
  let localCommit = '';
  if (!configuredCommit) {
    try {
      const gitOptions = {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      } as const;
      const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], gitOptions).trim();
      if (!dirty) localCommit = execFileSync('git', ['rev-parse', 'HEAD'], gitOptions).trim();
    } catch {
      localCommit = '';
    }
  }
  const commitCandidate = configuredCommit || localCommit;
  const commit = /^[0-9a-f]{40}$/i.test(commitCandidate) ? commitCandidate.toLowerCase() : 'local';

  return {
    define: {
      __CANVINK_COMMIT__: JSON.stringify(commit),
      __CANVINK_VERSION__: JSON.stringify(packageJson.version),
      // Set by `pnpm build:android`: the phone app is a viewer that cannot draw.
      __CANVINK_VIEWER__: JSON.stringify(env.CANVINK_VIEWER === '1'),
    },
    plugins: [
      react(),
      {
        // Browsers install a new service worker only when its bytes change, and
        // the install step is what precaches a build's lazy chunks for offline
        // use. The worker is static, so every build stamps it with an id that
        // covers the names (content hashes) of everything the build emitted.
        name: 'canvink-service-worker-build-id',
        apply: 'build',
        generateBundle(_, bundle) {
          const hash = createHash('sha256');
          for (const name of Object.keys(bundle).sort()) {
            const output = bundle[name];
            hash.update(name);
            // The page itself has no content hash in its name.
            if (output.type === 'asset' && name.endsWith('.html')) hash.update(output.source);
          }
          buildId = hash.digest('hex').slice(0, 16);
          // Every emitted file is content-hashed and immutable, so the worker
          // caches all of them at install: a lazy chunk (math, import, Markdown,
          // export) must never depend on the network the moment it is needed.
          precache = Object.keys(bundle).filter((name) => name.startsWith('assets/')).sort();
        },
        writeBundle(options) {
          const worker = join(options.dir ?? 'dist', 'sw.js');
          const source = readFileSync(worker, 'utf8');
          if (!source.includes(BUILD_ID_TOKEN)) throw new Error('public/sw.js lost its build id placeholder.');
          if (!source.includes(PRECACHE_TOKEN)) throw new Error('public/sw.js lost its precache placeholder.');
          writeFileSync(
            worker,
            source.replace(BUILD_ID_TOKEN, buildId).replace(PRECACHE_TOKEN, JSON.stringify(precache)),
          );
        },
      },
      {
        // The phone app is not the website: public/download holds the installers
        // and the APK itself (an APK inside the APK doubled its size), and
        // public/landing the landing page's clips.
        name: 'canvink-viewer-without-site-files',
        apply: 'build',
        configResolved(config) {
          viewerOutDir = config.build.outDir;
        },
        closeBundle() {
          if (env.CANVINK_VIEWER !== '1') return;
          for (const folder of ['download', 'landing']) rmSync(join(viewerOutDir, folder), { recursive: true, force: true });
        },
      },
      {
        name: 'canvink-version-manifest',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'version.json',
            source: JSON.stringify({
              commit,
              version: packageJson.version,
            }),
          });
        },
      },
    ],
    build: {
      // CANVINK_PROFILE_BUILD=1 keeps function names readable in CPU profiles.
      ...(env.CANVINK_PROFILE_BUILD ? { minify: false } : {}),
      rolldownOptions: {
        output: {
          // Libraries change far less often than the app: in their own chunks
          // they stay cached across deploys, and they download and compile in
          // parallel with the app's code. The lazily loaded libraries (math,
          // PDF, Clerk, OneNote sign-in) keep the chunks their dynamic imports
          // give them.
          codeSplitting: {
            groups: [
              { name: 'react', test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/, priority: 30 },
              { name: 'prosemirror', test: /node_modules[\\/](?:prosemirror-[^\\/]+|@automerge[\\/]prosemirror|rope-sequence|orderedmap|w3c-keyname)[\\/]/, priority: 25 },
              { name: 'automerge', test: /node_modules[\\/]@automerge[\\/]/, priority: 20 },
              { name: 'lucide', test: /node_modules[\\/]lucide-react[\\/]/, priority: 10 },
              // Named so a chunk in the network log says what it is (JSXGraph's
              // own folder is called `src`); tests/e2e/startup-chunks.spec.ts
              // relies on these names.
              { name: 'jsxgraph', test: /node_modules[\\/]jsxgraph[\\/]/, priority: 10 },
              { name: 'sodium', test: /node_modules[\\/]libsodium[^\\/]*[\\/]/, priority: 10 },
            ],
          },
        },
      },
    },
    server: {
      port: 1420,
      strictPort: true,
    },
    optimizeDeps: {
      // Vite's dev-only dependency pre-bundling breaks the Automerge WASM
      // module (import throws a WebAssembly.Exception), leaving the dev app
      // unable to mount. The production Rollup build is unaffected. The
      // excluded packages' CommonJS dependencies still need the optimizer's
      // ESM interop, so they are force-included.
      exclude: ['@automerge/automerge', '@automerge/automerge-repo'],
      include: [
        '@automerge/automerge-repo > bs58check',
        '@automerge/automerge-repo > cbor-x',
        '@automerge/automerge-repo > debug',
        '@automerge/automerge-repo > eventemitter3',
        '@automerge/automerge-repo > fast-sha256',
        '@automerge/automerge-repo > uuid',
        '@automerge/automerge-repo > xstate',
      ],
    },
    // Workers (search's page projection) load Automerge's WebAssembly
    // module like the app does, which needs ES module workers.
    worker: {
      format: 'es',
    },
    clearScreen: false,
    test: {
      environment: 'node',
      setupFiles: ['src/i18n/testSetup.ts'],
      include: ['src/**/*.test.ts'],
      // The heavy tests (Automerge documents, convergence simulations) take a
      // few seconds on an idle core and several times that next to other
      // processes. A timeout only has to catch a hang.
      testTimeout: 60_000,
      hookTimeout: 60_000,
      coverage: {
        reporter: ['text', 'html'],
      },
    },
  };
});
