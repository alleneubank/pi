import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessManager, type ProcessManagerEvent, type ProcessSnapshot } from "../src/core/process-manager.ts";
import { getShellConfig } from "../src/utils/shell.ts";

const tempDirectories: string[] = [];

function createManager(
	onEvent: (event: ProcessManagerEvent) => void,
	limits?: { maxProcesses?: number; maxRecords?: number; maxOutputBytes?: number; maxNotificationBytes?: number },
): ProcessManager {
	const outputDirectory = join(tmpdir(), `pi-process-manager-${process.pid}-${tempDirectories.length}`);
	mkdirSync(outputDirectory, { recursive: true });
	tempDirectories.push(outputDirectory);
	return new ProcessManager({ onEvent, outputDirectory, limits });
}

function startBash(manager: ProcessManager, command: string, background = true) {
	return manager.start({
		command,
		cwd: process.cwd(),
		env: process.env,
		shellConfig: getShellConfig(),
		owner: { sessionId: "session-a", branchAnchorId: "entry-a" },
		backgroundReason: background ? "explicit" : undefined,
	});
}

async function waitForExit(manager: ProcessManager, pid: number): Promise<ProcessSnapshot> {
	return await manager.waitForExit(pid);
}

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!existsSync(path)) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("ProcessManager", () => {
	it("returns the spawned OS PID and emits one bounded terminal event", async () => {
		const events: ProcessManagerEvent[] = [];
		const manager = createManager((event) => events.push(event), { maxNotificationBytes: 32 });
		const script = "process.stdout.write('x'.repeat(128)); process.stderr.write('diagnostic');";

		const started = startBash(manager, `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`);
		const snapshot = await waitForExit(manager, started.pid);

		expect(started.pid).toBeGreaterThan(0);
		expect(snapshot).toMatchObject({ pid: started.pid, state: "exited", exitCode: 0 });
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			pid: started.pid,
			type: "exit",
			state: "exited",
			exitCode: 0,
			outputPath: started.outputPath,
		});
		expect(Buffer.byteLength(events[0].output ?? "")).toBeLessThanOrEqual(32);
		expect(Buffer.byteLength(events[0].diagnostics ?? "")).toBeLessThanOrEqual(32);
		expect(readFileSync(started.outputPath, "utf8")).toContain("diagnostic");
		manager.dispose();
	});

	it("does not emit foreground Bash evidence until ownership transfers", async () => {
		const events: ProcessManagerEvent[] = [];
		const manager = createManager((event) => events.push(event));
		const started = startBash(manager, "printf complete", false);

		const outcome = await manager.waitForForeground(started.pid, { yieldAfterMs: 0 });

		expect(outcome.type).toBe("exited");
		expect(events).toEqual([]);
		expect(readFileSync(started.outputPath, "utf8")).toBe("complete");
		manager.dispose();
	});

	it("transfers the same Bash process after the foreground wait", async () => {
		const events: ProcessManagerEvent[] = [];
		const manager = createManager((event) => events.push(event));
		const marker = join(tempDirectories.at(-1)!, "starts");
		const script = `printf x >> ${JSON.stringify(marker)}; sleep 0.2; printf done`;
		const started = startBash(manager, script, false);

		const outcome = await manager.waitForForeground(started.pid, { yieldAfterMs: 10 });
		expect(outcome).toEqual({ type: "backgrounded", reason: "yield" });
		await waitForExit(manager, started.pid);

		expect(readFileSync(marker, "utf8")).toBe("x");
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "exit", pid: started.pid, exitCode: 0 });
		manager.dispose();
	});

	it("transfers the foreground Bash process through the human action", async () => {
		const events: ProcessManagerEvent[] = [];
		const manager = createManager((event) => events.push(event));
		const started = startBash(manager, "sleep 0.1; printf done", false);

		expect(manager.backgroundForegroundBash()).toBe(started.pid);
		const outcome = await manager.waitForForeground(started.pid, { yieldAfterMs: 0 });
		expect(outcome).toEqual({ type: "backgrounded", reason: "human" });
		await waitForExit(manager, started.pid);

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ pid: started.pid, exitCode: 0, output: "done" });
		manager.dispose();
	});

	it("finalizes after the shell exits even when a descendant inherits stdio", async () => {
		const events: ProcessManagerEvent[] = [];
		const manager = createManager((event) => events.push(event));
		const started = startBash(manager, "sleep 30 & printf complete");

		const snapshot = await Promise.race([
			waitForExit(manager, started.pid),
			new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error("Process remained running after its shell exited")), 2_000);
			}),
		]);

		expect(snapshot).toMatchObject({ state: "exited", exitCode: 0 });
		expect(events).toHaveLength(1);
		expect(events[0].output).toBe("complete");
		manager.dispose();
	});

	it("reports a termination signal instead of an unknown exit code", async () => {
		const events: ProcessManagerEvent[] = [];
		const manager = createManager((event) => events.push(event));
		const started = startBash(manager, "exec sleep 30");

		process.kill(-started.pid, "SIGTERM");
		const snapshot = await waitForExit(manager, started.pid);

		expect(snapshot).toMatchObject({ state: "failed", signal: "SIGTERM" });
		expect(snapshot.exitCode).toBeUndefined();
		expect(snapshot.error).toBe("Command terminated by signal SIGTERM");
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ signal: "SIGTERM", error: "Command terminated by signal SIGTERM" });
		manager.dispose();
	});

	it("surfaces output overflow in the sole terminal event and bounds the output file", async () => {
		const events: ProcessManagerEvent[] = [];
		const manager = createManager((event) => events.push(event), { maxOutputBytes: 128 });
		const started = startBash(
			manager,
			`${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('x'.repeat(4096))")}`,
		);

		const snapshot = await waitForExit(manager, started.pid);

		expect(snapshot.state).toBe("failed");
		expect(snapshot.error).toContain("output limit");
		expect(events).toHaveLength(1);
		expect(events[0].error).toContain("output limit");
		expect(readFileSync(started.outputPath).byteLength).toBeLessThanOrEqual(128);
		manager.dispose();
	});

	it("rejects starts beyond the process-count bound and stops owned child trees", async () => {
		const manager = createManager(() => {}, { maxProcesses: 1 });
		const launched = join(tempDirectories.at(-1)!, "child-launched");
		const orphanOutput = join(tempDirectories.at(-1)!, "orphan-output");
		const command = `(printf launched > ${JSON.stringify(launched)}; sleep 0.2; printf orphan > ${JSON.stringify(orphanOutput)}) & wait`;
		const first = startBash(manager, command);
		await waitForFile(launched);

		expect(() => startBash(manager, "sleep 30")).toThrow("process limit");
		await manager.stop(first.pid);
		const snapshot = await waitForExit(manager, first.pid);
		expect(snapshot.state).toBe("cancelled");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(existsSync(orphanOutput)).toBe(false);
		manager.dispose();
	});

	it("retains terminal records until notification delivery and then enforces the record bound", async () => {
		const events: ProcessManagerEvent[] = [];
		const manager = createManager((event) => events.push(event), { maxRecords: 1 });
		const first = startBash(manager, "printf first");
		await waitForExit(manager, first.pid);

		expect(() => startBash(manager, "printf blocked")).toThrow("record limit");
		expect(existsSync(first.outputPath)).toBe(true);
		manager.acknowledgeTerminalEvent(first.pid);

		const second = startBash(manager, "printf second");
		await waitForExit(manager, second.pid);
		expect(existsSync(first.outputPath)).toBe(false);
		expect(events).toHaveLength(2);
		manager.dispose();
	});

	it("removes retained output after runtime disposal", async () => {
		const manager = createManager(() => {});
		const started = startBash(manager, "sleep 30");
		await waitForFile(started.outputPath);

		manager.dispose();
		const snapshot = await waitForExit(manager, started.pid);

		expect(snapshot.state).toBe("cancelled");
		expect(existsSync(started.outputPath)).toBe(false);
	});
});
