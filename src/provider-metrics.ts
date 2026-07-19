export interface ProviderRuntimeMetrics {
	modelId?: string;
	phase?: "running" | "completed";
	estimated?: boolean;
	inputTokens?: number;
	outputTokens?: number;
	cachedInputTokens?: number;
	contextUsedTokens?: number;
	contextWindowTokens?: number;
	contextUsagePercent?: number;
	contextDetail?: string;
	throughputTokensPerSecond?: number;
	updatedAt?: number;
}

export function formatCompactTokenCount(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value)) {
		return "n/a";
	}
	const normalized = Math.max(0, value);
	if (normalized >= 1_000_000) {
		return `${(normalized / 1_000_000).toFixed(1)}M`;
	}
	if (normalized >= 1_000) {
		return `${(normalized / 1_000).toFixed(1)}K`;
	}
	return Math.round(normalized).toString();
}

export function formatProviderTokens(metrics: ProviderRuntimeMetrics | undefined): string {
	if (metrics?.inputTokens === undefined && metrics?.outputTokens === undefined) {
		return metrics?.phase === "running" ? "Estimating..." : "No completed request";
	}
	const prefix = metrics?.estimated ? "~" : "";
	return `${prefix}${formatCompactTokenCount(metrics.inputTokens)} in · ${prefix}${formatCompactTokenCount(metrics.outputTokens)} out`;
}

export function formatProviderCache(metrics: ProviderRuntimeMetrics | undefined): string {
	if (metrics?.cachedInputTokens === undefined || metrics.inputTokens === undefined) {
		return metrics?.phase === "running" ? "Awaiting server snapshot" : "Not reported";
	}
	const percent =
		metrics.inputTokens > 0 ? Math.max(0, Math.min(100, (metrics.cachedInputTokens / metrics.inputTokens) * 100)) : 0;
	const prefix = metrics.estimated ? "~" : "";
	return `${prefix}${percent.toFixed(1)}% · ${prefix}${formatCompactTokenCount(metrics.cachedInputTokens)}/${prefix}${formatCompactTokenCount(metrics.inputTokens)}`;
}

export function formatProviderContext(metrics: ProviderRuntimeMetrics | undefined): string {
	if (metrics?.contextUsedTokens === undefined || metrics.contextWindowTokens === undefined) {
		return "No current snapshot";
	}
	const percent =
		metrics.contextUsagePercent ??
		(metrics.contextWindowTokens > 0 ? (metrics.contextUsedTokens / metrics.contextWindowTokens) * 100 : 0);
	const prefix = metrics.estimated ? "~" : "";
	return `${prefix}${Math.max(0, Math.min(100, percent)).toFixed(1)}% · ${prefix}${formatCompactTokenCount(metrics.contextUsedTokens)}/${formatCompactTokenCount(metrics.contextWindowTokens)}`;
}
