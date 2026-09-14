// dsh-btw — 「新上下文」surface 替换契约测试。
//
// 直接 import 部署里真实的 @deepseek-ai/dsh-session，用它的 canonical
// surface fold 校验 lib/index.js 追加的那条 replace 事件是否合法。
// 这是纯函数测试：不建会话、不写日志、不碰运行中的 dsh。
//
// Run: node scripts/check-newcontext.mjs
//
// 包位置解析顺序：$DSH_SESSION_PKG → node 可执行文件旁的全局安装（nvm-windows 与标准
// Windows 安装都是这个布局）→ %APPDATA%\npm 全局 → $DSH_HOME/profiles/* → 报错提示。
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const REL = "node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session";
const REL_DIRECT = "node_modules/@deepseek-ai/dsh-session";

/** 每个 dsh profile 的 node_modules（插件常装在这里）。 */
function profileCandidates() {
	const home = process.env.DSH_HOME ?? ((process.env.USERPROFILE ?? process.env.HOME) ? join(process.env.USERPROFILE ?? process.env.HOME, ".dsh") : undefined);
	if (home === undefined || !existsSync(join(home, "profiles"))) return [];
	try {
		return readdirSync(join(home, "profiles")).flatMap((name) => [
			join(home, "profiles", name, REL),
			join(home, "profiles", name, REL_DIRECT),
		]);
	} catch {
		return [];
	}
}

/** 候选的 dsh-session 包目录。 */
const CANDIDATES = [
	process.env.DSH_SESSION_PKG,
	join(dirname(process.execPath), REL),
	join(dirname(process.execPath), REL_DIRECT),
	process.env.APPDATA === undefined ? undefined : join(process.env.APPDATA, "npm", REL),
	process.env.APPDATA === undefined ? undefined : join(process.env.APPDATA, "npm", REL_DIRECT),
	...profileCandidates(),
].filter((value) => typeof value === "string" && value !== "");

const found = CANDIDATES.find((dir) => existsSync(join(dir, "lib/index.js")));
if (found === undefined) {
	console.error("FAIL 找不到 @deepseek-ai/dsh-session；用 DSH_SESSION_PKG=<包目录> 指定");
	process.exit(1);
}

const session = await import(pathToFileURL(join(found, "lib/index.js")).href);
if (typeof session.foldSurface !== "function") {
	console.error(`FAIL ${found}/lib/index.js 没有导出 foldSurface（导出：${Object.keys(session).join(", ")}）`);
	process.exit(1);
}
const { foldSurface } = session;

let failed = false;
const ok = (label) => console.log(`OK   ${label}`);
const bad = (label, detail) => {
	failed = true;
	console.error(`FAIL ${label}${detail === undefined ? "" : `: ${detail}`}`);
};

/** 造一条最简 surface 事件（fold 只看 type/seq/surfaceOp/sourceEventSeqs）。 */
const ev = (seq, type, surfaceOp, sourceEventSeqs) => ({
	type,
	seq,
	time: 0,
	data: {},
	...(surfaceOp === undefined ? {} : { surfaceOp }),
	...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
});

// 会话原貌：系统提示 + 三轮对话。
const base = [
	ev(0, "system/message", "append"),
	ev(1, "user/message", "append"),
	ev(2, "assistant/message", "append"),
	ev(3, "user/message", "append"),
];

const before = foldSurface(base);
JSON.stringify(before.nodes) === JSON.stringify([0, 1, 2, 3])
	? ok("基线 surface = [0,1,2,3]")
	: bad("基线 surface", JSON.stringify(before.nodes));

/** lib/index.js cutContext 追加的那条事件（同形状）。 */
const replacement = ev(4, "user/message", { op: "replace", startSeq: 1, endSeq: 3 }, [1, 2, 3]);

const after = foldSurface([...base, replacement]);
JSON.stringify(after.nodes) === JSON.stringify([0, 4])
	? ok("切分后 surface = [0, 4]（系统提示保留，历史节点全部被遮蔽）")
	: bad("切分后 surface", JSON.stringify(after.nodes));

after.replacements.length === 1 && after.replacements[0].shadowedSeqs.join(",") === "1,2,3"
	? ok("replace 记录覆盖全部被遮蔽节点")
	: bad("replace 记录", JSON.stringify(after.replacements));

/** 累积语义：切分后又有了新对话，再切一次 —— 连上一条 notice 与新对话一起替换。
 *  注意 startSeq 取的是**当时**表面的 nodes[1]（第一次切分后它就是那条 notice 的 seq），
 *  而不是最初的 1：被遮蔽过的 seq 已经不在表面上了，不能再引用。 */
const further = [ev(5, "user/message", "append"), ev(6, "assistant/message", "append")];
const mid = foldSurface([...base, replacement, ...further]);
JSON.stringify(mid.nodes) === JSON.stringify([0, 4, 5, 6])
	? ok("切分后新对话正常追加 surface = [0,4,5,6]")
	: bad("切分后新对话 surface", JSON.stringify(mid.nodes));

const second = ev(7, "user/message", { op: "replace", startSeq: 4, endSeq: 6 }, [4, 5, 6]);
const twice = foldSurface([...base, replacement, ...further, second]);
JSON.stringify(twice.nodes) === JSON.stringify([0, 7])
	? ok("累积切分 surface = [0, 7]")
	: bad("累积切分 surface", JSON.stringify(twice.nodes));

// 陷阱：切分后若仍沿用第一次的旧 seq 作为 startSeq，必须被拒 ——
// 这保证 lib/index.js 的 cutContext 每次都重新读 session.surface.nodes。
// （反向用例见下方 mustThrow 段。）

/** 反向用例：这些形状必须被真实校验拒绝。 */
const mustThrow = (label, events, needle) => {
	try {
		foldSurface(events);
		bad(label, "没有被拒绝");
	} catch (error) {
		const message = error && error.message ? error.message : String(error);
		if (message.includes(needle)) ok(`${label} → 被拒绝（${needle}）`);
		else bad(label, `拒绝原因不符：${message}`);
	}
};

// 覆盖 node 0（系统提示）必须被拒 —— 这正是本实现从 nodes[1] 开始的原因。
mustThrow(
	"覆盖系统提示节点",
	[...base, ev(4, "user/message", { op: "replace", startSeq: 0, endSeq: 3 }, [0, 1, 2, 3])],
	"holds the system prompt",
);
// sourceEventSeqs 漏掉被遮蔽节点。
mustThrow(
	"sourceEventSeqs 漏节点",
	[...base, ev(4, "user/message", { op: "replace", startSeq: 1, endSeq: 3 }, [1, 3])],
	"must include every shadowed surface node",
);
// startSeq 指到未来/自身（seq 9 >= 事件 seq 4）。
mustThrow(
	"startSeq 指到未来 seq",
	[...base, ev(4, "user/message", { op: "replace", startSeq: 9, endSeq: 3 }, [9, 1, 2, 3])],
	"must reference earlier events",
);
// 引用未来事件。
mustThrow(
	"sourceEventSeqs 引用未来 seq",
	[...base, ev(4, "user/message", { op: "replace", startSeq: 1, endSeq: 3 }, [1, 2, 3, 4])],
	"must reference earlier events",
);
// 累积切分沿用被遮蔽的旧 seq（上一条陷阱）。
mustThrow(
	"累积切分沿用被遮蔽的旧 seq",
	[...base, replacement, ...further, ev(7, "user/message", { op: "replace", startSeq: 1, endSeq: 6 }, [1, 4, 5, 6])],
	"not found in surface",
);

// 宿主半边自身的静态断言：命令名与注入面。
const host = await import(pathToFileURL(new URL("../lib/index.js", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, "")).href);
host.name === "dsh-btw" && typeof host.apply === "function"
	? ok("lib/index.js 导出 name/apply")
	: bad("lib/index.js 导出");
JSON.stringify(host.inject) === JSON.stringify(["commands", "sessions"])
	? ok("注入 commands + sessions（服务 key）")
	: bad("inject", JSON.stringify(host.inject));
host.COMMAND_NAME === "newcontext" ? ok("命令名 newcontext") : bad("命令名", host.COMMAND_NAME);

const notice = host.buildNotice();
notice.role === "user" && Array.isArray(notice.content) && notice.content[0]?.type === "text"
	? ok("notice 消息形状")
	: bad("notice 消息形状", JSON.stringify(notice));
notice.source.kind === "plugin" && notice.source.plugin === "dsh-btw" && notice.source.form === "notice"
	? ok("notice provenance（plugin/dsh-btw/notice）")
	: bad("notice provenance", JSON.stringify(notice.source));
JSON.parse(JSON.stringify(notice)).id === notice.id
	? ok("notice 可无损 JSON 序列化")
	: bad("notice 序列化");

process.exit(failed ? 1 : 0);
