import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	createWriteStream,
	mkdirSync,
	mkdtempSync,
	openSync,
	renameSync,
	rmSync,
	type WriteStream,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { waitForChildProcess } from "../utils/child-process.ts";
import { killProcessTree, type ShellConfig, trackDetachedChildPid, untrackDetachedChildPid } from "../utils/shell.ts";

export const DEFAULT_PROCESS_LIMIT = 32;
export const DEFAULT_PROCESS_RECORD_LIMIT = 128;
export const DEFAULT_PROCESS_OUTPUT_BYTES = 10 * 1024 * 1024;

export type ProcessState = "running" | "exited" | "failed" | "cancelled" | "timed_out";
export type BackgroundReason = "explicit" | "human";

export interface ProcessOwner {
	sessionId: string;
	branchAnchorId: string | null;
}

export interface ProcessSnapshot {
	pid: number;
	command: string;
	owner: ProcessOwner;
	state: ProcessState;
	backgroundReason?: BackgroundReason;
	outputPath: string;
	statusPath: string;
	startedAt: number;
	endedAt?: number;
	exitCode?: number;
	signal?: NodeJS.Signals;
	error?: string;
}

export interface StartProcessOptions {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	shellConfig: ShellConfig;
	owner: ProcessOwner;
	backgroundReason?: BackgroundReason;
	timeoutMs?: number;
	onData?: (data: Buffer) => void;
}

export interface StartedProcess {
	pid: number;
	outputPath: string;
	statusPath: string;
}

export type ForegroundProcessOutcome =
	| { type: "exited"; snapshot: ProcessSnapshot }
	| { type: "backgrounded"; reason: BackgroundReason };

export interface ProcessManagerLimits {
	maxProcesses?: number;
	maxRecords?: number;
	maxOutputBytes?: number;
}

export interface ProcessManagerOptions {
	outputDirectory?: string;
	limits?: ProcessManagerLimits;
}

interface ProcessRecord {
	snapshot: ProcessSnapshot;
	child: ChildProcess;
	output: WriteStream;
	outputBytes: number;
	completion: Promise<ProcessSnapshot>;
	resolveCompletion: (snapshot: ProcessSnapshot) => void;
	backgrounded: Promise<BackgroundReason>;
	resolveBackgrounded: (reason: BackgroundReason) => void;
	timeoutHandle?: NodeJS.Timeout;
	requestedTerminal?: "cancelled" | "timed_out" | "failed";
	requestedError?: string;
	finalized: boolean;
	pausedStreams: Set<Readable>;
	onData?: (data: Buffer) => void;
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

export class ProcessManager {
	private readonly outputDirectory: string;
	private readonly ownsOutputDirectory: boolean;
	private readonly maxProcesses: number;
	private readonly maxRecords: number;
	private readonly maxOutputBytes: number;
	private readonly records = new Map<number, ProcessRecord>();
	private disposed = false;

	constructor(options: ProcessManagerOptions = {}) {
		this.ownsOutputDirectory = options.outputDirectory === undefined;
		this.outputDirectory = options.outputDirectory ?? mkdtempSync(join(tmpdir(), "pi-processes-"));
		this.maxProcesses = options.limits?.maxProcesses ?? DEFAULT_PROCESS_LIMIT;
		this.maxRecords = options.limits?.maxRecords ?? DEFAULT_PROCESS_RECORD_LIMIT;
		this.maxOutputBytes = options.limits?.maxOutputBytes ?? DEFAULT_PROCESS_OUTPUT_BYTES;
		mkdirSync(this.outputDirectory, { recursive: true });
	}

	start(options: StartProcessOptions): StartedProcess {
		if (this.disposed) throw new Error("Process manager is disposed");
		const running = [...this.records.values()].filter((record) => record.snapshot.state === "running").length;
		if (running >= this.maxProcesses) {
			throw new Error(`Background process limit reached (${this.maxProcesses})`);
		}
		this.evictTerminalRecords();

		const commandFromStdin = options.shellConfig.commandTransport === "stdin";
		const child = spawn(
			options.shellConfig.shell,
			commandFromStdin ? options.shellConfig.args : [...options.shellConfig.args, options.command],
			{
				cwd: options.cwd,
				detached: process.platform !== "win32",
				env: options.env,
				stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			},
		);
		if (commandFromStdin) {
			child.stdin?.on("error", () => {});
			child.stdin?.end(options.command);
		}
		const pid = child.pid;
		if (pid === undefined) {
			child.once("error", () => {});
			throw new Error("Failed to start process: no OS PID was assigned");
		}
		trackDetachedChildPid(pid);

		const previous = this.records.get(pid);
		if (previous) {
			if (previous.snapshot.state === "running") {
				killProcessTree(pid);
				untrackDetachedChildPid(pid);
				throw new Error(`OS PID ${pid} is already tracked`);
			}
			this.removeArtifacts(previous);
			this.records.delete(pid);
		}

		// Artifact identity must not be reused when the OS recycles a PID.
		const artifactPath = join(this.outputDirectory, `${pid}-${randomUUID()}`);
		const outputPath = `${artifactPath}.log`;
		const statusPath = `${artifactPath}.status.json`;
		let output: WriteStream;
		try {
			const outputFd = openSync(outputPath, "wx", 0o600);
			output = createWriteStream(outputPath, { fd: outputFd, autoClose: true });
		} catch (error) {
			killProcessTree(pid);
			untrackDetachedChildPid(pid);
			throw error;
		}

		const completion = createDeferred<ProcessSnapshot>();
		const backgrounded = createDeferred<BackgroundReason>();
		const record: ProcessRecord = {
			snapshot: {
				pid,
				command: options.command,
				owner: { ...options.owner },
				state: "running",
				backgroundReason: options.backgroundReason,
				outputPath,
				statusPath,
				startedAt: Date.now(),
			},
			child,
			output,
			outputBytes: 0,
			completion: completion.promise,
			resolveCompletion: completion.resolve,
			backgrounded: backgrounded.promise,
			resolveBackgrounded: backgrounded.resolve,
			finalized: false,
			pausedStreams: new Set(),
			onData: options.onData,
		};
		this.records.set(pid, record);

		output.on("drain", () => {
			for (const stream of record.pausedStreams) stream.resume();
			record.pausedStreams.clear();
		});
		output.on("error", (error) => {
			this.requestTermination(record, "failed", `Output file failed: ${error.message}`);
		});
		child.stdout?.on("data", (data: Buffer) => this.handleOutput(record, child.stdout!, data));
		child.stderr?.on("data", (data: Buffer) => this.handleOutput(record, child.stderr!, data));
		child.once("exit", () => {
			// A shell may exit while descendants retain its stdio. End the owned tree so
			// the dead shell PID cannot remain tracked forever or be reused underneath us.
			killProcessTree(pid);
		});
		void waitForChildProcess(child).then(
			(code) => this.finalize(record, code, child.signalCode),
			(error: Error) => {
				record.requestedTerminal = "failed";
				record.requestedError = `Failed to start process: ${error.message}`;
				return this.finalize(record, null, null);
			},
		);

		if (options.timeoutMs !== undefined) {
			record.timeoutHandle = setTimeout(() => {
				this.requestTermination(record, "timed_out", `Command timed out after ${options.timeoutMs}ms`);
			}, options.timeoutMs);
		}

		try {
			this.publishStatus(record.snapshot);
		} catch (error) {
			this.requestTermination(record, "failed", `Status file failed: ${String(error)}`);
			throw new Error(`Could not publish process status for PID ${pid}`, { cause: error });
		}
		return { pid, outputPath, statusPath };
	}

	async waitForForeground(pid: number, options?: { signal?: AbortSignal }): Promise<ForegroundProcessOutcome> {
		const record = this.requireRecord(pid);
		if (record.snapshot.backgroundReason) {
			return { type: "backgrounded", reason: record.snapshot.backgroundReason };
		}

		let abortListener: (() => void) | undefined;
		if (options?.signal) {
			abortListener = () => {
				void this.stop(pid);
			};
			if (options.signal.aborted) abortListener();
			else options.signal.addEventListener("abort", abortListener, { once: true });
		}

		try {
			return await Promise.race([
				record.completion.then((snapshot) => ({ type: "exited" as const, snapshot })),
				record.backgrounded.then((reason) => ({ type: "backgrounded" as const, reason })),
			]);
		} finally {
			if (options?.signal && abortListener) options.signal.removeEventListener("abort", abortListener);
		}
	}

	background(pid: number, reason: BackgroundReason = "human"): boolean {
		const record = this.records.get(pid);
		if (!record || record.snapshot.state !== "running" || record.snapshot.backgroundReason) return false;
		record.snapshot.backgroundReason = reason;
		record.resolveBackgrounded(reason);
		return true;
	}

	backgroundForegroundBash(): number | undefined {
		for (const record of this.records.values()) {
			if (record.snapshot.state === "running" && !record.snapshot.backgroundReason) {
				this.background(record.snapshot.pid, "human");
				return record.snapshot.pid;
			}
		}
		return undefined;
	}

	async stop(pid: number): Promise<ProcessSnapshot> {
		const record = this.requireRecord(pid);
		if (record.snapshot.state !== "running") return this.copySnapshot(record.snapshot);
		this.requestTermination(record, "cancelled", "Process stopped");
		return await record.completion;
	}

	waitForExit(pid: number): Promise<ProcessSnapshot> {
		return this.requireRecord(pid).completion;
	}

	list(): ProcessSnapshot[] {
		return [...this.records.values()].map((record) => this.copySnapshot(record.snapshot));
	}

	inspect(pid: number): ProcessSnapshot | undefined {
		const record = this.records.get(pid);
		return record ? this.copySnapshot(record.snapshot) : undefined;
	}

	hasRunning(): boolean {
		return [...this.records.values()].some((record) => record.snapshot.state === "running");
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const record of this.records.values()) {
			if (record.snapshot.state === "running") {
				this.requestTermination(record, "cancelled", "Runtime disposed");
			}
			// The host may exit before child/stream callbacks run. Invalidate artifacts now;
			// finalization retries cleanup after closing any still-open output handle.
			this.removeArtifacts(record);
		}
		this.removeOwnedDirectory();
	}

	private handleOutput(record: ProcessRecord, source: Readable, data: Buffer): void {
		if (record.finalized || data.length === 0) return;
		const remaining = this.maxOutputBytes - record.outputBytes;
		const accepted = data.subarray(0, Math.max(0, remaining));
		if (accepted.length > 0) {
			record.outputBytes += accepted.length;
			if (!record.output.write(accepted)) {
				source.pause();
				record.pausedStreams.add(source);
			}
			record.onData?.(accepted);
		}
		if (accepted.length !== data.length) {
			this.requestTermination(record, "failed", `Process output limit exceeded (${this.maxOutputBytes} bytes)`);
		}
	}

	private requestTermination(record: ProcessRecord, state: "cancelled" | "timed_out" | "failed", error: string): void {
		if (record.snapshot.state !== "running" || record.requestedTerminal) return;
		record.requestedTerminal = state;
		record.requestedError = error;
		killProcessTree(record.snapshot.pid);
	}

	private async finalize(record: ProcessRecord, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
		if (record.finalized) return;
		record.finalized = true;
		if (record.timeoutHandle) clearTimeout(record.timeoutHandle);
		untrackDetachedChildPid(record.snapshot.pid);

		// A terminal status promises that readers can retrieve all retained output.
		await new Promise<void>((resolve) => {
			if (record.output.closed) {
				resolve();
				return;
			}
			record.output.once("close", resolve);
			record.output.end();
		});

		const state: Exclude<ProcessState, "running"> = record.requestedTerminal ?? (code === 0 ? "exited" : "failed");
		record.snapshot.state = state;
		record.snapshot.endedAt = Date.now();
		if (code !== null) record.snapshot.exitCode = code;
		if (signal) record.snapshot.signal = signal;
		if (record.requestedError) record.snapshot.error = record.requestedError;
		else if (signal) record.snapshot.error = `Command terminated by signal ${signal}`;
		else if (state === "failed") record.snapshot.error = `Command exited with code ${code ?? 1}`;

		if (!this.disposed) {
			try {
				this.publishStatus(record.snapshot);
			} catch (error) {
				record.snapshot.state = "failed";
				record.snapshot.error = [record.snapshot.error, `Status file failed: ${String(error)}`]
					.filter(Boolean)
					.join("; ");
				// Invalidate the running record rather than leave it looking current.
				this.removeFile(record.snapshot.statusPath);
			}
		}
		record.resolveCompletion(this.copySnapshot(record.snapshot));
		if (this.disposed) {
			this.removeArtifacts(record);
			this.removeOwnedDirectory();
		}
	}

	private publishStatus(snapshot: ProcessSnapshot): void {
		const { pid, state, outputPath, startedAt, endedAt, exitCode, signal, error } = snapshot;
		const temporaryPath = `${snapshot.statusPath}.tmp`;
		try {
			writeFileSync(
				temporaryPath,
				`${JSON.stringify({ pid, state, outputPath, startedAt, endedAt, exitCode, signal, error })}\n`,
				{
					flag: "wx",
					mode: 0o600,
				},
			);
			renameSync(temporaryPath, snapshot.statusPath);
		} finally {
			this.removeFile(temporaryPath);
		}
	}

	private requireRecord(pid: number): ProcessRecord {
		const record = this.records.get(pid);
		if (!record) throw new Error(`Unknown process PID: ${pid}`);
		return record;
	}

	private copySnapshot(snapshot: ProcessSnapshot): ProcessSnapshot {
		return { ...snapshot, owner: { ...snapshot.owner } };
	}

	private removeArtifacts(record: ProcessRecord): void {
		this.removeFile(record.snapshot.outputPath);
		this.removeFile(record.snapshot.statusPath);
		this.removeFile(`${record.snapshot.statusPath}.tmp`);
	}

	private removeFile(path: string): void {
		try {
			rmSync(path, { force: true });
		} catch {
			// Best-effort cleanup: process teardown must not fail because a file is locked.
		}
	}

	private removeOwnedDirectory(): void {
		if (!this.ownsOutputDirectory || !this.disposed) return;
		try {
			rmSync(this.outputDirectory, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup: process teardown must not fail because a file is locked.
		}
	}

	private evictTerminalRecords(): void {
		while (this.records.size >= this.maxRecords) {
			const terminal = [...this.records.entries()].find(([, record]) => record.snapshot.state !== "running");
			if (!terminal) throw new Error(`Process record limit reached (${this.maxRecords})`);
			this.removeArtifacts(terminal[1]);
			this.records.delete(terminal[0]);
		}
	}
}
