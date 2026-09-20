import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { getShellConfig } from "../../src/utils/shell.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const WAIT_TIMEOUT_MS = 5_000;

function waitForAssistantText(harness: Harness, text: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			unsubscribe();
			reject(new Error(`Timed out waiting for assistant text: ${text}`));
		}, WAIT_TIMEOUT_MS);
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			if (getMessageText(event.message) !== text) return;
			clearTimeout(timeout);
			unsubscribe();
			resolve();
		});
	});
}

function backgroundMessages(harness: Harness) {
	return harness.session.messages.filter(
		(message) => message.role === "custom" && message.customType === "background-process",
	);
}

function startOwnedBackgroundProcess(harness: Harness, command: string) {
	return harness.session.processManager.start({
		command,
		cwd: harness.tempDir,
		env: process.env,
		shellConfig: getShellConfig(),
		owner: { sessionId: harness.session.sessionId, branchAnchorId: null },
		backgroundReason: "explicit",
	});
}

describe("AgentSession background processes", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("returns the OS PID and output path, injects active context, and notifies once on exit", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const startsPath = join(harness.tempDir, "starts");
		let activeContext = "";
		let completionContext = "";
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("bash", {
					command: `printf x >> ${JSON.stringify(startsPath)}; sleep 0.2; printf finished`,
					runInBackground: true,
				}),
				{ stopReason: "toolUse" },
			),
			(context) => {
				activeContext = context.messages.map(getMessageText).join("\n");
				return fauxAssistantMessage("background started");
			},
			(context) => {
				completionContext = context.messages.map(getMessageText).join("\n");
				return fauxAssistantMessage("completion handled");
			},
		]);
		const completion = waitForAssistantText(harness, "completion handled");

		await harness.session.prompt("run it");
		await completion;

		expect(readFileSync(startsPath, "utf8")).toBe("x");
		const bashResult = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "bash",
		);
		const bashText = bashResult ? getMessageText(bashResult) : "";
		const pid = Number(bashText.match(/PID: (\d+)/)?.[1]);
		const outputPath = bashText.match(/Output: (.+)/)?.[1];
		expect(pid).toBeGreaterThan(0);
		expect(outputPath).toBeTruthy();
		expect(activeContext).toContain("<background_processes>");
		expect(activeContext).toContain(`"pid":${pid}`);
		expect(activeContext).toContain('"backgroundReason":"explicit"');
		expect(activeContext).toContain(`"outputPath":${JSON.stringify(outputPath)}`);
		expect(completionContext).not.toContain("<background_processes>");
		expect(completionContext).toContain(`PID: ${pid}`);
		expect(completionContext).toContain("Exit code: 0");
		expect(completionContext).toContain(outputPath ?? "");
		expect(getMessageText(backgroundMessages(harness)[0]!)).not.toContain("Final output");
		expect(readFileSync(outputPath!, "utf8")).toBe("finished");
		expect(backgroundMessages(harness)).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("keeps timeout as a hard deadline before the foreground yield", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 30", timeout: 0.03 }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("timeout handled"),
		]);

		await harness.session.prompt("run with a deadline");

		const process = harness.session.processManager.list().find((entry) => entry.command === "sleep 30");
		expect(process?.state).toBe("timed_out");
		expect(backgroundMessages(harness)).toHaveLength(0);
		const result = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "bash",
		);
		expect(result ? getMessageText(result) : "").toContain("timed out");
	});

	it("automatically yields Bash without restarting it", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const startsPath = join(harness.tempDir, "yield-starts");
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("bash", {
					command: `printf x >> ${JSON.stringify(startsPath)}; sleep 0.15; printf done`,
					yieldAfter: 0.01,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("yielded"),
			fauxAssistantMessage("completion handled"),
		]);
		const completion = waitForAssistantText(harness, "completion handled");

		await harness.session.prompt("run it");
		await completion;

		expect(readFileSync(startsPath, "utf8")).toBe("x");
		const bashResult = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "bash",
		);
		expect(bashResult ? getMessageText(bashResult) : "").toContain("moved to background (yield)");
		expect(bashResult ? getMessageText(bashResult) : "").toMatch(/PID: \d+/);
		expect(backgroundMessages(harness)).toHaveLength(1);
	});

	it("uses no model call while a quiet process waits", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 30", runInBackground: true }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("started"),
		]);

		await harness.session.prompt("start quiet work");

		expect(harness.getPendingResponseCount()).toBe(0);
		expect(backgroundMessages(harness)).toHaveLength(0);
		const process = harness.session.listOwnedBackgroundProcesses().find((entry) => entry.command === "sleep 30");
		expect(process?.state).toBe("running");
	});

	it("coalesces concurrent terminal notifications into one wake-up without combining messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let completionContext = "";
		harness.setResponses([
			(context) => {
				completionContext = context.messages.map(getMessageText).join("\n");
				return fauxAssistantMessage("both handled");
			},
		]);
		const first = startOwnedBackgroundProcess(harness, "sleep 0.05; printf first");
		const second = startOwnedBackgroundProcess(harness, "sleep 0.05; printf second");
		const handled = waitForAssistantText(harness, "both handled");

		await Promise.all([
			harness.session.processManager.waitForExit(first.pid),
			harness.session.processManager.waitForExit(second.pid),
		]);
		await handled;

		expect(backgroundMessages(harness)).toHaveLength(2);
		expect(completionContext).toContain(`PID: ${first.pid}`);
		expect(completionContext).toContain(`PID: ${second.pid}`);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("serializes terminal delivery with a new prompt preflight", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (event.text === "new prompt") {
							await new Promise((resolve) => setTimeout(resolve, 100));
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 200));
				return fauxAssistantMessage("user handled");
			},
			fauxAssistantMessage("completion handled"),
		]);
		const handled = waitForAssistantText(harness, "completion handled");
		const started = startOwnedBackgroundProcess(harness, "sleep 0.01; printf complete");

		await expect(harness.session.prompt("new prompt")).resolves.toBeUndefined();
		await handled;

		expect(harness.session.processManager.inspect(started.pid)?.state).toBe("exited");
		expect(backgroundMessages(harness)).toHaveLength(1);
		expect(harness.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("reports signal termination without an unknown exit code", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let completionContext = "";
		harness.setResponses([
			(context) => {
				completionContext = context.messages.map(getMessageText).join("\n");
				return fauxAssistantMessage("signal handled");
			},
		]);
		const started = startOwnedBackgroundProcess(harness, "exec sleep 30");
		const handled = waitForAssistantText(harness, "signal handled");

		process.kill(-started.pid, "SIGTERM");
		await handled;

		expect(completionContext).toContain(`PID: ${started.pid}`);
		expect(completionContext).toContain("Termination signal: SIGTERM");
		expect(completionContext).not.toContain("exit code unknown");
		expect(backgroundMessages(harness)).toHaveLength(1);
	});

	it("preserves process ownership across extension reload", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const started = startOwnedBackgroundProcess(harness, "sleep 30");

		await harness.session.reload();

		expect(harness.session.processManager.inspect(started.pid)?.state).toBe("running");
		await harness.session.processManager.stop(started.pid);
	});

	it("holds notifications whose branch anchor is outside the active branch", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const started = harness.session.processManager.start({
			command: "printf 'other branch\\n'",
			cwd: harness.tempDir,
			env: process.env,
			shellConfig: getShellConfig(),
			owner: { sessionId: harness.session.sessionId, branchAnchorId: "not-on-active-branch" },
			backgroundReason: "explicit",
		});

		await harness.session.processManager.waitForExit(started.pid);
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(backgroundMessages(harness)).toHaveLength(0);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("aborting foreground Bash kills its owned process tree without a background notification", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 30", yieldAfter: 0 }), {
				stopReason: "toolUse",
			}),
		]);
		const prompt = harness.session.prompt("run in foreground");
		const deadline = Date.now() + 2_000;
		while (!harness.session.processManager.list().some((entry) => entry.command === "sleep 30")) {
			if (Date.now() >= deadline) throw new Error("Timed out waiting for foreground Bash");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		await harness.session.abort();
		await prompt;

		const process = harness.session.processManager.list().find((entry) => entry.command === "sleep 30");
		expect(process?.state).toBe("cancelled");
		expect(backgroundMessages(harness)).toHaveLength(0);
	});

	it("queues a steer while a run is active and does not clear that run", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness.setResponses([
			async () => {
				await gate;
				return fauxAssistantMessage("done");
			},
		]);
		const prompt = harness.session.prompt("start");
		const deadline = Date.now() + WAIT_TIMEOUT_MS;
		while (!harness.session.isStreaming) {
			if (Date.now() >= deadline) throw new Error("Timed out waiting for the run");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		await harness.session.prompt("steer this", { streamingBehavior: "steer" });
		expect(harness.session.getSteeringMessages()).toContain("steer this");
		expect(harness.session.isStreaming).toBe(true);
		await expect(harness.session.prompt("second prompt")).rejects.toThrow(/already processing|streamingBehavior/);
		expect(harness.session.isStreaming).toBe(true);

		release();
		await prompt;
		expect(harness.session.isStreaming).toBe(false);
		expect(
			harness.session.messages.some(
				(message) => message.role === "user" && getMessageText(message) === "steer this",
			),
		).toBe(true);
	});

	it("records a terminal notification during an active run and wakes once", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let exitPid = 0;
		const notificationRecorded = () =>
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom_message" && entry.customType === "background-process");
		harness.setResponses([
			async () => {
				const started = startOwnedBackgroundProcess(harness, "printf done");
				exitPid = started.pid;
				await harness.session.processManager.waitForExit(started.pid);
				const deadline = Date.now() + WAIT_TIMEOUT_MS;
				while (!notificationRecorded()) {
					if (Date.now() >= deadline) throw new Error("Timed out waiting for terminal notification");
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				await gate;
				return fauxAssistantMessage("still working");
			},
			(context) => {
				const text = context.messages.map(getMessageText).join("\n");
				if (!text.includes(`PID: ${exitPid}`)) throw new Error(`completion context missing PID ${exitPid}`);
				return fauxAssistantMessage("completion handled");
			},
		]);
		const handled = waitForAssistantText(harness, "completion handled");
		const prompt = harness.session.prompt("run");
		const deadline = Date.now() + WAIT_TIMEOUT_MS;
		while (!notificationRecorded()) {
			if (Date.now() >= deadline) throw new Error("Timed out waiting for terminal notification");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(harness.session.isStreaming).toBe(true);
		release();
		await prompt;
		await handled;
		expect(backgroundMessages(harness)).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
