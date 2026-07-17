import * as assert from "assert";

import {
	detectRepeatedToolCallLoop,
	injectToolLoopGuard,
	parseToolArguments,
	ToolCallReliabilityGuard,
	validateToolArguments,
} from "../tools/tool-call-reliability";
import type { OpenAIFunctionToolDef } from "../types";

const tool: OpenAIFunctionToolDef = {
	type: "function",
	function: {
		name: "read_file",
		parameters: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
			additionalProperties: false,
		},
	},
};

suite("tool call reliability", () => {
	test("repairs fenced objects and trailing commas conservatively", () => {
		const parsed = parseToolArguments("```json\n{\"path\":\"README.md\",}\n```", true);
		assert.deepStrictEqual(parsed, { ok: true, value: { path: "README.md" }, repaired: true });
	});

	test("does not repair incomplete JSON before the final chunk", () => {
		assert.deepStrictEqual(parseToolArguments('{"path":"README', false), { ok: false, pending: true });
	});

	test("validates required and additional properties", () => {
		assert.deepStrictEqual(validateToolArguments({ path: "README.md" }, tool.function.parameters), []);
		assert.ok(validateToolArguments({ extra: true }, tool.function.parameters).some(issue => issue.includes("required")));
		assert.ok(validateToolArguments({ path: "README.md", extra: true }, tool.function.parameters).some(issue => issue.includes("not allowed")));
	});

	test("validates common JSON Schema constraints", () => {
		const schema = {
			type: "object",
			properties: {
				mode: { const: "safe" },
				count: { type: "integer", minimum: 1, maximum: 3 },
				name: { type: "string", minLength: 3, pattern: "^[a-z]+$" },
				items: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string" } },
			},
			required: ["mode", "count", "name", "items"],
		};
		assert.deepStrictEqual(validateToolArguments({
			mode: "safe",
			count: 2,
			name: "valid",
			items: ["a", "b"],
		}, schema), []);
		const issues = validateToolArguments({
			mode: "unsafe",
			count: 4,
			name: "X",
			items: ["a", "a"],
		}, schema);
		assert.ok(issues.some(issue => issue.includes("constant")));
		assert.ok(issues.some(issue => issue.includes("maximum")));
		assert.ok(issues.some(issue => issue.includes("minimum length")));
		assert.ok(issues.some(issue => issue.includes("unique")));
	});

	test("repairs tool-name casing and records metrics", () => {
		const guard = new ToolCallReliabilityGuard();
		guard.configure([tool], { repairEnabled: true, validateSchema: true });
		const result = guard.evaluate("READ_FILE", '{"path":"README.md"}', true);
		assert.ok(result.ok);
		assert.strictEqual(result.ok && result.name, "read_file");
		assert.deepStrictEqual(guard.consumeMetrics(), {
			accepted: 1,
			repaired: 1,
			rejected: 0,
			unknownTool: 0,
			schemaRejected: 0,
			loopDetected: false,
		});
	});

	test("rejects unknown tools and invalid schemas", () => {
		const guard = new ToolCallReliabilityGuard();
		guard.configure([tool], { repairEnabled: true, validateSchema: true });
		const unknown = guard.evaluate("delete_everything", "{}", true);
		const invalid = guard.evaluate("read_file", "{}", true);
		assert.ok(!unknown.ok && !unknown.pending && unknown.kind === "unknown_tool");
		assert.ok(!invalid.ok && !invalid.pending && invalid.kind === "schema");
	});

	test("rejects calls when the request advertised no tools", () => {
		const guard = new ToolCallReliabilityGuard();
		guard.configure([], { repairEnabled: true, validateSchema: true });
		const result = guard.evaluate("read_file", "{}", true);
		assert.ok(!result.ok && !result.pending && result.kind === "unknown_tool");
	});

	test("detects only consecutive identical tool-call loops", () => {
		const calls = Array.from({ length: 3 }, (_, index) => ({
			role: "assistant" as const,
			content: "",
			tool_calls: [{
				id: `call-${index}`,
				type: "function" as const,
				function: { name: "read_file", arguments: '{"path":"README.md"}' },
			}],
		}));
		const detected = detectRepeatedToolCallLoop(calls, 3);
		assert.strictEqual(detected?.toolName, "read_file");
		assert.strictEqual(detected?.repetitions, 3);
		const guarded = injectToolLoopGuard(calls, detected);
		assert.strictEqual(guarded.at(-1)?.role, "user");
		assert.ok(String(guarded.at(-1)?.content).includes("Do not repeat"));
	});
});
