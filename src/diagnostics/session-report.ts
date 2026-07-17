import type { LlamaChatContextUsageMetrics, LlamaChatTurnMetrics } from "../llama-provider";

export interface SessionTurnRecord {
	turn: LlamaChatTurnMetrics;
	context?: LlamaChatContextUsageMetrics;
}

export interface SessionQualitySummary {
	turns: number;
	promptTokens: number;
	cachedPromptTokens: number;
	cacheHitPercent?: number;
	averageFirstTokenLatencyMs?: number;
	averageTokensPerSecond?: number;
	totalToolCalls: number;
	repairedToolCalls: number;
	rejectedToolCalls: number;
	toolCallRepairRetries: number;
	toolLoopsDetected: number;
	compactedTurns: number;
	overflowRetries: number;
}

export class SessionQualityTracker {
	private readonly contexts = new Map<string, LlamaChatContextUsageMetrics>();
	private readonly records: SessionTurnRecord[] = [];

	recordContext(context: LlamaChatContextUsageMetrics): void {
		this.contexts.set(context.requestId, { ...context });
		if (this.contexts.size > 500) {
			const oldestRequestId = this.contexts.keys().next().value as string | undefined;
			if (oldestRequestId) {
				this.contexts.delete(oldestRequestId);
			}
		}
	}

	recordTurn(turn: LlamaChatTurnMetrics): void {
		this.records.push({
			turn: { ...turn },
			context: this.contexts.get(turn.requestId),
		});
		if (this.records.length > 500) {
			this.records.shift();
		}
		this.contexts.delete(turn.requestId);
	}

	clear(): void {
		this.contexts.clear();
		this.records.length = 0;
	}

	get count(): number {
		return this.records.length;
	}

	get summary(): SessionQualitySummary {
		const promptTokens = this.records.reduce((sum, record) => sum + record.turn.promptTokens, 0);
		const cachedPromptTokens = this.records.reduce((sum, record) => sum + (record.turn.cachedPromptTokens ?? 0), 0);
		const firstTokenValues = this.records
			.map(record => record.turn.firstTokenLatencyMs)
			.filter((value): value is number => value !== undefined);
		const tpsValues = this.records
			.map(record => record.turn.tokensPerSecond)
			.filter((value): value is number => value !== undefined);
		return {
			turns: this.records.length,
			promptTokens,
			cachedPromptTokens,
			cacheHitPercent: promptTokens > 0 ? Number((cachedPromptTokens / promptTokens * 100).toFixed(1)) : undefined,
			averageFirstTokenLatencyMs: firstTokenValues.length > 0
				? Math.round(firstTokenValues.reduce((sum, value) => sum + value, 0) / firstTokenValues.length)
				: undefined,
			averageTokensPerSecond: tpsValues.length > 0
				? Number((tpsValues.reduce((sum, value) => sum + value, 0) / tpsValues.length).toFixed(2))
				: undefined,
			totalToolCalls: this.records.reduce((sum, record) => sum + record.turn.toolCalls, 0),
			repairedToolCalls: this.records.reduce((sum, record) => sum + record.turn.repairedToolCalls, 0),
			rejectedToolCalls: this.records.reduce((sum, record) => sum + record.turn.rejectedToolCalls, 0),
			toolCallRepairRetries: this.records.reduce((sum, record) => sum + record.turn.toolCallRepairRetries, 0),
			toolLoopsDetected: this.records.filter(record => record.turn.toolLoopDetected).length,
			compactedTurns: this.records.filter(record => record.context?.autoCompacted || record.context?.hardCompacted).length,
			overflowRetries: this.records.filter(record => record.turn.retriedAfterOverflow).length,
		};
	}

	toJSON(): { generatedAt: string; summary: SessionQualitySummary; turns: SessionTurnRecord[] } {
		return {
			generatedAt: new Date().toISOString(),
			summary: this.summary,
			turns: this.records.map(record => ({
				turn: { ...record.turn },
				context: record.context ? { ...record.context } : undefined,
			})),
		};
	}

	renderMarkdown(extensionVersion: string, vscodeVersion: string): string {
		const summary = this.summary;
		const lines = [
			"# Local LLM Session Quality Report",
			"",
			`Generated: ${new Date().toISOString()}`,
			`Extension: ${extensionVersion}`,
			`VS Code: ${vscodeVersion}`,
			"",
			"## Summary",
			"",
			`- Turns: ${summary.turns}`,
			`- Prompt tokens: ${summary.promptTokens}`,
			`- Cached prompt tokens: ${summary.cachedPromptTokens} (${summary.cacheHitPercent ?? "n/a"}%)`,
			`- Average first-token latency: ${summary.averageFirstTokenLatencyMs ?? "n/a"} ms`,
			`- Average generation speed: ${summary.averageTokensPerSecond ?? "n/a"} tok/s`,
			`- Tool calls: ${summary.totalToolCalls}`,
			`- Tool calls repaired/rejected: ${summary.repairedToolCalls}/${summary.rejectedToolCalls}`,
			`- Tool-call correction retries: ${summary.toolCallRepairRetries}`,
			`- Tool loops detected: ${summary.toolLoopsDetected}`,
			`- Compacted turns: ${summary.compactedTurns}`,
			`- Context-overflow retries: ${summary.overflowRetries}`,
			"",
			"## Turns",
			"",
			"| # | Model | Prompt | Cache | TTFT ms | tok/s | Tools | Repair | Reject | Context | Compact |",
			"| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
		];
		this.records.forEach((record, index) => {
			const turn = record.turn;
			const context = record.context;
			lines.push([
				`| ${index + 1}`,
				turn.modelId.replace(/\|/g, "\\|"),
				turn.promptTokens,
				turn.cachedPromptTokens ?? 0,
				turn.firstTokenLatencyMs ?? "n/a",
				turn.tokensPerSecond ?? "n/a",
				turn.toolCalls,
				turn.repairedToolCalls,
				turn.rejectedToolCalls,
				context ? `${context.estimatedUsagePercent.toFixed(1)}%` : "n/a",
				context?.hardCompacted ? "hard" : context?.autoCompacted ? "auto" : "no",
			].join(" | ") + " |" );
		});
		lines.push("", "This report contains metrics and model ids only. Message and tool-result bodies are not stored.", "");
		return lines.join("\n");
	}
}
