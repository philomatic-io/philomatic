/**
 * The eslint FLOOR (OSS hardening M-S3) — deliberately minimal: hook correctness, a
 * file-length pressure valve, and (from C-S1) the comment-hygiene tripwire. Not a style
 * cop — formatting stays the editor's job; the floor exists so a stranger's PR can't
 * break hook rules or land a 900-line file unnoticed.
 */
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'ui/src/generated/**', '**/*.gen.ts', 'archived/**', 'browser/**'],
  },
  {
    files: ['src/**/*.ts', 'ui/src/**/*.ts', 'ui/src/**/*.tsx', 'test/**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    rules: {
      // Files under pressure announce themselves before they become the next 1,500-liner.
      'max-lines': ['warn', { max: 400, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ['ui/src/**/*.ts', 'ui/src/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
