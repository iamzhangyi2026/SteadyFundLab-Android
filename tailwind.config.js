import animate from 'tailwindcss-animate'

/**
 * Tailwind CSS 配置
 * ------------------------------------------------------------
 * content：扫描所有可能写 class 的文件（vite root = 项目根目录）。
 * 需配合 postcss.config.js 注册 tailwindcss 插件，否则 app.css 的
 * @tailwind 指令不被展开 → Tailwind class 全部失效。
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,jsx,ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // 对齐 tokens.css 设计令牌，方便在 class 里直接用（如 text-ink）
        ink: '#0F1923',
        muted: '#5B6675',
        subtle: '#A8B0BF',
        line: '#E5E9F0',
        brand: '#2B7BCF',
        canvas: '#F5F7FA',
      },
    },
  },
  plugins: [animate],
}
