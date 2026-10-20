/**
 * 远端地址配置
 * ------------------------------------------------------------
 * 全项目**唯一**的地址来源 —— 换域名只改这一个文件。
 *
 * 之前 App.jsx 与 Me.jsx 各写了一份同样的地址常量，
 * 靠注释提醒「改域名时两处都要改」。那种约定迟早会漏，
 * 现在收敛到这里，两处都从这里 import。
 *
 * ⚠️ 三个地址各管一摊，别混：
 *   HOT_UPDATE_MANIFEST —— 热更新清单（界面版本）
 *   REMOTE_VERSION_URL  —— 安装包清单（原生 build）
 *   STATS_URL           —— 统计上报（SCF 云函数）
 */

/* 腾讯云 COS 桶（更新分发用）。
   桶里只放「分发给用户的东西」：前端资源包、APK、两个清单。
   用户数据不在这里 —— 它们从生成到存储全程在手机上。 */
const UPDATE_BASE =
  ''

/* ⚠️ 热更新临时关闭：「热更新暂缓，先做好本地」。
   置空后 checkHotUpdate / checkRemoteVersion 都会直接 early-return，
   App 启动与「检查更新」都不再去拉 COS 上的旧包（bundle-1.0.50），
   避免它覆盖本地新构建。恢复热更新时把下面两行改回
   UPDATE_BASE + '/latest.json' 与 UPDATE_BASE + '/version.json' 即可。 */
export const HOT_UPDATE_MANIFEST = ''

export const REMOTE_VERSION_URL = ''

/* 统计上报地址（腾讯云 SCF 函数 URL）。
   ⚠️ 域名是 tencentscf.com（scf，不是 csf）—— 抄错一个字母 DNS 就解析不到。
   函数 URL 只能在控制台建（API 网关已停售、无开放 API），换函数时手点一次。
   ⚠️ 换这个地址后，capacitor.config.json 里的 statsUrl 不用动 ——
      它是空串（= 插件默认关闭），真正的地址由 enableStats() 在运行时设。 */
export const STATS_URL = ''
