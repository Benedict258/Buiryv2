import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-server/**',
      '**/.terraform/**',
      '**/node_modules/**',
      'coverage/**',
      'apps/dashboard/.next/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  // Storage may sign Seal sessions (A23) but must not open Sui network clients; its one Sui read is injected.
  {
    files: ['packages/storage/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: '@mysten/sui', message: 'Import only @mysten/sui/keypairs/ed25519 in packages/storage.' },
          ],
          patterns: [
            {
              group: [
                '@mysten/sui/client',
                '@mysten/sui/grpc',
                '@mysten/sui/jsonRpc',
                '@mysten/sui/graphql',
                '@grpc/*',
              ],
              message: 'Sui network access belongs in packages/chain; inject it into storage.',
            },
          ],
        },
      ],
    },
  },
  // Confinement: chain clients only in packages/chain tatum gateway; Walrus clients only in packages/storage.
  {
    files: ['packages/**/*.ts', 'scripts/**/*.ts'],
    ignores: [
      'packages/chain/src/tatum.ts',
      'packages/chain/src/tatum/**',
      'packages/chain/test/**',
      'packages/storage/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@grpc/*', '@mysten/*'],
              message: 'Chain/Walrus clients are confined to packages/chain/src/tatum* and packages/storage.',
            },
            { group: ['*memwal*'], message: 'Walrus Memory clients are confined to packages/storage.' },
          ],
        },
      ],
    },
  },
);
