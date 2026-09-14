// Static self-check for the dsh-btw plugin sources (repo-relative, no deps).
// 1. lib/client.js must parse as a classic script (ModuleLoader factory form).
// 2. lib/index.js must import cleanly as ESM (named exports contract).
// 3. package.json / cordis.patch.yml sanity.
// Run: node scripts/check.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, "")), "..");
let failed = false;

// 1) client.js — syntax parse as classic script
const clientSrc = fs.readFileSync(path.join(root, "lib/client.js"), "utf8");
try {
	new vm.Script(clientSrc, { filename: "client.js" });
	console.log("OK   lib/client.js parses as classic script");
} catch (error) {
	failed = true;
	console.error("FAIL lib/client.js:", error.message);
}

// 2) client.js — cheap structural assertions
const checks = [
	["window.__ModuleLoader__.load(", "ModuleLoader registration"],
	['id: "dsh-btw"', "module id"],
	["module.exports = { name, inject, apply };", "plugin export shape"],
	['"shell.overlay"', "overlay seat"],
	['"conversation.session.header.utilities"', "session bridge seat"],
	["ctx.slots.inject(", "declaration-aware registration"],
	["inputActions.setDraft(", "draft write via standard kit"],
	["archiveSession(", "auto-archive"],
	["sessions.fork(", "btw fork"],
	["useInput((s) => s)", "kit hook consumption"],
	['"settings.models.provider-card"', "provider config panel seat"],
	["key: SETTINGS_NS", "provider-card keyed registration (dsh >= 0.1.5)"],
	["settings.mutate(", "settings write RPC"],
	["settings.describe()", "settings read RPC (no-arg form)"],
	["llm-pi-ai", "provider namespace"],
	['"remote.settings"', "remote.<namespace> child service injected"],
	["useChat((s) => s.nodes)", "chat node face via session standard kit"],
	["anchorOf", "fork anchor resolver lifted to root scope"],
	['"conversation.input.left"', "new-context button seat"],
	['face.command("/newcontext")', "new-context trigger via ISession.command"],
];
for (const [needle, label] of checks) {
	if (clientSrc.includes(needle)) console.log(`OK   ${label}`);
	else {
		failed = true;
		console.error(`FAIL missing: ${label} (${needle})`);
	}
}

// 2b) inject must name SERVICES, never packages: a package name there leaves the
// plugin waiting for a service that will never appear, so apply() never runs.
if (/const inject = \[[^\]]*"@/.test(clientSrc)) {
	failed = true;
	console.error("FAIL inject[] contains a package name; Cordis inject takes service keys");
} else console.log("OK   inject[] holds service keys only");

// 2c) i18n coverage: every translate("key") must exist in BOTH dictionaries —
// a missing key silently falls back to Chinese and is invisible in review.
{
	const dictStart = clientSrc.indexOf("const DICT = {");
	const enAt = dictStart < 0 ? -1 : clientSrc.indexOf("\n\t\t\ten: {", dictStart);
	const dictEnd = dictStart < 0 ? -1 : clientSrc.indexOf("\n\t\t};", dictStart);
	if (dictStart < 0 || enAt < 0 || dictEnd < 0) {
		failed = true;
		console.error("FAIL cannot locate the DICT zh/en blocks");
	} else {
		const keysOf = (text) => new Set([...text.matchAll(/^\t*"([^"]+)":/gm)].map((m) => m[1]));
		const zhKeys = keysOf(clientSrc.slice(dictStart, enAt));
		const enKeys = keysOf(clientSrc.slice(enAt, dictEnd));
		const used = new Set([...clientSrc.matchAll(/translate\(\s*"([^"]+)"/g)].map((m) => m[1]));
		const missing = [];
		for (const key of used) {
			if (!zhKeys.has(key)) missing.push(`zh:${key}`);
			if (!enKeys.has(key)) missing.push(`en:${key}`);
		}
		if (missing.length > 0) {
			failed = true;
			console.error(`FAIL i18n keys missing: ${missing.join(", ")}`);
		} else {
			console.log(`OK   i18n keys covered (${used.size} used, zh ${zhKeys.size} / en ${enKeys.size} declared)`);
		}
	}
}

// 3) index.js — ESM import + named exports
try {
	const mod = await import(pathToFileURL(path.join(root, "lib/index.js")).href);
	if (mod.name !== "dsh-btw") throw new Error(`unexpected name: ${mod.name}`);
	if (typeof mod.apply !== "function") throw new Error("apply is not a function");
	if (mod.COMMAND_NAME !== "newcontext") throw new Error(`unexpected COMMAND_NAME: ${mod.COMMAND_NAME}`);
	console.log("OK   lib/index.js imports as ESM; name/apply/COMMAND_NAME present");
} catch (error) {
	failed = true;
	console.error("FAIL lib/index.js:", error.message);
}
// 宿主半边的 surface 替换契约由 scripts/check-newcontext.mjs 用真实
// dsh-session 的 foldSurface 验证（另跑一条命令）。

// 4) package.json / patch sanity
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (pkg.exports["./client"]?.default !== "./lib/client.js") {
	failed = true;
	console.error("FAIL package.json exports[./client]");
} else console.log("OK   package.json exports[./client]");
if (pkg.dsh?.client?.platform !== "web") {
	failed = true;
	console.error("FAIL package.json dsh.client.platform");
} else console.log("OK   package.json dsh.client.platform = web");
const patch = fs.readFileSync(path.join(root, "cordis.patch.yml"), "utf8");
if (!patch.includes("name: dsh-btw")) {
	failed = true;
	console.error("FAIL cordis.patch.yml insert");
} else console.log("OK   cordis.patch.yml insert");

process.exit(failed ? 1 : 0);
