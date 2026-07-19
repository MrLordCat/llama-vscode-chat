import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { inspect } from "node:util";

import { EXTENSION_ID } from "./constants";

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogRecord {
	ts: string;
	sessionId: string;
	level: LogLevel;
	event: string;
	data?: unknown;
}

export interface LlamaLogSink {
	log(event: string, data?: unknown, level?: LogLevel): void;
	logError(event: string, error: unknown, data?: unknown): void;
	shouldLogStreamChunks(): boolean;
}

export class LlamaLogService implements vscode.Disposable, LlamaLogSink {
	private readonly output = vscode.window.createOutputChannel("Llama.cpp Provider");
	private readonly sessionId = randomUUID();
	private readonly logDirPath: string;

	private currentLogPath: string | undefined;
	private initPromise: Promise<void> | undefined;
	private writeQueue: Promise<void> = Promise.resolve();
	private disposed = false;

	constructor(context: vscode.ExtensionContext) {
		this.logDirPath = path.join(context.globalStorageUri.fsPath, "logs");
	}

	async initialize(): Promise<void> {
		if (!this.isEnabled()) {
			return;
		}

		await this.ensureReady();
		this.log("session.start", {
			vscodeVersion: vscode.version,
			extensionVersion: vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON?.version,
			logFile: this.currentLogPath,
		});
	}

	dispose(): void {
		this.disposed = true;
		this.output.dispose();
	}

	log(event: string, data?: unknown, level: LogLevel = "info"): void {
		if (!this.isEnabled() || this.disposed) {
			return;
		}

		const payload: LogRecord = {
			ts: new Date().toISOString(),
			sessionId: this.sessionId,
			level,
			event,
		};
		if (data !== undefined) {
			payload.data = this.toSerializable(data);
		}

		this.enqueueWrite(async () => {
			await this.ensureReady();
			if (!this.currentLogPath) {
				return;
			}
			await fs.appendFile(this.currentLogPath, `${this.safeStringify(payload)}\n`, "utf8");
		});
	}

	logError(event: string, error: unknown, data?: unknown): void {
		const serializedError = this.serializeError(error);
		const payload: Record<string, unknown> = {
			error: serializedError,
		};
		if (data !== undefined) {
			payload.context = this.toSerializable(data);
		}

		this.log(event, payload, "error");
		this.output.appendLine(`[${event}] ${serializedError.message}`);
	}

	shouldLogStreamChunks(): boolean {
		if (!this.isEnabled()) {
			return false;
		}
		return vscode.workspace.getConfiguration("llamacpp").get<boolean>("logStreamChunks", false) === true;
	}

	async openLogsFolder(): Promise<void> {
		await fs.mkdir(this.logDirPath, { recursive: true });
		const uri = vscode.Uri.file(this.logDirPath);
		try {
			await vscode.commands.executeCommand("revealFileInOS", uri);
		} catch {
			await vscode.env.openExternal(uri);
		}
	}

	async openLatestLogFile(): Promise<string | undefined> {
		const filePath = await this.findLatestLogPath();
		if (!filePath) {
			vscode.window.showWarningMessage("No Llama.cpp logs found yet.");
			return undefined;
		}

		const uri = vscode.Uri.file(filePath);
		const doc = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(doc, { preview: false });
		return filePath;
	}

	async copyLatestLogPath(): Promise<string | undefined> {
		const filePath = await this.findLatestLogPath();
		if (!filePath) {
			vscode.window.showWarningMessage("No Llama.cpp logs found yet.");
			return undefined;
		}

		await vscode.env.clipboard.writeText(filePath);
		vscode.window.showInformationMessage(`Llama.cpp log path copied: ${filePath}`);
		return filePath;
	}

	private isEnabled(): boolean {
		return vscode.workspace.getConfiguration("llamacpp").get<boolean>("enableFileLogging", true) !== false;
	}

	private enqueueWrite(task: () => Promise<void>): void {
		this.writeQueue = this.writeQueue.then(task).catch(err => {
			const message = err instanceof Error ? err.message : String(err);
			this.output.appendLine(`[logging-error] ${message}`);
		});
	}

	private async ensureReady(): Promise<void> {
		if (this.initPromise) {
			await this.initPromise;
			return;
		}

		this.initPromise = (async () => {
			await fs.mkdir(this.logDirPath, { recursive: true });
			if (!this.currentLogPath) {
				const stamp = new Date().toISOString().replace(/[.:]/g, "-");
				this.currentLogPath = path.join(this.logDirPath, `llamacpp-${stamp}-${process.pid}.jsonl`);
			}
			await this.pruneOldLogs(this.getMaxLogFiles());
		})().catch(error => {
			this.initPromise = undefined;
			throw error;
		});

		await this.initPromise;
	}

	private getMaxLogFiles(): number {
		const raw = vscode.workspace.getConfiguration("llamacpp").get<number>("maxLogFiles", 20);
		if (!Number.isFinite(raw)) {
			return 20;
		}
		return Math.max(1, Math.min(200, Math.floor(raw)));
	}

	private async pruneOldLogs(maxFiles: number): Promise<void> {
		const entries = await fs.readdir(this.logDirPath, { withFileTypes: true });
		const files = entries.filter(entry => entry.isFile() && entry.name.endsWith(".jsonl"));
		if (files.length <= maxFiles) {
			return;
		}

		const withStats = await Promise.all(
			files.map(async entry => {
				const filePath = path.join(this.logDirPath, entry.name);
				const stat = await fs.stat(filePath);
				return { filePath, mtimeMs: stat.mtimeMs };
			})
		);

		withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
		for (const stale of withStats.slice(maxFiles)) {
			if (stale.filePath === this.currentLogPath) {
				continue;
			}
			await fs.unlink(stale.filePath).catch(() => undefined);
		}
	}

	private async findLatestLogPath(): Promise<string | undefined> {
		if (this.currentLogPath) {
			return this.currentLogPath;
		}

		await fs.mkdir(this.logDirPath, { recursive: true });
		const entries = await fs.readdir(this.logDirPath, { withFileTypes: true });
		const files = entries.filter(entry => entry.isFile() && entry.name.endsWith(".jsonl"));
		if (files.length === 0) {
			return undefined;
		}

		const withStats = await Promise.all(
			files.map(async entry => {
				const filePath = path.join(this.logDirPath, entry.name);
				const stat = await fs.stat(filePath);
				return { filePath, mtimeMs: stat.mtimeMs };
			})
		);

		withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
		return withStats[0]?.filePath;
	}

	private serializeError(error: unknown): { name: string; message: string; stack?: string } {
		if (error instanceof Error) {
			return {
				name: error.name,
				message: error.message,
				stack: error.stack,
			};
		}
		return {
			name: "Error",
			message: String(error),
		};
	}

	private toSerializable(value: unknown): unknown {
		try {
			JSON.stringify(value);
			return value;
		} catch {
			return {
				type: "non-serializable",
				preview: inspect(value, { depth: 4, maxArrayLength: 80, breakLength: 140 }),
			};
		}
	}

	private safeStringify(value: unknown): string {
		try {
			return JSON.stringify(value);
		} catch {
			return JSON.stringify({
				ts: new Date().toISOString(),
				sessionId: this.sessionId,
				level: "error",
				event: "logging.serialize_failure",
				data: {
					type: "non-serializable",
					preview: inspect(value, { depth: 2, maxArrayLength: 40, breakLength: 120 }),
				},
			});
		}
	}
}
