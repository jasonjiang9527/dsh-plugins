// formToOps diff 语义单测（不走 UI）：从 client.js 抽出纯函数执行。
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, "")), "..");
const src = fs.readFileSync(path.join(root, "lib/client.js"), "utf8");
// 截取 factory 体内的纯函数区（deepEqual 到 formToOps 结束），喂最小 stub 后 eval。
const start = src.indexOf("function deepEqual");
const end = src.indexOf("function PanelField");
if (start < 0 || end < 0) throw new Error("region not found");
const code = src.slice(start, end);

const sandbox = {
	PROTOCOLS: ["openai-completions", "openai-responses", "anthropic-messages"],
	THINKING_LEVELS: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
	CACHE_RETENTIONS: ["none", "short", "long"],
	TRANSPORTS: ["auto", "sse", "websocket", "websocket-cached"],
	BUDGET_KEYS: ["minimal", "low", "medium", "high"],
	MODALITIES: ["text", "image"],
	COMPAT_SWITCHES: [
		"supportsTemperature",
		"forceAdaptiveThinking",
		"allowEmptySignature",
		"supportsStrictTools",
		"requiresThinkingAsText",
		"supportsCacheControlOnTools",
	],
	console,
};
vm.createContext(sandbox);
vm.runInContext(code + "\nglobalThis.__f = { deepEqual, formToOps, toForm, profileOf };", sandbox);
const { formToOps, toForm, profileOf } = sandbox.__f;

let failed = 0;
const eq = (label, actual, expected) => {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	if (a === b) console.log(`OK   ${label}`);
	else {
		failed++;
		console.error(`FAIL ${label}\n  got:      ${a}\n  expected: ${b}`);
	}
};
const P = ["providers", "acme"];

// 1. 全空表单 vs 空 profile → 零 op
{
	const form = toForm({});
	const r = formToOps(form, P, {});
	eq("empty form + empty profile => no ops", r, { ops: [], invalid: [] });
}

// 2. 设置一个数字字段 → 单 set op
{
	const form = toForm({});
	form.timeoutMs = "30000";
	const r = formToOps(form, P, {});
	eq("timeoutMs set", r.ops, [{ op: "set", path: [...P, "timeoutMs"], value: 30000 }]);
	eq("timeoutMs valid", r.invalid, []);
}

// 3. 相同值 → 零 op（不把 base 值钉进 user 层）
{
	const profile = { timeoutMs: 30000 };
	const form = toForm(profile);
	const r = formToOps(form, P, profile);
	eq("unchanged value => no op", r.ops, []);
}

// 4. 清空已设值 → unset
{
	const profile = { timeoutMs: 30000 };
	const form = toForm(profile);
	form.timeoutMs = "";
	const r = formToOps(form, P, profile);
	eq("cleared value => unset", r.ops, [{ op: "unset", path: [...P, "timeoutMs"] }]);
}

// 5. 非法数字 → invalid
{
	const form = toForm({});
	form.streamIdleTimeoutMs = "-5";
	const r = formToOps(form, P, {});
	eq("negative streamIdle => invalid", r.invalid, ["streamIdleTimeoutMs"]);
	eq("negative streamIdle => no ops", r.ops, []);
}

// 6. headers 解析 + 覆盖
{
	const form = toForm({});
	form.headerLines = ["X-A: 1", "X-B: 2"];
	const r = formToOps(form, P, {});
	eq("headers set", r.ops, [{ op: "set", path: [...P, "headers"], value: { "X-A": "1", "X-B": "2" } }]);
}

// 7. retryPolicy normal 完整形状
{
	const form = toForm({});
	form.retryMaxRetries = "3";
	form.retryInitial = "500";
	const r = formToOps(form, P, {});
	eq(
		"retry normal",
		r.ops,
		[{ op: "set", path: [...P, "retryPolicy"], value: { mode: "normal", maxRetries: 3, backoff: { initialDelayMs: 500 } } }],
	);
}

// 8. thinkingBudgets 部分键
{
	const form = toForm({});
	form.budgets.low = "1024";
	const r = formToOps(form, P, {});
	eq(
		"budgets partial",
		r.ops,
		[{ op: "set", path: [...P, "thinkingBudgets"], value: { low: 1024 } }],
	);
}

// 9. modelOverrides 行：只勾 compat
{
	const form = toForm({});
	form.overrideRows = [
		{ id: "gpt-x", name: "", contextWindow: "", maxTokens: "", input: [], reasoningMode: "", reasoningLines: [], switches: ["supportsTemperature", "forceAdaptiveThinking"] },
	];
	const r = formToOps(form, P, {});
	eq(
		"modelOverrides compat only",
		r.ops,
		[{ op: "set", path: [...P, "modelOverrides"], value: { "gpt-x": { compat: { supportsTemperature: true, forceAdaptiveThinking: true } } } }],
	);
}

// 9b. 模型级全字段：name / 容量 / 输入类型
{
	const form = toForm({});
	form.overrideRows = [
		{ id: "vision-x", name: "Vision X", contextWindow: "131072", maxTokens: "8192", input: ["text", "image"], reasoningMode: "", reasoningLines: [], switches: [] },
	];
	const r = formToOps(form, P, {});
	eq("modelOverrides fields", r.invalid, []);
	eq(
		"modelOverrides fields written",
		r.ops,
		[{ op: "set", path: [...P, "modelOverrides"], value: { "vision-x": { name: "Vision X", contextWindow: 131072, maxTokens: 8192, input: ["text", "image"] } } }],
	);
}

// 9c. 输入类型都不勾 = 不声明（不写空数组，因为空数组等同于继承）
{
	const form = toForm({});
	form.overrideRows = [
		{ id: "m", name: "", contextWindow: "", maxTokens: "", input: [], reasoningMode: "", reasoningLines: [], switches: ["supportsStrictTools"] },
	];
	const r = formToOps(form, P, {});
	eq(
		"empty input => omitted",
		r.ops,
		[{ op: "set", path: [...P, "modelOverrides"], value: { m: { compat: { supportsStrictTools: true } } } }],
	);
}

// 9d. reasoningEfforts：false 与自定义等级映射（wire 留空 = null）
{
	const form = toForm({});
	form.overrideRows = [
		{ id: "a", name: "", contextWindow: "", maxTokens: "", input: [], reasoningMode: "false", reasoningLines: [], switches: [] },
		{ id: "b", name: "", contextWindow: "", maxTokens: "", input: [], reasoningMode: "custom", reasoningLines: ["low: low", "high: high", "off:"], switches: [] },
	];
	const r = formToOps(form, P, {});
	eq(
		"reasoningEfforts false + custom",
		r.ops,
		[
			{
				op: "set",
				path: [...P, "modelOverrides"],
				value: { a: { reasoningEfforts: false }, b: { reasoningEfforts: { low: "low", high: "high", off: null } } },
			},
		],
	);
}

// 9e. 非法等级 → invalid，且整条 modelOverrides 不写
{
	const form = toForm({});
	form.overrideRows = [
		{ id: "b", name: "", contextWindow: "", maxTokens: "", input: [], reasoningMode: "custom", reasoningLines: ["bogus: x"], switches: [] },
	];
	const r = formToOps(form, P, {});
	eq("bogus reasoning level invalid", r.invalid, ["modelOverrides.b.reasoningEfforts"]);
	eq("bogus reasoning level => no ops", r.ops, []);
}

// 9f. 空行（只有 id）= 什么都没配 → invalid
{
	const form = toForm({});
	form.overrideRows = [{ id: "m", name: "", contextWindow: "", maxTokens: "", input: [], reasoningMode: "", reasoningLines: [], switches: [] }];
	const r = formToOps(form, P, {});
	eq("empty override row invalid", r.invalid, ["modelOverrides.m"]);
}

// 9g. route 级 defaultInput
{
	const form = toForm({});
	form.defaultInput = ["text", "image"];
	const r = formToOps(form, P, {});
	eq("defaultInput set", r.ops, [{ op: "set", path: [...P, "defaultInput"], value: ["text", "image"] }]);
}

// 9h. 回环：toForm 读出的模型级配置原样写回 → 零 op（不把 base 值钉进 user 层）
{
	const profile = {
		defaultInput: ["text", "image"],
		modelOverrides: {
			m: {
				name: "M",
				contextWindow: 4096,
				maxTokens: 1024,
				input: ["image"],
				reasoningEfforts: { low: "low", off: null },
				compat: { supportsStrictTools: true },
			},
		},
	};
	const form = toForm(profile);
	const r = formToOps(form, P, profile);
	eq("model override round-trip => no ops", r.ops, []);
}

// 10. 枚举非法
{
	const form = toForm({});
	form.transport = "bogus";
	const r = formToOps(form, P, {});
	eq("bogus transport invalid", r.invalid, ["transport"]);
}

process.exit(failed > 0 ? 1 : 0);
