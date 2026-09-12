#!/usr/bin/env node
/**
 * Extract system-prompt text embedded in other coding-agent binaries so it can
 * be read side-by-side with pi's buildSystemPrompt output.
 *
 * Supported:
 *   - Kimi Code CLI  (~/.kimi-code/bin/kimi): full prompt is one JS string
 *   - Codex (OpenAI) : full prompt(s) in `instructions_template` JSON strings
 *   - Claude Code    : prompt is assembled at runtime in minified JS, so only
 *                      the identity strings and sub-agent fragments are
 *                      statically recoverable (see the claude.md notes)
 *
 * Usage:
 *   node examples/extract-system-prompts.mjs [--out <dir>]
 *
 * Binaries are auto-discovered; override with:
 *   CLAUDE_BIN=/path/to/claude CODEX_BIN=/path/to/codex KIMI_BIN=/path/to/kimi
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function resolveClaude() {
	if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
	const link = join(homedir(), ".local", "bin", "claude");
	try {
		const target = readlinkSync(link);
		return target.startsWith("/") ? target : join(dirname(link), target);
	} catch {}
	const versions = join(homedir(), ".local", "share", "claude", "versions");
	if (existsSync(versions)) {
		const entries = readdirSync(versions).sort();
		if (entries.length > 0) return join(versions, entries[entries.length - 1]);
	}
	return link;
}

function resolveCodex() {
	if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
	try {
		return execFileSync("which", ["codex"], { encoding: "utf8" }).trim().split("\n")[0];
	} catch {}
	const base = join(homedir(), ".local", "share", "mise", "installs", "github-alleneubank-codex");
	if (existsSync(base)) {
		const entries = readdirSync(base).sort();
		if (entries.length > 0) return join(base, entries[entries.length - 1], "codex");
	}
	return undefined;
}

function resolveKimi() {
	return process.env.KIMI_BIN ?? join(homedir(), ".kimi-code", "bin", "kimi");
}

// ---------------------------------------------------------------------------
// Extraction primitives
// ---------------------------------------------------------------------------

function decodeEscapes(text) {
	return text.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|n|t|r|b|f|v|0|"|'|\\|\/)/g, (match, esc) => {
		if (esc[0] === "u" || esc[0] === "x") {
			return String.fromCodePoint(Number.parseInt(esc.slice(1), 16));
		}
		const map = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0", '"': '"', "'": "'", "\\": "\\", "/": "/" };
		return map[esc] ?? match;
	});
}

/**
 * Find every double-quoted string value that follows `key`.
 * `skipQuotes` counts quotes to skip after the key before the value's opening
 * quote (1 for a quoted JSON key like `"key": "..."`, 0 for `key = "..."`).
 */
function extractAfterKey(buf, key, skipQuotes = 0) {
	const results = [];
	const keyBuf = Buffer.from(key, "utf8");
	let idx = buf.indexOf(keyBuf);
	while (idx !== -1) {
		let open = buf.indexOf(0x22, idx + keyBuf.length); // 0x22 = "
		for (let skip = 0; skip < skipQuotes && open !== -1; skip++) {
			open = buf.indexOf(0x22, open + 1);
		}
		if (open === -1) break;
		// value must open close to the key (small gap only)
		if (open - (idx + keyBuf.length) > 16) {
			idx = buf.indexOf(keyBuf, idx + keyBuf.length);
			continue;
		}
		let close = -1;
		for (let i = open + 1; i < buf.length; i++) {
			if (buf[i] === 0x22) {
				let backslashes = 0;
				for (let j = i - 1; j > open && buf[j] === 0x5c; j--) backslashes++;
				if (backslashes % 2 === 0) {
					close = i;
					break;
				}
			}
		}
		if (close === -1) break;
		results.push(decodeEscapes(buf.subarray(open + 1, close).toString("utf8")));
		idx = buf.indexOf(keyBuf, close + 1);
	}
	return results;
}

/** Deduplicate and sort strings longest-first. */
function distinct(strings) {
	const seen = new Set();
	return strings.filter((s) => (seen.has(s) ? false : (seen.add(s), true)));
}

// ---------------------------------------------------------------------------
// Per-harness extraction
// ---------------------------------------------------------------------------

function extractCodex(buf) {
	const templates = distinct(extractAfterKey(buf, "instructions_template", 1));
	return {
		binary: resolveCodex(),
		method: 'all `"instructions_template": "..."` JSON string values in the Rust binary',
		completeness: templates.length > 0 ? "full (all variants embedded statically)" : "not found",
		prompts: templates.map((text) => ({ title: firstLine(text), text })),
	};
}

function extractKimi(buf) {
	const templates = distinct(extractAfterKey(buf, "system_default$1"));
	return {
		binary: resolveKimi(),
		method: 'the `system_default$1 = "..."` JS template string in the bundled executable',
		completeness: templates.length > 0 ? "full (single static template)" : "not found",
		prompts: templates.map((text) => ({ title: firstLine(text), text })),
	};
}

function extractClaude(buf) {
	const identities = [
		"You are Claude Code, Anthropic's official CLI for Claude.",
		"You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
		"You are a Claude agent, built on Anthropic's Claude Agent SDK.",
	].filter((s) => buf.includes(Buffer.from(s, "utf8")));

	// Example contiguous sub-agent prompt (truncated window; the real one ends later).
	const workerAnchor = "You are a worker agent executing a task assigned by the coordinator";
	const workerOffset = buf.indexOf(Buffer.from(workerAnchor, "utf8"));
	const workerFragment =
		workerOffset === -1
			? undefined
			: buf.subarray(workerOffset, workerOffset + 6000).toString("utf8");

	return {
		binary: resolveClaude(),
		method: "identity strings + a bounded sub-agent fragment from the minified JS bundle",
		completeness:
			"partial — the main prompt is assembled at runtime from these strings plus many `${...}` interpolations; use a logging proxy for the fully-rendered prompt",
		identities,
		workerFragment,
	};
}

function firstLine(text) {
	const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
	return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function frontmatter(fields) {
	const body = Object.entries(fields)
		.map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
		.join("\n");
	return `---\n${body}\n---\n`;
}

function escapeAngleBrackets(text) {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderCodex(result) {
	const sections = result.prompts.map((p, i) => {
		const lines = p.text.split("\n").length;
		return `## variant-${i + 1}\n\n**First line:** ${p.title}\n\n**Length:** ${p.text.length} chars / ${lines} lines\n\n${escapeAngleBrackets(p.text)}\n`;
	});
	return `${frontmatter({
		title: "Codex system prompt",
		binary: result.binary,
		method: result.method,
		completeness: result.completeness,
		variants: String(result.prompts.length),
	})}\n# Codex system prompt\n\n${sections.join("\n\n")}`;
}

function renderKimi(result) {
	const sections = result.prompts.map((p, i) => {
		const lines = p.text.split("\n").length;
		return `## template-${i + 1}\n\n**First line:** ${p.title}\n\n**Length:** ${p.text.length} chars / ${lines} lines\n\n${escapeAngleBrackets(p.text)}\n`;
	});
	return `${frontmatter({
		title: "Kimi Code system prompt",
		binary: result.binary,
		method: result.method,
		completeness: result.completeness,
	})}\n# Kimi Code system prompt\n\n${sections.join("\n\n")}`;
}

function renderClaude(result) {
	const body = [];
	body.push(`**Method:** ${result.method}`);
	body.push(`**Completeness:** ${result.completeness}`);
	body.push("");
	body.push("## Identity strings");
	body.push("");
	for (const identity of result.identities) {
		body.push(`- ${identity}`);
	}
	body.push("");
	body.push("## Sub-agent fragment (worker)");
	body.push("");
	if (result.workerFragment) {
		body.push("_Truncated window; the real prompt continues past this point._");
		body.push("");
		body.push(escapeAngleBrackets(result.workerFragment));
	} else {
		body.push("(not found in this build)");
	}
	body.push("");
	return `${frontmatter({
		title: "Claude Code system prompt (partial)",
		binary: result.binary,
		method: result.method,
		completeness: result.completeness,
	})}\n# Claude Code system prompt (partial)\n\n${body.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
	const args = process.argv.slice(2);
	const outIndex = args.indexOf("--out");
	const outDir = outIndex !== -1 ? args[outIndex + 1] : join(process.cwd(), "examples", "system-prompts");
	mkdirSync(outDir, { recursive: true });

	const claudeBuf = readFileSync(resolveClaude());
	const codexBin = resolveCodex();
	const kimiBin = resolveKimi();

	const written = [];

	if (codexBin && existsSync(codexBin)) {
		const result = extractCodex(readFileSync(codexBin));
		const file = join(outDir, "codex.md");
		writeFileSync(file, renderCodex(result));
		written.push(file);
	} else {
		console.error("codex binary not found; set CODEX_BIN");
	}

	if (existsSync(kimiBin)) {
		const result = extractKimi(readFileSync(kimiBin));
		const file = join(outDir, "kimi.md");
		writeFileSync(file, renderKimi(result));
		written.push(file);
	} else {
		console.error("kimi binary not found; set KIMI_BIN");
	}

	{
		const result = extractClaude(claudeBuf);
		const file = join(outDir, "claude.md");
		writeFileSync(file, renderClaude(result));
		written.push(file);
	}

	for (const file of written) console.log(`Wrote ${file}`);
}

main();
