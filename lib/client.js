/* global window, document */
// dsh-btw — browser half (handwritten CJS factory for the dsh web ModuleLoader).
//
// 功能一：会话选中钻取（design/02）
//   1. 划选会话消息区文本 → 浮层 [引用提问] [btw] [×]
//   2. 引用提问：引用块+来源头 预填当前会话输入框草稿（不发送）
//   3. btw：sessions.fork(选中节点 anchorSeq) → 自动切换到一次性临时会话并预填
//      引用块；离开该会话时自动 workspaces.archiveSession（running 顺延，可关）
//
// 功能二：Provider 高级配置面板（settings.models.provider-card 槽位）
//   Models 设置页只可视化基础字段；本面板把 llm-pi-ai profile 的全部高级字段
//   （超时/传输/缓存/推理/headers/兼容开关/retryPolicy…）可视化：
//     读取  ctx.remote.settings.describe("llm-pi-ai") → { namespaces:[{ value, revision, writable }] }
//     写入  ctx.remote.settings.mutate("llm-pi-ai", ops, revision)
//           → 服务端 schemastery + assertServiceable 校验；冲突回 settings/conflict
//     diff  只对相对当前 profile 有变化的字段生成 op（空 = unset = 回退目录默认）
//   不碰凭据（官方 credentials seam 的职责）与 models 列表（官方编辑器已覆盖）。
//
// 只走公开面：
//   - slots：shell.overlay + conversation.session.header.utilities + settings.models.provider-card
//   - sessions standard kit / ctx.sessions / ctx.workspaces
//   - @deepseek-ai/dsh-api-remotes 注入的 ctx.remote.settings
//   - DOM 锚点：data-conversation-scroll / data-chat-anchor-key
//
// hooks 纪律：任何 hook 都不条件调用。useInput 由内层 InputDraftTap 无条件调用。
window.__ModuleLoader__.load({
	id: "dsh-btw",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const { useState, useEffect, useRef, useCallback, useMemo } = React;

		//#region constants & dictionaries
		const NS = "btw";
		const SETTINGS_NS = "llm-pi-ai";
		/** 会话消息滚动容器（ui-conversation ChatView scrollerOf 同款判定）。 */
		const SEL_SCROLLER = "[data-conversation-scroll]";
		/** 每个聊天节点行的稳定锚（ChatNodeSeat 输出）。 */
		const SEL_NODE_ROW = "[data-chat-anchor-key]";
		/** 不触发浮层的区域：输入区镜像/座位 + 本插件浮层自身。 */
		const SEL_EXCLUDE =
			"[data-input-mirror],[data-composer-seat],[data-dsh-btw-toolbar]";

		const LS_AUTO_ARCHIVE = "dsh-btw:autoArchive";
		const LS_TRUNCATE = "dsh-btw:truncateChars";
		const LS_BTWS = "dsh-btw:activeBtws";
		const DEFAULT_TRUNCATE = 2000;
		const MIN_SELECT_CHARS = 2;
		const PENDING_SEED_TTL_MS = 120000;

		const DICT = {
			zh: {
				"quote.label": "引用提问",
				"btw.label": "btw",
				"close.label": "关闭",
				"quote.head": '> 🔖 引用自「{title}」· {time}',
				"btw.head": '> 🔖 btw（fork 自「{title}」）',
				"toast.archived": "btw 会话已归档（不可逆）",
				"toast.archiveFailed": "btw 会话归档失败",
				"toast.quoteUnavailable": "当前会话输入框不可用",
				"toast.quoteFailed": "引用写入失败",
				"btw.failed": "btw 失败",
				"btw.runningTail": "选区位于进行中的回合，暂不能从这里 btw",
				"btw.titlePrefix": "btw",
				// —— 高级配置面板 ——
				"panel.title": "高级配置（dsh-btw）",
				"panel.notWritable": "当前部署设置文档只读，无法编辑",
				"panel.notConfigured": "该 provider 尚未在 Models 页完成配置",
				"panel.loadFailed": "读取配置失败",
				"panel.conflict": "配置已被别处修改，请收起后重新展开再编辑",
				"panel.saved": "已保存",
				"panel.saveFailed": "保存失败",
				"panel.saving": "保存中…",
				"panel.save": "保存高级字段",
				"panel.reset": "放弃修改",
				"panel.endpoint": "端点与协议",
				"panel.baseURL": "Base URL",
				"panel.baseURL.ph": "留空 = 目录默认",
				"panel.api": "wire 协议",
				"panel.api.ph": "留空 = 目录默认",
				"panel.display": "显示名",
				"panel.timeouts": "超时",
				"panel.timeoutMs": "请求超时 (ms)",
				"panel.streamIdle": "流空闲超时 (ms)",
				"panel.wsConnect": "WS 连接超时 (ms)",
				"panel.stream": "传输与缓存",
				"panel.transport": "transport",
				"panel.cacheRetention": "cacheRetention",
				"panel.reasoning": "reasoning（思考等级）",
				"panel.budgets": "thinkingBudgets（token 预算）",
				"panel.capacity": "容量兜底",
				"panel.defaultContextWindow": "defaultContextWindow",
				"panel.defaultMaxTokens": "defaultMaxTokens",
				"panel.headers": "headers（每行 Name: Value）",
				"panel.headers.ph": "X-Custom-Header: value",
				"panel.compat": "模型兼容性开关（modelOverrides.*.compat）",
				"panel.compat.modelId": "添加一行后填模型 id，勾选需要的开关",
				"panel.compat.add": "添加模型",
				"panel.compat.remove": "移除",
				"panel.retry": "retryPolicy",
				"panel.retry.mode": "mode",
				"panel.retry.maxRetries": "maxRetries",
				"panel.retry.initial": "backoff.initialDelayMs",
				"panel.retry.max": "backoff.maxDelayMs",
				"panel.retry.jitter": "backoff.jitterRatio (0-1)",
				"panel.retry.codes": "retryableCodes（逗号分隔）",
				"panel.inherited": "（继承默认）",
			},
			en: {
				"quote.label": "Quote to input",
				"btw.label": "btw",
				"close.label": "Close",
				"quote.head": '> 🔖 Quoted from "{title}" · {time}',
				"btw.head": '> 🔖 btw (forked from "{title}")',
				"toast.archived": "btw session archived (irreversible)",
				"toast.archiveFailed": "Failed to archive the btw session",
				"toast.quoteUnavailable": "Composer unavailable for this session",
				"toast.quoteFailed": "Failed to write the quote",
				"btw.failed": "btw failed",
				"btw.runningTail": "Selection is inside a running turn; btw unavailable here",
				"btw.titlePrefix": "btw",
				// —— advanced config panel ——
				"panel.title": "Advanced configuration (dsh-btw)",
				"panel.notWritable": "The settings document is read-only in this deployment",
				"panel.notConfigured": "This provider is not configured yet — finish the Models card first",
				"panel.loadFailed": "Failed to read the configuration",
				"panel.conflict": "Settings changed elsewhere — collapse and reopen this panel",
				"panel.saved": "Saved",
				"panel.saveFailed": "Save failed",
				"panel.saving": "Saving…",
				"panel.save": "Save advanced fields",
				"panel.reset": "Discard changes",
				"panel.endpoint": "Endpoint & protocol",
				"panel.baseURL": "Base URL",
				"panel.baseURL.ph": "Empty = catalog default",
				"panel.api": "Wire protocol",
				"panel.api.ph": "Empty = catalog default",
				"panel.display": "Display name",
				"panel.timeouts": "Timeouts",
				"panel.timeoutMs": "Request timeout (ms)",
				"panel.streamIdle": "Stream idle timeout (ms)",
				"panel.wsConnect": "WS connect timeout (ms)",
				"panel.stream": "Transport & cache",
				"panel.transport": "transport",
				"panel.cacheRetention": "cacheRetention",
				"panel.reasoning": "reasoning (thinking level)",
				"panel.budgets": "thinkingBudgets (token budgets)",
				"panel.capacity": "Fallback capacities",
				"panel.defaultContextWindow": "defaultContextWindow",
				"panel.defaultMaxTokens": "defaultMaxTokens",
				"panel.headers": "headers (one per line, Name: Value)",
				"panel.headers.ph": "X-Custom-Header: value",
				"panel.compat": "Model compat switches (modelOverrides.*.compat)",
				"panel.compat.modelId": "Add a row, fill the model id, tick the switches",
				"panel.compat.add": "Add model",
				"panel.compat.remove": "Remove",
				"panel.retry": "retryPolicy",
				"panel.retry.mode": "mode",
				"panel.retry.maxRetries": "maxRetries",
				"panel.retry.initial": "backoff.initialDelayMs",
				"panel.retry.max": "backoff.maxDelayMs",
				"panel.retry.jitter": "backoff.jitterRatio (0-1)",
				"panel.retry.codes": "retryableCodes (comma-separated)",
				"panel.inherited": "(inherited)",
			},
		};

		const PROTOCOLS = ["openai-completions", "openai-responses", "anthropic-messages"];
		const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
		const CACHE_RETENTIONS = ["none", "short", "long"];
		const TRANSPORTS = ["auto", "sse", "websocket", "websocket-cached"];
		const BUDGET_KEYS = ["minimal", "low", "medium", "high"];
		/** 排障高频 compat 开关（模型级；全集 20+，其余可在 settings.yaml 调）。 */
		const COMPAT_SWITCHES = [
			"supportsTemperature",
			"forceAdaptiveThinking",
			"allowEmptySignature",
			"supportsStrictTools",
			"requiresThinkingAsText",
			"supportsCacheControlOnTools",
		];
		//#endregion

		//#region module state (singletons)
		/** apply 时的 root ctx（sessions/workspaces/remote 服务入口）。 */
		let hostCtx = null;
		/** locale 服务（可选，chat-import 同款降级策略）。 */
		let localeSvc = null;
		/** session 作用域桥组件写入、OverlayHost 读取的能力面。 */
		const bridge = { current: null };
		/** fork 成功后暂存、由子会话的桥组件挂载时消费。 */
		let pendingSeed = null;
		/** OverlayHost 提供的浮层控制面。 */
		let overlayApi = null;
		/** childSessionId -> { sourceSessionId, createdAt }。 */
		const activeBtws = new Map();
		//#endregion

		//#region storage & small utils
		function storageGet(key, fallback) {
			try {
				const v = window.localStorage.getItem(key);
				return v === null ? fallback : v;
			} catch {
				return fallback;
			}
		}
		function storageSet(key, value) {
			try {
				window.localStorage.setItem(key, value);
			} catch {
				/* 隐私模式等——设置失存可接受 */
			}
		}
		function autoArchiveEnabled() {
			return storageGet(LS_AUTO_ARCHIVE, "1") === "1";
		}
		function truncateChars() {
			const n = Number(storageGet(LS_TRUNCATE, String(DEFAULT_TRUNCATE)));
			return Number.isFinite(n) && n >= 100 ? Math.floor(n) : DEFAULT_TRUNCATE;
		}
		function loadBtws() {
			try {
				const raw = JSON.parse(storageGet(LS_BTWS, "[]"));
				if (Array.isArray(raw)) {
					for (const it of raw) {
						if (it && typeof it.childSessionId === "string") {
							activeBtws.set(it.childSessionId, it);
						}
					}
				}
			} catch {
				/* 损坏即弃 */
			}
		}
		function saveBtws() {
			try {
				storageSet(LS_BTWS, JSON.stringify([...activeBtws.values()]));
			} catch {
				/* ignore */
			}
		}
		function fmtTime(ts) {
			const d = new Date(ts);
			const p = (n) => String(n).padStart(2, "0");
			return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
		}
		/** 优先 locale 服务绑定的 t（随 DSH 语言切换），缺失时降级内置 zh。 */
		function translate(key, params) {
			let text;
			try {
				const bound =
					localeSvc && typeof localeSvc.bind === "function" ? localeSvc.bind(NS) : null;
				text = bound ? bound(key, params) : undefined;
			} catch {
				text = undefined;
			}
			if (typeof text !== "string" || text === "" || text === key) text = DICT.zh[key] ?? key;
			if (params) {
				for (const [k, v] of Object.entries(params)) {
					text = text.split(`{${k}}`).join(String(v));
				}
			}
			return text;
		}
		/** 模板头：优先槽位注入的 t（同一 ns），再做 {x} 参数替换。 */
		function fill(headKey, params, t) {
			let out;
			try {
				out = typeof t === "function" ? t(headKey) : undefined;
			} catch {
				out = undefined;
			}
			if (typeof out !== "string" || out === "" || out === headKey) out = translate(headKey);
			for (const [k, v] of Object.entries(params)) out = out.split(`{${k}}`).join(String(v));
			return out;
		}

		let toastSeq = 0;
		function toast(text) {
			if (typeof document === "undefined") return;
			const el = document.createElement("div");
			el.setAttribute("data-dsh-btw-toast", "");
			el.textContent = text;
			const slot = toastSeq++ % 5;
			const bottom = 28 + slot * 44;
			el.style.cssText =
				"position:fixed;left:50%;bottom:" + bottom + "px;transform:translateX(-50%);" +
				"z-index:2147483600;background:var(--dsw-alias-bg-overlay,rgba(24,26,31,.97));" +
				"color:var(--dsw-alias-label-primary,#f2f2f2);" +
				"border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));" +
				"border-radius:10px;padding:8px 14px;font-size:13px;line-height:20px;" +
				"box-shadow:0 8px 24px rgba(0,0,0,.28);pointer-events:none;max-width:60vw;";
			document.body.appendChild(el);
			window.setTimeout(() => {
				el.remove();
			}, 3600);
		}
		//#endregion

		//#region quote building
		/** 引用块 + 来源头；多行逐行加 "> "，超长截断。 */
		function buildQuote(kind, sourceTitle, text, t) {
			const limit = truncateChars();
			const body = text.length > limit ? text.slice(0, limit) + " …" : text;
			const head =
				kind === "btw"
					? fill("btw.head", { title: sourceTitle }, t)
					: fill("quote.head", { title: sourceTitle, time: fmtTime(Date.now()) }, t);
			return (
				head + "\n" + body.split("\n").map((l) => "> " + l).join("\n") + "\n\n"
			);
		}
		//#endregion

		//#region selection detection
		function elementOf(n) {
			if (!n) return null;
			return n.nodeType === 3 ? n.parentElement : n instanceof Element ? n : null;
		}
		function sessionRunning() {
			try {
				const snap = hostCtx.sessions.list.getSnapshot();
				return Boolean(
					snap.current && snap.byId[snap.current] && snap.byId[snap.current].running,
				);
			} catch {
				return false;
			}
		}
		function currentTitle() {
			try {
				const snap = hostCtx.sessions.list.getSnapshot();
				if (!snap.current) return "";
				const row = snap.byId[snap.current];
				return (row && (row.displayTitle || row.title)) || snap.current;
			} catch {
				return "";
			}
		}
		/**
		 * 选中节点的事件序号（fork 锚点）：session face 快照
		 * （SessionFace = ISession & ObservableSnapshot<ConversationSnapshot>）
		 * → chat.nodes.get(nodeKey).anchorSeq。拿不到就交由 fork 的缺省边界语义。
		 */
		function currentNodeSeq(sessionId, nodeKey) {
			if (!nodeKey) return undefined;
			try {
				const snap = hostCtx.sessions.binding?.(sessionId)?.session?.getSnapshot?.();
				const node = snap?.chat?.nodes?.get?.(nodeKey);
				if (node && Number.isFinite(node.anchorSeq)) return node.anchorSeq;
			} catch {
				/* 落回 undefined → fork 用缺省边界 */
			}
			return undefined;
		}
		/** 取当前选区；仅会话消息区内、非输入区、≥2 字符有效。 */
		function selectionInfo() {
			const sel = window.getSelection();
			if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
			const anchorEl = elementOf(sel.anchorNode);
			if (!anchorEl) return null;
			const scroller = anchorEl.closest(SEL_SCROLLER);
			if (!scroller) return null;
			if (anchorEl.closest(SEL_EXCLUDE)) return null;
			const text = sel.toString().replace(/\u00a0/g, " ").trim();
			if (text.length < MIN_SELECT_CHARS) return null;
			const rowEl = anchorEl.closest(SEL_NODE_ROW);
			let atRunningTail = false;
			if (rowEl && sessionRunning()) {
				const rows = scroller.querySelectorAll(SEL_NODE_ROW);
				atRunningTail = rows.length > 0 && rows[rows.length - 1] === rowEl;
			}
			const rect = sel.getRangeAt(0).getBoundingClientRect();
			return {
				text,
				nodeKey: rowEl ? rowEl.getAttribute("data-chat-anchor-key") : null,
				atRunningTail,
				rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
			};
		}
		//#endregion

		//#region actions
		function quoteToInput(info) {
			if (!info) return;
			const snap = hostCtx.sessions.list.getSnapshot();
			const b = bridge.current;
			if (!b || !b.inputActions || b.sessionId !== snap.current) {
				toast(translate("toast.quoteUnavailable"));
				return;
			}
			const cur = typeof b.draft === "function" ? b.draft() : "";
			const quote = buildQuote("quote", currentTitle(), info.text, b.t);
			try {
				b.inputActions.setDraft(cur.trim() ? quote + "\n" + cur : quote);
				overlayApi && overlayApi.hide();
			} catch (error) {
				toast(
					translate("toast.quoteFailed") +
						(error && error.message ? ` · ${error.message}` : ""),
				);
			}
		}

		async function btwFromSelection(info) {
			if (!info) return;
			const snap = hostCtx.sessions.list.getSnapshot();
			const sessionId = snap.current;
			if (!sessionId) return;
			if (info.atRunningTail) {
				toast(translate("btw.runningTail"));
				return;
			}
			const opts = { sessionId };
			const seq = currentNodeSeq(sessionId, info.nodeKey);
			if (seq !== undefined) opts.atSeq = seq;
			const row = snap.byId[sessionId];
			const title = (row && (row.displayTitle || row.title)) || sessionId;
			let childId;
			try {
				childId = await hostCtx.sessions.fork(opts);
			} catch (error) {
				const reason = error && error.message ? ` · ${error.message}` : "";
				toast(translate("btw.failed") + reason);
				return;
			}
			// 临时会话显式改名：一眼可辨（rename 会把标题钉住不被 LLM 自动再生）。
			try {
				const child = hostCtx.sessions.binding?.(childId)?.session;
				const shortTitle = title.length > 20 ? title.slice(0, 20) + "…" : title;
				if (child) await child.rename(`🔍 ${translate("btw.titlePrefix")} · ${shortTitle}`);
			} catch {
				/* 非致命 */
			}
			pendingSeed = {
				childSessionId: childId,
				quote: buildQuote("btw", title, info.text, bridge.current && bridge.current.t),
				ts: Date.now(),
			};
			activeBtws.set(childId, { sourceSessionId: sessionId, createdAt: Date.now() });
			saveBtws();
			overlayApi && overlayApi.hide();
			hostCtx.sessions.open(childId);
		}
		//#endregion

		//#region auto-archive watcher (root scope, whole plugin lifetime)
		/**
		 * 订阅会话列表：当前选择离开"活跃 btw 会话"时自动归档。
		 * running 的会话顺延到下次离开；会话已消失则静默清理记录。
		 * 归档不可逆（rc.2 无 unarchive）——该语义已在需求文档与用户确认。
		 */
		function installArchiveWatcher(ctx) {
			let lastCurrent;
			try {
				lastCurrent = ctx.sessions.list.getSnapshot().current;
			} catch {
				lastCurrent = undefined;
			}
			const unsubscribe = ctx.sessions.list.subscribe(() => {
				const snap = ctx.sessions.list.getSnapshot();
				const prev = lastCurrent;
				const cur = snap.current;
				lastCurrent = cur;
				if (pendingSeed && Date.now() - pendingSeed.ts > PENDING_SEED_TTL_MS) pendingSeed = null;
				if (!autoArchiveEnabled() || !prev || prev === cur) return;
				if (!activeBtws.has(prev)) return;
				const row = snap.byId[prev];
				if (!row) {
					activeBtws.delete(prev);
					saveBtws();
					return;
				}
				if (row.running) return; // 顺延：等它空闲后再次被离开时归档
				ctx.workspaces
					.archiveSession(prev)
					.then(() => toast(translate("toast.archived")))
					.catch(() => toast(translate("toast.archiveFailed")))
					.finally(() => {
						activeBtws.delete(prev);
						saveBtws();
					});
			});
			return typeof unsubscribe === "function" ? unsubscribe : () => {};
		}
		//#endregion

		//#region ==== Provider 高级配置面板（settings.models.provider-card 槽位） ====
		const STYLE = {
			wrap: {
				margin: "8px 0 2px",
				border: "1px solid var(--dsw-alias-border-l3, rgba(255,255,255,.10))",
				borderRadius: "10px",
				overflow: "hidden",
			},
			head: {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				padding: "8px 12px",
				cursor: "pointer",
				userSelect: "none",
				background: "var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.04))",
				fontSize: "13px",
				lineHeight: "20px",
				color: "var(--dsw-alias-label-secondary, #ccc)",
				border: "none",
				width: "100%",
				textAlign: "left",
				fontFamily: "inherit",
			},
			body: {
				padding: "10px 12px 12px",
				display: "flex",
				flexDirection: "column",
				gap: "10px",
				fontSize: "13px",
				color: "var(--dsw-alias-label-primary, #f2f2f2)",
			},
			group: {
				display: "flex",
				flexDirection: "column",
				gap: "6px",
				padding: "8px 0 2px",
				borderTop: "1px dashed var(--dsw-alias-border-l4, rgba(255,255,255,.08))",
			},
			groupTitle: {
				fontSize: "12px",
				fontWeight: "600",
				color: "var(--dsw-alias-label-tertiary, #999)",
				letterSpacing: "0.02em",
			},
			row: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
			label: { flex: "0 0 168px", color: "var(--dsw-alias-label-secondary, #bbb)", fontSize: "12px" },
			input: {
				flex: "1 1 160px",
				minWidth: "120px",
				border: "1px solid var(--dsw-alias-border-l3, rgba(255,255,255,.12))",
				background: "var(--dsw-alias-bg-input, rgba(0,0,0,.2))",
				color: "inherit",
				borderRadius: "7px",
				padding: "4px 8px",
				font: "inherit",
				fontSize: "12px",
			},
			select: {
				flex: "0 0 180px",
				border: "1px solid var(--dsw-alias-border-l3, rgba(255,255,255,.12))",
				background: "var(--dsw-alias-bg-input, rgba(0,0,0,.2))",
				color: "inherit",
				borderRadius: "7px",
				padding: "4px 8px",
				font: "inherit",
				fontSize: "12px",
			},
			textarea: {
				width: "100%",
				minHeight: "56px",
				border: "1px solid var(--dsw-alias-border-l3, rgba(255,255,255,.12))",
				background: "var(--dsw-alias-bg-input, rgba(0,0,0,.2))",
				color: "inherit",
				borderRadius: "7px",
				padding: "6px 8px",
				font: "var(--dsh-font-mono, monospace)",
				fontSize: "12px",
				resize: "vertical",
			},
			button: {
				border: "1px solid var(--dsw-alias-border-l3, rgba(255,255,255,.12))",
				background: "transparent",
				color: "var(--dsw-alias-label-primary, #f2f2f2)",
				borderRadius: "8px",
				padding: "4px 12px",
				font: "inherit",
				fontSize: "12px",
				cursor: "pointer",
			},
			primary: {
				border: "none",
				background: "var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.10))",
				color: "var(--dsw-alias-label-primary, #f2f2f2)",
				borderRadius: "8px",
				padding: "5px 14px",
				font: "inherit",
				fontSize: "12px",
				cursor: "pointer",
			},
			note: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #999)", margin: "0" },
			error: { fontSize: "12px", color: "var(--dsw-alias-state-error-primary, #ff6b6b)", margin: "0" },
			ok: { fontSize: "12px", color: "var(--dsw-alias-state-success-primary, #5bd899)", margin: "0" },
		};

		function deepEqual(a, b) {
			if (a === b) return true;
			if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
			if (Array.isArray(a) !== Array.isArray(b)) return false;
			const ka = Object.keys(a);
			const kb = Object.keys(b);
			if (ka.length !== kb.length) return false;
			for (const k of ka) {
				if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k])) return false;
			}
			return true;
		}
		/** 在 profile 中按相对路径取值。 */
		function pathGet(obj, rel) {
			let cur = obj;
			for (const key of rel) {
				if (cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, key)) {
					return { has: false, value: undefined };
				}
				cur = cur[key];
			}
			return { has: true, value: cur };
		}

		/** 文档里 providers.<route> 的 profile（合成层，只含显式配置的字段）。 */
		function profileOf(nsValue, route) {
			const providers = nsValue && typeof nsValue === "object" ? nsValue.providers : undefined;
			const p = providers && typeof providers === "object" ? providers[route] : undefined;
			return p && typeof p === "object" ? p : {};
		}

		/** 表单初值 = profile 字段（缺失 = 空 = 继承默认）。 */
		function toForm(profile) {
			const retry = profile.retryPolicy && typeof profile.retryPolicy === "object" ? profile.retryPolicy : {};
			const backoff = retry.backoff && typeof retry.backoff === "object" ? retry.backoff : {};
			const budgets = profile.thinkingBudgets && typeof profile.thinkingBudgets === "object" ? profile.thinkingBudgets : {};
			const overrides = profile.modelOverrides && typeof profile.modelOverrides === "object" ? profile.modelOverrides : {};
			return {
				displayName: profile.displayName ?? "",
				baseURL: profile.baseURL ?? "",
				api: profile.api ?? "",
				timeoutMs: profile.timeoutMs ?? "",
				streamIdleTimeoutMs: profile.streamIdleTimeoutMs ?? "",
				websocketConnectTimeoutMs: profile.websocketConnectTimeoutMs ?? "",
				transport: profile.transport ?? "",
				cacheRetention: profile.cacheRetention ?? "",
				reasoning: profile.reasoning ?? "",
				budgets: {
					minimal: budgets.minimal ?? "",
					low: budgets.low ?? "",
					medium: budgets.medium ?? "",
					high: budgets.high ?? "",
				},
				defaultContextWindow: profile.defaultContextWindow ?? "",
				defaultMaxTokens: profile.defaultMaxTokens ?? "",
				headerLines: Object.entries(profile.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
				overrideRows: Object.entries(overrides).map(([id, v]) => ({
					id,
					switches: COMPAT_SWITCHES.filter((key) => v && typeof v === "object" && v.compat && v.compat[key] === true),
				})),
				retryMode: typeof retry.mode === "string" ? retry.mode : "",
				retryMaxRetries: retry.maxRetries ?? "",
				retryCodes: Array.isArray(retry.retryableCodes) ? retry.retryableCodes.join(", ") : "",
				retryInitial: backoff.initialDelayMs ?? "",
				retryMax: backoff.maxDelayMs ?? "",
				retryJitter: backoff.jitterRatio ?? "",
			};
		}

		/** 空/继承 → undefined（unset）；非法 → null。 */
		function numOrNull(text) {
			const t = String(text ?? "").trim();
			if (t === "") return undefined;
			const n = Number(t);
			return Number.isFinite(n) && n >= 0 ? n : null;
		}

		/**
		 * 表单 → settings.mutate ops。只对相对 original（打开面板时的 profile）
		 * 有变化的字段生成 op：未改动的不写（避免把 base 层值钉进 user 层）；
		 * 清空 = unset（回退默认）。
		 * @returns {{ops: Array, invalid: string[]}} invalid 为非法字段名列表。
		 */
		function formToOps(form, path, original) {
			const ops = [];
			const invalid = [];
			const want = (rel, value) => {
				const cur = pathGet(original, rel);
				if (value === undefined) {
					if (cur.has) ops.push({ op: "unset", path: [...path, ...rel] });
					return;
				}
				if (!cur.has || !deepEqual(cur.value, value)) {
					ops.push({ op: "set", path: [...path, ...rel], value });
				}
			};

			// 文本
			want(["displayName"], String(form.displayName).trim() || undefined);
			want(["baseURL"], String(form.baseURL).trim() || undefined);
			{
				const v = form.api;
				if (v !== "" && !PROTOCOLS.includes(v)) invalid.push("api");
				want(["api"], v === "" ? undefined : v);
			}

			// 数字
			const num = (key, rel, positive) => {
				const n = numOrNull(form[key]);
				if (n === null || (positive && n !== undefined && n <= 0)) {
					invalid.push(rel[rel.length - 1]);
					return;
				}
				want(rel, n === undefined ? undefined : Math.floor(n));
			};
			num("timeoutMs", ["timeoutMs"]);
			num("streamIdleTimeoutMs", ["streamIdleTimeoutMs"], true);
			num("websocketConnectTimeoutMs", ["websocketConnectTimeoutMs"]);
			num("defaultContextWindow", ["defaultContextWindow"], true);
			num("defaultMaxTokens", ["defaultMaxTokens"], true);

			// 枚举
			const pick = (key, rel, allowed) => {
				const v = form[key];
				if (v !== "" && !allowed.includes(v)) invalid.push(rel[rel.length - 1]);
				want(rel, v === "" ? undefined : v);
			};
			pick("transport", ["transport"], TRANSPORTS);
			pick("cacheRetention", ["cacheRetention"], CACHE_RETENTIONS);
			pick("reasoning", ["reasoning"], THINKING_LEVELS);

			// thinkingBudgets：任一子键有值即整对象 set（schemastery 对象整体校验）
			{
				const value = {};
				let bad = false;
				for (const k of BUDGET_KEYS) {
					const n = numOrNull(form.budgets[k]);
					if (n === null) {
						invalid.push(`thinkingBudgets.${k}`);
						bad = true;
					} else if (n !== undefined) value[k] = Math.floor(n);
				}
				if (!bad) want(["thinkingBudgets"], Object.keys(value).length > 0 ? value : undefined);
			}

			// headers（Name: Value 每行一条）
			{
				const headers = {};
				for (const line of form.headerLines) {
					const t = String(line).trim();
					if (t === "") continue;
					const idx = t.indexOf(":");
					const name = idx > 0 ? t.slice(0, idx).trim() : "";
					const value = idx > 0 ? t.slice(idx + 1).trim() : "";
					if (!name || !value) {
						invalid.push("headers");
						continue;
					}
					headers[name] = value;
				}
				if (!invalid.includes("headers")) {
					want(["headers"], Object.keys(headers).length > 0 ? headers : undefined);
				}
			}

			// modelOverrides compat（本面板所见形状全量重写该字段）
			{
				const overrides = {};
				let bad = false;
				for (const row of form.overrideRows) {
					const id = String(row.id ?? "").trim();
					if (id === "" || row.switches.length === 0) {
						invalid.push("modelOverrides");
						bad = true;
						continue;
					}
					const compat = {};
					for (const key of row.switches) compat[key] = true;
					overrides[id] = { compat };
				}
				if (!bad) want(["modelOverrides"], Object.keys(overrides).length > 0 ? overrides : undefined);
			}

			// retryPolicy（normal: maxRetries/codes/backoff；always: 仅 backoff）
			{
				const retryEmpty =
					form.retryMode === "" &&
					String(form.retryMaxRetries).trim() === "" &&
					String(form.retryCodes).trim() === "" &&
					String(form.retryInitial).trim() === "" &&
					String(form.retryMax).trim() === "" &&
					String(form.retryJitter).trim() === "";
				if (retryEmpty) {
					want(["retryPolicy"], undefined);
				} else {
					const policy = {};
					let bad = false;
					if (form.retryMode === "always") {
						policy.mode = "always";
					} else {
						policy.mode = "normal";
						const mr = numOrNull(form.retryMaxRetries);
						if (mr === null) {
							invalid.push("retryPolicy.maxRetries");
							bad = true;
						} else if (mr !== undefined) policy.maxRetries = Math.floor(mr);
						const codes = form.retryCodes
							.split(",")
							.map((c) => c.trim())
							.filter(Boolean);
						if (codes.length > 0) policy.retryableCodes = codes;
					}
					const b0 = numOrNull(form.retryInitial);
					const b1 = numOrNull(form.retryMax);
					const jt = String(form.retryJitter).trim();
					const b2 = jt === "" ? undefined : Number(jt);
					if (b0 === null || b1 === null) {
						invalid.push("retryPolicy.backoff");
						bad = true;
					} else {
						const backoff = {};
						if (b0 !== undefined) backoff.initialDelayMs = b0;
						if (b1 !== undefined) backoff.maxDelayMs = b1;
						if (jt !== "") {
							if (!Number.isFinite(b2) || b2 < 0 || b2 > 1) {
								invalid.push("retryPolicy.jitterRatio");
								bad = true;
							} else backoff.jitterRatio = b2;
						}
						if (Object.keys(backoff).length > 0) policy.backoff = backoff;
					}
					if (!bad) want(["retryPolicy"], policy);
				}
			}
			return { ops, invalid };
		}

		function PanelField({ label, children }) {
			return React.createElement(
				"div",
				{ style: STYLE.row },
				React.createElement("span", { style: STYLE.label }, label),
				children,
			);
		}
		function PanelText({ value, onChange, placeholder, type }) {
			return React.createElement("input", {
				style: STYLE.input,
				value,
				placeholder,
				type: type ?? "text",
				onChange: (e) => onChange(e.target.value),
			});
		}
		function PanelSelect({ value, onChange, options }) {
			return React.createElement(
				"select",
				{ style: STYLE.select, value, onChange: (e) => onChange(e.target.value) },
				React.createElement("option", { value: "" }, translate("panel.inherited")),
				options.map((o) => React.createElement("option", { key: o, value: o }, o)),
			);
		}

		/**
		 * Provider 高级配置面板（settings.models.provider-card 槽位组件）。
		 * props = { provider: {provider, displayName, settingsNs, settingsPath, declared?},
		 *           configured, keyConfigured, t? }。
		 * 仅 settingsNs === "llm-pi-ai" 且已配置的路由渲染；每次展开重新拉 describe
		 * 保证 revision 新鲜（乐观锁前提）；保存走 mutate，服务端校验兜底。
		 */
		function BtwProviderConfig(props) {
			const provider = props.provider;
			const route =
				Array.isArray(provider?.settingsPath) && provider.settingsPath.length >= 2
					? provider.settingsPath[1]
					: provider?.provider;
			const settingsNs = provider?.settingsNs;
			const relevant =
				props.configured === true && settingsNs === SETTINGS_NS && typeof route === "string" && route.length > 0;

			const [open, setOpen] = useState(false);
			const [load, setLoad] = useState(null); // { status, doc?, error? }
			const [form, setForm] = useState(null);
			const [dirty, setDirty] = useState(false);
			const [saving, setSaving] = useState(false);
			const [feedback, setFeedback] = useState(null);
			const revisionRef = useRef(undefined);

			const loadDoc = useCallback(async () => {
				try {
					const response = await hostCtx.remote.settings.describe(SETTINGS_NS);
					if (!response.ok) {
						setLoad({ status: "failed", error: response.error?.message ?? String(response.error) });
						return;
					}
					const ns = (response.value.namespaces ?? []).find((n) => n.ns === SETTINGS_NS);
					if (!ns) {
						setLoad({ status: "unconfigured" });
						return;
					}
					revisionRef.current = ns.revision;
					setLoad({ status: ns.writable ? "ok" : "readonly", doc: ns.value ?? ns.user ?? ns.base ?? {} });
				} catch (error) {
					setLoad({ status: "failed", error: error?.message ?? String(error) });
				}
			}, []);

			useEffect(() => {
				if (open && load === null) loadDoc();
			}, [open, load, loadDoc]);

			const profile = useMemo(() => (load?.doc ? profileOf(load.doc, route) : null), [load, route]);
			useEffect(() => {
				if (open && profile) setForm((cur) => cur ?? toForm(profile));
			}, [open, profile]);

			if (!relevant) return null;

			const toggle = () =>
				setOpen((o) => {
					const next = !o;
					if (next) {
						// 每次展开重新拉取：revision 与远端一致是乐观锁的前提
						setLoad(null);
						setForm(null);
						setDirty(false);
						setFeedback(null);
					}
					return next;
				});
			const patch = (key, value) =>
				setForm((cur) => {
					setDirty(true);
					return { ...cur, [key]: value };
				});
			const patchBudget = (key, value) =>
				setForm((cur) => {
					setDirty(true);
					return { ...cur, budgets: { ...cur.budgets, [key]: value } };
				});
			const patchRow = (idx, key, value) =>
				setForm((cur) => {
					setDirty(true);
					return { ...cur, overrideRows: cur.overrideRows.map((r, i) => (i === idx ? { ...r, [key]: value } : r)) };
				});
			const toggleSwitch = (idx, key) =>
				setForm((cur) => {
					setDirty(true);
					return {
						...cur,
						overrideRows: cur.overrideRows.map((r, i) => {
							if (i !== idx) return r;
							const set = new Set(r.switches);
							if (set.has(key)) set.delete(key);
							else set.add(key);
							return { ...r, switches: [...set] };
						}),
					};
				});
			const addRow = () =>
				setForm((cur) => {
					setDirty(true);
					return { ...cur, overrideRows: [...cur.overrideRows, { id: "", switches: [] }] };
				});
			const removeRow = (idx) =>
				setForm((cur) => {
					setDirty(true);
					return { ...cur, overrideRows: cur.overrideRows.filter((_, i) => i !== idx) };
				});

			const save = async () => {
				if (!form || saving) return;
				setSaving(true);
				setFeedback(null);
				try {
					const { ops, invalid } = formToOps(form, ["providers", route], profile);
					if (invalid.length > 0) {
						setFeedback({ kind: "error", text: `${translate("panel.saveFailed")}: ${invalid.join(", ")}` });
						return;
					}
					if (ops.length === 0) {
						setFeedback({ kind: "ok", text: translate("panel.saved") });
						setDirty(false);
						return;
					}
					const response = await hostCtx.remote.settings.mutate(SETTINGS_NS, ops, revisionRef.current);
					if (!response.ok) {
						const conflict = response.error?.code === "settings/conflict";
						setFeedback({
							kind: "error",
							text: conflict
								? translate("panel.conflict")
								: `${translate("panel.saveFailed")}: ${response.error?.message ?? ""}`,
						});
						return;
					}
					revisionRef.current = response.value?.revision ?? revisionRef.current;
					setFeedback({ kind: "ok", text: translate("panel.saved") });
					setDirty(false);
					toast(translate("panel.saved"));
				} catch (error) {
					setFeedback({ kind: "error", text: `${translate("panel.saveFailed")}: ${error?.message ?? error}` });
				} finally {
					setSaving(false);
				}
			};

			const reset = () => {
				if (profile) setForm(toForm(profile));
				setDirty(false);
				setFeedback(null);
			};

			return React.createElement(
				"div",
				{ "data-dsh-btw-config": "", style: STYLE.wrap },
				React.createElement(
					"button",
					{ type: "button", style: STYLE.head, onClick: toggle },
					`${open ? "▾" : "▸"} ${translate("panel.title")}${dirty ? " *" : ""}`,
				),
				open
					? React.createElement(
							"div",
							{ style: STYLE.body },
							load === null
								? React.createElement("p", { style: STYLE.note }, "…")
								: load.status === "failed"
									? React.createElement("p", { style: STYLE.error }, `${translate("panel.loadFailed")}: ${load.error ?? ""}`)
									: load.status === "unconfigured"
										? React.createElement("p", { style: STYLE.note }, translate("panel.notConfigured"))
										: load.status === "readonly"
											? React.createElement("p", { style: STYLE.note }, translate("panel.notWritable"))
											: form === null
												? null
												: React.createElement(
														React.Fragment,
														null,
														React.createElement("div", { style: STYLE.group },
															React.createElement("span", { style: STYLE.groupTitle }, translate("panel.endpoint")),
															React.createElement(PanelField, { label: translate("panel.display") },
																React.createElement(PanelText, { value: form.displayName, onChange: (v) => patch("displayName", v) })),
															React.createElement(PanelField, { label: translate("panel.baseURL") },
																React.createElement(PanelText, { value: form.baseURL, onChange: (v) => patch("baseURL", v), placeholder: translate("panel.baseURL.ph") })),
															React.createElement(PanelField, { label: translate("panel.api") },
																React.createElement(PanelSelect, { value: form.api, onChange: (v) => patch("api", v), options: PROTOCOLS })),
														),
														React.createElement("div", { style: STYLE.group },
															React.createElement("span", { style: STYLE.groupTitle }, translate("panel.timeouts")),
															React.createElement(PanelField, { label: translate("panel.timeoutMs") },
																React.createElement(PanelText, { value: form.timeoutMs, onChange: (v) => patch("timeoutMs", v), placeholder: translate("panel.inherited") })),
															React.createElement(PanelField, { label: translate("panel.streamIdle") },
																React.createElement(PanelText, { value: form.streamIdleTimeoutMs, onChange: (v) => patch("streamIdleTimeoutMs", v), placeholder: translate("panel.inherited") })),
															React.createElement(PanelField, { label: translate("panel.wsConnect") },
																React.createElement(PanelText, { value: form.websocketConnectTimeoutMs, onChange: (v) => patch("websocketConnectTimeoutMs", v), placeholder: translate("panel.inherited") })),
														),
														React.createElement("div", { style: STYLE.group },
															React.createElement("span", { style: STYLE.groupTitle }, translate("panel.stream")),
															React.createElement(PanelField, { label: translate("panel.transport") },
																React.createElement(PanelSelect, { value: form.transport, onChange: (v) => patch("transport", v), options: TRANSPORTS })),
															React.createElement(PanelField, { label: translate("panel.cacheRetention") },
																React.createElement(PanelSelect, { value: form.cacheRetention, onChange: (v) => patch("cacheRetention", v), options: CACHE_RETENTIONS })),
															React.createElement(PanelField, { label: translate("panel.reasoning") },
																React.createElement(PanelSelect, { value: form.reasoning, onChange: (v) => patch("reasoning", v), options: THINKING_LEVELS })),
														),
														React.createElement("div", { style: STYLE.group },
															React.createElement("span", { style: STYLE.groupTitle }, translate("panel.budgets")),
															React.createElement("div", { style: STYLE.row },
																BUDGET_KEYS.map((k) =>
																	React.createElement(
																		"label",
																		{ key: k, style: { display: "flex", alignItems: "center", gap: "4px", flex: "1 1 120px" } },
																		React.createElement("span", { style: { ...STYLE.label, flex: "0 0 auto" } }, k),
																		React.createElement(PanelText, { value: form.budgets[k], onChange: (v) => patchBudget(k, v), placeholder: translate("panel.inherited") }),
																	),
																)),
														),
														React.createElement("div", { style: STYLE.group },
															React.createElement("span", { style: STYLE.groupTitle }, translate("panel.capacity")),
															React.createElement(PanelField, { label: translate("panel.defaultContextWindow") },
																React.createElement(PanelText, { value: form.defaultContextWindow, onChange: (v) => patch("defaultContextWindow", v), placeholder: translate("panel.inherited") })),
															React.createElement(PanelField, { label: translate("panel.defaultMaxTokens") },
																React.createElement(PanelText, { value: form.defaultMaxTokens, onChange: (v) => patch("defaultMaxTokens", v), placeholder: translate("panel.inherited") })),
														),
														React.createElement("div", { style: STYLE.group },
															React.createElement("span", { style: STYLE.groupTitle }, translate("panel.headers")),
															React.createElement("textarea", {
																style: STYLE.textarea,
																value: form.headerLines.join("\n"),
																placeholder: translate("panel.headers.ph"),
																onChange: (e) => patch("headerLines", e.target.value.split("\n")),
															}),
														),
														React.createElement("div", { style: STYLE.group },
															React.createElement("span", { style: STYLE.groupTitle }, translate("panel.compat")),
															React.createElement("p", { style: STYLE.note }, translate("panel.compat.modelId")),
															form.overrideRows.map((row, idx) =>
																React.createElement(
																	"div",
																	{ key: `${idx}:${row.id}`, style: STYLE.row },
																	React.createElement(PanelText, { value: row.id, onChange: (v) => patchRow(idx, "id", v), placeholder: "model-id" }),
																	COMPAT_SWITCHES.map((key) =>
																		React.createElement(
																			"label",
																			{ key, style: { display: "flex", alignItems: "center", gap: "2px", fontSize: "11px" } },
																			React.createElement("input", {
																				type: "checkbox",
																				checked: row.switches.includes(key),
																				onChange: () => toggleSwitch(idx, key),
																			}),
																			key,
																		),
																	),
																	React.createElement("button", { type: "button", style: STYLE.button, onClick: () => removeRow(idx) }, translate("panel.compat.remove")),
																),
															),
															React.createElement("button", { type: "button", style: STYLE.button, onClick: addRow }, translate("panel.compat.add")),
														),
														React.createElement("div", { style: STYLE.group },
															React.createElement("span", { style: STYLE.groupTitle }, translate("panel.retry")),
															React.createElement(PanelField, { label: translate("panel.retry.mode") },
																React.createElement(PanelSelect, { value: form.retryMode, onChange: (v) => patch("retryMode", v), options: ["normal", "always"] })),
															React.createElement(PanelField, { label: translate("panel.retry.maxRetries") },
																React.createElement(PanelText, { value: form.retryMaxRetries, onChange: (v) => patch("retryMaxRetries", v), placeholder: translate("panel.inherited") })),
															React.createElement(PanelField, { label: translate("panel.retry.codes") },
																React.createElement(PanelText, { value: form.retryCodes, onChange: (v) => patch("retryCodes", v) })),
															React.createElement(PanelField, { label: translate("panel.retry.initial") },
																React.createElement(PanelText, { value: form.retryInitial, onChange: (v) => patch("retryInitial", v), placeholder: translate("panel.inherited") })),
															React.createElement(PanelField, { label: translate("panel.retry.max") },
																React.createElement(PanelText, { value: form.retryMax, onChange: (v) => patch("retryMax", v), placeholder: translate("panel.inherited") })),
															React.createElement(PanelField, { label: translate("panel.retry.jitter") },
																React.createElement(PanelText, { value: form.retryJitter, onChange: (v) => patch("retryJitter", v), placeholder: translate("panel.inherited") })),
														),
														React.createElement(
															"div",
															{ style: { ...STYLE.row, justifyContent: "flex-end" } },
															React.createElement("button", { type: "button", style: STYLE.button, onClick: reset, disabled: saving }, translate("panel.reset")),
															React.createElement("button", { type: "button", style: STYLE.primary, onClick: save, disabled: saving || !dirty }, saving ? translate("panel.saving") : translate("panel.save")),
														),
														feedback
															? React.createElement("p", { style: feedback.kind === "ok" ? STYLE.ok : STYLE.error }, feedback.text)
															: null,
													),
						)
					: null,
			);
		}
		//#endregion

		//#region components (conversation overlay & bridge)
		const TOOLBAR_STYLE = {
			position: "fixed",
			zIndex: 2147483000,
			display: "flex",
			alignItems: "center",
			gap: "4px",
			padding: "6px",
			borderRadius: "10px",
			background: "var(--dsw-alias-bg-overlay, rgba(24,26,31,.97))",
			border: "1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.14))",
			boxShadow: "0 8px 24px rgba(0,0,0,.28)",
			pointerEvents: "auto",
			fontSize: "13px",
			lineHeight: "20px",
		};
		const BUTTON_STYLE = {
			appearance: "none",
			border: "none",
			background: "transparent",
			color: "var(--dsw-alias-label-primary, #f2f2f2)",
			borderRadius: "8px",
			padding: "4px 10px",
			fontSize: "13px",
			lineHeight: "20px",
			cursor: "pointer",
			whiteSpace: "nowrap",
		};

		/**
		 * 全局选中浮层（root 作用域；shell.overlay 座位）。
		 * 监听 document 级 mouseup/selectionchange/scroll/Esc，命中会话消息区选区时浮现。
		 */
		function OverlayHost(props) {
			const [info, setInfo] = useState(null);
			const infoRef = useRef(null);
			infoRef.current = info;
			const t = props && props.t;

			const hide = useCallback(() => setInfo(null), []);
			useEffect(() => {
				overlayApi = { show: (i) => setInfo(i), hide };
				return () => {
					overlayApi = null;
				};
			}, [hide]);

			useEffect(() => {
				const onSelectionChange = () => {
					if (infoRef.current) {
						const sel = window.getSelection();
						if (!sel || sel.isCollapsed) hide();
					}
				};
				const onMouseUp = () => {
					// 等浏览器完成本次点击的选区落定后取样
					window.requestAnimationFrame(() => {
						const next = selectionInfo();
						if (next) setInfo(next);
						else hide();
					});
				};
				const onKeyDown = (e) => {
					if (e.key === "Escape" && infoRef.current) hide();
				};
				const onScroll = () => {
					if (infoRef.current) hide();
				};
				const onResize = () => {
					if (infoRef.current) hide();
				};
				document.addEventListener("selectionchange", onSelectionChange);
				document.addEventListener("mouseup", onMouseUp, true);
				document.addEventListener("keydown", onKeyDown, true);
				window.addEventListener("scroll", onScroll, true);
				window.addEventListener("resize", onResize);
				return () => {
					document.removeEventListener("selectionchange", onSelectionChange);
					document.removeEventListener("mouseup", onMouseUp, true);
					document.removeEventListener("keydown", onKeyDown, true);
					window.removeEventListener("scroll", onScroll, true);
					window.removeEventListener("resize", onResize);
				};
			}, [hide]);

			if (!info) return null;

			// 定位：选区末端右下；越界翻转/夹取
			const EST_W = 220;
			const EST_H = 36;
			const MARGIN = 8;
			let left = info.rect.right - 60;
			let top = info.rect.bottom + MARGIN;
			const vw = window.innerWidth;
			const vh = window.innerHeight;
			if (left + EST_W > vw - MARGIN) left = vw - MARGIN - EST_W;
			if (left < MARGIN) left = MARGIN;
			if (top + EST_H > vh - MARGIN) top = info.rect.top - EST_H - MARGIN;
			if (top < MARGIN) top = MARGIN;

			const label = (key) => (typeof t === "function" ? t(key) : translate(key));
			return React.createElement(
				"div",
				{
					"data-dsh-btw-toolbar": "",
					style: { ...TOOLBAR_STYLE, left: `${Math.round(left)}px`, top: `${Math.round(top)}px` },
					// 阻止 mousedown 默认行为：保住选区、避免触发外层失焦逻辑
					onMouseDown: (e) => e.preventDefault(),
				},
				React.createElement(
					"button",
					{ style: BUTTON_STYLE, type: "button", onClick: () => quoteToInput(infoRef.current) },
					label("quote.label"),
				),
				React.createElement(
					"button",
					{
						style: { ...BUTTON_STYLE, opacity: info.atRunningTail ? 0.5 : 1 },
						type: "button",
						title: info.atRunningTail ? label("btw.runningTail") : undefined,
						onClick: () => btwFromSelection(infoRef.current),
					},
					label("btw.label"),
				),
				React.createElement(
					"button",
					{
						style: { ...BUTTON_STYLE, padding: "4px 6px", opacity: 0.7 },
						type: "button",
						"aria-label": label("close.label"),
						title: label("close.label"),
						onClick: hide,
					},
					"✕",
				),
			);
		}

		/**
		 * useInput 的无条件调用点（防条件 hook 顺序漂移）：把草稿快照实时上报给 ref。
		 * 每渲染同步（写普通 ref，幂等）——点击时刻读到的是最近一次提交的草稿。
		 */
		function InputDraftTap({ useInput, onSnapshot }) {
			const input = useInput((s) => s);
			onSnapshot(input);
			return null;
		}

		/**
		 * 会话桥（session 作用域；conversation.session.header.utilities 座位，
		 * 官方 session-log-export 同款注册形态）。零渲染高度：
		 * - 把 standard kit 能力面（inputActions、草稿快照、locale t）提升给 root 作用域
		 *   的浮层（kit 不注入 root 槽位组件，桥是唯一合法通道）；
		 * - 挂载时消费 pendingSeed —— fork 子会话预填引用块。
		 */
		function SessionBridge(props) {
			const sessionId = props.sessionId;
			const inputActions = props.inputActions;
			const useInput = props.useInput;
			const t = props.t;

			const draftRef = useRef("");
			const ready = Boolean(inputActions && useInput);

			// 每渲染把最新能力面同步给桥
			useEffect(() => {
				bridge.current = {
					sessionId,
					inputActions: inputActions ?? null,
					draft: () => draftRef.current,
					t,
				};
			});
			// 卸载清理（仅当仍是本会话占位时）
			useEffect(() => {
				return () => {
					if (bridge.current && bridge.current.sessionId === sessionId) bridge.current = null;
				};
			}, [sessionId]);

			// 消费 pendingSeed：fork 子会话首次挂载时预填引用块
			useEffect(() => {
				if (!pendingSeed || !inputActions) return;
				if (pendingSeed.childSessionId !== sessionId) return;
				const seed = pendingSeed;
				pendingSeed = null;
				const cur = draftRef.current;
				try {
					inputActions.setDraft(cur.trim() ? seed.quote + "\n" + cur : seed.quote);
				} catch (error) {
					toast(
						translate("toast.quoteFailed") +
							(error && error.message ? ` · ${error.message}` : ""),
					);
				}
			}, [sessionId, inputActions]);

			if (!ready) return null;
			return React.createElement(InputDraftTap, {
				useInput,
				onSnapshot: (s) => {
					draftRef.current = (s && s.draft) || "";
				},
			});
		}
		//#endregion

		//#region plugin exports
		const name = "dsh-btw";
		// remotes：settings.describe/mutate（Provider 高级配置面板）
		const inject = ["slots", "sessions", "workspaces", "@deepseek-ai/dsh-api-remotes", "@deepseek-ai/dsh-client-locale"];

		/**
		 * Client plugin body.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			hostCtx = ctx;
			loadBtws();

			// locale（可选服务）：注册插件字典，随 DSH 语言切换；缺失时组件内降级 zh
			const locale = ctx.get("locale") ?? ctx.get("@deepseek-ai/dsh-client-locale");
			if (locale && typeof locale.register === "function" && typeof locale.bind === "function") {
				localeSvc = locale;
				ctx.effect(() => locale.register(NS, DICT), "dsh-btw: dictionaries");
			}

			// 归档 watcher（root 级，随插件 fiber 卸载自动解除）
			ctx.effect(() => installArchiveWatcher(ctx), "dsh-btw: archive watcher");

			// 全局浮层（shell.overlay 由 ui-layout 声明；slots.inject 等声明就绪后再注册，
			// 与 bundle 顺序无关）
			ctx.effect(
				() =>
					ctx.slots.inject("shell.overlay", () =>
						ctx.slots.register(
							{ name: "shell.overlay", id: "dsh-btw", locale: NS },
							OverlayHost,
						),
					),
				"dsh-btw: overlay seat",
			);

			// 会话桥（header.utilities 由 ui-conversation 声明，session 作用域 → 收 kit 成员）
			ctx.effect(
				() =>
					ctx.slots.inject("conversation.session.header.utilities", () =>
						ctx.slots.register(
							{ name: "conversation.session.header.utilities", id: "dsh-btw", locale: NS },
							SessionBridge,
						),
					),
				"dsh-btw: session bridge seat",
			);

			// Provider 高级配置面板（settings.models.provider-card 由 ui-settings-models 声明）
			ctx.effect(
				() =>
					ctx.slots.inject("settings.models.provider-card", () =>
						ctx.slots.register(
							{ name: "settings.models.provider-card", id: "dsh-btw", locale: NS },
							BtwProviderConfig,
						),
					),
				"dsh-btw: provider config panel seat",
			);
		}

		module.exports = { name, inject, apply };
		return module.exports;
	},
});
