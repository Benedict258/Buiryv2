import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'coverage/**', 'apps/dashboard/.next/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
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
