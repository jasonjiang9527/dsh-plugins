// dsh-btw — host half (cordis function plugin).
//
// 浏览器半边（lib/client.js）负责交互；这里只做一件客户端做不到的事：
// **把一段历史从模型上下文里切掉**。
//
// 原理（dsh 原生 surface 机制，与 compaction 同一条路子）：
//   会话日志的「消息可见面」（surface）是派生模型历史的唯一来源
//   （`session.deriveMessages()` 按 surface 顺序折叠事件）。
//   surface 上的一条 replace 操作可以把 [startSeq, endSeq] 这段节点替换成
//   一条新节点 —— 被替换掉的节点从**模型可见面**消失，但仍然是日志里
//   的 append 事件，所以人看的 transcript 不受影响。
//   这正是 /compact 用的机制，区别只是我们不放摘要，只放一条 notice。
//
// 因此「新上下文」= 把 surface 上除系统提示（node 0）以外的全部节点，
// 替换成一条 plugin notice。此后模型只看到 [系统提示, notice, 之后的新消息]。
// 累积语义：再点一次就是拿当时的 surface 重做一遍，旧的 notice 也被替换掉。
//
// 规则来自 dsh-session 的 surface 校验（已逐条核对）：
//   - 只有 system/message | user/message | assistant/message | tool/result 能带 surfaceOp；
//   - replace 的 startSeq/endSeq 必须是**当前 surface 上已存在**的更早 seq，
//     start 不得早于 end，且必须覆盖全部被遮蔽节点（sourceEventSeqs ⊇ shadowed）；
//   - node 0 若是 system/message（系统提示）则受保护，只能被 system/message 单节点替换
//     → 所以本实现一律从 nodes[1] 开始；
//   - assistant/message 不能携带 sourceEventSeqs；tool/result 只能改 content
//     → 所以替换体用 user/message。
// 服务端 invariant 对 user/message 没有任何额外约束（可在回合外追加）。

import { randomUUID } from "node:crypto";

/** 插件显示名，用于诊断信息。 */
export const name = "dsh-btw";

/**
 * 硬依赖：commands（注册 /newcontext）+ sessions（取会话拿 surface）。
 * 两者都是宿主服务 key，不是包名。
 */
export const inject = ["commands", "sessions"];

/** 斜杠命令名（不带前导斜杠）。 */
export const COMMAND_NAME = "newcontext";

/** 替换节点的 provenance 标记：plugin 名。 */
const NOTICE_PLUGIN = "dsh-btw";

/** 折叠后显示在 transcript 上的一行摘要。 */
const NOTICE_SUMMARY = "新上下文：以上历史不再进入模型上下文";

/** 模型看到的那条 notice 正文。 */
const NOTICE_TEXT =
	"⧉ 新上下文从这里开始。\n" +
	"以上对话历史仍然保留在会话记录中（人可见），但已不再发送给模型；" +
	"请只依据本条之后的内容继续。";

/**
 * 构造替换节点：一条 plugin 来源的 user/message（notice 形态）。
 * 手工构造而不 import `createUserMessage`，是为了让宿主半边零运行时依赖
 * （插件的 node_modules 里没有 @deepseek-ai/*，从 link 安装的目录解析不到）。
 * 形状与 `@deepseek-ai/dsh-llm` 的 createUserMessage 一致，id 是裸字符串即可
 * （brand 只是编译期记号）。
 * @returns 可 JSON 序列化的 user 消息。
 */
export function buildNotice() {
	return {
		id: randomUUID(),
		role: "user",
		content: [{ type: "text", text: NOTICE_TEXT }],
		source: {
			kind: "plugin",
			plugin: NOTICE_PLUGIN,
			form: "notice",
			summary: NOTICE_SUMMARY,
		},
	};
}

/**
 * 把会话当前 surface 上除系统提示外的全部节点替换成一条 notice。
 *
 * 幂等性说明：连续调用是安全的 —— 第二次会连上一次的 notice 一起替换，
 * 结果仍然是「一条 notice + 系统提示」。
 *
 * @param session - 目标会话（`ctx.sessions.get(agent.id)`）。
 * @returns 命令结果：success 带被切掉的节点数与替换事件的 seq。
 */
export function cutContext(session) {
	const nodes = [...session.surface.nodes];
	if (nodes.length <= 1) {
		return { kind: "error", text: "当前会话还没有可切分的历史（只有系统提示）" };
	}
	const startSeq = nodes[1];
	const endSeq = nodes[nodes.length - 1];
	const shadowedSeqs = nodes.slice(1);
	const event = session.append("user/message", buildNotice(), {
		surfaceOp: { op: "replace", startSeq, endSeq },
		sourceEventSeqs: shadowedSeqs,
	});
	return {
		kind: "success",
		text: `已切分上下文：${shadowedSeqs.length} 个历史节点不再发送给模型（日志保留）`,
		sourceEventSeq: event.seq,
	};
}

/**
 * Plugin body: 注册 /newcontext 命令。
 * @param ctx - host context.
 */
export function apply(ctx) {
	ctx.effect(
		() =>
			ctx.commands.register({
				name: COMMAND_NAME,
				description: "从当前位置切分上下文：以上历史不再发送给模型（会话记录保留）",
				// 命令本身不需要把原始输入抄进日志，替换事件已经是被持久化的分割点。
				recordInput: false,
				handler: (invocation) => {
					const session = ctx.sessions.get(invocation.agent.id);
					if (session === undefined) return { kind: "error", text: "找不到当前会话" };
					try {
						return cutContext(session);
					} catch (error) {
						return {
							kind: "error",
							text: `切分失败：${error && error.message ? error.message : String(error)}`,
						};
					}
				},
			}),
		"dsh-btw: /newcontext command",
	);
}
