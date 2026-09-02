// dsh-drill — host half (cordis function plugin).
// 命名导出契约：name / apply（Config 留待 M2，见 design/03 §6.4）。
// MVP 刻意保持空实现：全部能力在浏览器半边 lib/client.js，
// 服务端 apply 抛错会 fail loud 终止进程，因此这里不做任何可能抛错的初始化。

/** 插件显示名，用于诊断信息。 */
export const name = "dsh-drill";

/**
 * Plugin body. No host services are required for the MVP client-only feature
 * set; M2 may register drill-index / unarchive routes here once the host
 * supports them.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 */
export function apply(ctx) {
	// no-op by design (see header comment).
}
