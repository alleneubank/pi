#!/usr/bin/env node
/**
 * Capture the fully-rendered system prompt each coding agent actually sends,
 * by pointing it at a local logging proxy and reading the request body.
 *
 * The proxy never forwards: it logs the request and returns 401, so no real
 * API call is made and no key is used. Auth headers are redacted before the
 * request is written to disk. Each harness is run non-interactively in a fresh
 * empty working directory with a dummy key.
 *
 * Usage:
 *   node examples/capture-system-prompts/capture.mjs [--out <dir>]
 *
 * Overrides: CLAUDE_BIN / CODEX_BIN / KIMI_BIN, CAPTURE_PORT (default 4318).
 */

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const PORT = Number(process.env.CAPTURE_PORT ?? 4318);
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const OUT = outIndex !== -1 ? args[outIndex + 1] : join(process.cwd(), "examples", "system-prompts-captured");
const onlyIndex = args.indexOf("--only");
const ONLY = onlyIndex !== -1 ? args[onlyIndex + 1] : undefined;

// ---------------------------------------------------------------------------
// Binary discovery (same as the static extractor)
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
// Redaction (secrets never touch disk)
// ---------------------------------------------------------------------------

const SECRET_HEADER = /token|key|secret|auth|cookie/i;
const SECRET_FIELD = /token|key|secret|auth|cookie/i;

function redactHeaders(headers) {
	const out = {};
	for (const [name, value] of Object.entries(headers)) {
		out[name] = SECRET_HEADER.test(name) ? "REDACTED" : value;
	}
	return out;
}

function redactBody(value) {
	if (Array.isArray(value)) return value.map(redactBody);
	if (value && typeof value === "object") {
		const out = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = SECRET_FIELD.test(k) ? "REDACTED" : redactBody(v);
		}
		return out;
	}
	return value;
}

// ---------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------

let currentHarness = "default";

const server = createServer((req, res) => {
	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		const raw = Buffer.concat(chunks).toString("utf8");
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch {
			parsed = undefined;
		}
		const record = {
			method: req.method,
			path: req.url,
			headers: redactHeaders(req.headers),
			body: parsed ? redactBody(parsed) : redactBody({ raw }),
		};
		const dir = join(OUT, currentHarness);
		mkdirSync(dir, { recursive: true });
		const count = readdirSync(dir).length;
		writeFileSync(join(dir, `${String(count).padStart(3, "0")}.json`), `${JSON.stringify(record, null, 2)}\n`);

		res.writeHead(401, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: "captured by proxy", type: "authentication_error" } }));
	});
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function runHarness(name, cmd, argv, env) {
	return new Promise((resolve) => {
		const cwd = mkdtempSync(join(tmpdir(), "sp-capture-"));
		const child = spawn(cmd, argv, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => {
			stdout += d;
		});
		child.stderr.on("data", (d) => {
			stderr += d;
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			resolve({ name, code, signal, stdout: stdout.slice(-1500), stderr: stderr.slice(-1500) });
		});
	});
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const base = `http://127.0.0.1:${PORT}`;

const HARNESSES = [
	{
		name: "claude",
		cmd: resolveClaude(),
		argv: ["-p", "Reply with exactly: ok"],
		env: {
			ANTHROPIC_BASE_URL: base,
			ANTHROPIC_API_KEY: "sk-ant-dummy-capture",
			CLAUDE_CONFIG_DIR: join(tmpdir(), "sp-claude-config"),
		},
	},
	{
		name: "codex",
		cmd: resolveCodex(),
		argv: ["exec", "--skip-git-repo-check", "-c", 'model_provider="openai"', "-c", 'model="gpt-5"', "Reply with exactly: ok"],
		env: {
			OPENAI_BASE_URL: base,
			OPENAI_API_KEY: "sk-dummy-capture",
			CODEX_HOME: join(tmpdir(), "sp-codex-home"),
		},
		prepare: (env) => {
			mkdirSync(env.CODEX_HOME, { recursive: true });
			writeFileSync(join(env.CODEX_HOME, "config.toml"), 'model = "gpt-5"\nmodel_provider = "openai"\n');
		},
	},
	{
		name: "kimi",
		cmd: resolveKimi(),
		argv: ["-p", "Reply with exactly: ok"],
		env: {
			KIMI_CODE_HOME: join(tmpdir(), "sp-kimi-home"),
		},
		prepare: (env) => {
			mkdirSync(env.KIMI_CODE_HOME, { recursive: true });
			const cfg = [
				"default_model = \"capture/cap\"",
				"",
				"[providers.capture]",
				'type = "openai"',
				'api_key = "dummy"',
				`base_url = "${base}/v1"`,
				"",
				'[models."capture/cap"]',
				'provider = "capture"',
				'model = "cap"',
				"max_context_size = 262144",
				'capabilities = ["tool_use"]',
				'display_name = "Capture"',
				"",
			].join("\n");
			writeFileSync(join(env.KIMI_CODE_HOME, "config.toml"), cfg);
		},
	},
];

server.listen(PORT, "127.0.0.1", async () => {
	for (const h of HARNESSES) {
		if (ONLY && h.name !== ONLY) continue;
		if (!h.cmd || !existsSync(h.cmd)) {
			console.error(`${h.name}: binary not found (${h.cmd})`);
			continue;
		}
		currentHarness = h.name;
		if (h.prepare) h.prepare(h.env);
		console.log(`\n=== ${h.name} ===`);
		const result = await runHarness(h.name, h.cmd, h.argv, h.env);
		console.log(`exit=${result.code} signal=${result.signal}`);
		const dir = join(OUT, h.name);
		const count = existsSync(dir) ? readdirSync(dir).length : 0;
		console.log(`captured ${count} request(s) -> ${dir}`);
		if (result.stderr.trim()) console.log(`stderr tail: ${result.stderr.trim().slice(-800)}`);
		if (result.stdout.trim()) console.log(`stdout tail: ${result.stdout.trim().slice(-800)}`);
	}
	server.close();
	process.exit(0);
});
