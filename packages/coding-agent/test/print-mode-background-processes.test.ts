import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { getShellConfig } from "../src/utils/shell.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

describe("print-mode background process policy", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("waits through the Bash completion grace and delivers the terminal notification", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let continuationContext = "";
		harness.setResponses([
			(context) => {
				continuationContext = context.messages.map(getMessageText).join("\n");
				return fauxAssistantMessage("background handled");
			},
		]);
		const started = harness.session.processManager.start({
			command: "sleep 0.05; printf 'ready\\n'",
			cwd: harness.tempDir,
			env: process.env,
			shellConfig: getShellConfig(),
			owner: { sessionId: harness.session.sessionId, branchAnchorId: null },
			backgroundReason: "explicit",
		});

		await harness.session.waitForBackgroundProcessesForExit({ bashGraceMs: 2_000 });

		expect(harness.session.processManager.inspect(started.pid)?.state).toBe("exited");
		expect(continuationContext).toContain("Output was not loaded");
		expect(continuationContext).toContain("Exit code: 0");
		expect(continuationContext).not.toContain("ready");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("does not wait indefinitely for quiet background Bash", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const started = harness.session.processManager.start({
			command: "sleep 30",
			cwd: harness.tempDir,
			env: process.env,
			shellConfig: getShellConfig(),
			owner: { sessionId: harness.session.sessionId, branchAnchorId: null },
			backgroundReason: "explicit",
		});

		await harness.session.waitForBackgroundProcessesForExit({ bashGraceMs: 10 });

		expect(harness.session.processManager.inspect(started.pid)?.state).toBe("running");
	});
});
