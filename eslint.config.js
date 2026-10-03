import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    '**/dist/**',
    '**/node_modules/**',
    '**/coverage/**',
    '.data/**',
    '.data-*/**',
    'test-results/**',
    'playwright-report/**',
  ]),

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Template literals with numbers are fine in messages; everything else must be converted deliberately.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      // Return-type generics are deliberate for query results and parsed JSON (`query<Row>(...)`).
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
      // `catch { ... }` and effect cleanups are used deliberately; the standard no-empty-function rule stays on.
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
    },
  },

  // Node: server, shared, scripts, e2e, configs
  {
    files: ['apps/server/**/*.ts', 'packages/shared/**/*.ts', 'scripts/**/*.ts', 'e2e/**/*.ts', '*.ts'],
    languageOptions: { globals: globals.node },
  },

  // Browser: the web app
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    extends: [jsxA11y.flatConfigs.recommended],
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      // Schemas must come from @enchanted/shared, which configures zod for the Content-Security-Policy
      // before building any (packages/shared/src/zod.ts).
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'zod',
              message: "Import z from '@enchanted/shared': it configures zod for the production CSP first.",
            },
          ],
        },
      ],
    },
  },

  // Tests: test doubles and fixtures legitimately poke at things production code must not
  {
    files: ['**/test/**/*.{ts,tsx}', 'e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-type-assertion': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  // Plain JavaScript (configs, small scripts): no type information
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
);
