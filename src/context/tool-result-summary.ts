const SENSITIVE_KEY = /^(?:api[_-]?key|authorization|password|secret|token)$/i;
const SIGNAL_LINE = /\b(?:error|warning|warn|failed|failure|status|exit(?:\s+code)?|diagnostic|modified|created|deleted)\b|(?:[A-Za-z]:\\|\/[\w.-]+\/)/i;

function clip(value: string, maxChars: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > maxChars ? `${normalized.slice(0, Math.max(0, maxChars - 3))}...` : normalized;
}

function summarizeJsonValue(value: unknown): string {
	if (value === null || typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (typeof value === "string") {
		return JSON.stringify(clip(value, 120));
	}
	if (Array.isArray(value)) {
		return `[${value.length} items]`;
	}
	if (typeof value === "object") {
		return `{${Object.keys(value as Record<string, unknown>).length} keys}`;
	}
	return typeof value;
}

function summarizeJson(content: string): string | undefined {
	try {
		const parsed = JSON.parse(content) as unknown;
		if (Array.isArray(parsed)) {
			return `json array, items=${parsed.length}`;
		}
		if (!parsed || typeof parsed !== "object") {
			return `json value=${summarizeJsonValue(parsed)}`;
		}

		const entries = Object.entries(parsed as Record<string, unknown>);
		const keys = entries.map(([key]) => key);
		const selected = entries
			.filter(([key]) => !SENSITIVE_KEY.test(key))
			.filter(([key]) => /^(?:path|file|filePath|uri|status|exitCode|code|error|message|count|total|success)$/i.test(key))
			.slice(0, 6)
			.map(([key, value]) => `${key}=${summarizeJsonValue(value)}`);
		const keyText = keys.slice(0, 12).join(", ");
		return `json object, keys=[${keyText}${keys.length > 12 ? ", ..." : ""}]${selected.length > 0 ? `; ${selected.join("; ")}` : ""}`;
	} catch {
		return undefined;
	}
}

export function summarizeToolResultContent(content: string, maxChars = 900): string {
	const normalized = content.replace(/\r\n/g, "\n").trim();
	const lines = normalized.length > 0 ? normalized.split("\n") : [];
	const jsonSummary = summarizeJson(normalized);
	const header = `original=${content.length} chars, lines=${lines.length}`;
	if (jsonSummary) {
		return clip(`[tool result summarized: ${header}, ${jsonSummary}]`, maxChars);
	}

	const boundaryLines = [...lines.slice(0, 2), ...lines.slice(-2)]
		.filter(line => line.length <= 240 || SIGNAL_LINE.test(line));
	const candidates = [
		...boundaryLines.slice(0, 2),
		...lines.filter(line => SIGNAL_LINE.test(line)).slice(0, 6),
		...boundaryLines.slice(-2),
	];
	const seen = new Set<string>();
	const selected = candidates
		.map(line => clip(line, 240))
		.filter(line => line.length > 0 && !seen.has(line) && Boolean(seen.add(line)))
		.slice(0, 8);
	const details = selected.length > 0 ? `\n${selected.map(line => `- ${line}`).join("\n")}` : "";
	return clip(`[tool result summarized: ${header}]${details}`, maxChars);
}

export function summarizeToolCallArguments(argumentsText: string | undefined, maxChars = 320): string {
	if (!argumentsText) {
		return "";
	}
	try {
		const parsed = JSON.parse(argumentsText) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return clip(argumentsText, maxChars);
		}
		const entries = Object.entries(parsed as Record<string, unknown>)
			.filter(([key]) => !SENSITIVE_KEY.test(key))
			.slice(0, 6)
			.map(([key, value]) => `${key}=${summarizeJsonValue(value)}`);
		return clip(entries.join(", "), maxChars);
	} catch {
		return clip(argumentsText, maxChars);
	}
}
