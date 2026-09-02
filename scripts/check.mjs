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
];
for (const [needle, label] of checks) {
	if (clientSrc.includes(needle)) console.log(`OK   ${label}`);
	else {
		failed = true;
		console.error(`FAIL missing: ${label} (${needle})`);
	}
}

// 3) index.js — ESM import + named exports
try {
	const mod = await import(pathToFileURL(path.join(root, "lib/index.js")).href);
	if (mod.name !== "dsh-btw") throw new Error(`unexpected name: ${mod.name}`);
	if (typeof mod.apply !== "function") throw new Error("apply is not a function");
	console.log("OK   lib/index.js imports as ESM; name/apply present");
} catch (error) {
	failed = true;
	console.error("FAIL lib/index.js:", error.message);
}

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
