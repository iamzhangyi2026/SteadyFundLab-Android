// ESLint 扁平配置（ESLint 9+）
// 定位：**宽松起步** —— 先挡住真问题（未定义变量、重复键、不可达代码等），
// 不追求风格统一（不做格式化职责，格式化交给编辑器）。
// TS 文件的类型正确性由 `npx tsc --noEmit` 负责（见 tsconfig.json），此处不重复检查。

import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'

export default [
  {
    ignores: [
      'dist/**',
      'android/**',
      'node_modules/**',
      'public/**',
      'verify/**',
      'tools/**',
      'scripts/**',
      '*.config.js',
      'vite.config.js.timestamp-*',
      // TS 文件不在 ESLint 覆盖范围：类型与未用变量由 `npx tsc --noEmit` 负责
      //（当前 typescript-eslint 尚不支持项目使用的 TS 7.x，强行接入会整体报错）
      '**/*.ts',
      '**/*.tsx',
    ],
  },

  js.configs.recommended,

  {
    files: ['**/*.{js,jsx,mjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        // Capacitor 注入的全局对象（dataAdapter 启动自检日志使用）
        Capacitor: 'readonly',
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { react },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      ...react.configs.recommended.rules,

      // 项目用 React 17+ 自动 JSX runtime，不需要显式引入 React
      'react/react-in-jsx-scope': 'off',
      // 纯前端 JS 项目，未引入 prop-types（类型交给 TS / 运行时）
      'react/prop-types': 'off',
      // 允许 <div onClick> 这类非交互元素带事件（本项目大量使用，WebView 内可控）
      'react/no-unknown-property': 'off',

      // 宽松：未使用变量只警告，且 `_` 前缀视为有意忽略
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // 宽松：空 catch 块允许（本项目大量「单只失败即跳过」的容错写法）
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // 宽松：允许 console（诊断信息走内部诊断，不显示用户）
      'no-console': 'off',
      // 中文排版用全角空格（\u3000）做视觉分隔，属项目约定 → 不按「不规则空格」报错
      'no-irregular-whitespace': ['error', {
        skipStrings: true, skipTemplates: true, skipJSXText: true, skipComments: true,
      }],
      // 该规则对「初始值随后在 try/catch 内被覆盖」的场景误报较多 → 降为提示
      'no-useless-assignment': 'warn',
    },
  },

]
