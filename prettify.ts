/**
 * Prettify — Pi coding agent input field extension.
 *
 * Two flavors: "frame" (full box-drawing frame) and "bar" (left thick bar).
 * Switch via `/prettify frame` or `/prettify bar`.
 * Toggle stats via `/prettify show <stat>` or `/prettify hide <stat>`.
 *
 * Available stats: model, session, mode, thinking, tps, cost, context, cwd, git, version
 *
 * Layout (both flavors):
 *   top    → model (provider)               [left]   session name [right]
 *   middle → "> " prompt + editor text
 *   bottom → mode · thinking                [left]   tps · cost · context [right]
 *   footer → cwd · git                      [left]   version [right]   (below the box)
 *
 * The frame/bar is coloured by mode (accent for exec, warning for plan); the
 * context bar is coloured by fill (success → warning → error). All colours come
 * from the active theme.
 *
 * Load:
 *   pi -e ./prettify.ts
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	CustomEditor,
	VERSION,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ThinkingLevel } from "@earendil-works/pi-ai";

// ─── Types & config ─────────────────────────────────────────────────────

type Flavor = "frame" | "bar";

type StatKey =
	| "model"
	| "session"
	| "mode"
	| "thinking"
	| "tps"
	| "cost"
	| "context"
	| "cwd"
	| "git"
	| "version";

const ALL_STATS: StatKey[] = [
	"model",
	"session",
	"mode",
	"thinking",
	"tps",
	"cost",
	"context",
	"cwd",
	"git",
	"version",
];

interface PrettifyConfig {
	flavor: Flavor;
	visible: Set<StatKey>;
}

const config: PrettifyConfig = { flavor: "frame", visible: new Set(ALL_STATS) };

const VERSION_LABEL = `pi ${VERSION}`;

// Git status glyphs (starship-inspired). Edit to taste / match your font.
const GIT_SYMBOLS = {
	ahead: "⇡",
	behind: "⇣",
	staged: "+",
	modified: "!",
	renamed: "»",
	deleted: "󰧧",
	untracked: "󱀣",
	conflicted: "󱠇",
	stashed: "*",
};

interface GitInfo {
	branch: string;
	ahead: number;
	behind: number;
	staged: number;
	modified: number;
	deleted: number;
	renamed: number;
	untracked: number;
	conflicted: number;
	stashed: number;
	state: string;
}

// ─── State ────────────────────────────────────────────────────────────────

let activeTui: { requestRender: () => void } | undefined;
let currentModelLabel = "";
let currentThinking: ThinkingLevel = "off";
let lastTps = 0;
let sessionCost = 0;
let currentCwd = "";
let gitInfo: GitInfo | null = null;

// TPS tracking
let tpsTokenCount = 0;
let tpsStartTime = 0;
let tpsInterval: ReturnType<typeof setInterval> | undefined;

function startTpsTracking(): void {
	tpsTokenCount = 0;
	tpsStartTime = Date.now();
	if (!tpsInterval) {
		tpsInterval = setInterval(() => {
			const elapsed = (Date.now() - tpsStartTime) / 1000;
			if (elapsed > 0 && tpsTokenCount > 0) {
				lastTps = Math.round(tpsTokenCount / elapsed);
			}
			activeTui?.requestRender();
		}, 500);
	}
}

function stopTpsTracking(): void {
	if (tpsInterval) {
		clearInterval(tpsInterval);
		tpsInterval = undefined;
	}
	const elapsed = (Date.now() - tpsStartTime) / 1000;
	if (elapsed > 0 && tpsTokenCount > 0) {
		lastTps = Math.round(tpsTokenCount / elapsed);
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function formatCwd(cwd: string): string {
	const home = process.env.HOME;
	if (home && cwd.startsWith(home)) {
		return `~${cwd.slice(home.length)}`;
	}
	return cwd;
}

function formatThinking(level: string): string {
	return level === "off" ? "thinking off" : `thinking ${level}`;
}

function formatTokens(n: number): string {
	return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
}

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

// A border line from the base editor is made up only of ─ ━ (and the optional
// "↑ N more" / "↓ N more" scroll indicator). Used to locate the bottom border,
// since the autocomplete dropdown appends extra lines after it.
const isBorderLine = (s: string): boolean =>
	stripAnsi(s)
		.replace(/[─━↑↓\d ]/g, "")
		.replace(/more/g, "")
		.length === 0;

function findBottomBorderIndex(lines: string[]): number {
	for (let i = lines.length - 1; i >= 1; i--) {
		if (isBorderLine(lines[i]!)) return i;
	}
	return lines.length - 1;
}

function padTo(text: string, width: number): string {
	const w = visibleWidth(text);
	if (w === width) return text;
	if (w < width) return text + " ".repeat(width - w);
	return truncateToWidth(text, width);
}

function gitSegment(): string {
	if (!gitInfo) return "no git";
	const g = gitInfo;
	const parts = [g.branch || "(detached)"];
	if (g.state) parts.push(g.state);
	if (g.ahead) parts.push(`${GIT_SYMBOLS.ahead}${g.ahead}`);
	if (g.behind) parts.push(`${GIT_SYMBOLS.behind}${g.behind}`);
	if (g.staged) parts.push(`${GIT_SYMBOLS.staged}${g.staged}`);
	if (g.modified) parts.push(`${GIT_SYMBOLS.modified}${g.modified}`);
	if (g.renamed) parts.push(`${GIT_SYMBOLS.renamed}${g.renamed}`);
	if (g.deleted) parts.push(`${GIT_SYMBOLS.deleted}${g.deleted}`);
	if (g.untracked) parts.push(`${GIT_SYMBOLS.untracked}${g.untracked}`);
	if (g.conflicted) parts.push(`${GIT_SYMBOLS.conflicted}${g.conflicted}`);
	if (g.stashed) parts.push(`${GIT_SYMBOLS.stashed}${g.stashed}`);
	return parts.join(" ");
}

// ─── Extension Entry Point ───────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	function isValidStat(key: string): key is StatKey {
		return (ALL_STATS as string[]).includes(key);
	}

	async function refreshGit(): Promise<void> {
		const cwd = currentCwd;
		if (!cwd) return;
		const status = await pi
			.exec("git", ["status", "--porcelain=2", "--branch"], { cwd, timeout: 5000 })
			.catch(() => undefined);
		if (!status || status.code !== 0) {
			gitInfo = null;
			activeTui?.requestRender();
			return;
		}

		const info: GitInfo = {
			branch: "",
			ahead: 0,
			behind: 0,
			staged: 0,
			modified: 0,
			deleted: 0,
			renamed: 0,
			untracked: 0,
			conflicted: 0,
			stashed: 0,
			state: "",
		};
		let oid = "";
		for (const line of status.stdout.split("\n")) {
			if (line.startsWith("# branch.head ")) info.branch = line.slice(14).trim();
			else if (line.startsWith("# branch.oid ")) oid = line.slice(13).trim();
			else if (line.startsWith("# branch.ab ")) {
				const m = line.match(/\+(\d+)\s+-(\d+)/);
				if (m) {
					info.ahead = Number(m[1]);
					info.behind = Number(m[2]);
				}
			} else if (line.startsWith("1 ") || line.startsWith("2 ")) {
				const x = line[2];
				const y = line[3];
				if (line.startsWith("2 ")) info.renamed++;
				else if (x && x !== ".") info.staged++;
				if (y === "M") info.modified++;
				else if (y === "D") info.deleted++;
			} else if (line.startsWith("u ")) info.conflicted++;
			else if (line.startsWith("? ")) info.untracked++;
		}
		if ((!info.branch || info.branch === "(detached)") && oid && oid !== "(initial)") {
			info.branch = oid.slice(0, 7);
		}

		const stash = await pi.exec("git", ["stash", "list"], { cwd, timeout: 5000 }).catch(() => undefined);
		if (stash?.code === 0 && stash.stdout) {
			info.stashed = stash.stdout.split("\n").filter(Boolean).length;
		}

		const gd = await pi
			.exec("git", ["rev-parse", "--absolute-git-dir"], { cwd, timeout: 5000 })
			.catch(() => undefined);
		if (gd?.code === 0 && gd.stdout) {
			const dir = gd.stdout.trim();
			if (existsSync(join(dir, "rebase-merge")) || existsSync(join(dir, "rebase-apply"))) info.state = "REBASING";
			else if (existsSync(join(dir, "MERGE_HEAD"))) info.state = "MERGING";
			else if (existsSync(join(dir, "CHERRY_PICK_HEAD"))) info.state = "CHERRY-PICKING";
			else if (existsSync(join(dir, "REVERT_HEAD"))) info.state = "REVERTING";
			else if (existsSync(join(dir, "BISECT_LOG"))) info.state = "BISECTING";
		}

		gitInfo = info;
		activeTui?.requestRender();
	}

	// ── Command ───────────────────────────────────────────────────────

	pi.registerCommand("prettify", {
		description: "Configure prettify. Usage: /prettify [frame|bar|show <stat>|hide <stat>]",
		handler: async (args, ctx) => {
			const parts = (args || "").trim().split(/\s+/).filter(Boolean);
			if (parts.length === 0) {
				const vis = [...config.visible].join(", ");
				ctx.ui.notify(`prettify: ${config.flavor} mode | visible: ${vis}`, "info");
				return;
			}

			const cmd = parts[0]!;
			if (cmd === "frame" || cmd === "bar") {
				config.flavor = cmd;
				ctx.ui.notify(`prettify: switched to ${cmd} mode`, "info");
				activeTui?.requestRender();
				return;
			}
			if ((cmd === "show" || cmd === "hide") && parts[1]) {
				const key = parts[1];
				if (!isValidStat(key)) {
					ctx.ui.notify(`prettify: unknown stat "${key}"`, "warning");
					return;
				}
				if (cmd === "show") config.visible.add(key);
				else config.visible.delete(key);
				ctx.ui.notify(`prettify: ${cmd === "show" ? "showing" : "hiding"} "${key}"`, "info");
				activeTui?.requestRender();
				return;
			}
			ctx.ui.notify(
				`prettify: unknown command "${cmd}". Try: frame, bar, show <stat>, hide <stat>`,
				"warning",
			);
		},
	});

	// ── Events ────────────────────────────────────────────────────────

	pi.on("agent_start", () => {
		startTpsTracking();
		activeTui?.requestRender();
	});

	pi.on("agent_end", () => {
		stopTpsTracking();
		void refreshGit();
		activeTui?.requestRender();
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role === "assistant") {
			const msg = event.message as any;
			if (msg.usage) {
				tpsTokenCount = (msg.usage.output || 0) + (msg.usage.input || 0) + (msg.usage.thinking || 0);
				sessionCost += msg.usage.cost?.total || 0;
			}
		}
		activeTui?.requestRender();
	});

	pi.on("thinking_level_select", (event) => {
		currentThinking = event.level;
		activeTui?.requestRender();
	});

	pi.on("model_select", (event) => {
		const m = event.model;
		currentModelLabel = `${m.id} (${m.provider})`;
		activeTui?.requestRender();
	});

	pi.on("session_start", (_event, ctx) => {
		currentThinking = pi.getThinkingLevel();
		currentModelLabel = ctx.model ? `${ctx.model.id} (${ctx.model.provider})` : "no model";
		currentCwd = ctx.cwd;

		// Session cost = sum of assistant message costs (restored on resume).
		let cost = 0;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && (entry as any).message?.role === "assistant") {
				cost += (entry as any).message.usage?.cost?.total || 0;
			}
		}
		sessionCost = cost;

		void refreshGit();
		ctx.ui.setWorkingVisible(false);


		// ── Stat groups (capture ctx via closure) ──────────────────────

		const getMode = (): { label: string; color: string } => {
			let plan = false;
			try {
				const active = new Set(pi.getActiveTools());
				plan = !active.has("edit") && !active.has("write");
			} catch {
				plan = false;
			}
			return plan ? { label: "plan", color: "warning" } : { label: "exec", color: "accent" };
		};

		const getCtxInfo = (): { pct: number; used: number; cw: number } | null => {
			const usage = ctx.getContextUsage();
			const cw = usage?.contextWindow ?? ctx.model?.contextWindow ?? null;
			if (!cw || !usage || usage.percent === null || usage.percent === undefined) return null;
			return { pct: Math.round(usage.percent), used: (usage as any).tokens ?? 0, cw };
		};

		// "{pct}% ━━━──────── {used}/{total}" coloured by fill level.
		const ctxString = (info: { pct: number; used: number; cw: number }): string => {
			const thm = ctx.ui.theme;
			const barW = 10;
			const filled = Math.max(0, Math.min(barW, Math.round((info.pct / 100) * barW)));
			const col = info.pct < 50 ? "success" : info.pct < 80 ? "warning" : "error";
			const bar = thm.fg(col, "━".repeat(filled)) + thm.fg("dim", "─".repeat(barW - filled));
			return `${thm.fg(col, `${info.pct}%`)} ${bar} ${thm.fg("dim", `${formatTokens(info.used)}/${formatTokens(info.cw)}`)}`;
		};

		const topLeft = (): string => {
			const thm = ctx.ui.theme;
			return config.visible.has("model") ? thm.fg("text", currentModelLabel) : "";
		};
		const shorten = (s: string, max = 32): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
		const topRight = (): string => {
			const thm = ctx.ui.theme;
			const summary = pi.getSessionName?.();
			return config.visible.has("session") && summary ? thm.fg("dim", shorten(summary)) : "";
		};
		const bottomLeft = (sep: string): string => {
			const thm = ctx.ui.theme;
			const mode = getMode();
			const items: string[] = [];
			if (config.visible.has("mode")) items.push(thm.fg(mode.color, mode.label));
			if (config.visible.has("thinking")) items.push(thm.fg("dim", formatThinking(currentThinking)));
			return items.join(sep);
		};
		const bottomRight = (sep: string): string => {
			const thm = ctx.ui.theme;
			const items: string[] = [];
			if (config.visible.has("tps") && lastTps > 0) items.push(thm.fg("dim", `${lastTps} t/s`));
			if (config.visible.has("cost") && sessionCost > 0) items.push(thm.fg("dim", `${sessionCost.toFixed(3)}$`));
			if (config.visible.has("context")) {
				const info = getCtxInfo();
				if (info) items.push(ctxString(info));
			}
			return items.join(sep);
		};

		// Apply a background colour across an entire string, re-asserting it after
		// any embedded reset (\x1b[0m) so the fill survives styled text / cursor.
		const bgFill = (text: string, key: string): string => {
			const thm = ctx.ui.theme;
			const probe = thm.bg(key, " ");
			const i = probe.indexOf(" ");
			if (i < 0) return thm.bg(key, text);
			const prefix = probe.slice(0, i);
			const suffix = probe.slice(i + 1);
			const patched = text.replace(/\x1b\[0m/g, (m) => m + prefix);
			return prefix + patched + suffix;
		};

		// ── Frame flavor ──────────────────────────────────────────────

		const frameBorder = (
			cornerL: string,
			cornerR: string,
			left: string,
			right: string,
			width: number,
			fc: (t: string) => string,
		): string => {
			let l = left;
			let r = right;
			const fillFor = () =>
				visibleWidth(r) > 0
					? width - (visibleWidth(l) + visibleWidth(r) + 8)
					: width - (visibleWidth(l) + 6);
			while (fillFor() < 1 && visibleWidth(r) > 0) r = truncateToWidth(r, Math.max(0, visibleWidth(r) - 1), "");
			while (fillFor() < 1 && visibleWidth(l) > 0) l = truncateToWidth(l, Math.max(0, visibleWidth(l) - 1), "");
			const fill = fc("─".repeat(Math.max(0, fillFor())));
			if (visibleWidth(r) > 0) {
				return `${fc(cornerL)}${fc("─")} ${l} ${fill} ${r} ${fc("─")}${fc(cornerR)}`;
			}
			return `${fc(cornerL)}${fc("─")} ${l} ${fill}${fc("─")}${fc(cornerR)}`;
		};

		const renderFrame = (lines: string[], width: number): string[] => {
			const thm = ctx.ui.theme;
			const mode = getMode();
			const fc = (t: string) => thm.fg(mode.color, t);
			const sep = fc(" ── ");
			const bottomIdx = findBottomBorderIndex(lines);

			lines[0] = frameBorder("╭", "╮", topLeft(), topRight(), width, fc);
			for (let i = 1; i < bottomIdx; i++) {
				const prompt = thm.fg(mode.color, i === 1 ? "> " : "  ");
				lines[i] = `${fc("│")} ${prompt}${lines[i]} ${fc("│")}`;
			}
			lines[bottomIdx] = frameBorder("╰", "╯", bottomLeft(sep), bottomRight(sep), width, fc);
			return lines;
		};

		// ── Bar flavor ────────────────────────────────────────────────

		// One bar row: " " + ▐ + dark-grey box + ▌ + " " — symmetric half-block edges.
		const barRow = (inner: string, width: number, fc: (t: string) => string): string => {
			const thm = ctx.ui.theme;
			// ▌ uses toolPendingBg as foreground (left half filled), default bg (right half transparent)
			const bgAnsi = thm.getBgAnsi("toolPendingBg");
			const fgAnsi = bgAnsi.replace("48", "38");
			return ` ${fc("▐")}${bgFill(padTo(inner, width - 4), "toolPendingBg")}${fgAnsi}▌\x1b[39m `;
		};

		const renderBar = (lines: string[], width: number): string[] => {
			const thm = ctx.ui.theme;
			const mode = getMode();
			const fc = (t: string) => thm.fg(mode.color, t);
			const sep = " · ";
			const bottomIdx = findBottomBorderIndex(lines);
			const innerW = width - 4;

			const tl = topLeft();
			const tr = topRight();
			const topGap = Math.max(1, innerW - 2 - visibleWidth(tl) - visibleWidth(tr));
			lines[0] = barRow(` ${tl}${" ".repeat(topGap)}${tr} `, width, fc);

			for (let i = 1; i < bottomIdx; i++) {
				const prompt = thm.fg(mode.color, i === 1 ? "> " : "  ");
				lines[i] = barRow(` ${prompt}${lines[i]}`, width, fc);
			}

			const bl = bottomLeft(sep);
			const br = bottomRight(sep);
			const botGap = Math.max(1, innerW - 2 - visibleWidth(bl) - visibleWidth(br));
			lines[bottomIdx] = barRow(` ${bl}${" ".repeat(botGap)}${br} `, width, fc);
			return lines;
		};

		// ── Footer (below the box): cwd · git [left] ... version [right] ──

		const makeFooter = (footerData: any) => {
			const unsub = footerData?.onBranchChange?.(() => {
				void refreshGit();
			});
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					const thm = ctx.ui.theme;
					const left: string[] = [];
					if (config.visible.has("cwd")) left.push(formatCwd(ctx.cwd));
					if (config.visible.has("git")) left.push(gitSegment());
					const leftStr = thm.fg("dim", ` ${left.join("  ")}`);
					const rightStr = config.visible.has("version") ? thm.fg("dim", `${VERSION_LABEL} `) : "";
					const gap = Math.max(1, width - visibleWidth(leftStr) - visibleWidth(rightStr));
					return ["", `${leftStr}${" ".repeat(gap)}${rightStr}`];
				},
			};
		};

		// ── Install (compose, don't clobber) ──────────────────────────
		// Other extensions (e.g. raw-paste) also call setEditorComponent/setFooter
		// in their session_start. Rather than fight over who runs last, we WRAP
		// whatever editor is currently installed and decorate its rendered lines.
		// Deferred to a timer so this runs after every other extension's
		// session_start has installed its own editor.
		const installUI = () => {
			ctx.ui.setFooter((_tui: any, _theme: any, footerData: any) => makeFooter(footerData));

			const prev = ctx.ui.getEditorComponent() as
				| ((tui: any, theme: any, keybindings: any) => EditorComponent)
				| undefined;

			// Don't re-wrap our own wrapper (e.g. across /reload when nobody else
			// reset the editor) — that would stack decorations.
			if (prev && (prev as any).__prettify) return;

			const factory = (tui: any, theme: any, keybindings: any): EditorComponent => {
				const base: any = prev
					? prev(tui, theme, keybindings)
					: new CustomEditor(tui, theme, keybindings, { paddingX: 0 });
				activeTui = tui;

				// We manage horizontal gutters ourselves, so neutralise the inner
				// editor's padding (and ignore the runtime's later attempts to set it).
				base.paddingX = 0;
				base.setPaddingX = () => {};

				const baseRender = base.render.bind(base);
				base.render = (width: number): string[] => {
					// Reserve columns for our frame/bar + prompt, then decorate.
					// frame: │ + " " + "> " + text + " " + │  → text width = width - 6
					// bar:   " " + ▐ + "> " + text + ▐ + " "  → text width = width - 7
					if (width < 12) return baseRender(width);
					const reserve = config.flavor === "bar" ? 7 : 6;
					const lines = baseRender(width - reserve);
					if (lines.length < 2) return baseRender(width);
					return config.flavor === "bar" ? renderBar(lines, width) : renderFrame(lines, width);
				};
				return base;
			};
			(factory as any).__prettify = true;

			ctx.ui.setEditorComponent(factory);
			activeTui?.requestRender();
		};

		setTimeout(installUI, 0);
	});

	pi.on("session_shutdown", () => {
		stopTpsTracking();
		activeTui = undefined;
	});
}
