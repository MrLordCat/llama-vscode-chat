import type { OpenAIChatMessage } from "../types";

const SUMMARY_MARKERS = [
	"summarize the conversation history so far",
	"write a continuation summary",
	"your only task right now is to produce a comprehensive summary",
	"this summary should serve as a comprehensive handoff document",
];

const COMPACTION_MARKERS = [
	"conversation has grown too large for the context window",
	"must be compacted now",
	"triggered this summarization",
	"conversation history will be replaced with this summary",
];

function contentToText(content: OpenAIChatMessage["content"]): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter(part => part.type === "text" && typeof part.text === "string")
		.map(part => part.text ?? "")
		.join("\n");
}

export function isCopilotCompactionRequest(messages: readonly OpenAIChatMessage[]): boolean {
	if (messages.length === 0 || messages.length > 6) {
		return false;
	}

	const prompt = messages
		.filter(message => message.role === "system" || message.role === "user")
		.map(message => contentToText(message.content))
		.join("\n")
		.toLocaleLowerCase();

	return SUMMARY_MARKERS.some(marker => prompt.includes(marker))
		&& COMPACTION_MARKERS.some(marker => prompt.includes(marker));
}

export function addCopilotCompactionLimit(
	messages: readonly OpenAIChatMessage[],
	maxOutputTokens: number
): OpenAIChatMessage[] {
	const next = messages.map(message => ({
		...message,
		content: Array.isArray(message.content)
			? message.content.map(part => ({ ...part }))
			: message.content,
	}));
	const latestUserIndex = next.findLastIndex(message => message.role === "user");
	if (latestUserIndex < 0) {
		return next;
	}

	const targetTokens = Math.max(256, Math.floor(maxOutputTokens * 0.75));
	const instruction = [
		"Provider compaction constraint:",
		`Keep the summary complete but concise and under ${targetTokens} tokens.`,
		"Prioritize active requirements, decisions, changed files, errors, and exact next actions. Omit repetition and narrative detail.",
	].join("\n");
	const message = next[latestUserIndex];
	if (typeof message.content === "string") {
		message.content = `${message.content}\n\n${instruction}`;
	} else if (Array.isArray(message.content)) {
		message.content = [...message.content, { type: "text", text: instruction }];
	} else {
		message.content = instruction;
	}

	return next;
}
