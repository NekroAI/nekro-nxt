import { workspaceBoundariesRule } from './scripts/lib/eslint-workspace-boundaries.mjs'
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/.local/**',
      'assets/**',
      'coverage/**',
      'data/**',
      'apps/*/data/**',
      '**/dist/**',
      '**/release/**',
      'apps/*/lib/**',
      'packages/*/lib/**',
      'node_modules/**',
      'prototype/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ['**/*.ts', '**/*.tsx'],
  })),
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.lint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { workspace: { rules: { boundaries: workspaceBoundariesRule } } },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'workspace/boundaries': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unsafe-type-assertion': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },
  {
    // Plain-HTTP LAN access is not a secure context, so `crypto.randomUUID` is missing there; use `randomId()`.
    files: ['apps/web/src/**/*.ts', 'apps/web/src/**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='randomUUID']",
          message: 'crypto.randomUUID 只在 HTTPS 或 localhost 下存在，请改用 apps/web/src/random-id.ts 的 randomId()。',
        },
      ],
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      globals: {
        URL: 'readonly',
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
)
