import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync, openSync, rmSync, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { waitForChildProcess } from "../utils/child-process.ts";
import { killProcessTree, type ShellConfig, trackDetachedChildPid, untrackDetachedChildPid } from "../utils/shell.ts";

export const DEFAULT_PROCESS_LIMIT = 32;
export const DEFAULT_PROCESS_RECORD_LIMIT = 128;
export const DEFAULT_PROCESS_OUTPUT_BYTES = 10 * 1024 * 1024;
export const DEFAULT_PROCESS_NOTIFICATION_BYTES = 16 * 1024;

export type ProcessState = "running" | "exited" | "failed" | "cancelled" | "timed_out";
export type BackgroundReason = "explicit" | "yield" | "human";

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
	startedAt: number;
	endedAt?: number;
	exitCode?: number;
	signal?: NodeJS.Signals;
	error?: string;
}

export interface ProcessManagerEvent {
	sequence: number;
	pid: number;
	owner: ProcessOwner;
	type: "exit";
	state: Exclude<ProcessState, "running">;
	outputPath: string;
	exitCode?: number;
	signal?: NodeJS.Signals;
	output?: string;
	diagnostics?: string;
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
}

export type ForegroundProcessOutcome =
	| { type: "exited"; snapshot: ProcessSnapshot }
	| { type: "backgrounded"; reason: BackgroundReason };

export interface ProcessManagerLimits {
	maxProcesses?: number;
	maxRecords?: number;
	maxOutputBytes?: number;
	maxNotificationBytes?: number;
}

export interface ProcessManagerOptions {
	onEvent: (event: ProcessManagerEvent) => void;
	outputDirectory?: string;
	limits?: ProcessManagerLimits;
}

interface ProcessRecord {
	snapshot: ProcessSnapshot;
	child: ChildProcess;
	output: WriteStream;
	outputBytes: number;
	stdoutTail: Buffer;
	stderrTail: Buffer;
	completion: Promise<ProcessSnapshot>;
	resolveCompletion: (snapshot: ProcessSnapshot) => void;
	backgrounded: Promise<BackgroundReason>;
	resolveBackgrounded: (reason: BackgroundReason) => void;
	timeoutHandle?: NodeJS.Timeout;
	requestedTerminal?: "cancelled" | "timed_out" | "failed";
	requestedError?: string;
	finalized: boolean;
	notificationDelivered: boolean;
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

function appendTail(current: Buffer, data: Buffer, maxBytes: number): Buffer {
	const combined = Buffer.concat([current, data]);
	return combined.subarray(Math.max(0, combined.length - maxBytes));
}

export class ProcessManager {
	private readonly onEvent: (event: ProcessManagerEvent) => void;
	private readonly outputDirectory: string;
	private readonly ownsOutputDirectory: boolean;
	private readonly maxProcesses: number;
	private readonly maxRecords: number;
	private readonly maxOutputBytes: number;
	private readonly maxNotificationBytes: number;
	private readonly records = new Map<number, ProcessRecord>();
	private sequence = 0;
	private disposed = false;

	constructor(options: ProcessManagerOptions) {
		this.onEvent = options.onEvent;
		this.ownsOutputDirectory = options.outputDirectory === undefined;
		this.outputDirectory = options.outputDirectory ?? mkdtempSync(join(tmpdir(), "pi-processes-"));
		this.maxProcesses = options.limits?.maxProcesses ?? DEFAULT_PROCESS_LIMIT;
		this.maxRecords = options.limits?.maxRecords ?? DEFAULT_PROCESS_RECORD_LIMIT;
		this.maxOutputBytes = options.limits?.maxOutputBytes ?? DEFAULT_PROCESS_OUTPUT_BYTES;
		this.maxNotificationBytes = options.limits?.maxNotificationBytes ?? DEFAULT_PROCESS_NOTIFICATION_BYTES;
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
			const previousEventPending =
				previous.snapshot.backgroundReason !== undefined && !previous.notificationDelivered;
			if (previous.snapshot.state === "running" || previousEventPending) {
				killProcessTree(pid);
				untrackDetachedChildPid(pid);
				throw new Error(`OS PID ${pid} is already tracked`);
			}
			this.removeOutput(previous);
			this.records.delete(pid);
		}

		const outputPath = join(this.outputDirectory, `${pid}.log`);
		let output: WriteStream;
		try {
			const outputFd = openSync(outputPath, "wx");
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
				startedAt: Date.now(),
			},
			child,
			output,
			outputBytes: 0,
			stdoutTail: Buffer.alloc(0),
			stderrTail: Buffer.alloc(0),
			completion: completion.promise,
			resolveCompletion: completion.resolve,
			backgrounded: backgrounded.promise,
			resolveBackgrounded: backgrounded.resolve,
			finalized: false,
			notificationDelivered: false,
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
		child.stdout?.on("data", (data: Buffer) => this.handleOutput(record, child.stdout!, data, false));
		child.stderr?.on("data", (data: Buffer) => this.handleOutput(record, child.stderr!, data, true));
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

		return { pid, outputPath };
	}

	async waitForForeground(
		pid: number,
		options: { yieldAfterMs: number; signal?: AbortSignal },
	): Promise<ForegroundProcessOutcome> {
		const record = this.requireRecord(pid);
		if (record.snapshot.backgroundReason) {
			return { type: "backgrounded", reason: record.snapshot.backgroundReason };
		}

		let yieldHandle: NodeJS.Timeout | undefined;
		let abortListener: (() => void) | undefined;
		const yields = new Promise<BackgroundReason>((resolve) => {
			if (options.yieldAfterMs > 0) {
				yieldHandle = setTimeout(() => {
					this.background(pid, "yield");
					resolve("yield");
				}, options.yieldAfterMs);
			}
		});
		if (options.signal) {
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
				yields.then((reason) => ({ type: "backgrounded" as const, reason })),
			]);
		} finally {
			if (yieldHandle) clearTimeout(yieldHandle);
			if (options.signal && abortListener) options.signal.removeEventListener("abort", abortListener);
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

	acknowledgeTerminalEvent(pid: number): void {
		const record = this.requireRecord(pid);
		if (record.snapshot.state === "running" || !record.snapshot.backgroundReason) {
			throw new Error(`Process ${pid} has no terminal background event to acknowledge`);
		}
		record.notificationDelivered = true;
	}

	hasRunning(): boolean {
		return [...this.records.values()].some((record) => record.snapshot.state === "running");
	}

	async waitForAll(timeoutMs: number): Promise<boolean> {
		const completions = [...this.records.values()]
			.filter((record) => record.snapshot.state === "running")
			.map((record) => record.completion);
		if (completions.length === 0) return true;
		let timeout: NodeJS.Timeout | undefined;
		try {
			return await Promise.race([
				Promise.all(completions).then(() => true),
				new Promise<boolean>((resolve) => {
					timeout = setTimeout(() => resolve(false), timeoutMs);
				}),
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const record of this.records.values()) {
			if (record.snapshot.state === "running") {
				this.requestTermination(record, "cancelled", "Runtime disposed");
			} else {
				this.removeOutput(record);
			}
		}
		this.removeOwnedDirectoryIfFinished();
	}

	private handleOutput(record: ProcessRecord, source: Readable, data: Buffer, stderr: boolean): void {
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
			if (stderr) {
				record.stderrTail = appendTail(record.stderrTail, accepted, this.maxNotificationBytes);
			} else {
				record.stdoutTail = appendTail(record.stdoutTail, accepted, this.maxNotificationBytes);
			}
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

		await new Promise<void>((resolve) => {
			if (record.output.closed || record.output.destroyed) {
				resolve();
				return;
			}
			record.output.end(resolve);
		});

		const state: Exclude<ProcessState, "running"> = record.requestedTerminal ?? (code === 0 ? "exited" : "failed");
		record.snapshot.state = state;
		record.snapshot.endedAt = Date.now();
		if (code !== null) record.snapshot.exitCode = code;
		if (signal) record.snapshot.signal = signal;
		if (record.requestedError) record.snapshot.error = record.requestedError;
		else if (signal) record.snapshot.error = `Command terminated by signal ${signal}`;
		else if (state === "failed") record.snapshot.error = `Command exited with code ${code ?? 1}`;

		if (record.snapshot.backgroundReason) {
			this.onEvent({
				sequence: ++this.sequence,
				pid: record.snapshot.pid,
				owner: { ...record.snapshot.owner },
				type: "exit",
				state,
				outputPath: record.snapshot.outputPath,
				exitCode: record.snapshot.exitCode,
				signal: record.snapshot.signal,
				output: record.stdoutTail.toString("utf8") || undefined,
				diagnostics: record.stderrTail.toString("utf8") || undefined,
				error: record.snapshot.error,
			});
		}
		record.resolveCompletion(this.copySnapshot(record.snapshot));
		if (this.disposed) {
			this.removeOutput(record);
			this.removeOwnedDirectoryIfFinished();
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

	private removeOutput(record: ProcessRecord): void {
		try {
			rmSync(record.snapshot.outputPath, { force: true });
		} catch {
			// Best-effort cleanup: process teardown must not fail because a file is locked.
		}
	}

	private removeOwnedDirectoryIfFinished(): void {
		if (!this.ownsOutputDirectory || !this.disposed) return;
		if ([...this.records.values()].some((record) => record.snapshot.state === "running")) return;
		try {
			rmSync(this.outputDirectory, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup: process teardown must not fail because a file is locked.
		}
	}

	private evictTerminalRecords(): void {
		while (this.records.size >= this.maxRecords) {
			const terminal = [...this.records.entries()].find(
				([, record]) =>
					record.snapshot.state !== "running" &&
					(record.snapshot.backgroundReason === undefined || record.notificationDelivered),
			);
			if (!terminal) throw new Error(`Process record limit reached (${this.maxRecords})`);
			this.removeOutput(terminal[1]);
			this.records.delete(terminal[0]);
		}
	}
}
