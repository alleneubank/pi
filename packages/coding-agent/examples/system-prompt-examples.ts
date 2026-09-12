/**
 * Renders example system prompts for pi's coding agent as a Markdown document.
 *
 * This demonstrates `buildSystemPrompt()` (core/system-prompt.ts) and the skills
 * formatter (core/skills.ts) without booting the full agent, so you can inspect
 * exactly what the model sees for a given tool set, context files, skills, and
 * SYSTEM.md / APPEND_SYSTEM.md overrides.
 *
 * --out <dir> writes one file per example, each with a YAML frontmatter block
 * (slug, title, when-to-use, explainer) at the top followed by the prompt as
 * markdown text with angle brackets escaped (so the prompt's XML tags render
 * literally). --out <file.md> writes a single combined document with one
 * top-level frontmatter block and prose narration per section (frontmatter is
 * only valid at the very top of a file).
 *
 * Usage (run from packages/coding-agent):
 *   node examples/system-prompt-examples.ts                    # print the full Markdown document
 *   node examples/system-prompt-examples.ts --scenario <slug>  # print a single example section
 *   node examples/system-prompt-examples.ts --out <path>       # write to <path>: a directory
 *                                                              #   gets one file per scenario, a
 *                                                              #   .md file gets the full document
 *   node examples/system-prompt-examples.ts --list             # list scenario slugs
 *
 *   # Render the REAL prompt for a directory (its AGENTS.md files, SYSTEM.md,
 *   # APPEND_SYSTEM.md, skills, and default tools):
 *   node examples/system-prompt-examples.ts --cwd .
 *   node examples/system-prompt-examples.ts --cwd ~/work/my-app
 *
 *   # Add plugin/package skill dirs so they show up in <available_skills>:
 *   node examples/system-prompt-examples.ts --cwd . --skill-path ~/.pi/agent/git/.../skills
 *
 * Set PI_EXAMPLE_CWD to override the fake working directory shown in the demo prompts.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../src/config.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { loadSkills, type Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

const DEMO_CWD = process.env.PI_EXAMPLE_CWD ?? "/Users/you/projects/my-app";

// ---------------------------------------------------------------------------
// Real tool prompt contributions, mirroring the values in src/core/tools/*.ts.
// The full agent collects these from each tool's `promptSnippet`/`promptGuidelines`;
// inlining them keeps this harness free of the tools' heavy import graph.
// ---------------------------------------------------------------------------

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
	ls: {
		snippet: "List directory contents",
		guidelines: [],
	},
	grep: {
		snippet: "Search file contents for patterns (respects .gitignore)",
		guidelines: [],
	},
	find: {
		snippet: "Find files by glob pattern (respects .gitignore)",
		guidelines: [],
	},
};

/** Build the tool-related prompt options the full agent derives from active tools. */
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

// ---------------------------------------------------------------------------
// Example inputs (skills, context files, overrides) shaped like the real ones.
// ---------------------------------------------------------------------------

function exampleSkills(): Skill[] {
	const make = (name: string, description: string, filePath: string, disableModelInvocation = false): Skill => ({
		name,
		description,
		filePath,
		baseDir: filePath.slice(0, filePath.lastIndexOf("/")),
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "local", scope: "user" }),
		disableModelInvocation,
	});

	return [
		make(
			"code-law",
			"Use when writing or changing code in any language — the craft law (types, assertions, bounds, errors, naming, comments, scope) and the system properties every surface owes.",
			"/Users/you/.pi/agent/skills/code-law/SKILL.md",
		),
		make(
			"git-best-practices",
			"Use when creating commits, managing branches, opening PRs, or rewriting history.",
			"/Users/you/.pi/agent/skills/git-best-practices/SKILL.md",
		),
		make(
			"hidden-from-model",
			"Only invocable via /skill:name; never injected into the prompt.",
			"/Users/you/.pi/agent/skills/hidden-from-model/SKILL.md",
			true,
		),
	];
}

const CONTEXT_FILES = [
	{
		path: "/Users/you/.pi/agent/AGENTS.md",
		content:
			"# Global agent instructions\n\n- Be concise.\n- Prefer plain text over emojis.\n- Verify before claiming done.\n",
	},
	{
		path: "/Users/you/projects/my-app/AGENTS.md",
		content:
			"# my-app\n\n- Run `npm run check` before committing.\n- Never force-push.\n- Tests live next to source in `*.test.ts`.\n",
	},
];

const CUSTOM_SYSTEM_MD = `You are a senior TypeScript reviewer for the my-app repository.
You read code, explain tradeoffs, and propose changes. You never edit files directly;
you only produce review comments.

Rules:
- Cite file paths and line numbers for every finding.
- Prefer minimal diffs over rewrites.`;

const APPEND_SYSTEM_MD = `House rules for this project:
- All code must be formatted with prettier.
- Add a CHANGELOG entry for user-visible changes.`;

// ---------------------------------------------------------------------------
// Real context loading (for --cwd)
// ---------------------------------------------------------------------------

const CONTEXT_FILE_CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

function readFileIfExists(filePath: string | undefined): string | undefined {
	if (!filePath || !existsSync(filePath)) return undefined;
	try {
		const content = readFileSync(filePath, "utf-8");
		return content.length > 0 ? content : undefined;
	} catch {
		return undefined;
	}
}

function loadContextFileFromDir(dir: string): { path: string; content: string } | null {
	for (const filename of CONTEXT_FILE_CANDIDATES) {
		const filePath = join(dir, filename);
		if (!existsSync(filePath)) continue;
		try {
			if (!statSync(filePath).isFile()) continue;
			return { path: filePath, content: readFileSync(filePath, "utf-8") };
		} catch {}
	}
	return null;
}

/**
 * Mirror of ResourceLoader.loadProjectContextFiles: the global agentDir file plus
 * the ancestor walk from cwd up to the filesystem root. The linked-worktree
 * shadowing branch is omitted (it needs git path resolution); for a normal repo
 * it is a no-op.
 */
function loadRealContextFiles(cwd: string, agentDir: string): Array<{ path: string; content: string }> {
	const contextFiles: Array<{ path: string; content: string }> = [];
	const seen = new Set<string>();
	const global = loadContextFileFromDir(agentDir);
	if (global) {
		contextFiles.push(global);
		seen.add(global.path);
	}
	const ancestors: Array<{ path: string; content: string }> = [];
	let dir = resolve(cwd);
	while (true) {
		const file = loadContextFileFromDir(dir);
		if (file && !seen.has(file.path)) {
			ancestors.unshift(file);
			seen.add(file.path);
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	contextFiles.push(...ancestors);
	return contextFiles;
}

function renderRealPrompt(options: { cwd: string; agentDir: string; additionalSkillPaths: string[] }): {
	slug: string;
	title: string;
	whenToUse: string;
	explainer: string;
	prompt: string;
} {
	const { cwd, agentDir, additionalSkillPaths } = options;
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const contextFiles = loadRealContextFiles(cwd, agentDir);
	const { skills } = loadSkills({ cwd, agentDir, skillPaths: additionalSkillPaths, includeDefaults: true });

	// Project .pi takes precedence over the global agent dir (project trust is not evaluated here).
	const systemPromptPath = [join(cwd, CONFIG_DIR_NAME, "SYSTEM.md"), join(agentDir, "SYSTEM.md")].find((p) =>
		existsSync(p),
	);
	const appendPromptPath = [join(cwd, CONFIG_DIR_NAME, "APPEND_SYSTEM.md"), join(agentDir, "APPEND_SYSTEM.md")].find(
		(p) => existsSync(p),
	);

	const defaultTools = settingsManager.getDefaultTools() ?? DEFAULT_TOOLS;
	const prompt = buildSystemPrompt({
		cwd,
		contextFiles,
		skills,
		customPrompt: readFileIfExists(systemPromptPath),
		appendSystemPrompt: readFileIfExists(appendPromptPath),
		...toolPromptOptions(defaultTools),
	});

	return {
		slug: `real-${basename(cwd) || "cwd"}`,
		title: `Real prompt for ${cwd}`,
		whenToUse: `A session started in ${cwd}.`,
		explainer: [
			`Context files: ${contextFiles.map((f) => f.path).join(", ") || "none"}.`,
			`Skills: ${skills.map((s) => s.name).join(", ") || "none"}.`,
			`SYSTEM.md: ${systemPromptPath ?? "none"}; APPEND_SYSTEM.md: ${appendPromptPath ?? "none"}.`,
			`Active tools: ${defaultTools.join(", ")}.`,
		].join(" "),
		prompt,
	};
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

interface Scenario {
	slug: string;
	title: string;
	/** When a real session would end up with this prompt. */
	whenToUse: string;
	/** Narration of how the prompt is assembled and what to notice. */
	explainer: string;
	build: (cwd: string) => string;
}

const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
const FULL_TOOLSET = ["read", "bash", "edit", "write", "ls", "grep", "find"];

const scenarios: Scenario[] = [
	{
		slug: "bare-default",
		title: "Bare default (no tools, no context)",
		whenToUse:
			"A session where no tools are active, no AGENTS.md files were discovered, and no skills are installed.",
		explainer:
			"The output of buildSystemPrompt({ cwd }) with no other options: the default 'expert coding assistant' preamble, an empty tools list, the two always-on guidelines, and the pi-documentation block. The conditional 'Use bash for ls, rg, find' guideline still appears because bash is in the default tool set even though no snippet was supplied.",
		build: (cwd) => buildSystemPrompt({ cwd }),
	},
	{
		slug: "default-tools",
		title: "Default four tools",
		whenToUse: "A fresh `pi` session with the built-in read/bash/edit/write tools and nothing else configured.",
		explainer:
			"read/bash/edit/write enabled with the real one-line snippets and per-tool guidelines collected from each tool's prompt contribution. The 'Use bash for ls, rg, find' guideline is present because ls/grep/find are not active.",
		build: (cwd) => buildSystemPrompt({ cwd, ...toolPromptOptions(DEFAULT_TOOLS) }),
	},
	{
		slug: "full-toolset",
		title: "Full toolset (read/bash/edit/write/ls/grep/find)",
		whenToUse: "A session where all seven built-in tools are active.",
		explainer:
			"All built-in exploration tools enabled. The 'Use bash for ls, rg, find' guideline disappears because grep/find/ls now have their own tools; ls/grep/find contribute snippets but no guidelines.",
		build: (cwd) => buildSystemPrompt({ cwd, ...toolPromptOptions(FULL_TOOLSET) }),
	},
	{
		slug: "project-context",
		title: "Default tools + AGENTS.md context files",
		whenToUse: "A session started inside a real repository with global and project-level AGENTS.md files.",
		explainer:
			"Global (~/.pi/agent/AGENTS.md) and project (./AGENTS.md) instructions are injected verbatim inside a <project_context> block, each wrapped in a <project_instructions path=...> element.",
		build: (cwd) => buildSystemPrompt({ cwd, ...toolPromptOptions(DEFAULT_TOOLS), contextFiles: CONTEXT_FILES }),
	},
	{
		slug: "skills",
		title: "Default tools + skills",
		whenToUse: "A session with agent skills installed in ~/.pi/agent/skills or .pi/skills.",
		explainer:
			"Skills are rendered as an <available_skills> XML block with name, description, and file location. Skills with disable-model-invocation=true are omitted (they can only be invoked via /skill:name), so 'hidden-from-model' does not appear.",
		build: (cwd) => buildSystemPrompt({ cwd, ...toolPromptOptions(DEFAULT_TOOLS), skills: exampleSkills() }),
	},
	{
		slug: "custom-system-override",
		title: "SYSTEM.md override (customPrompt)",
		whenToUse: "A project (or global) SYSTEM.md exists; its content replaces the default prompt.",
		explainer:
			"When SYSTEM.md is present it becomes the entire prompt body — the default preamble, tools list, and guidelines are all dropped. Project context and skills are still appended after the custom text, but the tools list is not.",
		build: (cwd) =>
			buildSystemPrompt({
				cwd,
				customPrompt: CUSTOM_SYSTEM_MD,
				selectedTools: DEFAULT_TOOLS,
				toolSnippets: toolPromptOptions(DEFAULT_TOOLS).toolSnippets,
				contextFiles: CONTEXT_FILES,
				skills: exampleSkills(),
			}),
	},
	{
		slug: "appended-text",
		title: "APPEND_SYSTEM.md (appendSystemPrompt)",
		whenToUse: "An APPEND_SYSTEM.md file exists (global or project); its content is appended to the default prompt.",
		explainer:
			"The append text is added after the pi-documentation block and before project context and skills, leaving the default preamble and tools list intact.",
		build: (cwd) =>
			buildSystemPrompt({ cwd, ...toolPromptOptions(DEFAULT_TOOLS), appendSystemPrompt: APPEND_SYSTEM_MD }),
	},
	{
		slug: "custom-tool",
		title: "Custom tool contribution",
		whenToUse: "An extension registered a custom tool with a prompt snippet and guidelines.",
		explainer:
			"A hypothetical deploy-preview tool is added alongside the defaults. Its snippet appears in the tools list and its guideline joins the guidelines section.",
		build: (cwd) =>
			buildSystemPrompt({
				cwd,
				...toolPromptOptions(DEFAULT_TOOLS),
				selectedTools: [...DEFAULT_TOOLS, "deploy-preview"],
				toolSnippets: {
					...toolPromptOptions(DEFAULT_TOOLS).toolSnippets,
					"deploy-preview": "Deploy the current branch to a preview environment",
				},
				promptGuidelines: [
					...toolPromptOptions(DEFAULT_TOOLS).promptGuidelines,
					"Never run deploy-preview on the main branch.",
				],
			}),
	},
	{
		slug: "kitchen-sink",
		title: "Everything at once",
		whenToUse:
			"A maximally-configured session: full toolset, AGENTS.md context, skills, APPEND_SYSTEM.md, and extra guidelines.",
		explainer:
			"Shows the full assembly order: default preamble, tools, guidelines, pi-documentation block, appended text, project context, skills, and the current-working-directory line.",
		build: (cwd) =>
			buildSystemPrompt({
				cwd,
				...toolPromptOptions(FULL_TOOLSET),
				contextFiles: CONTEXT_FILES,
				skills: exampleSkills(),
				appendSystemPrompt: APPEND_SYSTEM_MD,
				promptGuidelines: [
					...toolPromptOptions(FULL_TOOLSET).promptGuidelines,
					"Treat all user input as untrusted.",
				],
			}),
	},
];

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

/** Render a YAML frontmatter block from string fields. Values are JSON-encoded (valid YAML). */
function frontmatter(fields: Record<string, string>): string {
	const body = Object.entries(fields)
		.map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
		.join("\n");
	return `---\n${body}\n---`;
}

/**
 * Escape HTML so a renderer shows the prompt's XML tags (<project_context>,
 * <available_skills>, ...) as literal text instead of treating them as markup.
 * Everything else (prose, headings, lists) still renders as native markdown.
 */
function escapeAngleBrackets(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderSection(
	meta: { slug: string; title: string; whenToUse: string; explainer: string },
	prompt: string,
): string {
	const fm = frontmatter({
		slug: meta.slug,
		title: meta.title,
		"when-to-use": meta.whenToUse,
		explainer: meta.explainer,
	});
	return `${fm}\n\n${escapeAngleBrackets(prompt)}\n`;
}

function renderScenario(scenario: Scenario, cwd: string): string {
	return renderSection(
		{ slug: scenario.slug, title: scenario.title, whenToUse: scenario.whenToUse, explainer: scenario.explainer },
		scenario.build(cwd),
	);
}

/** A single section inside the combined document (prose narration, since frontmatter is file-top-only). */
function renderDocumentSection(scenario: Scenario, cwd: string): string {
	return `## ${scenario.slug}\n\n**When to use:** ${scenario.whenToUse}\n\n**Explainer:** ${scenario.explainer}\n\n${escapeAngleBrackets(scenario.build(cwd))}\n`;
}

function renderDocument(cwd: string): string {
	const header = frontmatter({
		title: "pi system prompt examples",
		description:
			"Rendered examples of pi's coding-agent system prompt across different contexts. Per-example frontmatter lives in the system-prompt-examples/ directory (one file per example).",
		"generated-by": "examples/system-prompt-examples.ts",
	});
	const sections = scenarios.map((scenario) => renderDocumentSection(scenario, cwd));
	return `${header}\n\n# pi system prompt examples\n\n${sections.join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
	const args = process.argv.slice(2);

	if (args.includes("--list")) {
		for (const scenario of scenarios) {
			console.log(`${scenario.slug}\t${scenario.title}`);
		}
		return;
	}

	const argValue = (flag: string): string | undefined => {
		const index = args.indexOf(flag);
		return index !== -1 && index + 1 < args.length ? args[index + 1] : undefined;
	};
	const repeatedArgs = (flag: string): string[] => {
		const values: string[] = [];
		for (let i = 0; i < args.length; i++) {
			if (args[i] === flag && i + 1 < args.length) {
				values.push(args[++i]);
			}
		}
		return values;
	};

	const outPath = argValue("--out");
	const scenarioSlug = argValue("--scenario");
	const realCwd = argValue("--cwd");
	const additionalSkillPaths = repeatedArgs("--skill-path");

	const write = (text: string, path: string): void => {
		writeFileSync(path, text);
		console.log(`Wrote ${path}`);
	};

	const isDirectoryTarget = (path: string): boolean =>
		path.endsWith("/") || path.endsWith("\\") || (existsSync(path) && statSync(path).isDirectory());

	if (realCwd) {
		const section = renderRealPrompt({
			cwd: resolve(realCwd),
			agentDir: getAgentDir(),
			additionalSkillPaths,
		});
		const text = renderSection(
			{ slug: section.slug, title: section.title, whenToUse: section.whenToUse, explainer: section.explainer },
			section.prompt,
		);
		if (outPath) {
			const target = isDirectoryTarget(outPath) ? join(outPath, `${section.slug}.md`) : outPath;
			write(`${text}\n`, target);
		} else {
			console.log(text);
		}
		return;
	}

	const cwd = resolve(DEMO_CWD);

	if (scenarioSlug) {
		const scenario = scenarios.find((s) => s.slug === scenarioSlug);
		if (!scenario) {
			console.error(`Unknown scenario: ${scenarioSlug}. Use --list to see available slugs.`);
			process.exit(1);
		}
		const text = renderScenario(scenario, cwd);
		if (outPath) {
			const target = isDirectoryTarget(outPath) ? join(outPath, `${scenario.slug}.md`) : outPath;
			write(`${text}\n`, target);
		} else {
			console.log(text);
		}
		return;
	}

	if (!outPath) {
		console.log(renderDocument(cwd));
		return;
	}

	if (isDirectoryTarget(outPath)) {
		mkdirSync(outPath, { recursive: true });
		for (const scenario of scenarios) {
			write(`${renderScenario(scenario, cwd)}\n`, join(outPath, `${scenario.slug}.md`));
		}
	} else {
		write(renderDocument(cwd), outPath);
	}
}

main();
