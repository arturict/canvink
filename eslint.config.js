import eslint from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-viewer/**',
      'functions/*/dist/**',
      'functions/*/dist-test/**',
      'node_modules/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'src-tauri/target/**',
      // Wrangler's local dev/build scratch space (e.g. `services/*/.wrangler/tmp`)
      // holds generated, unlinted bundler output, not source we own.
      '**/.wrangler/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'inline-type-imports',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Native browser dialogs are banned in the app: they block the page, look
    // foreign next to OneNote's UI and cannot be tested or styled. Scripts and
    // tests sit outside `src` and may still stub them.
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-alert': 'error',
      'no-restricted-properties': ['error',
        ...['prompt', 'confirm', 'alert'].flatMap((name) => ['window', 'globalThis', 'self'].map((object) => ({
          object,
          property: name,
          message: `Native ${name}() dialogs are not allowed. Rename in place with InlineRename (src/ui/InlineRename.tsx) and ask for confirmation with ConfirmDialog / useConfirm (src/ui/ConfirmDialog.tsx).`,
        }))),
      ],
    },
  },
  {
    // P10 (services/collab-sync/PERSONAL-SYNC.md §0 decision log): only
    // `src/personal-space/**` may write the local workspace from a network
    // trigger (`WorkspaceV2Runtime.commitWorkspaceGraphRevision` /
    // `.extendActiveWorkspace`). A shared/collab session must only forward
    // diffs into DocHandles it already holds (`handle.update(...)`),
    // never open a new topology transaction.
    //
    // `commitWorkspaceGraphRevision`/`extendActiveWorkspace` are instance
    // methods, not free functions, so they cannot be named directly in
    // `no-restricted-imports`. The primary, always-enforced guard is the
    // `no-restricted-syntax` call-site check below; `no-restricted-imports`
    // additionally blocks importing the request type a caller would need to
    // build such a call in the first place.
    files: ['src/collab/**/*.{ts,tsx}', 'src/components/collab/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          {
            name: '../../storage/workspaceV2Runtime',
            importNames: ['WorkspaceGraphRevisionRequest', 'ExtendActiveWorkspaceRequest'],
            message: 'P10: only src/personal-space/** may construct a workspace-graph-revision '
              + 'request (a network-triggered local workspace write). A shared/collab session '
              + 'must forward diffs into existing DocHandles only.',
          },
          {
            name: '../storage/workspaceV2Runtime',
            importNames: ['WorkspaceGraphRevisionRequest', 'ExtendActiveWorkspaceRequest'],
            message: 'P10: only src/personal-space/** may construct a workspace-graph-revision '
              + 'request (a network-triggered local workspace write). A shared/collab session '
              + 'must forward diffs into existing DocHandles only.',
          },
        ],
      }],
      'no-restricted-syntax': ['error',
        {
          selector: "CallExpression[callee.property.name='commitWorkspaceGraphRevision']",
          message: 'P10: commitWorkspaceGraphRevision may only be called from src/personal-space/**.',
        },
        {
          selector: "CallExpression[callee.property.name='extendActiveWorkspace']",
          message: 'P10: extendActiveWorkspace may only be called from src/personal-space/**.',
        },
      ],
    },
  },
  {
    // P13 (services/collab-sync/PERSONAL-SYNC.md §0 decision log) amends P10 for exactly one
    // file: opening a share link adds the shared notebook to the workspace, and a page a
    // collaborator adds is adopted into it. Both are topology transactions with the documents'
    // history intact, kept in this module so the rest of `src/collab/**` stays read-only.
    files: ['src/components/collab/adoptSharedDocuments.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
    },
  },
);
