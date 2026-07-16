export type ThinkingMode = "off" | "light" | "balanced" | "deep" | "auto";

const THINKING_MODE_ALIASES: Readonly<Record<string, ThinkingMode>> = {
	auto: "auto",
	default: "auto",
	off: "off",
	none: "off",
	minimal: "light",
	light: "light",
	low: "light",
	balanced: "balanced",
	medium: "balanced",
	deep: "deep",
	high: "deep",
	xhigh: "deep",
	max: "deep",
};

export function normalizeThinkingMode(value: unknown): ThinkingMode {
	if (typeof value !== "string") {
		return "auto";
	}
	return THINKING_MODE_ALIASES[value.trim().toLowerCase()] ?? "auto";
}

export function resolveRequestThinkingMode(
	configuredMode: unknown,
	modelOptions: Readonly<Record<string, unknown>> | undefined
): ThinkingMode {
	const requestedMode =
		modelOptions?.reasoningEffort ??
		modelOptions?.reasoning_effort ??
		modelOptions?.thinkingMode ??
		modelOptions?.thinking_mode;

	return requestedMode === undefined
		? normalizeThinkingMode(configuredMode)
		: normalizeThinkingMode(requestedMode);
}

export function resolveReasoningBudget(mode: ThinkingMode, configuredBudget: number): number {
	switch (mode) {
		case "off":
			return 0;
		case "light":
			return 512;
		case "balanced":
			return 2048;
		case "deep":
			return 8192;
		case "auto":
		default:
			return configuredBudget;
	}
}

export function toDeepSeekReasoningEffort(mode: ThinkingMode): "high" | "max" | undefined {
	switch (mode) {
		case "off":
			return undefined;
		case "deep":
			return "max";
		case "light":
		case "balanced":
		case "auto":
		default:
			return "high";
	}
}

interface ReasoningConfigurationProperty {
	type: "string";
	title: string;
	enum: string[];
	enumItemLabels: string[];
	enumDescriptions: string[];
	default: string;
	group: "navigation";
}

export interface ReasoningConfigurationSchema {
	properties: {
		reasoningEffort: ReasoningConfigurationProperty;
	};
}

export function createReasoningConfigurationSchema(family: string): ReasoningConfigurationSchema {
	const isDeepSeek = family.toLowerCase().includes("deepseek");
	const efforts = isDeepSeek
		? ["high", "max"]
		: ["none", "low", "medium", "high"];
	const descriptions: Readonly<Record<string, string>> = {
		none: "Disable model reasoning for the current chat session.",
		low: "Use a small reasoning budget for faster responses.",
		medium: "Balance reasoning quality and response latency.",
		high: "Use a larger reasoning budget for complex tasks.",
		max: "Use the maximum DeepSeek reasoning effort.",
	};

	return {
		properties: {
			reasoningEffort: {
				type: "string",
				title: "Thinking Effort",
				enum: efforts,
				enumItemLabels: efforts.map(effort => effort.charAt(0).toUpperCase() + effort.slice(1)),
				enumDescriptions: efforts.map(effort => descriptions[effort]),
				default: isDeepSeek ? "high" : "medium",
				group: "navigation",
			},
		},
	};
}
