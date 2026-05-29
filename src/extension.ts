
import * as vscode from "vscode";

import {
	LlamaCppChatModelProvider,
	type LlamaChatContextUsageMetrics,
	type LlamaChatTurnMetrics,
} from "./llama-provider";
import { LlamaLogService } from "./logger";

const EXTENSION_ID = "maruf-bepary.llama-vscode-chat";
const DEFAULT_SERVER_URL = "http://localhost:8000";

type ThinkingMode = "off" | "light" | "balanced" | "deep" | "auto";
type ToolResultMode = "auto" | "tool" | "user";

type ContextUsageDisplay = {
	summary: string;
	breakdown: string;
	statusBarText: string;
	tooltip: string;
	tooltipLines: string[];
};

function formatNumber(value: number): string {
	if (!Number.isFinite(value)) {
		return "0";
	}
	return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

function formatPercent(value: number): string {
	if (!Number.isFinite(value)) {
		return "0.0";
	}
	return value.toFixed(1);
}

function formatContextUsage(metrics: LlamaChatContextUsageMetrics): ContextUsageDisplay {
	const usedTokens = Math.max(0, metrics.estimatedUsedTokens);
	const freeTokens = Math.max(0, metrics.estimatedFreeTokens);
	const usagePercent = Math.min(100, Math.max(0, metrics.estimatedUsagePercent));
	const compaction = [metrics.autoCompacted ? "auto" : undefined, metrics.hardCompacted ? "hard" : undefined]
		.filter((value): value is string => typeof value === "string")
		.join("+") || "none";

	const summary = `${formatPercent(usagePercent)}% (${formatNumber(usedTokens)}/${formatNumber(metrics.contextLength)})`;
	const breakdown = `msg ${formatNumber(metrics.messageTokensAfterCompact)} + tools ${formatNumber(metrics.toolTokens)} + reserved ${formatNumber(metrics.replyReserveTokens)}`;
	const tooltipLines = [
		`Model: ${metrics.modelId}`,
		`Usage: ${summary}`,
		`Messages: ${formatNumber(metrics.messageTokensAfterCompact)} (before ${formatNumber(metrics.messageTokensBeforeCompact)})`,
		`Tools: ${formatNumber(metrics.toolTokens)} (count ${metrics.cappedTools})`,
		`Reserved reply: ${formatNumber(metrics.replyReserveTokens)}`,
		`Input budget: ${formatNumber(metrics.inputBudget)}`,
		`Soft target: ${formatNumber(metrics.softInputTarget)}`,
		`Hard target: ${formatNumber(metrics.hardInputTarget)}`,
		`Free headroom: ${formatNumber(freeTokens)}`,
		`Compaction: ${compaction}`,
		`Attempt: #${metrics.attemptNo}`,
	];

	return {
		summary,
		breakdown,
		statusBarText: `$(pie-chart) llama.cpp ctx ${usagePercent.toFixed(0)}%`,
		tooltip: tooltipLines.join("\n"),
		tooltipLines,
	};
}

class QuickActionItem extends vscode.TreeItem {
	constructor(label: string, description: string | undefined, command: vscode.Command) {
		super(label, vscode.TreeItemCollapsibleState.None);
		this.description = description;
		this.command = command;
		this.contextValue = "llamacpp.quickAction";
	}
}

class LlamaQuickActionsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(
		private readonly getLastThroughput: () => string | undefined,
		private readonly getLastContextUsage: () => ContextUsageDisplay | undefined
	) {}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(): vscode.ProviderResult<vscode.TreeItem[]> {
		const config = vscode.workspace.getConfiguration("llamacpp");
		const serverUrl = String(config.get("serverUrl", DEFAULT_SERVER_URL) || DEFAULT_SERVER_URL);
		const thinkingMode = String(config.get("thinkingMode", "auto"));
		const reasoningBudget = Number(config.get("reasoningBudget", 2048));
		const toolResultMode = String(config.get("toolResultMode", "auto"));
		const fileLoggingEnabled = config.get<boolean>("enableFileLogging", true) !== false;
		const streamChunkLoggingEnabled = config.get<boolean>("logStreamChunks", false) === true;
		const performanceStatusBarEnabled = config.get<boolean>("showPerformanceStatusBar", true) !== false;
		const contextUsageStatusBarEnabled = config.get<boolean>("showContextUsageStatusBar", true) !== false;
		const lastThroughput = this.getLastThroughput();
		const lastContextUsage = this.getLastContextUsage();

		return [
			new QuickActionItem("Open Llama.cpp Sidebar", undefined, {
				title: "Open Llama.cpp Sidebar",
				command: "llamacpp.openSidebar",
			}),
			new QuickActionItem("Refresh Models", undefined, {
				title: "Llama.cpp: Refresh Models",
				command: "llamacpp.refreshModels",
			}),
			new QuickActionItem("Open Copilot Model Picker", undefined, {
				title: "Open Copilot Model Picker",
				command: "llamacpp.openCopilotModelPicker",
			}),
			new QuickActionItem("Manage Server URL", undefined, {
				title: "Manage Llama.cpp Provider",
				command: "llamacpp.manage",
			}),
			new QuickActionItem("Server URL", serverUrl, {
				title: "Manage Llama.cpp Provider",
				command: "llamacpp.manage",
			}),
			new QuickActionItem("Open Llama.cpp Settings", undefined, {
				title: "Open Llama.cpp Settings",
				command: "llamacpp.openSettings",
			}),
			new QuickActionItem("Thinking Mode", thinkingMode, {
				title: "Set Thinking Mode",
				command: "llamacpp.setThinkingMode",
			}),
			new QuickActionItem("Reasoning Budget", Number.isFinite(reasoningBudget) ? String(reasoningBudget) : "auto", {
				title: "Set Reasoning Budget",
				command: "llamacpp.setReasoningBudget",
			}),
			new QuickActionItem("Tool Result Mode", toolResultMode, {
				title: "Set Tool Result Mode",
				command: "llamacpp.setToolResultMode",
			}),
			new QuickActionItem("Open Logs Folder", undefined, {
				title: "Llama.cpp: Open Logs Folder",
				command: "llamacpp.openLogsFolder",
			}),
			new QuickActionItem("Open Latest Log", undefined, {
				title: "Llama.cpp: Open Latest Log",
				command: "llamacpp.openLatestLog",
			}),
			new QuickActionItem("Copy Latest Log Path", undefined, {
				title: "Llama.cpp: Copy Latest Log Path",
				command: "llamacpp.copyLatestLogPath",
			}),
			new QuickActionItem("File Logging", fileLoggingEnabled ? "on" : "off", {
				title: "Llama.cpp: Toggle File Logging",
				command: "llamacpp.toggleFileLogging",
			}),
			new QuickActionItem("Stream Chunk Logging", streamChunkLoggingEnabled ? "on" : "off", {
				title: "Llama.cpp: Toggle Stream Chunk Logging",
				command: "llamacpp.toggleStreamChunkLogging",
			}),
			new QuickActionItem("Performance Status Bar", performanceStatusBarEnabled ? "on" : "off", {
				title: "Llama.cpp: Toggle Performance Status Bar",
				command: "llamacpp.togglePerformanceStatusBar",
			}),
			new QuickActionItem("Context Usage Status Bar", contextUsageStatusBarEnabled ? "on" : "off", {
				title: "Llama.cpp: Toggle Context Usage Status Bar",
				command: "llamacpp.toggleContextUsageStatusBar",
			}),
			new QuickActionItem("Last Throughput", lastThroughput ?? "n/a", {
				title: "Llama.cpp: Open Latest Log",
				command: "llamacpp.openLatestLog",
			}),
			new QuickActionItem("Context Usage", lastContextUsage?.summary ?? "n/a", {
				title: "Llama.cpp: Open Latest Log",
				command: "llamacpp.openLatestLog",
			}),
			new QuickActionItem("Context Breakdown", lastContextUsage?.breakdown ?? "n/a", {
				title: "Llama.cpp: Open Latest Log",
				command: "llamacpp.openLatestLog",
			}),
		];
	}
}

function getExplicitConfiguredServerUrl(config: vscode.WorkspaceConfiguration): string | undefined {
	const inspected = config.inspect<string>("serverUrl");
	const candidates = [inspected?.workspaceFolderValue, inspected?.workspaceValue, inspected?.globalValue];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.trim().length > 0) {
			return candidate.trim();
		}
	}
	return undefined;
}

async function pickThinkingMode(current: ThinkingMode): Promise<ThinkingMode | undefined> {
	const options: Array<{ label: string; description: string; value: ThinkingMode }> = [
		{ label: "Auto", description: "Use configured reasoning budget", value: "auto" },
		{ label: "Off", description: "Disable chain-of-thought budget", value: "off" },
		{ label: "Light", description: "Fast/short reasoning", value: "light" },
		{ label: "Balanced", description: "Balanced quality and speed", value: "balanced" },
		{ label: "Deep", description: "Maximum reasoning depth", value: "deep" },
	];

	const picked = await vscode.window.showQuickPick(
		options.map(option => ({
			label: option.label,
			description: option.description,
			detail: option.value === current ? "Current" : undefined,
			value: option.value,
		})),
		{
			title: "Llama.cpp Thinking Mode",
			ignoreFocusOut: true,
		}
	);

	return picked?.value;
}

async function pickToolResultMode(current: ToolResultMode): Promise<ToolResultMode | undefined> {
	const options: Array<{ label: string; description: string; value: ToolResultMode }> = [
		{
			label: "Auto",
			description: "Prefer tool role, fallback to user-style results when template rejects tool role",
			value: "auto",
		},
		{
			label: "Tool",
			description: "Always send tool results as role=tool with tool_call_id",
			value: "tool",
		},
		{
			label: "User",
			description: "Always flatten tool results into user text (maximum compatibility)",
			value: "user",
		},
	];

	const picked = await vscode.window.showQuickPick(
		options.map(option => ({
			label: option.label,
			description: option.description,
			detail: option.value === current ? "Current" : undefined,
			value: option.value,
		})),
		{
			title: "Llama.cpp Tool Result Mode",
			ignoreFocusOut: true,
		}
	);

	return picked?.value;
}

async function openLlamaSidebar(): Promise<boolean> {
	try {
		await vscode.commands.executeCommand("llamacpp-quick-actions.focus");
		return true;
	} catch {
		// Continue with generic view opening commands.
	}

	const viewIds = ["llamacpp-quick-actions"];
	for (const viewId of viewIds) {
		try {
			await vscode.commands.executeCommand("workbench.action.openView", viewId, true);
			return true;
		} catch {
			// Fall through to other strategies.
		}
	}

	const staticCandidates = ["workbench.view.extension.llamacpp-sidebar"];
	const allCommands = await vscode.commands.getCommands(true);
	const dynamicCandidates = allCommands.filter(
		command =>
			command.startsWith("workbench.view.extension.") &&
			(command.includes("llamacpp") || command.includes("llama-vscode-chat"))
	);

	const candidates = Array.from(new Set([...staticCandidates, ...dynamicCandidates]));
	for (const command of candidates) {
		try {
			await vscode.commands.executeCommand(command);
			return true;
		} catch {
			// Keep trying candidate ids.
		}
	}

	console.warn("[Llama.cpp] Failed to open sidebar", { candidates });
	return false;
}

/**
 * Activates the VS Code extension.
 * Registers the Llama.cpp chat model provider and management commands.
 * Called when the extension is activated by VS Code.
 *
 * @param context - The extension context provided by VS Code.
 */
export function activate(context: vscode.ExtensionContext) {
	// Build a descriptive User-Agent to help quantify API usage
	const ext = vscode.extensions.getExtension(EXTENSION_ID);
	const extVersion = ext?.packageJSON?.version ?? "unknown";
	const vscodeVersion = vscode.version;
	// Keep UA minimal: only extension version and VS Code version
	const ua = `llama-vscode-chat/${extVersion} VSCode/${vscodeVersion}`;
	const logService = new LlamaLogService(context);
	context.subscriptions.push(logService);
	void logService.initialize();

	// Llama.cpp Provider
	const llamaProvider = new LlamaCppChatModelProvider(context.secrets, ua, logService);
	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider("llamacpp", llamaProvider));
	let lastThroughput: string | undefined;
	let lastContextUsage: ContextUsageDisplay | undefined;
	const quickActionsProvider = new LlamaQuickActionsProvider(() => lastThroughput, () => lastContextUsage);
	context.subscriptions.push(vscode.window.registerTreeDataProvider("llamacpp-quick-actions", quickActionsProvider));
	llamaProvider.refreshLanguageModelChatInformation();

	const performanceStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 95);
	performanceStatusBar.name = "Llama.cpp Throughput";
	performanceStatusBar.command = "llamacpp.openLatestLog";
	performanceStatusBar.text = "$(dashboard) llama.cpp TPS: n/a";

	const contextUsageStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 94);
	contextUsageStatusBar.name = "Llama.cpp Context Usage";
	contextUsageStatusBar.command = "llamacpp.openLatestLog";
	contextUsageStatusBar.text = "$(pie-chart) llama.cpp ctx: n/a";

	const updatePerformanceStatusBarVisibility = (): void => {
		const enabled = vscode.workspace.getConfiguration("llamacpp").get<boolean>("showPerformanceStatusBar", true) !== false;
		if (enabled) {
			performanceStatusBar.show();
		} else {
			performanceStatusBar.hide();
		}
	};

	const updateContextUsageStatusBarVisibility = (): void => {
		const enabled = vscode.workspace.getConfiguration("llamacpp").get<boolean>("showContextUsageStatusBar", true) !== false;
		if (enabled) {
			contextUsageStatusBar.show();
		} else {
			contextUsageStatusBar.hide();
		}
	};

	updatePerformanceStatusBarVisibility();
	updateContextUsageStatusBarVisibility();
	context.subscriptions.push(performanceStatusBar);
	context.subscriptions.push(contextUsageStatusBar);

	context.subscriptions.push(
		llamaProvider.onDidUpdateContextUsage((usage: LlamaChatContextUsageMetrics) => {
			lastContextUsage = formatContextUsage(usage);
			contextUsageStatusBar.text = lastContextUsage.statusBarText;
			contextUsageStatusBar.tooltip = lastContextUsage.tooltip;
			quickActionsProvider.refresh();
		})
	);

	context.subscriptions.push(
		llamaProvider.onDidCompleteChatTurn((metrics: LlamaChatTurnMetrics) => {
			const tpsText = metrics.tokensPerSecond === undefined ? "n/a" : `${metrics.tokensPerSecond.toFixed(1)} tok/s`;
			const latencyText = metrics.firstTokenLatencyMs === undefined ? "n/a" : `${metrics.firstTokenLatencyMs} ms`;
			const queueText = `${metrics.queueWaitMs} ms`;
			const performanceTooltipLines = [
				`Model: ${metrics.modelId}`,
				`TPS: ${tpsText}`,
				`Estimated output tokens: ${metrics.estimatedOutputTokens}`,
				`Thinking chars: ${metrics.thinkingChars}`,
				`First token latency: ${latencyText}`,
				`Queue wait: ${queueText}`,
				`Turn duration: ${metrics.durationMs} ms`,
			];
			if (lastContextUsage) {
				performanceTooltipLines.push("", ...lastContextUsage.tooltipLines);
			}

			lastThroughput = tpsText;
			performanceStatusBar.text = `$(dashboard) llama.cpp ${tpsText}`;
			performanceStatusBar.tooltip = performanceTooltipLines.join("\n");
			quickActionsProvider.refresh();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.openSidebar", async () => {
			const opened = await openLlamaSidebar();
			if (!opened) {
				vscode.window.showWarningMessage("Unable to open Llama.cpp sidebar automatically. Use View: Open View...");
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.manage", async () => {
			const config = vscode.workspace.getConfiguration("llamacpp");
			const configuredUrl = getExplicitConfiguredServerUrl(config);
			const existingUrl = configuredUrl || (await context.secrets.get("llamacpp.serverUrl"));
			const serverUrl = await vscode.window.showInputBox({
				title: "Llama.cpp Server URL",
				prompt: "Enter the URL of your Llama.cpp server",
				value: existingUrl || DEFAULT_SERVER_URL,
				ignoreFocusOut: true,
			});

			if (serverUrl === undefined) {
				return; // User canceled
			}

			if (serverUrl.trim()) {
				await config.update("serverUrl", serverUrl.trim(), vscode.ConfigurationTarget.Global);
				await context.secrets.delete("llamacpp.serverUrl");
			} else {
				await config.update("serverUrl", undefined, vscode.ConfigurationTarget.Global);
				await context.secrets.delete("llamacpp.serverUrl");
			}

			llamaProvider.refreshLanguageModelChatInformation();
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage("Llama.cpp configuration saved.");
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.openSettings", async () => {
			await vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${EXTENSION_ID} llamacpp`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.setThinkingMode", async () => {
			const config = vscode.workspace.getConfiguration("llamacpp");
			const current = (String(config.get("thinkingMode", "auto")) as ThinkingMode) ?? "auto";
			const next = await pickThinkingMode(current);
			if (!next) {
				return;
			}

			await config.update("thinkingMode", next, vscode.ConfigurationTarget.Global);
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage(`Llama.cpp thinking mode: ${next}`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.setReasoningBudget", async () => {
			const config = vscode.workspace.getConfiguration("llamacpp");
			const current = Number(config.get("reasoningBudget", 2048));

			const value = await vscode.window.showInputBox({
				title: "Llama.cpp Reasoning Budget",
				prompt: "Set reasoning budget in tokens (0 disables thinking budget)",
				value: Number.isFinite(current) ? String(current) : "2048",
				ignoreFocusOut: true,
				validateInput: input => {
					if (!/^\d+$/.test(input.trim())) {
						return "Enter a whole number from 0 to 65536";
					}
					const parsed = Number(input);
					if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65536) {
						return "Value must be between 0 and 65536";
					}
					return undefined;
				},
			});

			if (value === undefined) {
				return;
			}

			const parsed = Math.max(0, Math.min(65536, Number(value)));
			await config.update("reasoningBudget", parsed, vscode.ConfigurationTarget.Global);
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage(`Llama.cpp reasoning budget: ${parsed}`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.setToolResultMode", async () => {
			const config = vscode.workspace.getConfiguration("llamacpp");
			const current = (String(config.get("toolResultMode", "auto")) as ToolResultMode) ?? "auto";
			const next = await pickToolResultMode(current);
			if (!next) {
				return;
			}

			await config.update("toolResultMode", next, vscode.ConfigurationTarget.Global);
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage(`Llama.cpp tool result mode: ${next}`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.refreshModels", async () => {
			llamaProvider.refreshLanguageModelChatInformation();
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage("Llama.cpp models refreshed.");
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.openCopilotModelPicker", async () => {
			const candidates = [
				"github.copilot.chat.openModelPicker",
				"workbench.action.chat.openModelPicker",
			];

			for (const commandId of candidates) {
				try {
					await vscode.commands.executeCommand(commandId);
					return;
				} catch {
					// Keep trying fallback command ids.
				}
			}

			const allCommands = await vscode.commands.getCommands(true);
			const dynamicCandidate = allCommands.find(
				command => command.toLowerCase().includes("modelpicker") && command.includes("copilot")
			);
			if (dynamicCandidate) {
				try {
					await vscode.commands.executeCommand(dynamicCandidate);
					return;
				} catch {
					// Fall through to warning message.
				}
			}

			vscode.window.showWarningMessage("Unable to open the Copilot model picker automatically.");
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.openLogsFolder", async () => {
			await logService.openLogsFolder();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.openLatestLog", async () => {
			await logService.openLatestLogFile();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.copyLatestLogPath", async () => {
			await logService.copyLatestLogPath();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.toggleFileLogging", async () => {
			const config = vscode.workspace.getConfiguration("llamacpp");
			const current = config.get<boolean>("enableFileLogging", true) !== false;
			const next = !current;
			await config.update("enableFileLogging", next, vscode.ConfigurationTarget.Global);
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage(`Llama.cpp file logging: ${next ? "on" : "off"}`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.toggleStreamChunkLogging", async () => {
			const config = vscode.workspace.getConfiguration("llamacpp");
			const current = config.get<boolean>("logStreamChunks", false) === true;
			const next = !current;
			await config.update("logStreamChunks", next, vscode.ConfigurationTarget.Global);
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage(`Llama.cpp stream chunk logging: ${next ? "on" : "off"}`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.togglePerformanceStatusBar", async () => {
			const config = vscode.workspace.getConfiguration("llamacpp");
			const current = config.get<boolean>("showPerformanceStatusBar", true) !== false;
			const next = !current;
			await config.update("showPerformanceStatusBar", next, vscode.ConfigurationTarget.Global);
			updatePerformanceStatusBarVisibility();
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage(`Llama.cpp performance status bar: ${next ? "on" : "off"}`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.toggleContextUsageStatusBar", async () => {
			const config = vscode.workspace.getConfiguration("llamacpp");
			const current = config.get<boolean>("showContextUsageStatusBar", true) !== false;
			const next = !current;
			await config.update("showContextUsageStatusBar", next, vscode.ConfigurationTarget.Global);
			updateContextUsageStatusBarVisibility();
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage(`Llama.cpp context usage status bar: ${next ? "on" : "off"}`);
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration("llamacpp")) {
				if (event.affectsConfiguration("llamacpp.showPerformanceStatusBar")) {
					updatePerformanceStatusBarVisibility();
				}
				if (event.affectsConfiguration("llamacpp.showContextUsageStatusBar")) {
					updateContextUsageStatusBarVisibility();
				}
				if (
					event.affectsConfiguration("llamacpp.serverUrl") ||
					event.affectsConfiguration("llamacpp.contextLength") ||
					event.affectsConfiguration("llamacpp.maxOutputTokensCap") ||
					event.affectsConfiguration("llamacpp.maxToolsPerRequest") ||
					event.affectsConfiguration("llamacpp.modelFamily") ||
					event.affectsConfiguration("llamacpp.modelListCacheTtlMs")
				) {
					llamaProvider.refreshLanguageModelChatInformation();
				}
				quickActionsProvider.refresh();
			}
		})
	);
}

/**
 * Deactivates the VS Code extension.
 * Performs cleanup when the extension is deactivated.
 */
export function deactivate() {}
