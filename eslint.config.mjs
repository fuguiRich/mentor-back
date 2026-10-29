// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // 软删除表上 findUnique 是数据泄漏入口：它只接受唯一键条件，
      // 塞不进 deletedAt: null，已删除的行会从这里漏出来。
      // 所有读一律 findFirst（或带 where 的 findMany）。
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='findUnique']",
          message:
            '软删除表禁止使用 findUnique：它只接受唯一键条件，无法追加 deletedAt 过滤，已删除的数据会从这里漏出来。请改用 findFirst。',
        },
        {
          selector: "MemberExpression[property.name='findUniqueOrThrow']",
          message:
            '软删除表禁止使用 findUniqueOrThrow：它只接受唯一键条件，无法追加 deletedAt 过滤，已删除的数据会从这里漏出来。请改用 findFirstOrThrow。',
        },
      ],
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },
);
