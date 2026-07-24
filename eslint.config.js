// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // chat/ is a fully separate Next.js app (own package.json, own node_modules,
  // own .eslintrc.json) — it lints itself via `npm run lint` inside chat/, not
  // via this root flat config.
  { ignores: ['node_modules', 'dist', '.wrangler', 'coverage', 'chat'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Plain-JS Node launcher: give it Node globals so no-undef doesn't fire.
    files: ['bin/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', URL: 'readonly', console: 'readonly' },
    },
  },
  {
    // Guardrail §6.9: no Node-only APIs in Worker/DO code
    files: ['src/worker/**/*.ts', 'src/do/**/*.ts', 'src/adapters/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*'],
              message: 'Node-only APIs are banned in Worker core (BUILD_PLAN §6.9)',
            },
            {
              group: ['fs', 'path', 'os', 'net', 'child_process', 'crypto'],
              message: 'Node-only APIs are banned in Worker core (BUILD_PLAN §6.9)',
            },
          ],
        },
      ],
      'no-restricted-globals': ['error', 'process', 'require', '__dirname', 'Buffer'],
    },
  },
);
