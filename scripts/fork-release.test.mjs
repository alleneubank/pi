import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/build-binaries.yml", import.meta.url), "utf8");

test("fork tags cannot start upstream binary and npm publication", () => {
	assert.match(workflow, /^  build:\n    if: \$\{\{ github\.repository == 'earendil-works\/pi' \}\}$/m);
});

test("fork CI cannot start upstream model-catalog publication", () => {
	const catalogWorkflow = readFileSync(new URL("../.github/workflows/publish-model-catalog.yml", import.meta.url), "utf8");
	assert.match(catalogWorkflow, /^  generate:\n    if: \$\{\{ github\.repository == 'earendil-works\/pi' &&/m);
});

test("fork release builds validate model data instead of regenerating tracked sources", () => {
	const script = readFileSync(new URL("./release-fork.sh", import.meta.url), "utf8");
	assert.match(script, /^scripts\/build-binaries\.sh --skip-install --offline-model-data --platform darwin-arm64 /m);
});

test("a skipped upstream release cannot trigger draft cleanup in a fork", () => {
	assert.match(
		workflow,
		/^    if: \$\{\{ always\(\) && needs\.stage-github-release\.result != 'skipped' &&/m,
	);
});
