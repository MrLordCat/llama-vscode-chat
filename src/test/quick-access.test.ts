import * as assert from "assert";
import * as vscode from "vscode";

import {
	formatEndpointLabel,
	LlamaQuickActionsProvider,
	type QuickAccessItem,
} from "../ui/quick-access";

function labelOf(item: QuickAccessItem): string {
	return typeof item.label === "string" ? item.label : item.label?.label ?? "";
}

async function getItems(
	provider: LlamaQuickActionsProvider,
	parent?: QuickAccessItem
): Promise<QuickAccessItem[]> {
	const result = await Promise.resolve(provider.getChildren(parent));
	return result ?? [];
}

suite("quick access", () => {
	test("formats endpoint labels without protocol noise", () => {
		assert.strictEqual(formatEndpointLabel("http://localhost:8000"), "localhost:8000");
		assert.strictEqual(formatEndpointLabel("https://api.deepseek.com/v1/"), "api.deepseek.com/v1");
		assert.strictEqual(formatEndpointLabel("not a URL"), "not a URL");
	});

	test("uses four stable groups instead of a flat command list", async () => {
		const provider = new LlamaQuickActionsProvider(
			() => "24.5 tok/s",
			() => ({ summary: "61.0% (30,000/49,152)", breakdown: "msg 20,000 + tools 2,000 + reserved 8,000" }),
			() => 3
		);
		const root = await getItems(provider);

		assert.deepStrictEqual(root.map(labelOf), ["Connections", "Model Behavior", "Memory", "Diagnostics"]);
		assert.strictEqual(root[0].collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
		assert.strictEqual(root[1].collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
		assert.strictEqual(root[2].collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
		assert.strictEqual(root[3].collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
		assert.ok(root.every(item => item.id?.startsWith("llamacpp.quickAccess.")));
	});

	test("keeps detailed diagnostics inside the collapsed group", async () => {
		const provider = new LlamaQuickActionsProvider(
			() => "24.5 tok/s",
			() => ({ summary: "61.0%", breakdown: "msg 20K + tools 2K + reserved 8K" }),
			() => 0,
			() => "75.0% (75/100)"
		);
		const diagnostics = (await getItems(provider)).find(item => labelOf(item) === "Diagnostics");
		assert.ok(diagnostics);

		const children = await getItems(provider, diagnostics);
		assert.ok(children.some(item => labelOf(item) === "Throughput"));
		assert.ok(children.some(item => labelOf(item) === "Context Usage"));
		assert.strictEqual(children.find(item => labelOf(item) === "Prompt Cache")?.description, "75.0% (75/100)");
		assert.ok(!children.some(item => labelOf(item) === "Context Breakdown"));
		assert.strictEqual(
			children.find(item => labelOf(item) === "Context Usage")?.tooltip,
			"msg 20K + tools 2K + reserved 8K"
		);
	});

	test("exposes knowledge verification with the other model controls", async () => {
		const provider = new LlamaQuickActionsProvider(() => undefined, () => undefined, () => 0);
		const modelBehavior = (await getItems(provider)).find(item => labelOf(item) === "Model Behavior");
		assert.ok(modelBehavior);

		const children = await getItems(provider, modelBehavior);
		const knowledge = children.find(item => labelOf(item) === "Knowledge Verification");
		assert.ok(knowledge);
		assert.strictEqual(knowledge.command?.command, "llamacpp.setKnowledgeMode");
	});
});
