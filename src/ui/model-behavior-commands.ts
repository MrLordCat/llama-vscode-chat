import * as vscode from "vscode";

import { CONFIG_SECTION } from "../constants";
import type { ThinkingMode } from "../reasoning";

type ToolResultMode = "auto" | "tool" | "user";
type ToolCallingMode = "classic" | "apiDirect";

async function pickThinkingMode(current: ThinkingMode): Promise<ThinkingMode | undefined> {
	const options: Array<{ label: string; description: string; value: ThinkingMode }> = [
		{ label: "Auto", description: "Use the configured local reasoning cap", value: "auto" },
		{ label: "Off", description: "Disable model reasoning", value: "off" },
		{ label: "Light", description: "Use up to 512 hidden reasoning tokens", value: "light" },
		{ label: "Balanced", description: "Use up to 2048 hidden reasoning tokens", value: "balanced" },
		{ label: "Deep", description: "Use the configured local cap or DeepSeek Max effort", value: "deep" },
	];
	const picked = await vscode.window.showQuickPick(
		options.map(option => ({
			...option,
			detail: option.value === current ? "Current" : undefined,
		})),
		{ title: "Local LLM Thinking Mode", ignoreFocusOut: true }
	);
	return picked?.value;
}

async function pickToolResultMode(current: ToolResultMode): Promise<ToolResultMode | undefined> {
	const options: Array<{ label: string; description: string; value: ToolResultMode }> = [
		{ label: "Auto", description: "Use tool role and retry with user-style results only when required", value: "auto" },
		{ label: "Tool", description: "Always send role=tool with tool_call_id", value: "tool" },
		{ label: "User", description: "Flatten tool results into user text for maximum compatibility", value: "user" },
	];
	const picked = await vscode.window.showQuickPick(
		options.map(option => ({ ...option, detail: option.value === current ? "Current" : undefined })),
		{ title: "Local LLM Tool Result Mode", ignoreFocusOut: true }
	);
	return picked?.value;
}

async function pickToolCallingMode(current: ToolCallingMode): Promise<ToolCallingMode | undefined> {
	const options: Array<{ label: string; description: string; value: ToolCallingMode }> = [
		{ label: "API Direct", description: "Send a compact prioritized tool catalog within its token budget", value: "apiDirect" },
		{ label: "Classic", description: "Send the unmodified tool catalog", value: "classic" },
	];
	const picked = await vscode.window.showQuickPick(
		options.map(option => ({ ...option, detail: option.value === current ? "Current" : undefined })),
		{ title: "Local LLM Tool Calling Mode", ignoreFocusOut: true }
	);
	return picked?.value;
}

export function registerModelBehaviorCommands(refresh: () => void): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand("llamacpp.setThinkingMode", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const current = String(config.get("thinkingMode", "auto")) as ThinkingMode;
			const next = await pickThinkingMode(current);
			if (!next) {
				return;
			}
			await config.update("thinkingMode", next, vscode.ConfigurationTarget.Global);
			refresh();
			vscode.window.showInformationMessage(`Local LLM thinking mode: ${next}`);
		}),
		vscode.commands.registerCommand("llamacpp.setReasoningBudget", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const current = Number(config.get("reasoningBudget", 8192));
			const value = await vscode.window.showInputBox({
				title: "Local LLM Reasoning Cap",
				prompt: "Maximum hidden reasoning tokens for local models; DeepSeek uses High or Max effort",
				value: Number.isFinite(current) ? String(current) : "8192",
				ignoreFocusOut: true,
				validateInput: input => {
					if (!/^\d+$/.test(input.trim())) {
						return "Enter a whole number from 256 to 65536";
					}
					const parsed = Number(input);
					return parsed < 256 || parsed > 65536 ? "Value must be between 256 and 65536" : undefined;
				},
			});
			if (value === undefined) {
				return;
			}
			const parsed = Math.max(256, Math.min(65536, Number(value)));
			await config.update("reasoningBudget", parsed, vscode.ConfigurationTarget.Global);
			refresh();
			vscode.window.showInformationMessage(`Local LLM reasoning cap: ${parsed} tokens`);
		}),
		vscode.commands.registerCommand("llamacpp.setToolResultMode", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const current = String(config.get("toolResultMode", "auto")) as ToolResultMode;
			const next = await pickToolResultMode(current);
			if (!next) {
				return;
			}
			await config.update("toolResultMode", next, vscode.ConfigurationTarget.Global);
			refresh();
			vscode.window.showInformationMessage(`Local LLM tool result mode: ${next}`);
		}),
		vscode.commands.registerCommand("llamacpp.setToolCallingMode", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const current = String(config.get("toolCallingMode", "apiDirect")) as ToolCallingMode;
			const next = await pickToolCallingMode(current);
			if (!next) {
				return;
			}
			await config.update("toolCallingMode", next, vscode.ConfigurationTarget.Global);
			refresh();
			vscode.window.showInformationMessage(`Local LLM tool calling mode: ${next}`);
		}),
	];
}
