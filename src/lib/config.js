/**
 * 远端地址配置
 * ------------------------------------------------------------
 * 全项目**唯一**的地址来源 —— 换域名只改这一个文件。
 *
 * 三个地址各管一摊，别混：
 *   HOT_UPDATE_MANIFEST —— 热更新清单（界面版本）
 *   REMOTE_VERSION_URL  —— 安装包清单（原生 build）
 *   STATS_URL           —— 统计上报（SCF 云函数）
 *
 * 三项默认均为空 = 对应能力关闭：App 启动与「检查更新」不发起任何远端请求。
 * 接入自己的服务时，把对应地址填成完整 URL 即可（需自备分发端点）。
 */

/* 热更新清单（界面版本包 manifest）。置空 = 关闭热更新检查。 */
export const HOT_UPDATE_MANIFEST = ''

/* 安装包清单（远端 version.json）。置空 = 关闭安装包更新检查。 */
export const REMOTE_VERSION_URL = ''

/* 统计上报地址（Serverless 函数 URL）。置空 = 不上报任何数据。
   仅在用户同意隐私政策后才会启用，见 src/lib/consent.js。 */
export const STATS_URL = ''
