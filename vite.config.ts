import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import packageJson from './package.json';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const commit = env.VERCEL_GIT_COMMIT_SHA || env.GITHUB_SHA || 'local';

  return {
    define: {
      __CANVINK_VERSION__: JSON.stringify(packageJson.version),
    },
    plugins: [
      react(),
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
    server: {
      port: 1420,
      strictPort: true,
    },
    clearScreen: false,
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts'],
      coverage: {
        reporter: ['text', 'html'],
      },
    },
  };
});
