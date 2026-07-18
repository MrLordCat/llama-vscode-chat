import * as vscode from "vscode";

import { CONFIG_SECTION, DEFAULT_LOCAL_REASONING_BUDGET, DEFAULT_SERVER_URL } from "../constants";
import { normalizeThinkingMode, resolveReasoningBudget } from "../reasoning";

export interface QuickAccessContextUsage {
	summary: string;
	breakdown: string;
}

interface QuickAccessItemOptions {
	description?: string;
	command?: vscode.Command;
	icon?: vscode.ThemeIcon;
	tooltip?: string;
	children?: QuickAccessItem[];
	expanded?: boolean;
}

export class QuickAccessItem extends vscode.TreeItem {
	readonly children?: QuickAccessItem[];

	constructor(id: string, label: string, options: QuickAccessItemOptions = {}) {
		super(
			label,
			options.children
				? options.expanded
					? vscode.TreeItemCollapsibleState.Expanded
					: vscode.TreeItemCollapsibleState.Collapsed
				: vscode.TreeItemCollapsibleState.None
		);
		this.id = `llamacpp.quickAccess.${id}`;
		this.description = options.description;
		this.command = options.command;
		this.iconPath = options.icon;
		this.tooltip = options.tooltip;
		this.children = options.children;
		this.contextValue = options.children ? "llamacpp.quickAccessGroup" : "llamacpp.quickAction";
	}
}

function command(command: string, title: string): vscode.Command {
	return { command, title };
}

function toggleIcon(enabled: boolean): vscode.ThemeIcon {
	return new vscode.ThemeIcon(
		enabled ? "pass-filled" : "circle-slash",
		new vscode.ThemeColor(enabled ? "testing.iconPassed" : "disabledForeground")
	);
}

export function formatEndpointLabel(value: string): string {
	try {
		const url = new URL(value);
		const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
		return `${url.host}${path}`;
	} catch {
		return value.length > 36 ? `${value.slice(0, 33)}...` : value;
	}
}

export class LlamaQuickActionsProvider implements vscode.TreeDataProvider<QuickAccessItem> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(
		private readonly getLastThroughput: () => string | undefined,
		private readonly getLastContextUsage: () => QuickAccessContextUsage | undefined,
		private readonly getMemoryCount: () => number,
		private readonly getLastPromptCache: () => string | undefined = () => undefined,
		private readonly getSessionSummary: () => string | undefined = () => undefined,
		private readonly getHealthStatus: () => string | undefined = () => undefined,
		private readonly getExpiredMemoryCount: () => number = () => 0,
		private readonly getCodexStatus: () => string | undefined = () => undefined
	) {}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: QuickAccessItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: QuickAccessItem): vscode.ProviderResult<QuickAccessItem[]> {
		if (element) {
			return element.children ?? [];
		}
		return this.buildRootItems();
	}

	private buildRootItems(): QuickAccessItem[] {
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const serverUrl = String(config.get("serverUrl", DEFAULT_SERVER_URL) || DEFAULT_SERVER_URL);
		const localServerUrl = String(config.get("localServerUrl", DEFAULT_SERVER_URL) || DEFAULT_SERVER_URL);
		const localServerEnabled = config.get<boolean>("enableLocalServer", true) !== false;
		const deepSeekEnabled = config.get<boolean>("enableDeepSeek", true) !== false;
		const codexEnabled = config.get<boolean>("enableCodexSubscription", true) !== false;
		const codexVsCodeToolsEnabled = config.get<boolean>("codexUseVsCodeTools", true) !== false;
		const codexDeferredToolsEnabled = config.get<boolean>("codexDeferNonCoreTools", true) !== false;
		const thinkingMode = String(config.get("thinkingMode", "auto"));
		const reasoningBudget = Number(config.get("reasoningBudget", DEFAULT_LOCAL_REASONING_BUDGET));
		const effectiveReasoningBudget = resolveReasoningBudget(
			normalizeThinkingMode(thinkingMode),
			Number.isFinite(reasoningBudget) ? reasoningBudget : DEFAULT_LOCAL_REASONING_BUDGET
		);
		const toolResultMode = String(config.get("toolResultMode", "auto"));
		const toolCallingMode = String(config.get("toolCallingMode", "apiDirect"));
		const knowledgeMode = String(config.get("knowledgeMode", "adaptive"));
		const fileLoggingEnabled = config.get<boolean>("enableFileLogging", true) !== false;
		const streamChunkLoggingEnabled = config.get<boolean>("logStreamChunks", false) === true;
		const performanceStatusBarEnabled = config.get<boolean>("showPerformanceStatusBar", true) !== false;
		const contextUsageStatusBarEnabled = config.get<boolean>("showContextUsageStatusBar", true) !== false;
		const memoryEnabled = config.get<boolean>("memoryEnabled", true) !== false;
		const memoryCount = this.getMemoryCount();
		const expiredMemoryCount = this.getExpiredMemoryCount();
		const memoryDescription = memoryEnabled
			? `${memoryCount} entries${expiredMemoryCount > 0 ? ` / ${expiredMemoryCount} expired` : ""}`
			: "Off";
		const lastThroughput = this.getLastThroughput();
		const lastContextUsage = this.getLastContextUsage();
		const lastPromptCache = this.getLastPromptCache();
		const sessionSummary = this.getSessionSummary();
		const healthStatus = this.getHealthStatus();
		const codexStatus = this.getCodexStatus();

		const connections = new QuickAccessItem("connections", "Connections", {
			description: `Local ${localServerEnabled ? "on" : "off"} / DeepSeek ${deepSeekEnabled ? "on" : "off"} / Codex ${codexEnabled ? "on" : "off"}`,
			icon: new vscode.ThemeIcon("server-environment"),
			expanded: true,
			children: [
				new QuickAccessItem("connections.primaryEndpoint", "Primary Endpoint", {
					description: formatEndpointLabel(serverUrl),
					tooltip: serverUrl,
					icon: new vscode.ThemeIcon("link"),
					command: command("llamacpp.manage", "Manage Primary Server"),
				}),
				new QuickAccessItem("connections.localSource", "Local Source", {
					description: localServerEnabled ? "On" : "Off",
					tooltip: "Enable or disable the dedicated local model source",
					icon: toggleIcon(localServerEnabled),
					command: command("llamacpp.toggleLocalServer", "Toggle Local Server Source"),
				}),
				new QuickAccessItem("connections.localEndpoint", "Local Endpoint", {
					description: formatEndpointLabel(localServerUrl),
					tooltip: localServerUrl,
					icon: new vscode.ThemeIcon("vm"),
					command: command("llamacpp.setLocalServerUrl", "Set Local Server URL"),
				}),
				new QuickAccessItem("connections.deepSeekSource", "DeepSeek Source", {
					description: deepSeekEnabled ? "On" : "Off",
					tooltip: "Enable or disable the dedicated DeepSeek source",
					icon: toggleIcon(deepSeekEnabled),
					command: command("llamacpp.toggleDeepSeek", "Toggle DeepSeek Source"),
				}),
				new QuickAccessItem("connections.deepSeekSetup", "DeepSeek Setup", {
					description: "API key and profile",
					icon: new vscode.ThemeIcon("cloud"),
					command: command("llamacpp.configureDeepSeek", "Configure DeepSeek"),
				}),
				new QuickAccessItem("connections.codexSource", "Codex Subscription", {
					description: codexEnabled ? "On" : "Off",
					tooltip: "Advertise Codex models backed by the signed-in ChatGPT subscription",
					icon: toggleIcon(codexEnabled),
					command: command("llamacpp.toggleCodexSubscription", "Toggle Codex Subscription Source"),
				}),
				new QuickAccessItem("connections.codexStatus", "Codex Account", {
					description: codexStatus ?? "Checking...",
					tooltip: "Read the ChatGPT plan, subscription usage, in-memory thread reuse, and last reported prompt-cache hit without exposing OAuth tokens",
					icon: new vscode.ThemeIcon("account"),
					command: command("llamacpp.codexShowStatus", "Show Codex Subscription Status"),
				}),
				new QuickAccessItem("connections.codexSignIn", "Sign In to Codex", {
					icon: new vscode.ThemeIcon("sign-in"),
					command: command("llamacpp.codexSignIn", "Sign In to Codex Subscription"),
				}),
				new QuickAccessItem("connections.primaryKey", "Primary API Key", {
					icon: new vscode.ThemeIcon("key"),
					command: command("llamacpp.setApiKey", "Set Primary API Key"),
				}),
			],
		});

		const modelBehavior = new QuickAccessItem("modelBehavior", "Model Behavior", {
			description: `${thinkingMode} / ${toolCallingMode} / ${knowledgeMode}`,
			icon: new vscode.ThemeIcon("settings-gear"),
			expanded: true,
			children: [
				new QuickAccessItem("modelBehavior.thinking", "Thinking", {
					description: thinkingMode,
					tooltip: "Global default. The native chat-session selector overrides it when available.",
					icon: new vscode.ThemeIcon("lightbulb"),
					command: command("llamacpp.setThinkingMode", "Set Thinking Mode"),
				}),
				new QuickAccessItem("modelBehavior.reasoningBudget", "Local Reasoning Cap", {
					description: `${effectiveReasoningBudget} tokens`,
					tooltip: "Maximum hidden reasoning tokens for local models. Light uses up to 512, Balanced up to 2048, Deep/Auto use this cap. DeepSeek uses High/Max effort instead.",
					icon: new vscode.ThemeIcon("symbol-numeric"),
					command: command("llamacpp.setReasoningBudget", "Set Reasoning Budget"),
				}),
				new QuickAccessItem("modelBehavior.toolCalling", "Tool Calling", {
					description: toolCallingMode,
					icon: new vscode.ThemeIcon("tools"),
					command: command("llamacpp.setToolCallingMode", "Set Tool Calling Mode"),
				}),
				new QuickAccessItem("modelBehavior.toolResults", "Tool Results", {
					description: toolResultMode,
					icon: new vscode.ThemeIcon("output"),
					command: command("llamacpp.setToolResultMode", "Set Tool Result Mode"),
				}),
				new QuickAccessItem("modelBehavior.codexVsCodeTools", "Codex VS Code Tools", {
					description: codexVsCodeToolsEnabled ? "On" : "Off",
					tooltip: "Delegate Codex-selected actions to native Copilot tool cards and the current session approval mode.",
					icon: toggleIcon(codexVsCodeToolsEnabled),
					command: command("llamacpp.toggleCodexVsCodeTools", "Toggle Codex VS Code Tools"),
				}),
				new QuickAccessItem("modelBehavior.codexDeferredTools", "Codex Deferred Tools", {
					description: codexDeferredToolsEnabled ? "On" : "Off",
					tooltip: "Keep core coding tools eager and load uncommon Copilot tool schemas on demand to reduce prompt overhead.",
					icon: toggleIcon(codexDeferredToolsEnabled),
					command: command("llamacpp.toggleCodexDeferredTools", "Toggle Codex Deferred Tools"),
				}),
				new QuickAccessItem("modelBehavior.knowledge", "Knowledge Verification", {
					description: knowledgeMode,
					tooltip: "Controls when the model verifies changing external knowledge with primary sources.",
					icon: new vscode.ThemeIcon("book"),
					command: command("llamacpp.setKnowledgeMode", "Set Knowledge Verification"),
				}),
			],
		});

		const memoryChildren = [
			new QuickAccessItem("memory.open", "Shared Memory", {
				description: memoryDescription,
				icon: new vscode.ThemeIcon("database"),
				command: command("llamacpp.openMemory", "Open Shared Memory"),
			}),
		];
		if (memoryCount > 0) {
			memoryChildren.push(
				new QuickAccessItem("memory.clear", "Clear All Entries", {
					icon: new vscode.ThemeIcon("trash"),
					command: command("llamacpp.clearMemory", "Clear Shared Memory"),
				})
			);
		}
		const memory = new QuickAccessItem("memory", "Memory", {
			description: memoryDescription,
			icon: new vscode.ThemeIcon("database"),
			children: memoryChildren,
		});

		const diagnostics = new QuickAccessItem("diagnostics", "Diagnostics", {
			description: `${lastThroughput ?? "n/a"} · ctx ${lastContextUsage?.summary ?? "n/a"}`,
			icon: new vscode.ThemeIcon("pulse"),
			children: [
				new QuickAccessItem("diagnostics.health", "Provider Health Check", {
					description: healthStatus ?? "Not run",
					tooltip: "Run read-only endpoint, runtime context, tokenizer, cache, and reliability checks.",
					icon: new vscode.ThemeIcon("heart"),
					command: command("llamacpp.runHealthCheck", "Run Provider Health Check"),
				}),
				new QuickAccessItem("diagnostics.session", "Session Quality Report", {
					description: sessionSummary ?? "No turns",
					tooltip: "Export aggregate cache, latency, context, compaction, and tool-call reliability metrics.",
					icon: new vscode.ThemeIcon("graph"),
					command: command("llamacpp.openSessionReport", "Open Session Quality Report"),
				}),
				new QuickAccessItem("diagnostics.resetSession", "Reset Session Metrics", {
					icon: new vscode.ThemeIcon("clear-all"),
					command: command("llamacpp.resetSessionReport", "Reset Session Metrics"),
				}),
				new QuickAccessItem("diagnostics.throughput", "Throughput", {
					description: lastThroughput ?? "n/a",
					icon: new vscode.ThemeIcon("dashboard"),
					command: command("llamacpp.openLatestLog", "Open Latest Log"),
				}),
				new QuickAccessItem("diagnostics.context", "Context Usage", {
					description: lastContextUsage?.summary ?? "n/a",
					tooltip: lastContextUsage?.breakdown,
					icon: new vscode.ThemeIcon("pie-chart"),
					command: command("llamacpp.openLatestLog", "Open Latest Log"),
				}),
				new QuickAccessItem("diagnostics.promptCache", "Prompt Cache", {
					description: lastPromptCache ?? "n/a",
					tooltip: "Cached prompt tokens reported by the selected server for the last completed turn",
					icon: new vscode.ThemeIcon("database"),
					command: command("llamacpp.openLatestLog", "Open Latest Log"),
				}),
				new QuickAccessItem("diagnostics.latestLog", "Latest Log", {
					icon: new vscode.ThemeIcon("file-text"),
					command: command("llamacpp.openLatestLog", "Open Latest Log"),
				}),
				new QuickAccessItem("diagnostics.logsFolder", "Logs Folder", {
					icon: new vscode.ThemeIcon("folder-opened"),
					command: command("llamacpp.openLogsFolder", "Open Logs Folder"),
				}),
				new QuickAccessItem("diagnostics.copyLogPath", "Copy Latest Log Path", {
					icon: new vscode.ThemeIcon("copy"),
					command: command("llamacpp.copyLatestLogPath", "Copy Latest Log Path"),
				}),
				new QuickAccessItem("diagnostics.fileLogging", "File Logging", {
					description: fileLoggingEnabled ? "On" : "Off",
					icon: toggleIcon(fileLoggingEnabled),
					command: command("llamacpp.toggleFileLogging", "Toggle File Logging"),
				}),
				new QuickAccessItem("diagnostics.streamLogging", "Stream Logging", {
					description: streamChunkLoggingEnabled ? "On" : "Off",
					icon: toggleIcon(streamChunkLoggingEnabled),
					command: command("llamacpp.toggleStreamChunkLogging", "Toggle Stream Chunk Logging"),
				}),
				new QuickAccessItem("diagnostics.performanceStatus", "Throughput Status Bar", {
					description: performanceStatusBarEnabled ? "On" : "Off",
					icon: toggleIcon(performanceStatusBarEnabled),
					command: command("llamacpp.togglePerformanceStatusBar", "Toggle Throughput Status Bar"),
				}),
				new QuickAccessItem("diagnostics.contextStatus", "Context Status Bar", {
					description: contextUsageStatusBarEnabled ? "On" : "Off",
					icon: toggleIcon(contextUsageStatusBarEnabled),
					command: command("llamacpp.toggleContextUsageStatusBar", "Toggle Context Status Bar"),
				}),
			],
		});

		return [connections, modelBehavior, memory, diagnostics];
	}
}
