import * as vscode from "vscode";
import type { SharedMemoryService } from "./shared-memory-service";

interface StoreMemoryInput {
	id?: string;
	title: string;
	content: string;
	tags?: string[];
	pinned?: boolean;
}

interface SearchMemoryInput {
	query?: string;
	limit?: number;
}

interface DeleteMemoryInput {
	id: string;
}

class StoreMemoryTool implements vscode.LanguageModelTool<StoreMemoryInput> {
	constructor(private readonly memory: SharedMemoryService) {}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<StoreMemoryInput>): vscode.PreparedToolInvocation {
		return {
			invocationMessage: `Saving shared memory: ${options.input.title}`,
			confirmationMessages: {
				title: "Save shared memory",
				message: `Store "${options.input.title}" for use across chats, projects, and models?`,
			},
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<StoreMemoryInput>): Promise<vscode.LanguageModelToolResult> {
		const entry = await this.memory.upsert(options.input);
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(`Saved shared memory ${entry.id}: ${entry.title}`),
		]);
	}
}

class SearchMemoryTool implements vscode.LanguageModelTool<SearchMemoryInput> {
	constructor(private readonly memory: SharedMemoryService) {}

	prepareInvocation(): vscode.PreparedToolInvocation {
		return { invocationMessage: "Searching shared memory" };
	}

	invoke(options: vscode.LanguageModelToolInvocationOptions<SearchMemoryInput>): vscode.LanguageModelToolResult {
		const entries = this.memory.search(options.input.query ?? "", options.input.limit ?? 12);
		const result = entries.length === 0
			? "No matching shared memory entries."
			: entries.map(entry => `- [${entry.id}] ${entry.title}\n${entry.content}`).join("\n\n");
		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
	}
}

class DeleteMemoryTool implements vscode.LanguageModelTool<DeleteMemoryInput> {
	constructor(private readonly memory: SharedMemoryService) {}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<DeleteMemoryInput>): vscode.PreparedToolInvocation {
		return {
			invocationMessage: `Deleting shared memory ${options.input.id}`,
			confirmationMessages: {
				title: "Delete shared memory",
				message: `Permanently delete shared memory entry "${options.input.id}"?`,
			},
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<DeleteMemoryInput>): Promise<vscode.LanguageModelToolResult> {
		const removed = await this.memory.remove(options.input.id);
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(removed ? `Deleted shared memory ${options.input.id}.` : `Shared memory ${options.input.id} was not found.`),
		]);
	}
}

export function registerMemoryTools(context: vscode.ExtensionContext, memory: SharedMemoryService): void {
	context.subscriptions.push(
		vscode.lm.registerTool("llamacpp_store_memory", new StoreMemoryTool(memory)),
		vscode.lm.registerTool("llamacpp_search_memory", new SearchMemoryTool(memory)),
		vscode.lm.registerTool("llamacpp_delete_memory", new DeleteMemoryTool(memory))
	);
}
