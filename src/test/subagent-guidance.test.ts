import * as assert from "assert";

import {
	buildSubagentToolGuidance,
	enhanceSubagentToolDescription,
	getSubagentModelProfiles,
	setSubagentModelProfiles,
} from "../subagent-guidance";

suite("subagent model guidance", () => {
	test("explains native model inheritance and preferred routing profiles", () => {
		setSubagentModelProfiles("local", [{
			id: "local::qwen3-coder",
			label: "Qwen 3 Coder",
			provider: "local",
			useWhen: "Narrow economical tasks",
		}]);
		setSubagentModelProfiles("deepseek", [{
			id: "deepseek::deepseek-v4-pro",
			label: "DeepSeek V4 Pro",
			provider: "deepseek",
			defaultEffort: "high",
			useWhen: "Focused complex tasks",
		}]);
		setSubagentModelProfiles("codex", [{
			id: "gpt-5.6-codex",
			label: "GPT-5.6 Codex",
			provider: "codex",
			defaultEffort: "high",
			useWhen: "Repository-wide work",
		}]);

		const guidance = buildSubagentToolGuidance();
		assert.ok(guidance.includes("DeepSeek V4 Pro [deepseek::deepseek-v4-pro, high thinking]"));
		assert.ok(guidance.includes("GPT-5.6 Codex [gpt-5.6-codex, high thinking]"));
		assert.ok(guidance.includes("Budget routing policy"));
		assert.ok(guidance.includes("Never omit runSubagent.model and never select a Copilot built-in or free-tier model"));
		assert.ok(!guidance.includes("Without runSubagent.model, the general-purpose subagent inherits the parent model"));
		assert.ok(guidance.includes("agentName selects behaviour/custom instructions independently of model"));
		assert.ok(guidance.includes("always set runSubagent.model to the exact model-picker string"));
		assert.ok(guidance.includes("never a profile id"));
		assert.ok(guidance.includes("one bounded, independently verifiable task"));
		assert.ok(guidance.includes("explicit allowed files"));
		assert.ok(guidance.includes("expected output"));
	});

	test("augments only subagent tool descriptions", () => {
		assert.ok(enhanceSubagentToolDescription("runSubagent", "Run an agent").includes("Subagent model routing"));
		assert.strictEqual(enhanceSubagentToolDescription("read_file", "Read a file"), "Read a file");
	});

	test("keeps model-visible guidance stable when availability changes", () => {
		setSubagentModelProfiles("claude", [{
			id: "claude-opus-4-8",
			label: "Opus 4.8 (Claude)",
			provider: "claude",
			defaultEffort: "high",
			useWhen: "Complex coding model",
			availability: "unavailable",
			availabilityReason: "5-hour limit 100%",
			unavailableUntil: "2026-07-19T10:50:00.000Z",
		}]);
		const unavailableGuidance = buildSubagentToolGuidance();
		setSubagentModelProfiles("claude", [{
			id: "claude-opus-4-8",
			label: "Opus 4.8 (Claude)",
			provider: "claude",
			defaultEffort: "high",
			useWhen: "Complex coding model",
			availability: "available",
			availabilityReason: "Subscription limit reset",
		}]);
		const availableGuidance = buildSubagentToolGuidance();
		assert.strictEqual(unavailableGuidance, availableGuidance);
		assert.ok(availableGuidance.includes("Opus 4.8 (Claude) [claude-opus-4-8, high thinking]"));
		assert.ok(!availableGuidance.includes("5-hour limit"));
		assert.ok(!availableGuidance.includes("Subscription limit reset"));
	});

	test("excludes Sol and Fable from subagent routing only", () => {
		setSubagentModelProfiles("codex", [
			{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol", provider: "codex", useWhen: "Large tasks" },
			{ id: "gpt-5.6-luna", label: "GPT-5.6 Luna", provider: "codex", useWhen: "Subagent tasks" },
		]);
		setSubagentModelProfiles("claude", [
			{ id: "claude-fable-5", label: "Fable 5", provider: "claude", useWhen: "Large tasks" },
			{ id: "claude-opus-4-8", label: "Opus 4.8", provider: "claude", useWhen: "Subagent tasks" },
		]);
		const profiles = getSubagentModelProfiles();
		assert.ok(!profiles.some(profile => profile.id === "gpt-5.6-sol"));
		assert.ok(!profiles.some(profile => profile.id === "claude-fable-5"));
		assert.ok(profiles.some(profile => profile.id === "gpt-5.6-luna"));
		assert.ok(profiles.some(profile => profile.id === "claude-opus-4-8"));
		const guidance = buildSubagentToolGuidance();
		assert.ok(!guidance.includes("GPT-5.6 Sol"));
		assert.ok(!guidance.includes("Fable 5"));
	});

	test("orders budget tiers from cheapest local to premium subscription", () => {
		setSubagentModelProfiles("local", [{
			id: "local::qwen3-coder", label: "Qwen 3 Coder", provider: "local", useWhen: "Narrow tasks",
		}]);
		setSubagentModelProfiles("deepseek", [{
			id: "deepseek::deepseek-v4-pro", label: "DeepSeek V4 Pro", provider: "deepseek", defaultEffort: "high", useWhen: "Complex tasks",
		}]);
		setSubagentModelProfiles("codex", [{
			id: "gpt-5.6-codex", label: "GPT-5.6 Codex", provider: "codex", defaultEffort: "high", useWhen: "Repo work",
		}]);
		setSubagentModelProfiles("claude", []);
		const guidance = buildSubagentToolGuidance();
		const cheapest = guidance.indexOf("cheapest —");
		const mid = guidance.indexOf("mid —");
		const premium = guidance.indexOf("premium —");
		assert.ok(cheapest >= 0 && mid > cheapest && premium > mid);
	});

	test("omits budget policy when only one cost tier is available", () => {
		setSubagentModelProfiles("local", []);
		setSubagentModelProfiles("deepseek", []);
		setSubagentModelProfiles("codex", [{
			id: "gpt-5.6-codex", label: "GPT-5.6 Codex", provider: "codex", defaultEffort: "high", useWhen: "Repo work",
		}]);
		setSubagentModelProfiles("claude", []);
		const guidance = buildSubagentToolGuidance();
		assert.ok(!guidance.includes("Budget routing policy"));
		assert.ok(guidance.includes("Never omit runSubagent.model and never select a Copilot built-in or free-tier model"));
	});

	test("includes vision delegation guidance when a local model is available", () => {
		setSubagentModelProfiles("local", [{
			id: "local::qwen3-coder", label: "Qwen 3 Coder", provider: "local", useWhen: "Narrow tasks",
		}]);
		setSubagentModelProfiles("deepseek", []);
		setSubagentModelProfiles("codex", []);
		setSubagentModelProfiles("claude", []);
		const guidance = buildSubagentToolGuidance();
		assert.ok(guidance.includes("Vision delegation:"));
		assert.ok(guidance.includes("The subagent has access to view_image and terminal tools"));
		assert.ok(guidance.includes("Use agentName 'Explore' or any available agent type with a local model"));
	});

	test("omits vision delegation guidance when no local model is available", () => {
		setSubagentModelProfiles("local", []);
		setSubagentModelProfiles("deepseek", [{
			id: "deepseek::deepseek-v4-pro", label: "DeepSeek V4 Pro", provider: "deepseek", defaultEffort: "high", useWhen: "Complex tasks",
		}]);
		setSubagentModelProfiles("codex", []);
		setSubagentModelProfiles("claude", []);
		const guidance = buildSubagentToolGuidance();
		assert.ok(!guidance.includes("Vision delegation:"));
	});
});
