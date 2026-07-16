import type { OpenAIChatMessage } from "../types";

export interface CompactMessagesOptions {
	tokenBudget: number;
	keepLastCount: number;
	label: string;
	estimateTokens(messages: OpenAIChatMessage[]): number;
}

function contentToText(content: OpenAIChatMessage["content"]): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map(part => part.type === "text" && typeof part.text === "string" ? part.text : "")
			.join("\n");
	}
	return "";
}

function summarizeMessage(message: OpenAIChatMessage): string {
	if (message.role === "tool") {
		const toolName = typeof message.name === "string" && message.name.trim().length > 0
			? message.name.trim()
			: "tool";
		const size = typeof message.content === "string" ? message.content.length : 0;
		return `[tool_result ${toolName}] ${size} chars omitted`;
	}

	if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
		const names = message.tool_calls
			.map(call => call.function?.name)
			.filter((name): name is string => typeof name === "string" && name.length > 0);
		if (names.length > 0) {
			const shown = names.slice(0, 3).join(", ");
			const extra = names.length > 3 ? ` +${names.length - 3} more` : "";
			return `[tool_calls] ${shown}${extra}`;
		}
		return `[tool_calls] ${message.tool_calls.length}`;
	}

	return contentToText(message.content);
}

function cloneMessage(message: OpenAIChatMessage): OpenAIChatMessage {
	return {
		...message,
		...(Array.isArray(message.content)
			? { content: message.content.map(part => ({ ...part })) }
			: {}),
	};
}

export function compactMessages(
	messages: OpenAIChatMessage[],
	options: CompactMessagesOptions
): OpenAIChatMessage[] {
	if (messages.length <= 2) {
		return messages.map(cloneMessage);
	}

	const systems = messages.filter(message => message.role === "system").map(cloneMessage);
	const nonSystem = messages.filter(message => message.role !== "system");
	if (nonSystem.length === 0) {
		return systems;
	}

	const keepLast = Math.min(nonSystem.length, Math.max(1, options.keepLastCount));
	const head = nonSystem.slice(0, Math.max(0, nonSystem.length - keepLast));
	let tail = nonSystem.slice(Math.max(0, nonSystem.length - keepLast)).map(cloneMessage);
	const summaryLines = head.slice(-24).flatMap(message => {
		const text = summarizeMessage(message).replace(/\s+/g, " ").trim();
		if (!text) {
			return [];
		}
		const clipped = text.length > 220 ? `${text.slice(0, 220)}...` : text;
		return [`- ${message.role}: ${clipped}`];
	});
	const summaryText = summaryLines.length > 0
		? `${options.label}:\n${summaryLines.join("\n")}`
		: `${options.label}: prior turns were compacted to fit model context.`;
	const compacted: OpenAIChatMessage[] = [
		...systems,
		{ role: "system", content: summaryText },
		...tail,
	];

	while (options.estimateTokens(compacted) > options.tokenBudget && tail.length > 2) {
		tail = tail.slice(1);
		compacted.splice(systems.length + 1, compacted.length - (systems.length + 1), ...tail);
	}

	if (options.estimateTokens(compacted) > options.tokenBudget) {
		for (const message of compacted) {
			if (typeof message.content === "string" && message.content.length > 1200) {
				message.content = `${message.content.slice(0, 1200)}...`;
			}
		}
	}

	return compacted;
}
