
import * as vscode from "vscode";

import {
	LlamaCppChatModelProvider,
	type LlamaChatContextUsageMetrics,
	type LlamaChatTurnMetrics,
} from "./llama-provider";
import {
	CONFIG_SECTION,
	DEEPSEEK_DISCOVERY_TIMEOUT_MS,
	DEEPSEEK_MAX_OUTPUT_TOKENS,
	DEEPSEEK_SERVER_URL,
	DEFAULT_SERVER_URL,
	EXTENSION_ID,
	EXTENSION_NAME,
	PROVIDER_VENDOR,
} from "./constants";
import { LlamaLogService } from "./logger";
import { SharedMemoryService } from "./memory/shared-memory-service";
import { registerMemoryTools } from "./memory/tools";
import type { ThinkingMode } from "./reasoning";
import { LlamaQuickActionsProvider } from "./ui/quick-access";

type ToolResultMode = "auto" | "tool" | "user";
type ToolCallingMode = "classic" | "apiDirect";

interface ContextUsageDisplay {
	summary: string;
	breakdown: string;
	statusBarText: string;
	tooltip: string;
	tooltipLines: string[];
}

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
		statusBarText: `$(pie-chart) local LLM ctx ${usagePercent.toFixed(0)}%`,
		tooltip: tooltipLines.join("\n"),
		tooltipLines,
	};
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
			title: "Local LLM Thinking Mode",
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
			title: "Local LLM Tool Result Mode",
			ignoreFocusOut: true,
		}
	);

	return picked?.value;
}

async function pickToolCallingMode(current: ToolCallingMode): Promise<ToolCallingMode | undefined> {
	const options: Array<{ label: string; description: string; value: ToolCallingMode }> = [
		{
			label: "Classic",
			description: "Send the full tool catalog (existing behavior)",
			value: "classic",
		},
		{
			label: "API Direct",
			description: "Send compact prioritized tool definitions to reduce token overhead",
			value: "apiDirect",
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
			title: "Local LLM Tool Calling Mode",
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

	console.warn("[Local LLM] Failed to open sidebar", { candidates });
	return false;
}

/**
 * Activates the VS Code extension.
 * Registers the Llama.cpp chat model provider and management commands.
 * Called when the extension is activated by VS Code.
 *
 * @param context - The extension context provided by VS Code.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
	// Build a descriptive User-Agent to help quantify API usage
	const ext = vscode.extensions.getExtension(EXTENSION_ID);
	const extVersion = ext?.packageJSON?.version ?? "unknown";
	const vscodeVersion = vscode.version;
	// Keep UA minimal: only extension version and VS Code version
	const ua = `${EXTENSION_NAME}/${extVersion} VSCode/${vscodeVersion}`;
	const logService = new LlamaLogService(context);
	const memoryService = new SharedMemoryService(context.globalStorageUri.fsPath);
	context.subscriptions.push(logService);
	await Promise.all([logService.initialize(), memoryService.initialize()]);
	registerMemoryTools(context, memoryService);

	// Llama.cpp Provider
	const llamaProvider = new LlamaCppChatModelProvider(context.secrets, ua, logService, memoryService);
	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(PROVIDER_VENDOR, llamaProvider));
	let lastThroughput: string | undefined;
	let lastContextUsage: ContextUsageDisplay | undefined;
	const quickActionsProvider = new LlamaQuickActionsProvider(
		() => lastThroughput,
		() => lastContextUsage,
		() => memoryService.count
	);
	context.subscriptions.push(vscode.window.registerTreeDataProvider("llamacpp-quick-actions", quickActionsProvider));
	context.subscriptions.push(memoryService.onDidChange(() => quickActionsProvider.refresh()));
	llamaProvider.refreshLanguageModelChatInformation();

	const performanceStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 95);
	performanceStatusBar.name = "Local LLM Throughput";
	performanceStatusBar.command = "llamacpp.openLatestLog";
	performanceStatusBar.text = "$(dashboard) local LLM TPS: n/a";

	const contextUsageStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 94);
	contextUsageStatusBar.name = "Local LLM Context Usage";
	contextUsageStatusBar.command = "llamacpp.openLatestLog";
	contextUsageStatusBar.text = "$(pie-chart) local LLM ctx: n/a";

	const updatePerformanceStatusBarVisibility = (): void => {
		const enabled = vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>("showPerformanceStatusBar", true) !== false;
		if (enabled) {
			performanceStatusBar.show();
		} else {
			performanceStatusBar.hide();
		}
	};

	const updateContextUsageStatusBarVisibility = (): void => {
		const enabled = vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>("showContextUsageStatusBar", true) !== false;
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
			performanceStatusBar.text = `$(dashboard) local LLM ${tpsText}`;
			performanceStatusBar.tooltip = performanceTooltipLines.join("\n");
			quickActionsProvider.refresh();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.openSidebar", async () => {
			const opened = await openLlamaSidebar();
			if (!opened) {
				vscode.window.showWarningMessage("Unable to open the Local LLM sidebar automatically. Use View: Open View...");
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.manage", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const configuredUrl = getExplicitConfiguredServerUrl(config);
			const existingUrl = configuredUrl || (await context.secrets.get("llamacpp.serverUrl"));
			const serverUrl = await vscode.window.showInputBox({
				title: "Primary OpenAI-Compatible Server URL",
				prompt: "Enter the URL of the primary model server",
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
			vscode.window.showInformationMessage("Primary model server configuration saved.");
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.setLocalServerUrl", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const current = String(config.get("localServerUrl", DEFAULT_SERVER_URL) || DEFAULT_SERVER_URL);
			const serverUrl = await vscode.window.showInputBox({
				title: "Local LLM Server URL",
				prompt: "Enter the URL of your local OpenAI-compatible server",
				value: current,
				ignoreFocusOut: true,
			});

			if (serverUrl === undefined) {
				return;
			}

			const trimmed = serverUrl.trim() || DEFAULT_SERVER_URL;
			await config.update("localServerUrl", trimmed, vscode.ConfigurationTarget.Global);
			await config.update("enableLocalServer", true, vscode.ConfigurationTarget.Global);

			llamaProvider.refreshLanguageModelChatInformation();
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage(`Local LLM source enabled: ${trimmed}`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.toggleLocalServer", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const next = config.get<boolean>("enableLocalServer", true) === false;
			await config.update("enableLocalServer", next, vscode.ConfigurationTarget.Global);

			llamaProvider.refreshLanguageModelChatInformation();
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage(`Local LLM source ${next ? "enabled" : "disabled"}.`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.toggleDeepSeek", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const next = config.get<boolean>("enableDeepSeek", true) === false;
			await config.update("enableDeepSeek", next, vscode.ConfigurationTarget.Global);

			llamaProvider.refreshLanguageModelChatInformation();
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage(`DeepSeek source ${next ? "enabled" : "disabled"}.`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.setApiKey", async () => {
			const existingApiKey = await context.secrets.get("llamacpp.apiKey");
			const apiKey = await vscode.window.showInputBox({
				title: "Primary OpenAI-Compatible API Key",
				prompt: "Enter API key (leave empty to clear)",
				password: true,
				ignoreFocusOut: true,
				value: existingApiKey ?? "",
			});

			if (apiKey === undefined) {
				return;
			}

			if (apiKey.trim().length > 0) {
				await context.secrets.store("llamacpp.apiKey", apiKey.trim());
				vscode.window.showInformationMessage("Primary server API key saved to Secret Storage.");
			} else {
				await context.secrets.delete("llamacpp.apiKey");
				vscode.window.showInformationMessage("Primary server API key cleared.");
			}

			llamaProvider.refreshLanguageModelChatInformation();
			quickActionsProvider.refresh();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.configureDeepSeek", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const existingApiKey = await context.secrets.get("llamacpp.deepSeekApiKey");
			const apiKey = await vscode.window.showInputBox({
				title: "DeepSeek API Key",
				prompt: "Enter DeepSeek API key (saved in VS Code Secret Storage)",
				password: true,
				ignoreFocusOut: true,
				placeHolder: "sk-...",
				value: existingApiKey ?? "",
			});

			if (apiKey === undefined) {
				return;
			}

			await config.update("enableDeepSeek", true, vscode.ConfigurationTarget.Global);
			await config.update("maxOutputTokensCap", DEEPSEEK_MAX_OUTPUT_TOKENS, vscode.ConfigurationTarget.Global);
			await config.update("thinkingMode", "deep", vscode.ConfigurationTarget.Global);
			await config.update("toolCallingMode", "apiDirect", vscode.ConfigurationTarget.Global);
			await config.update("apiDirectMaxTools", 128, vscode.ConfigurationTarget.Global);
			await config.update("apiDirectIncludeAllTools", true, vscode.ConfigurationTarget.Global);
			await config.update("toolResultMode", "auto", vscode.ConfigurationTarget.Global);
			await config.update("autoCompact", true, vscode.ConfigurationTarget.Global);
			await config.update("retryOnContextOverflow", true, vscode.ConfigurationTarget.Global);
			await config.update("modelDiscoveryTimeoutMs", DEEPSEEK_DISCOVERY_TIMEOUT_MS, vscode.ConfigurationTarget.Global);
			await config.update("requestTimeoutMs", 1200000, vscode.ConfigurationTarget.Global);
			await config.update("requestQueueTimeoutMs", 1200000, vscode.ConfigurationTarget.Global);

			if (apiKey.trim().length > 0) {
				await context.secrets.store("llamacpp.deepSeekApiKey", apiKey.trim());

				try {
					const controller = new AbortController();
					const timeoutHandle = setTimeout(() => controller.abort(), DEEPSEEK_DISCOVERY_TIMEOUT_MS);
					let response: Response;
					try {
						response = await fetch(`${DEEPSEEK_SERVER_URL}/models`, {
							method: "GET",
							headers: {
								"User-Agent": ua,
								"Accept": "application/json",
								"Authorization": `Bearer ${apiKey.trim()}`,
							},
							signal: controller.signal,
						});
					} finally {
						clearTimeout(timeoutHandle);
					}

					if (!response.ok) {
						const details = (await response.text()).trim().slice(0, 200);
						const suffix = details.length > 0 ? `: ${details}` : "";
						vscode.window.showErrorMessage(
							`DeepSeek key check failed (${response.status} ${response.statusText})${suffix}`
						);
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					vscode.window.showWarningMessage(`DeepSeek key saved, but model check failed: ${message}`);
				}
			} else {
				await context.secrets.delete("llamacpp.deepSeekApiKey");
			}

			llamaProvider.refreshLanguageModelChatInformation();
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage("DeepSeek source enabled alongside local models. Open model picker and select a DeepSeek model.");
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.openSettings", async () => {
			await vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${EXTENSION_ID} llamacpp`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.openMemory", async () => {
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(memoryService.filePath));
			await vscode.window.showTextDocument(document, { preview: false });
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.clearMemory", async () => {
			const confirmed = await vscode.window.showWarningMessage(
				`Delete all ${memoryService.count} shared memory entries?`,
				{ modal: true },
				"Delete All"
			);
			if (confirmed !== "Delete All") {
				return;
			}
			await memoryService.clear();
			vscode.window.showInformationMessage("Shared memory cleared.");
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument(async document => {
			if (document.uri.fsPath !== memoryService.filePath) {
				return;
			}
			try {
				await memoryService.reload();
				vscode.window.showInformationMessage(`Shared memory reloaded (${memoryService.count} entries).`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Unable to reload shared memory: ${message}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.setThinkingMode", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const current = (String(config.get("thinkingMode", "auto")) as ThinkingMode) ?? "auto";
			const next = await pickThinkingMode(current);
			if (!next) {
				return;
			}

			await config.update("thinkingMode", next, vscode.ConfigurationTarget.Global);
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage(`Local LLM thinking mode: ${next}`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.setReasoningBudget", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const current = Number(config.get("reasoningBudget", 2048));

			const value = await vscode.window.showInputBox({
				title: "Local LLM Reasoning Budget",
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
			vscode.window.showInformationMessage(`Local LLM reasoning budget: ${parsed}`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.setToolResultMode", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const current = (String(config.get("toolResultMode", "auto")) as ToolResultMode) ?? "auto";
			const next = await pickToolResultMode(current);
			if (!next) {
				return;
			}

			await config.update("toolResultMode", next, vscode.ConfigurationTarget.Global);
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage(`Local LLM tool result mode: ${next}`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.setToolCallingMode", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const current = (String(config.get("toolCallingMode", "classic")) as ToolCallingMode) ?? "classic";
			const next = await pickToolCallingMode(current);
			if (!next) {
				return;
			}

			await config.update("toolCallingMode", next, vscode.ConfigurationTarget.Global);
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage(`Local LLM tool calling mode: ${next}`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.refreshModels", async () => {
			llamaProvider.refreshLanguageModelChatInformation();
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage("Local LLM models refreshed.");
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
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const current = config.get<boolean>("enableFileLogging", true) !== false;
			const next = !current;
			await config.update("enableFileLogging", next, vscode.ConfigurationTarget.Global);
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage(`Local LLM file logging: ${next ? "on" : "off"}`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.toggleStreamChunkLogging", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const current = config.get<boolean>("logStreamChunks", false) === true;
			const next = !current;
			await config.update("logStreamChunks", next, vscode.ConfigurationTarget.Global);
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage(`Local LLM stream chunk logging: ${next ? "on" : "off"}`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.togglePerformanceStatusBar", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const current = config.get<boolean>("showPerformanceStatusBar", true) !== false;
			const next = !current;
			await config.update("showPerformanceStatusBar", next, vscode.ConfigurationTarget.Global);
			updatePerformanceStatusBarVisibility();
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage(`Local LLM performance status bar: ${next ? "on" : "off"}`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.toggleContextUsageStatusBar", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const current = config.get<boolean>("showContextUsageStatusBar", true) !== false;
			const next = !current;
			await config.update("showContextUsageStatusBar", next, vscode.ConfigurationTarget.Global);
			updateContextUsageStatusBarVisibility();
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage(`Local LLM context usage status bar: ${next ? "on" : "off"}`);
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
					event.affectsConfiguration("llamacpp.enableLocalServer") ||
					event.affectsConfiguration("llamacpp.localServerUrl") ||
					event.affectsConfiguration("llamacpp.localContextLength") ||
					event.affectsConfiguration("llamacpp.enableDeepSeek") ||
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
