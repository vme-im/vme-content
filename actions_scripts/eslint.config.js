// @ts-check
// actions_scripts 的 ESLint（扁平配置，ESM）。
// 仅覆盖 src 下的 TS 脚本；故意精简：脚本包大量使用 any，
// 若开为 error 会淹没既有代码（createData/moderationLogic 等），
// 故 no-explicit-any 关闭、未用变量降为 warn —— lint 作为有用门而非历史噪音墙。
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'eslint.config.js',
      'rollup.config.js',
      'jest.config.js',
      'babel.config.*',
      '**/*.config.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
)
