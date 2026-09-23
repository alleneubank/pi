import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getSupportedThinkingLevels } from "../src/models.ts";
import type { Api, Model } from "../src/types.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("Copilot model generation", () => {
	it.each([false, true])(
		"preserves Opus 5.5 thinking levels with upstream effort metadata: %s",
		(hasEffortMetadata) => {
			const root = mkdtempSync(join(tmpdir(), "pi-copilot-generation-"));
			temporaryRoots.push(root);
			const preloadPath = join(root, "mock-catalog.mjs");
			const outputPath = join(root, "catalog");
			const catalog = {
				"github-copilot": {
					models: {
						"claude-opus-5.5": {
							id: "claude-opus-5.5",
							tool_call: true,
							reasoning: true,
							...(hasEffortMetadata
								? { reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }] }
								: {}),
						},
					},
				},
			};
			writeFileSync(
				preloadPath,
				`const catalog = ${JSON.stringify(catalog)};\n` +
					`globalThis.fetch = async (input) => {\n` +
					`  const url = String(input);\n` +
					`  if (url === "https://models.dev/api.json") return Response.json(catalog);\n` +
					`  if (url === "https://openrouter.ai/api/v1/models" || url === "https://ai-gateway.vercel.sh/v1/models") return Response.json({ data: [] });\n` +
					`  if (url === "https://radius.pi.dev/v1/config") return Response.json({ baseUrl: "https://radius.pi.dev", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 4096 }] });\n` +
					`  throw new Error(\`Unexpected fetch: \${url}\`);\n` +
					`};\n`,
			);
			const result = spawnSync(
				process.execPath,
				[
					"--import",
					pathToFileURL(preloadPath).href,
					"scripts/generate-models.ts",
					"--json-only",
					"--json-output",
					outputPath,
				],
				{ cwd: packageRoot, encoding: "utf8", timeout: 10_000 },
			);
			expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
			expect(result.stderr).toBe("");
			const models = JSON.parse(readFileSync(join(outputPath, "providers/github-copilot.json"), "utf8")) as Record<
				string,
				Model<Api>
			>;
			expect(getSupportedThinkingLevels(models["claude-opus-5.5"])).toEqual([
				"low",
				"medium",
				"high",
				"xhigh",
				"max",
			]);
		},
	);
});
