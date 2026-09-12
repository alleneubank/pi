import { describe, expect, test } from "vitest";
import { type ChangelogEntry, getNewEntries, normalizeChangelogLinks } from "../src/utils/changelog.ts";

const entry: ChangelogEntry = {
	major: 0,
	minor: 79,
	patch: 0,
	content: "",
};

function versionEntry(major: number, minor: number, patch: number): ChangelogEntry {
	return { major, minor, patch, content: "" };
}

describe("getNewEntries", () => {
	test("treats a prerelease/build suffix as the same base version", () => {
		const entries = [versionEntry(0, 85, 1), versionEntry(0, 85, 0), versionEntry(0, 84, 2)];

		expect(getNewEntries(entries, "0.85.1-fork.20260910.g678734131")).toEqual([]);
	});

	test("returns entries strictly newer than the base version", () => {
		const entries = [versionEntry(0, 86, 0), versionEntry(0, 85, 1)];

		expect(getNewEntries(entries, "0.85.1-fork.20260910.g678734131")).toEqual([versionEntry(0, 86, 0)]);
	});

	test("accepts a leading v and plain semver", () => {
		const entries = [versionEntry(0, 85, 1)];

		expect(getNewEntries(entries, "v0.85.1")).toEqual([]);
		expect(getNewEntries(entries, "0.85.0")).toEqual([versionEntry(0, 85, 1)]);
	});

	test("falls back to 0.0.0 for unparseable versions", () => {
		const entries = [versionEntry(0, 85, 1)];

		expect(getNewEntries(entries, "unknown")).toEqual([versionEntry(0, 85, 1)]);
	});
});

describe("normalizeChangelogLinks", () => {
	test("rewrites package-relative changelog links to tag-pinned GitHub source links", () => {
		const markdown = [
			"[Project Trust](README.md#project-trust)",
			"[Extensions](docs/extensions.md#project_trust)",
			"[Examples](examples/extensions/)",
			"[Root README](../../README.md#supply-chain-hardening)",
		].join("\n");

		expect(normalizeChangelogLinks(markdown, entry)).toBe(
			[
				"[Project Trust](https://github.com/earendil-works/pi/blob/v0.79.0/packages/coding-agent/README.md#project-trust)",
				"[Extensions](https://github.com/earendil-works/pi/blob/v0.79.0/packages/coding-agent/docs/extensions.md#project_trust)",
				"[Examples](https://github.com/earendil-works/pi/tree/v0.79.0/packages/coding-agent/examples/extensions/)",
				"[Root README](https://github.com/earendil-works/pi/blob/v0.79.0/README.md#supply-chain-hardening)",
			].join("\n"),
		);
	});

	test("canonicalizes old repository URLs without changing external links", () => {
		const markdown = [
			"[#5167](https://github.com/earendil-works/pi-mono/pull/5167)",
			"[#4163](https://github.com/badlogic/pi-mono/issues/4163)",
			"[Agent README](https://github.com/badlogic/pi-mono/blob/main/packages/agent/README.md)",
			"[External](https://example.com/docs)",
			"[Local anchor](#settings)",
		].join("\n");

		expect(normalizeChangelogLinks(markdown, "0.79.0")).toBe(
			[
				"[#5167](https://github.com/earendil-works/pi/pull/5167)",
				"[#4163](https://github.com/earendil-works/pi/issues/4163)",
				"[Agent README](https://github.com/earendil-works/pi/blob/v0.79.0/packages/agent/README.md)",
				"[External](https://example.com/docs)",
				"[Local anchor](#settings)",
			].join("\n"),
		);
	});
});
