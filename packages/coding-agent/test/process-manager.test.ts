import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessManager, type ProcessManagerLimits } from "../src/core/process-manager.ts";
import { getShellConfig } from "../src/utils/shell.ts";

const tempDirectories: string[] = [];
const managers: ProcessManager[] = [];

function createManager(limits?: ProcessManagerLimits): ProcessManager {
	const outputDirectory = mkdtempSync(join(tmpdir(), "pi-process-manager-"));
	tempDirectories.push(outputDirectory);
	const manager = new ProcessManager({ outputDirectory, limits });
	managers.push(manager);
	return manager;
}

function startBash(manager: ProcessManager, command: string, background = true, timeoutMs?: number) {
	return manager.start({
		command,
		cwd: process.cwd(),
		env: process.env,
		shellConfig: getShellConfig(),
		owner: { sessionId: "session-a", branchAnchorId: "entry-a" },
		backgroundReason: background ? "explicit" : undefined,
		timeoutMs,
	});
}

function readStatus(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

async function waitForFile(path: string): Promise<void> {
	await vi.waitFor(() => expect(existsSync(path)).toBe(true), { timeout: 2_000, interval: 10 });
}

afterEach(async () => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	for (const manager of managers.splice(0)) {
		manager.dispose();
		await Promise.all(manager.list().map((record) => manager.waitForExit(record.pid)));
	}
	for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ProcessManager", () => {
	it("publishes readable running status and final status after all retained output is available", async () => {
		const manager = createManager();
		const script = "process.stdout.write('x'.repeat(131072)); process.stderr.write('diagnostic');";
		const started = startBash(manager, `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`);

		expect(started.pid).toBeGreaterThan(0);
		expect(readStatus(started.statusPath)).toMatchObject({
			pid: started.pid,
			state: "running",
			outputPath: started.outputPath,
		});
		expect(readStatus(started.statusPath)).not.toHaveProperty("exitCode");

		await vi.waitFor(
			() => {
				expect(readStatus(started.statusPath)).toMatchObject({ state: "exited", exitCode: 0 });
				expect(readFileSync(started.outputPath, "utf8")).toHaveLength(131082);
			},
			{ timeout: 2_000, interval: 10 },
		);
		const status = readStatus(started.statusPath);
		expect(status).toHaveProperty("startedAt");
		expect(status).toHaveProperty("endedAt");
		expect(status).not.toHaveProperty("command");
		expect(status).not.toHaveProperty("output");
		expect(existsSync(`${started.statusPath}.tmp`)).toBe(false);
	});

	it("keeps foreground Bash waiting and executes its side effect once", async () => {
		const manager = createManager();
		const marker = join(tempDirectories.at(-1)!, "starts");
		const started = startBash(manager, `printf x >> ${JSON.stringify(marker)}; printf done`, false);
		const outcome = await manager.waitForForeground(started.pid);

		expect(outcome.type).toBe("exited");
		expect(readFileSync(marker, "utf8")).toBe("x");
		expect(readFileSync(started.outputPath, "utf8")).toBe("done");
		expect(readStatus(started.statusPath)).toMatchObject({ state: "exited", exitCode: 0 });
	});

	it("transfers the same foreground process through the human action", async () => {
		const manager = createManager();
		const marker = join(tempDirectories.at(-1)!, "starts");
		const started = startBash(manager, `printf x >> ${JSON.stringify(marker)}; printf done`, false);

		expect(manager.backgroundForegroundBash()).toBe(started.pid);
		expect(await manager.waitForForeground(started.pid)).toEqual({ type: "backgrounded", reason: "human" });
		await manager.waitForExit(started.pid);
		expect(readFileSync(marker, "utf8")).toBe("x");
		expect(readStatus(started.statusPath)).toMatchObject({ pid: started.pid, state: "exited", exitCode: 0 });
	});

	it("finalizes after the shell exits even when a descendant inherits stdio", async () => {
		const manager = createManager();
		const started = startBash(manager, "sleep 30 & printf complete");
		await vi.waitFor(
			() => {
				expect(readStatus(started.statusPath)).toMatchObject({ state: "exited", exitCode: 0 });
			},
			{ timeout: 2_000, interval: 10 },
		);
		expect(readFileSync(started.outputPath, "utf8")).toBe("complete");
	});

	it("retains a nonzero exit code and its diagnostics", async () => {
		const manager = createManager();
		const started = startBash(manager, "printf failed >&2; exit 7");
		await manager.waitForExit(started.pid);
		expect(readStatus(started.statusPath)).toMatchObject({
			state: "failed",
			exitCode: 7,
			error: "Command exited with code 7",
		});
		expect(readFileSync(started.outputPath, "utf8")).toBe("failed");
	});

	it("reports a termination signal instead of an unknown exit code", async () => {
		const manager = createManager();
		const started = startBash(manager, "exec sleep 30");
		process.kill(-started.pid, "SIGTERM");
		await manager.waitForExit(started.pid);
		expect(readStatus(started.statusPath)).toMatchObject({
			state: "failed",
			signal: "SIGTERM",
			error: "Command terminated by signal SIGTERM",
		});
		expect(readStatus(started.statusPath)).not.toHaveProperty("exitCode");
	});

	it("retains a timeout as a failure, not successful completion", async () => {
		const manager = createManager();
		const started = startBash(manager, "exec sleep 30", true, 50);
		await manager.waitForExit(started.pid);
		expect(readStatus(started.statusPath)).toMatchObject({
			state: "timed_out",
			error: "Command timed out after 50ms",
		});
	});

	it("reports output overflow and bounds the retained output", async () => {
		const manager = createManager({ maxOutputBytes: 128 });
		const started = startBash(
			manager,
			`${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('x'.repeat(4096))")}`,
		);
		await manager.waitForExit(started.pid);
		expect(readStatus(started.statusPath)).toMatchObject({
			state: "failed",
			error: "Process output limit exceeded (128 bytes)",
		});
		expect(readFileSync(started.outputPath).byteLength).toBe(128);
	});

	it("rejects starts beyond the process-count bound and stops owned child trees", async () => {
		const manager = createManager({ maxProcesses: 1 });
		const launched = join(tempDirectories.at(-1)!, "child-pid");
		const first = startBash(manager, `sleep 30 & echo $! > ${JSON.stringify(launched)}; wait`);
		await waitForFile(launched);
		await vi.waitFor(() => expect(readFileSync(launched, "utf8").trim()).toMatch(/^\d+$/));
		const childPid = Number(readFileSync(launched, "utf8").trim());

		expect(() => startBash(manager, "sleep 30")).toThrow("process limit");
		await manager.stop(first.pid);
		expect(readStatus(first.statusPath)).toMatchObject({ state: "cancelled" });
		await vi.waitFor(() => expect(() => process.kill(childPid, 0)).toThrow(), { timeout: 2_000, interval: 10 });
	});

	it("evicts terminal status and output together and never reuses artifact paths", async () => {
		const manager = createManager({ maxRecords: 1 });
		const first = startBash(manager, "printf first");
		await manager.waitForExit(first.pid);
		const second = startBash(manager, "printf second");
		await manager.waitForExit(second.pid);

		expect(existsSync(first.outputPath)).toBe(false);
		expect(existsSync(first.statusPath)).toBe(false);
		expect(second.outputPath).not.toBe(first.outputPath);
		expect(second.statusPath).not.toBe(first.statusPath);
		expect(manager.list()).toHaveLength(1);
	});

	it("removes artifacts synchronously so a quitting host cannot leave stale running status", async () => {
		const manager = new ProcessManager();
		managers.push(manager);
		const started = startBash(manager, "sleep 30");
		manager.dispose();
		// Interactive shutdown calls process.exit after dispose, without another event-loop turn.
		expect(existsSync(started.outputPath)).toBe(false);
		expect(existsSync(started.statusPath)).toBe(false);
		expect(existsSync(dirname(started.outputPath))).toBe(false);
		expect((await manager.waitForExit(started.pid)).state).toBe("cancelled");
	});

	it("fails the handoff and terminates the process when initial status publication fails", async () => {
		const manager = createManager();
		vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
			throw new Error("disk unavailable");
		});
		syncBuiltinESMExports();
		expect(() => startBash(manager, "sleep 30")).toThrow("Could not publish process status");
		const record = manager.list()[0];
		const final = await manager.waitForExit(record.pid);
		expect(final.state).toBe("failed");
		expect(final.error).toContain("disk unavailable");
		expect(() => process.kill(record.pid, 0)).toThrow();
	});

	it("invalidates running status and retains diagnostics if terminal publication fails", async () => {
		const manager = createManager();
		const started = startBash(manager, "exec sleep 30");
		// A filesystem obstruction makes publication fail without mocking lifecycle code.
		mkdirSync(`${started.statusPath}.tmp`);
		const final = await manager.stop(started.pid);
		expect(final.state).toBe("failed");
		expect(final.error).toContain("Status file failed");
		expect(existsSync(started.statusPath)).toBe(false);
		expect(existsSync(started.outputPath)).toBe(true);
	});
});
