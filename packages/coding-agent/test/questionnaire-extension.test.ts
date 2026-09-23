import { stripVTControlCharacters } from "node:util";
import {
	type Component,
	getKeybindings,
	type KeybindingsConfig,
	setKeybindings,
	type TUI,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { Check } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import questionnaire from "../examples/extensions/questionnaire.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import {
	createExtensionRuntime,
	type ExtensionContext,
	type ExtensionUIContext,
	loadExtensionFromFactory,
} from "../src/core/extensions/index.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { initTheme, type Theme, theme } from "../src/modes/interactive/theme/theme.ts";

const targets = {
	id: "targets",
	label: "Targets",
	prompt: "Which platforms?",
	options: [
		{ value: "linux", label: "Linux" },
		{ value: "macos", label: "macOS" },
		{ value: "windows", label: "Windows" },
	],
};
const runtime = {
	id: "runtime",
	label: "Runtime",
	prompt: "Which runtime?",
	options: [
		{ value: "node", label: "Node.js" },
		{ value: "bun", label: "Bun" },
	],
};
const up = "\x1b[A";
const down = "\x1b[B";
const enter = "\r";
const esc = "\x1b";
const tab = "\t";
const previousTab = "\x1b[Z";
const cleanups: Array<() => void> = [];
let previousKeybindings = getKeybindings();

beforeEach(() => {
	previousKeybindings = getKeybindings();
	initTheme("dark");
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	setKeybindings(previousKeybindings);
});

async function openQuestionnaire(questions: object[], bindings: KeybindingsConfig = {}) {
	const extension = await loadExtensionFromFactory(
		questionnaire,
		process.cwd(),
		createEventBus(),
		createExtensionRuntime(),
	);
	const tool = extension.tools.get("questionnaire")!.definition;
	const kb = new KeybindingsManager(bindings);
	setKeybindings(kb);
	const tui = new TuiMainScreen(new VirtualTerminal());
	cleanups.push(() => tui.stop());
	let component: Component;
	let completed = false;
	let ready!: () => void;
	const opened = new Promise<void>((resolve) => {
		ready = resolve;
	});
	const custom: ExtensionUIContext["custom"] = async <T>(
		factory: (
			tui: TUI,
			theme: Theme,
			kb: KeybindingsManager,
			done: (result: T) => void,
		) => Component | Promise<Component>,
	) => {
		let finish!: (value: T) => void;
		const answer = new Promise<T>((resolve) => {
			finish = resolve;
		});
		component = await factory(tui, theme, kb, (value) => {
			completed = true;
			finish(value);
		});
		ready();
		return answer;
	};
	const ctx = { mode: "tui", hasUI: true, ui: { custom } } as ExtensionContext;
	const result = tool.execute("questionnaire-test", { questions }, undefined, undefined, ctx);
	await opened;
	return {
		result,
		tool,
		completed: () => completed,
		press: (...keys: string[]) => {
			for (const key of keys) component.handleInput?.(key);
		},
		render: (width = 100) => {
			component.invalidate();
			return component.render(width).map(stripVTControlCharacters).join("\n");
		},
	};
}

describe("questionnaire example", () => {
	it("keeps single-select as the default and returns the original answer shape", async () => {
		const ui = await openQuestionnaire([targets]);
		expect(ui.render()).not.toContain("[ ]");
		ui.press(down, enter);
		expect((await ui.result).details).toMatchObject({
			cancelled: false,
			answers: [{ id: "targets", value: "macos", label: "macOS", wasCustom: false, index: 2 }],
		});
	});

	it("toggles without submitting, requires an answer, and returns all selected values in option order", async () => {
		const ui = await openQuestionnaire([{ ...targets, multiSelect: true }]);
		expect(ui.tool.executionMode).toBe("sequential");
		ui.press(enter);
		expect(ui.completed()).toBe(false);
		ui.press(down, " ", up, " ");
		expect(ui.completed()).toBe(false);
		expect(ui.render()).toContain("[x] 1. Linux");
		expect(ui.render()).toContain("[x] 2. macOS");
		ui.press(enter);
		const result = await ui.result;
		expect(result.details).toMatchObject({
			cancelled: false,
			answers: [{ id: "targets", values: ["linux", "macos"], labels: ["Linux", "macOS"] }],
		});
		expect(result.content).toEqual([
			{ type: "text", text: 'Targets: {"values":["linux","macos"],"labels":["Linux","macOS"]}' },
		]);
	});

	it("preserves drafts across tabs and prevents submission of a changed, unconfirmed answer", async () => {
		const ui = await openQuestionnaire([{ ...targets, multiSelect: true }, runtime]);
		ui.press(" ", down, " ", tab, previousTab);
		expect(ui.render()).toContain("[x] 2. macOS");
		ui.press(enter, enter);
		expect(ui.render()).toContain("Targets: Linux, macOS");
		expect(ui.render()).toContain("Runtime: Node.js");
		ui.press(tab, down, " ", tab, tab, enter);
		expect(ui.completed()).toBe(false);
		expect(ui.render()).toContain("Unanswered: Targets");
		ui.press(tab);
		expect(ui.render()).toContain("[ ] 2. macOS");
		ui.press(enter, tab, enter);
		expect((await ui.result).details).toMatchObject({
			cancelled: false,
			answers: expect.arrayContaining([
				{ id: "targets", values: ["linux"], labels: ["Linux"], custom: undefined },
				expect.objectContaining({ id: "runtime", value: "node" }),
			]),
		});
	});

	it("combines checked options with custom text and renders both in the review and result", async () => {
		const ui = await openQuestionnaire([{ ...targets, multiSelect: true }, runtime]);
		ui.press(" ", down, down, down, enter, "FreeBSD, OpenBSD", enter);
		expect(ui.completed()).toBe(false);
		expect(ui.render()).toContain("[x] 1. Linux");
		expect(ui.render()).toContain("Other: FreeBSD, OpenBSD");
		ui.press(enter, enter);
		expect(ui.render()).toContain("Targets: Linux, (wrote) FreeBSD, OpenBSD");
		ui.press(enter);
		const result = await ui.result;
		expect(result.details).toMatchObject({
			answers: expect.arrayContaining([
				{ id: "targets", values: ["linux"], labels: ["Linux"], custom: "FreeBSD, OpenBSD" },
			]),
		});
		const rendered = ui.tool.renderResult!(result, { expanded: false, isPartial: false }, theme, {} as never);
		expect(rendered!.render(100).map(stripVTControlCharacters).join("\n")).toContain(
			"targets: Linux, (wrote) FreeBSD, OpenBSD",
		);
	});

	it("allows a custom-only multi-select answer and clearing custom text without losing checked choices", async () => {
		const customOnly = await openQuestionnaire([{ ...targets, options: [], multiSelect: true }]);
		customOnly.press(enter, "FreeBSD", enter, enter);
		expect((await customOnly.result).details).toMatchObject({
			answers: [{ id: "targets", values: [], labels: [], custom: "FreeBSD" }],
		});
		const ui = await openQuestionnaire([{ ...targets, multiSelect: true }]);
		ui.press(" ", down, down, down, enter, "FreeBSD", enter, down, down, down, " ", up, enter);
		expect((await ui.result).details).toMatchObject({
			answers: [{ id: "targets", values: ["linux"], labels: ["Linux"] }],
		});
	});

	it("backs out of the editor without losing selections and cancels the questionnaire separately", async () => {
		const ui = await openQuestionnaire([{ ...targets, multiSelect: true }]);
		ui.press(" ", down, down, down, enter, "discard me", esc);
		expect(ui.completed()).toBe(false);
		expect(ui.render()).toContain("[x] 1. Linux");
		expect(ui.render()).not.toContain("discard me");
		ui.press(esc);
		expect((await ui.result).details).toMatchObject({ cancelled: true });
	});

	it("honors configured toggle, navigation, confirmation, and cancellation keys and displays them", async () => {
		const ui = await openQuestionnaire([{ ...targets, multiSelect: true, allowOther: false }, runtime], {
			"app.questionnaire.toggle": "x",
			"app.questionnaire.next": "n",
			"app.questionnaire.previous": "p",
			"tui.select.down": "j",
			"tui.select.confirm": "y",
			"tui.select.cancel": "q",
		});
		expect(ui.render()).toContain("x toggle");
		expect(ui.render()).toContain("y confirm");
		expect(ui.render()).not.toContain("Type something");
		ui.press(" ", enter);
		expect(ui.completed()).toBe(false);
		expect(ui.render()).toContain("[ ] 1. Linux");
		ui.press("x", "j", "x", "n", "p");
		expect(ui.render()).toContain("[x] 2. macOS");
		ui.press("y", "y", "y");
		expect((await ui.result).details).toMatchObject({ cancelled: false });
		const cancelled = await openQuestionnaire([targets], { "tui.select.cancel": "q" });
		cancelled.press("q");
		expect((await cancelled.result).details).toMatchObject({ cancelled: true });
	});

	it("validates multiSelect as an optional boolean in the model-facing schema", async () => {
		const ui = await openQuestionnaire([targets]);
		expect(Check(ui.tool.parameters, { questions: [targets] })).toBe(true);
		expect(Check(ui.tool.parameters, { questions: [{ ...targets, multiSelect: true }] })).toBe(true);
		expect(Check(ui.tool.parameters, { questions: [{ ...targets, multiSelect: "yes" }] })).toBe(false);
		ui.press(esc);
		await ui.result;
	});

	it("keeps selections independent when multiple questions allow multiple answers", async () => {
		const ui = await openQuestionnaire([
			{ ...targets, multiSelect: true },
			{ ...runtime, multiSelect: true },
		]);
		ui.press(" ", down, " ", enter);
		expect(ui.render()).toContain("[ ] 1. Node.js");
		expect(ui.render()).toContain("[ ] 2. Bun");
		ui.press(down, " ", enter);
		expect(ui.render()).toContain("Targets: Linux, macOS");
		expect(ui.render()).toContain("Runtime: Bun");
		ui.press(enter);
		expect((await ui.result).details).toMatchObject({
			answers: [
				{ id: "targets", values: ["linux", "macos"], labels: ["Linux", "macOS"] },
				{ id: "runtime", values: ["bun"], labels: ["Bun"] },
			],
		});
	});

	it("wraps multi-select labels and help on narrow terminals", async () => {
		const ui = await openQuestionnaire([{ ...targets, multiSelect: true }]);
		ui.press(" ");
		const lines = ui.render(24).split("\n");
		expect(lines.every((line) => line.length <= 24)).toBe(true);
		expect(lines.join("\n")).toContain("[x] 1. Linux");
		ui.press(esc);
		await ui.result;
	});
});
