import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelsDevV2Model } from "../catalog/sources/models-dev.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";
import type { Api, Model } from "../src/types.ts";
import { writeUpstreamMock } from "./catalog-generation-utils.ts";

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
			const sourceModel: ModelsDevV2Model = {
				id: "claude-opus-5.5",
				type: "chat",
				name: "Claude Opus 5.5",
				modalities: { input: ["text"], output: ["text"] },
				capabilities: {
					tools: { supported: true },
					reasoning: {
						supported: true,
						...(hasEffortMetadata ? { effort: ["low", "medium", "high", "xhigh", "max"] } : {}),
					},
				},
				api: {},
			};
			writeUpstreamMock(preloadPath, { "github-copilot": { models: { "claude-opus-5.5": sourceModel } } });
			const result = spawnSync(
				process.execPath,
				[
					"--import",
					pathToFileURL(preloadPath).href,
					"catalog/generate.ts",
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
