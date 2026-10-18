/**
 * PostCSS 配置
 * ------------------------------------------------------------
 * 注册 tailwindcss + autoprefixer 插件。
 * 缺少本文件时 PostCSS 不加载 tailwindcss，app.css 的 @tailwind 指令
 * 不被展开 → 所有 Tailwind class 失效。
 */
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
