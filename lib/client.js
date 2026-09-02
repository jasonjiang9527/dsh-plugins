/* global window, document */
// dsh-drill — browser half (handwritten CJS factory for the dsh web ModuleLoader).
//
// 功能（design/02）：
//   1. 划选会话消息区文本 → 浮层 [引用提问] [钻取] [×]
//   2. 引用提问：引用块+来源头 预填当前会话输入框草稿（不发送）
//   3. 钻取：sessions.fork(选中节点 anchorSeq) → 自动切换到子会话并预填引用块；
//      离开该钻取会话时自动 workspace.archiveSession（running 时顺延，设置可关）
//
// 只走公开面：
//   - slots：shell.overlay（list/root，全局浮层）+ conversation.session.header.utilities
//     （list/session，官方 session-log-export 同款座位与注册形态）
//   - sessions standard kit：session 作用域槽位组件自动收到 useInput / inputActions /
//     sessionId / t（locale: NS 声明 + locale.register）
//   - ctx.sessions.{list,fork,open,binding} / ctx.workspaces.archiveSession
//   - 会话快照读：binding.session.getSnapshot()（SessionFace = ISession &
//     ObservableSnapshot<ConversationSnapshot>）→ chat.nodes.get(key).anchorSeq
//   - DOM 锚点（ui-conversation 自有 data 属性）：data-conversation-scroll /
//     data-chat-anchor-key；输入区 data-input-mirror / data-composer-seat 一并排除
//
// hooks 纪律：任何 hook 都不条件调用。useInput 由内层 InputDraftTap 无条件调用，
// 外层桥组件是否存在 kit 成员只决定"是否渲染子组件"，不改变 hook 数量。
window.__ModuleLoader__.load({
	id: "dsh-drill",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const { useState, useEffect, useRef, useCallback } = React;

		//#region constants & dictionaries
		const NS = "drill";
		/** 会话消息滚动容器（ui-conversation ChatView scrollerOf 同款判定）。 */
		const SEL_SCROLLER = "[data-conversation-scroll]";
		/** 每个聊天节点行的稳定锚（ChatNodeSeat 输出）。 */
		const SEL_NODE_ROW = "[data-chat-anchor-key]";
		/** 不触发浮层的区域：输入区镜像/座位 + 本插件浮层自身。 */
		const SEL_EXCLUDE =
			"[data-input-mirror],[data-composer-seat],[data-dsh-drill-toolbar]";

		const LS_AUTO_ARCHIVE = "dsh-drill:autoArchive";
		const LS_TRUNCATE = "dsh-drill:truncateChars";
		const LS_DRILLS = "dsh-drill:activeDrills";
		const DEFAULT_TRUNCATE = 2000;
		const MIN_SELECT_CHARS = 2;
		const PENDING_SEED_TTL_MS = 120000;

		const DICT = {
			zh: {
				"quote.label": "引用提问",
				"drill.label": "钻取",
				"close.label": "关闭",
				"quote.head": '> 🔖 引用自「{title}」· {time}',
				"drill.head": '> 🔖 Drill 焦点（fork 自「{title}」）',
				"toast.archived": "钻取会话已归档（不可逆）",
				"toast.archiveFailed": "钻取会话归档失败",
				"toast.quoteUnavailable": "当前会话输入框不可用",
				"toast.quoteFailed": "引用写入失败",
				"drill.failed": "钻取失败",
				"drill.titlePrefix": "钻取",
				"drill.runningTail": "选区位于进行中的回合，暂不能从这里钻取",
			},
			en: {
				"quote.label": "Quote to input",
				"drill.label": "Drill",
				"close.label": "Close",
				"quote.head": '> 🔖 Quoted from "{title}" · {time}',
				"drill.head": '> 🔖 Drill focus (forked from "{title}")',
				"toast.archived": "Drill session archived (irreversible)",
				"toast.archiveFailed": "Failed to archive the drill session",
				"toast.quoteUnavailable": "Composer unavailable for this session",
				"toast.quoteFailed": "Failed to write the quote",
				"drill.failed": "Drill failed",
				"drill.titlePrefix": "Drill",
				"drill.runningTail": "Selection is inside a running turn; drill unavailable here",
			},
		};
		//#endregion

		//#region module state (singletons)
		/** apply 时的 root ctx（sessions/workspaces 服务入口）。 */
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
		const activeDrills = new Map();
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
		function loadDrills() {
			try {
				const raw = JSON.parse(storageGet(LS_DRILLS, "[]"));
				if (Array.isArray(raw)) {
					for (const it of raw) {
						if (it && typeof it.childSessionId === "string") {
							activeDrills.set(it.childSessionId, it);
						}
					}
				}
			} catch {
				/* 损坏即弃 */
			}
		}
		function saveDrills() {
			try {
				storageSet(LS_DRILLS, JSON.stringify([...activeDrills.values()]));
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
			el.setAttribute("data-dsh-drill-toast", "");
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
				kind === "drill"
					? fill("drill.head", { title: sourceTitle }, t)
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

		async function drillFromSelection(info) {
			if (!info) return;
			const snap = hostCtx.sessions.list.getSnapshot();
			const sessionId = snap.current;
			if (!sessionId) return;
			if (info.atRunningTail) {
				toast(translate("drill.runningTail"));
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
				toast(translate("drill.failed") + reason);
				return;
			}
			// 子会话显式改名（不用 increaseTitle 的 " (1)" 后缀——它与源会话几乎无法
			// 区分，容易被误认为源会话被改名）。rename 会把标题钉住不被自动再生；
			// 失败仅影响观感，不阻断钻取。
			try {
				const child = hostCtx.sessions.binding?.(childId)?.session;
				const shortTitle = title.length > 20 ? title.slice(0, 20) + "…" : title;
				if (child) await child.rename(`🔍 ${translate("drill.titlePrefix")} · ${shortTitle}`);
			} catch {
				/* 非致命 */
			}
			pendingSeed = {
				childSessionId: childId,
				quote: buildQuote("drill", title, info.text, bridge.current && bridge.current.t),
				ts: Date.now(),
			};
			activeDrills.set(childId, { sourceSessionId: sessionId, createdAt: Date.now() });
			saveDrills();
			overlayApi && overlayApi.hide();
			hostCtx.sessions.open(childId);
		}
		//#endregion

		//#region auto-archive watcher (root scope, whole plugin lifetime)
		/**
		 * 订阅会话列表：当前选择离开"活跃钻取会话"时自动归档。
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
				if (!activeDrills.has(prev)) return;
				const row = snap.byId[prev];
				if (!row) {
					activeDrills.delete(prev);
					saveDrills();
					return;
				}
				if (row.running) return; // 顺延：等它空闲后再次被离开时归档
				ctx.workspaces
					.archiveSession(prev)
					.then(() => toast(translate("toast.archived")))
					.catch(() => toast(translate("toast.archiveFailed")))
					.finally(() => {
						activeDrills.delete(prev);
						saveDrills();
					});
			});
			return typeof unsubscribe === "function" ? unsubscribe : () => {};
		}
		//#endregion

		//#region components
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
					"data-dsh-drill-toolbar": "",
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
						title: info.atRunningTail ? label("drill.runningTail") : undefined,
						onClick: () => drillFromSelection(infoRef.current),
					},
					label("drill.label"),
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
		const name = "dsh-drill";
		// 仅声明必需服务；locale 为可选，apply 内 ctx.get 读取（教程 §4 / chat-import 同款）
		const inject = ["slots", "sessions", "workspaces"];

		/**
		 * Client plugin body.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			hostCtx = ctx;
			loadDrills();

			// locale（可选服务）：注册插件字典，随 DSH 语言切换；缺失时组件内降级 zh
			const locale = ctx.get("locale");
			if (locale && typeof locale.register === "function" && typeof locale.bind === "function") {
				localeSvc = locale;
				ctx.effect(() => locale.register(NS, DICT), "dsh-drill: dictionaries");
			}

			// 归档 watcher（root 级，随插件 fiber 卸载自动解除）
			ctx.effect(() => installArchiveWatcher(ctx), "dsh-drill: archive watcher");

			// 全局浮层（shell.overlay 由 ui-layout 声明；slots.inject 等声明就绪后再注册，
			// 与 bundle 顺序无关）
			ctx.effect(
				() =>
					ctx.slots.inject("shell.overlay", () =>
						ctx.slots.register(
							{ name: "shell.overlay", id: "dsh-drill", locale: NS },
							OverlayHost,
						),
					),
				"dsh-drill: overlay seat",
			);

			// 会话桥（header.utilities 由 ui-conversation 声明，session 作用域 → 收 kit 成员）
			ctx.effect(
				() =>
					ctx.slots.inject("conversation.session.header.utilities", () =>
						ctx.slots.register(
							{ name: "conversation.session.header.utilities", id: "dsh-drill", locale: NS },
							SessionBridge,
						),
					),
				"dsh-drill: session bridge seat",
			);
		}

		module.exports = { name, inject, apply };
		return module.exports;
	},
});
