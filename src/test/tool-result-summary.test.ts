import * as assert from "node:assert";
import { summarizeToolCallArguments, summarizeToolResultContent } from "../context/tool-result-summary";

suite("tool result summaries", () => {
	test("preserves useful JSON metadata without secrets", () => {
		const summary = summarizeToolResultContent(JSON.stringify({
			filePath: "src/provider.ts",
			status: "modified",
			count: 12,
			token: "do-not-copy",
			items: [1, 2, 3],
		}));
		assert.match(summary, /filePath="src\/provider\.ts"/);
		assert.match(summary, /status="modified"/);
		assert.doesNotMatch(summary, /do-not-copy/);
	});

	test("retains errors and tail lines from text output", () => {
		const summary = summarizeToolResultContent([
			"building project",
			"step one",
			"warning: deprecated option",
			"error TS1234 at src/main.ts:10",
			"process exited with code 1",
		].join("\n"));
		assert.match(summary, /warning: deprecated option/);
		assert.match(summary, /error TS1234/);
		assert.match(summary, /exited with code 1/);
	});

	test("summarizes tool arguments and redacts credential fields", () => {
		const summary = summarizeToolCallArguments(JSON.stringify({
			filePath: "README.md",
			startLine: 10,
			apiKey: "secret",
		}));
		assert.match(summary, /filePath="README\.md"/);
		assert.match(summary, /startLine=10/);
		assert.doesNotMatch(summary, /secret/);
	});
});
