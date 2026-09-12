/**
 * Assemble a side-by-side comparison of pi's system prompt against the prompts
 * captured from Claude Code and Kimi Code, plus Codex's static templates.
 *
 * Sources:
 *   - pi:     buildSystemPrompt() rendered for an empty directory (base prompt)
 *   - Claude: examples/system-prompts-captured/claude/system-prompt.md (proxy capture)
 *   - Kimi:   examples/system-prompts-captured/kimi/system-prompt.md   (proxy capture)
 *   - Codex:  examples/system-prompts/codex.md                        (static template)
 *
 * Usage (run from packages/coding-agent):
 *   node examples/system-prompt-side-by-side.ts [--out <file>]
 *
 * The generated document is gitignored (it contains other vendors' prompts).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

const DEMO_CWD = process.env.PI_EXAMPLE_CWD ?? "/tmp/empty-project";

// Real tool prompt contributions (mirroring src/core/tools/*.ts) so pi's prompt
// renders with the default read/bash/edit/write toolset.
const TOOL_CONTRIBUTIONS: Record<string, { snippet: string; guidelines: string[] }> = {
	read: {
		snippet: "Read file contents",
		guidelines: ["Use read to examine files instead of cat or sed."],
	},
	bash: {
		snippet: "Execute bash commands (ls, grep, find, etc.)",
		guidelines: ["You can inspect PI_* environment variables for current model and session details."],
	},
	edit: {
		snippet: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
		guidelines: [
			"Use edit for precise changes (edits[].oldText must match exactly)",
			"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
			"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
			"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
		],
	},
	write: {
		snippet: "Create or overwrite files",
		guidelines: ["Use write only for new files or complete rewrites."],
	},
};

function toolPromptOptions(toolNames: string[]): {
	selectedTools: string[];
	toolSnippets: Record<string, string>;
	promptGuidelines: string[];
} {
	const toolSnippets: Record<string, string> = {};
	const promptGuidelines: string[] = [];
	for (const name of toolNames) {
		const contribution = TOOL_CONTRIBUTIONS[name];
		if (!contribution) continue;
		toolSnippets[name] = contribution.snippet;
		promptGuidelines.push(...contribution.guidelines);
	}
	return { selectedTools: toolNames, toolSnippets, promptGuidelines };
}

function piPrompt(): string {
	return buildSystemPrompt({ cwd: DEMO_CWD, ...toolPromptOptions(["read", "bash", "edit", "write"]) });
}

// ---------------------------------------------------------------------------
// Artifact readers
// ---------------------------------------------------------------------------

function readIfExists(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

/** Strip a leading frontmatter block and the first `# ` heading from a .md artifact. */
function stripArtifact(text: string): string {
	let out = text;
	if (out.startsWith("---")) {
		const end = out.indexOf("\n---", 3);
		if (end !== -1) out = out.slice(end + 4);
	}
	out = out.replace(/^# .*\n/gm, "");
	return out.trim();
}

/** Pull one `## variant-N` section out of the codex.md artifact. */
function codexVariant(text: string, n: number): string {
	const start = text.indexOf(`## variant-${n}`);
	if (start === -1) return "";
	const next = text.indexOf("\n## variant-", start + 1);
	const section = next === -1 ? text.slice(start) : text.slice(start, next);
	return section
		.replace(/^## variant-\d+\n+/gm, "")
		.replace(/^\*\*First line:\*\*.*\n/gm, "")
		.replace(/^\*\*Length:\*\*.*\n/gm, "")
		.trim();
}

function escapeAngleBrackets(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Comparison metadata (hand-curated; the raw texts are injected below)
// ---------------------------------------------------------------------------

const DIMENSIONS: Array<{ dimension: string; cells: [string, string, string, string] }> = [
	{
		dimension: "Identity",
		cells: [
			"expert coding assistant operating inside pi, a coding agent harness",
			"You are Claude Code, Anthropic's official CLI for Claude / a Claude agent on the Claude Agent SDK",
			"You are Codex, a coding agent based on GPT-5",
			"You are Kimi Code CLI, an interactive general AI agent running on a user's computer",
		],
	},
	{
		dimension: "Tools",
		cells: [
			"4 built-in (read, bash, edit, write)",
			"24 tool definitions in the request",
			"tool schemas injected at runtime (not in the static template)",
			"24 tool definitions in the request",
		],
	},
	{
		dimension: "Project context convention",
		cells: [
			"AGENTS.md (global + project, ancestor walk)",
			"CLAUDE.md plus a persistent memory directory",
			"AGENTS.md (also falls back to CLAUDE.md / CLAUDE.local.md)",
			"AGENTS.md + skills dirs",
		],
	},
	{
		dimension: "Personality / voice section",
		cells: [
			"none (terse instructions only)",
			"none in the system prompt",
			"`{{ personality }}` slot, rendered per profile",
			"none",
		],
	},
	{
		dimension: "Safety / authorization rules",
		cells: [
			"none in the prompt (enforced by the harness permission layer)",
			"security-testing policy + permission-mode framing",
			"destructive-command, dirty-worktree, and credential rules",
			"tool-use and task-action rules (no explicit security-testing policy)",
		],
	},
	{
		dimension: "Output formatting rules",
		cells: [
			"be concise; show file paths clearly",
			"GFM terminal rendering, clickable file:line references",
			"GFM, flat lists only, clickable file links",
			"reply in the user's language; concise user-visible prose",
		],
	},
	{
		dimension: "Runtime injection",
		cells: [
			"AGENTS.md files, skills, SYSTEM.md / APPEND_SYSTEM.md",
			"memory dir path, tools, billing header, mid-conversation system turns",
			"tools, AGENTS.md, personality",
			"ROLE_ADDITIONAL slot, tools, skills, date reminders",
		],
	},
];

// ---------------------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------------------

function frontmatter(fields: Record<string, string>): string {
	const body = Object.entries(fields)
		.map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
		.join("\n");
	return `---\n${body}\n---\n`;
}

function main(): void {
	const args = process.argv.slice(2);
	const outIndex = args.indexOf("--out");
	const outFile =
		outIndex !== -1 ? args[outIndex + 1] : join(process.cwd(), "examples", "system-prompts-side-by-side.md");

	const base = join(process.cwd(), "examples");

	const pi = piPrompt();
	const claude = stripArtifact(
		readIfExists(join(base, "system-prompts-captured", "claude", "system-prompt.md")) ?? "",
	);
	const kimi = stripArtifact(readIfExists(join(base, "system-prompts-captured", "kimi", "system-prompt.md")) ?? "");
	const codex = codexVariant(readIfExists(join(base, "system-prompts", "codex.md")) ?? "", 1);

	const sections: Array<{ name: string; text: string }> = [
		{ name: "pi", text: pi },
		{ name: "Claude Code", text: claude },
		{ name: "Codex", text: codex },
		{ name: "Kimi Code", text: kimi },
	];

	const tableHeader = "| Dimension | pi | Claude Code | Codex | Kimi Code |\n|---|---|---|---|---|";
	const tableRows = DIMENSIONS.map((d) => `| ${d.dimension} | ${d.cells.join(" | ")} |`).join("\n");

	const lengthRow = `| Prompt length (chars) | ${sections.map((s) => (s.text ? String(s.text.length) : "n/a")).join(" | ")} |`;

	const body = sections
		.map((s) => {
			const missing = s.text.length === 0 ? "\n\n_Not available — run the extract/capture steps first._" : "";
			return `## ${s.name}\n\n${escapeAngleBrackets(s.text)}${missing}\n`;
		})
		.join("\n");

	const header = frontmatter({
		title: "System prompts, side by side",
		description:
			"pi (rendered from source) vs Claude Code and Kimi Code (proxy captures) vs Codex (static template).",
		"generated-by": "examples/system-prompt-side-by-side.ts",
	});
	const doc = `${header}\n# System prompts, side by side\n\n${tableHeader}\n${lengthRow}\n${tableRows}\n\n${body}\n`;

	writeFileSync(outFile, doc);
	console.log(`Wrote ${outFile}`);
}

main();
