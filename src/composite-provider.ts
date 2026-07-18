import * as vscode from "vscode";

import { CODEX_MODEL_ID_PREFIX, decodeCodexModelId } from "./codex/model-adapter";

/** Combines independent transports under the existing picker-compatible vendor. */
export class CompositeChatModelProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
	private readonly modelChanges = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.modelChanges.event;
	private readonly subscriptions: vscode.Disposable[];

	constructor(
		private readonly defaultProvider: vscode.LanguageModelChatProvider,
		private readonly codexProvider: vscode.LanguageModelChatProvider
	) {
		this.subscriptions = [
			defaultProvider.onDidChangeLanguageModelChatInformation?.(() => this.modelChanges.fire()),
			codexProvider.onDidChangeLanguageModelChatInformation?.(() => this.modelChanges.fire()),
		].filter((value): value is vscode.Disposable => value !== undefined);
	}

	async provideLanguageModelChatInformation(
		options: { silent: boolean },
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelChatInformation[]> {
		const [defaultResult, codexResult] = await Promise.allSettled([
			this.defaultProvider.provideLanguageModelChatInformation(options, token),
			this.codexProvider.provideLanguageModelChatInformation(options, token),
		]);
		const defaults = defaultResult.status === "fulfilled" ? await defaultResult.value ?? [] : [];
		const codex = codexResult.status === "fulfilled" ? await codexResult.value ?? [] : [];
		return [...defaults, ...codex].sort((left, right) => left.name.localeCompare(right.name));
	}

	provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Thenable<void> {
		return this.selectProvider(model.id).provideLanguageModelChatResponse(
			model,
			messages,
			options,
			progress,
			token
		);
	}

	provideTokenCount(
		model: vscode.LanguageModelChatInformation,
		value: string | vscode.LanguageModelChatRequestMessage,
		token: vscode.CancellationToken
	): Thenable<number> {
		return this.selectProvider(model.id).provideTokenCount(model, value, token);
	}

	dispose(): void {
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
		this.modelChanges.dispose();
	}

	private selectProvider(modelId: string): vscode.LanguageModelChatProvider {
		return decodeCodexModelId(modelId) !== undefined || modelId.startsWith(CODEX_MODEL_ID_PREFIX)
			? this.codexProvider
			: this.defaultProvider;
	}
}
