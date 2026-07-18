import type * as vscode from "vscode";

const MAX_TOOL_DESCRIPTION_CHARS = 1_024;
export const CODEX_DEFERRED_TOOL_NAMESPACE = "vscode_deferred";
const EAGER_TOOL_SUFFIXES = [
	"readfile",
	"grepsearch",
	"filesearch",
	"semanticsearch",
	"listdir",
	"runinterminal",
	"getterminaloutput",
	"applypatch",
	"createfile",
	"replacestringinfile",
	"multireplacestringinfile",
	"managetodolist",
	"updateplan",
	"getchangedfiles",
	"geterrors",
	"runtests",
	"testfailure",
	"requestuserinput",
	"websearch",
	"fetchwebpage",
	"viewimage",
];
const EXCLUDED_VSCODE_TOOLS = new Set([
	"copilot_editFiles",
	"copilot_switchAgent",
]);

export interface CodexDynamicFunctionToolSpec {
	type: "function";
	name: string;
	description: string;
	inputSchema: unknown;
	deferLoading?: boolean;
}

export interface CodexDynamicNamespaceSpec {
	type: "namespace";
	name: string;
	description: string;
	tools: CodexDynamicFunctionToolSpec[];
}

export type CodexDynamicToolSpec = CodexDynamicFunctionToolSpec | CodexDynamicNamespaceSpec;

export interface CodexDynamicToolRuntimeSignature {
	namespace: string | null;
	name: string;
	inputSchema: unknown;
	deferLoading: boolean;
}

export interface CodexDynamicToolSet {
	specs: CodexDynamicToolSpec[];
	callableNames: Set<string>;
	deferredNames: Set<string>;
	runtimeSignatures: CodexDynamicToolRuntimeSignature[];
	skippedNames: string[];
}

export interface CodexDynamicToolCallResponse {
	contentItems: Array<
		| { type: "inputText"; text: string }
		| { type: "inputImage"; imageUrl: string }
	>;
	success: boolean;
}

function normalizeJsonSchema(value: object | undefined): unknown {
	if (!value) {
		return { type: "object", additionalProperties: true };
	}
	try {
		return JSON.parse(JSON.stringify(value)) as unknown;
	} catch {
		return { type: "object", additionalProperties: true };
	}
}

function isValidDynamicToolName(name: string): boolean {
	return /^[a-zA-Z0-9_-]{1,128}$/.test(name);
}

function isCoreAgentTool(name: string): boolean {
	const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");
	return EAGER_TOOL_SUFFIXES.some(suffix => normalized === suffix || normalized.endsWith(suffix));
}

/** Converts the outer Copilot tool catalog into app-server dynamic tool specs. */
export function buildCodexDynamicTools(
	advertisedTools: readonly vscode.LanguageModelChatTool[],
	options: { deferNonCoreTools?: boolean } = {}
): CodexDynamicToolSet {
	const eagerSpecs: CodexDynamicFunctionToolSpec[] = [];
	const deferredSpecs: CodexDynamicFunctionToolSpec[] = [];
	const callableNames = new Set<string>();
	const deferredNames = new Set<string>();
	const skippedNames: string[] = [];

	for (const tool of advertisedTools) {
		if (
			callableNames.has(tool.name)
			|| EXCLUDED_VSCODE_TOOLS.has(tool.name)
			|| !isValidDynamicToolName(tool.name)
		) {
			skippedNames.push(tool.name);
			continue;
		}
		const deferLoading = options.deferNonCoreTools === true && !isCoreAgentTool(tool.name);
		const spec: CodexDynamicFunctionToolSpec = {
			type: "function",
			name: tool.name,
			description: (tool.description || `Invoke the VS Code tool ${tool.name}.`).slice(0, MAX_TOOL_DESCRIPTION_CHARS),
			inputSchema: normalizeJsonSchema(tool.inputSchema),
			...(deferLoading ? { deferLoading: true } : {}),
		};
		if (deferLoading) {
			deferredSpecs.push(spec);
			deferredNames.add(tool.name);
		} else {
			eagerSpecs.push(spec);
		}
		callableNames.add(tool.name);
	}

	const specs: CodexDynamicToolSpec[] = [...eagerSpecs];
	if (deferredSpecs.length > 0) {
		specs.push({
			type: "namespace",
			name: CODEX_DEFERRED_TOOL_NAMESPACE,
			description: "Less common VS Code and Copilot tools available through tool search.",
			tools: deferredSpecs,
		});
	}
	const runtimeSignatures: CodexDynamicToolRuntimeSignature[] = [
		...eagerSpecs.map(tool => ({
			namespace: null,
			name: tool.name,
			inputSchema: tool.inputSchema,
			deferLoading: false,
		})),
		...deferredSpecs.map(tool => ({
			namespace: CODEX_DEFERRED_TOOL_NAMESPACE,
			name: tool.name,
			inputSchema: tool.inputSchema,
			deferLoading: true,
		})),
	].sort((left, right) => `${left.namespace ?? ""}\0${left.name}`.localeCompare(`${right.namespace ?? ""}\0${right.name}`));

	return { specs, callableNames, deferredNames, runtimeSignatures, skippedNames };
}
