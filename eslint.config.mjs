import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Only the bot lives in src/. Everything else is a read-only reference
    // checkout, a legacy bot, or an unrelated sub-project — don't lint them.
    ignores: [
      'dist/**',
      'node_modules/**',
      'unciv_reference/**',
      'unciv_server_implementation/**',
      'legacy_bot_2/**',
      'legacy_notification_bot/**',
      'docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Dedicated tsconfig that includes test files (the build tsconfig
        // excludes them), so type-checked rules cover the whole src tree.
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
