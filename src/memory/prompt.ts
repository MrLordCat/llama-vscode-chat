import type { OpenAIChatMessage } from "../types";

const MEMORY_SYSTEM_PREFIX = "Shared durable memory for this user:";

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

export function buildMemoryQuery(messages: readonly OpenAIChatMessage[]): string {
	return messages
		.filter(message => message.role === "user")
		.slice(-4)
		.map(message => contentToText(message.content))
		.filter(Boolean)
		.join("\n")
		.slice(-12000);
}

export function injectSharedMemoryContext(
	messages: readonly OpenAIChatMessage[],
	memoryText: string | undefined
): OpenAIChatMessage[] {
	if (!memoryText?.trim()) {
		return messages.map(message => ({ ...message }));
	}

	const memoryBlock = `${MEMORY_SYSTEM_PREFIX}\n${memoryText.trim()}`;
	const firstSystemIndex = messages.findIndex(message => message.role === "system");
	const next = messages.map(message => ({ ...message }));

	if (firstSystemIndex >= 0) {
		const existing = contentToText(next[firstSystemIndex].content);
		next[firstSystemIndex] = {
			...next[firstSystemIndex],
			content: existing ? `${existing}\n\n${memoryBlock}` : memoryBlock,
		};
		return next;
	}

	return [{ role: "system", content: memoryBlock }, ...next];
}
