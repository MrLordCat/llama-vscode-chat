
import * as vscode from "vscode";

import { LlamaCppChatModelProvider } from "./llama-provider";

const EXTENSION_ID = "maruf-bepary.llama-vscode-chat";

type ThinkingMode = "off" | "light" | "balanced" | "deep" | "auto";
type ToolResultMode = "auto" | "tool" | "user";

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

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(): vscode.ProviderResult<vscode.TreeItem[]> {
		const config = vscode.workspace.getConfiguration("llamacpp");
		const thinkingMode = String(config.get("thinkingMode", "auto"));
		const reasoningBudget = Number(config.get("reasoningBudget", 2048));
		const toolResultMode = String(config.get("toolResultMode", "auto"));

		return [
			new QuickActionItem("Open Llama.cpp Sidebar", undefined, {
				title: "Open Llama.cpp Sidebar",
				command: "llamacpp.openSidebar",
			}),
			new QuickActionItem("Manage Server URL", undefined, {
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
		];
	}
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

	// Llama.cpp Provider
	const llamaProvider = new LlamaCppChatModelProvider(context.secrets, ua);
	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider("llamacpp", llamaProvider));
	const quickActionsProvider = new LlamaQuickActionsProvider();
	context.subscriptions.push(vscode.window.registerTreeDataProvider("llamacpp-quick-actions", quickActionsProvider));

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
			const existingUrl = await context.secrets.get("llamacpp.serverUrl");
			const serverUrl = await vscode.window.showInputBox({
				title: "Llama.cpp Server URL",
				prompt: "Enter the URL of your Llama.cpp server",
				value: existingUrl || "http://localhost:8080",
				ignoreFocusOut: true,
			});

			if (serverUrl === undefined) {
				return; // User canceled
			}

			if (serverUrl.trim()) {
				await context.secrets.store("llamacpp.serverUrl", serverUrl.trim());
			} else {
				await context.secrets.delete("llamacpp.serverUrl");
			}

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
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration("llamacpp")) {
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
