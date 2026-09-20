import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { getShellConfig } from "../../src/utils/shell.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const WAIT_TIMEOUT_MS = 5_000;

function contextText(context: { messages: Parameters<typeof getMessageText>[0][] }): string {
	return context.messages.map(getMessageText).join("\n");
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

function bashResultText(harness: Harness): string {
	const result = harness.session.messages.find(
		(message) => message.role === "toolResult" && message.toolName === "bash",
	);
	return result ? getMessageText(result) : "";
}

describe("AgentSession background processes", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("returns PID and artifact paths once and retrieves completion only through explicit Read calls", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const startsPath = join(harness.tempDir, "starts");
		const releasePath = join(harness.tempDir, "release");
		let statusPath = "";
		let outputPath = "";
		let activeContext = "";
		let beforeReadContext = "";
		let statusResult = "";
		let outputResult = "";
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("bash", {
					command: `printf x >> ${JSON.stringify(startsPath)}; while [ ! -f ${JSON.stringify(releasePath)} ]; do sleep 0.01; done; printf '\\160\\165\\154\\154\\055\\157\\156\\154\\171'`,
					runInBackground: true,
					timeout: 5,
				}),
				{ stopReason: "toolUse" },
			),
			(context) => {
				activeContext = contextText(context);
				return fauxAssistantMessage("background started");
			},
			(context) => {
				beforeReadContext = contextText(context);
				return fauxAssistantMessage(fauxToolCall("read", { path: statusPath }), { stopReason: "toolUse" });
			},
			(context) => {
				statusResult = getMessageText(context.messages.at(-1)!);
				return fauxAssistantMessage(fauxToolCall("read", { path: outputPath }), { stopReason: "toolUse" });
			},
			(context) => {
				outputResult = getMessageText(context.messages.at(-1)!);
				return fauxAssistantMessage("verified");
			},
		]);

		await harness.session.prompt("run it");
		const result = bashResultText(harness);
		const pid = Number(result.match(/PID: (\d+)/)?.[1]);
		outputPath = result.match(/Output: (.+)/)![1];
		statusPath = result.match(/Status: (.+)/)![1];
		expect(pid).toBeGreaterThan(0);
		expect(JSON.parse(readFileSync(statusPath, "utf8"))).toMatchObject({ pid, state: "running" });
		writeFileSync(releasePath, "go");
		await harness.session.processManager.waitForExit(pid);
		expect(readFileSync(startsPath, "utf8")).toBe("x");
		expect(harness.getPendingResponseCount()).toBe(3);
		await harness.session.prompt("check it");
		expect(activeContext).not.toContain("<background_processes>");
		expect(beforeReadContext).not.toContain("<background_processes>");
		expect(beforeReadContext).not.toContain('"exitCode"');
		expect(JSON.parse(statusResult)).toMatchObject({ state: "exited", exitCode: 0 });
		expect(outputResult).toBe("pull-only");
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(3);
		expect(harness.session.messages.some((message) => message.role === "custom")).toBe(false);
	});

	it("keeps a foreground command in the foreground until it exits", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const startsPath = join(harness.tempDir, "foreground-starts");
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("bash", {
					command: `printf x >> ${JSON.stringify(startsPath)}; sleep 0.2; printf done`,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("finished"),
		]);

		await harness.session.prompt("run it");

		expect(readFileSync(startsPath, "utf8")).toBe("x");
		expect(bashResultText(harness)).toContain("done");
		expect(bashResultText(harness)).not.toContain("background");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("keeps timeout as a hard deadline for foreground Bash", async () => {
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
		expect(process?.backgroundReason).toBeUndefined();
		expect(bashResultText(harness)).toContain("timed out");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("uses no model call while a background process waits or exits", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.05; printf quiet", runInBackground: true }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("started"),
		]);

		await harness.session.prompt("start quiet work");
		const process = harness.session.listOwnedBackgroundProcesses().find((entry) => entry.command.includes("quiet"));
		expect(process?.state).toBe("running");
		await harness.session.processManager.waitForExit(process!.pid);

		expect(harness.session.processManager.inspect(process!.pid)?.state).toBe("exited");
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.messages.filter((message) => message.role === "assistant")).toHaveLength(2);
	});

	it("keeps concurrent exits out of subsequent model requests", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let exitContext = "";
		harness.setResponses([
			(context) => {
				exitContext = contextText(context);
				return fauxAssistantMessage("saw both");
			},
		]);
		const first = startOwnedBackgroundProcess(harness, "sleep 0.05; printf first");
		const second = startOwnedBackgroundProcess(harness, "sleep 0.05; printf second");

		await Promise.all([
			harness.session.processManager.waitForExit(first.pid),
			harness.session.processManager.waitForExit(second.pid),
		]);
		expect(harness.getPendingResponseCount()).toBe(1);

		await harness.session.prompt("check");

		expect(exitContext).not.toContain(String(first.pid));
		expect(exitContext).not.toContain(String(second.pid));
		expect(exitContext).not.toContain("<background_processes>");
		expect(exitContext).not.toContain('"exitCode"');
		expect(JSON.parse(readFileSync(first.statusPath, "utf8"))).toMatchObject({ exitCode: 0 });
		expect(JSON.parse(readFileSync(second.statusPath, "utf8"))).toMatchObject({ exitCode: 0 });
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("keeps signal termination out of model requests and makes it readable on demand", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let exitContext = "";
		harness.setResponses([
			(context) => {
				exitContext = contextText(context);
				return fauxAssistantMessage("saw signal");
			},
		]);
		const started = startOwnedBackgroundProcess(harness, "exec sleep 30");

		process.kill(-started.pid, "SIGTERM");
		await harness.session.processManager.waitForExit(started.pid);
		await harness.session.prompt("check");

		expect(exitContext).not.toContain(String(started.pid));
		expect(exitContext).not.toContain("SIGTERM");
		expect(exitContext).not.toContain("<background_processes>");
		const status = JSON.parse(readFileSync(started.statusPath, "utf8"));
		expect(status).toMatchObject({ state: "failed", signal: "SIGTERM" });
		expect(status).not.toHaveProperty("exitCode");
	});

	it.each([0, 7])("does not inject running or exited status for exit code %i", async (exitCode) => {
		const harness = await createHarness();
		harnesses.push(harness);
		const releasePath = join(harness.tempDir, "release");
		const started = startOwnedBackgroundProcess(
			harness,
			`while [ ! -f ${JSON.stringify(releasePath)} ]; do sleep 0.01; done; exit ${exitCode}`,
		);
		const contexts: string[] = [];
		harness.setResponses([
			(context) => {
				contexts.push(contextText(context));
				return fauxAssistantMessage("working");
			},
			(context) => {
				contexts.push(contextText(context));
				return fauxAssistantMessage("unrelated reply");
			},
		]);
		await harness.session.prompt("unrelated work");
		expect(harness.session.listOwnedBackgroundProcesses()[0].state).toBe("running");
		writeFileSync(releasePath, "go");
		await harness.session.processManager.waitForExit(started.pid);
		expect(harness.getPendingResponseCount()).toBe(1);
		await harness.session.prompt("more unrelated work");
		expect(contexts).toHaveLength(2);
		for (const context of contexts) {
			expect(context).not.toContain(String(started.pid));
			expect(context).not.toContain("<background_processes>");
		}
		expect(JSON.parse(readFileSync(started.statusPath, "utf8"))).toMatchObject({ exitCode });
	});

	it("returns the human handoff and does not wake when that process exits", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.2; printf done" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("handed off"),
		]);
		const prompt = harness.session.prompt("run in foreground");
		const deadline = Date.now() + 2_000;
		while (!harness.session.processManager.list().some((entry) => entry.command.includes("sleep 0.2"))) {
			if (Date.now() >= deadline) throw new Error("Timed out waiting for foreground Bash");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		const pid = harness.session.backgroundForegroundBash();
		await prompt;

		expect(pid).toBeGreaterThan(0);
		expect(bashResultText(harness)).toContain("moved to background (human)");
		expect(bashResultText(harness)).toContain(`PID: ${pid}`);
		const statusPath = bashResultText(harness).match(/Status: (.+)/)![1];
		await harness.session.processManager.waitForExit(pid!);
		expect(JSON.parse(readFileSync(statusPath, "utf8"))).toMatchObject({ pid, exitCode: 0 });
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("preserves process ownership across extension reload", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const started = startOwnedBackgroundProcess(harness, "sleep 30");

		await harness.session.reload();

		expect(harness.session.processManager.inspect(started.pid)?.state).toBe("running");
		await harness.session.processManager.stop(started.pid);
	});

	it("omits records from other branches in the human process list", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let exitContext = "";
		harness.setResponses([
			(context) => {
				exitContext = contextText(context);
				return fauxAssistantMessage("checked");
			},
		]);
		const started = harness.session.processManager.start({
			command: "printf 'other branch\\n'",
			cwd: harness.tempDir,
			env: process.env,
			shellConfig: getShellConfig(),
			owner: { sessionId: harness.session.sessionId, branchAnchorId: "not-on-active-branch" },
			backgroundReason: "explicit",
		});

		await harness.session.processManager.waitForExit(started.pid);
		await harness.session.prompt("check");

		expect(exitContext).not.toContain(`"pid":${started.pid}`);
		expect(harness.session.listOwnedBackgroundProcesses()).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("aborting foreground Bash kills its owned process tree", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 30" }), {
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
		expect(process?.backgroundReason).toBeUndefined();
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

	it("does not extend an active run when a background process exits", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let exitPid = 0;
		let nextContext = "";
		harness.setResponses([
			async () => {
				const started = startOwnedBackgroundProcess(harness, "printf done");
				exitPid = started.pid;
				await harness.session.processManager.waitForExit(started.pid);
				await gate;
				return fauxAssistantMessage("still working");
			},
			(context) => {
				nextContext = contextText(context);
				return fauxAssistantMessage("saw exit");
			},
		]);
		const prompt = harness.session.prompt("run");
		const deadline = Date.now() + WAIT_TIMEOUT_MS;
		while (exitPid === 0) {
			if (Date.now() >= deadline) throw new Error("Timed out waiting for the background process");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(harness.session.isStreaming).toBe(true);
		release();
		await prompt;

		expect(
			harness.session.messages.some(
				(message) => message.role === "custom" && message.customType === "background-process",
			),
		).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(1);
		await harness.session.prompt("check");
		expect(nextContext).not.toContain(`"pid":${exitPid}`);
		expect(nextContext).not.toContain("<background_processes>");
		expect(nextContext).not.toContain('"exitCode"');
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
