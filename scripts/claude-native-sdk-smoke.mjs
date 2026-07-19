import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const executable = process.argv.slice(2).find(argument => !argument.startsWith("--")) || findBundledClaude();
const model = process.argv.find(argument => argument.startsWith("--model="))?.slice("--model=".length)
	|| "claude-haiku-4-5";
if (!executable) {
	throw new Error("Usage: node scripts/claude-native-sdk-smoke.mjs <claude-executable>");
}

function findBundledClaude() {
	const roots = [
		join(homedir(), ".vscode", "extensions"),
		join(homedir(), ".vscode-server", "extensions"),
	];
	for (const root of roots) {
		if (!existsSync(root)) {
			continue;
		}
		const candidates = readdirSync(root)
			.filter(name => name.startsWith("anthropic.claude-code-"))
			.sort()
			.reverse();
		for (const candidate of candidates) {
			const binary = join(
				root,
				candidate,
				"resources",
				"native-binary",
				process.platform === "win32" ? "claude.exe" : "claude"
			);
			if (existsSync(binary)) {
				return binary;
			}
		}
	}
	return undefined;
}

class InputQueue {
	#values = [];
	#waiters = [];
	#closed = false;
	push(value) {
		if (this.#closed) {throw new Error("Input queue is closed");}
		const waiter = this.#waiters.shift();
		if (waiter) {waiter({ done: false, value });}
		else {this.#values.push(value);}
	}
	close() {
		this.#closed = true;
		for (const waiter of this.#waiters.splice(0)) {
			waiter({ done: true, value: undefined });
		}
	}
	[Symbol.asyncIterator]() {
		return {
			next: async () => {
				const value = this.#values.shift();
				if (value) {return { done: false, value };}
				if (this.#closed) {return { done: true, value: undefined };}
				return new Promise(resolve => this.#waiters.push(resolve));
			},
		};
	}
}

const input = new InputQueue();
let nativeCalls = 0;
const server = createSdkMcpServer({
	name: "vscode",
	version: "smoke",
	tools: [
		tool("native_probe", "Return the supplied value through the host.", {
			value: z.string(),
		}, async ({ value }) => {
			nativeCalls++;
			await new Promise(resolve => globalThis.setTimeout(resolve, 50));
			return { content: [{ type: "text", text: `host-result:${value}` }] };
		}, { alwaysLoad: true }),
	],
});

const stream = query({
	prompt: input,
	options: {
		model,
		pathToClaudeCodeExecutable: executable,
		systemPrompt: "Call the vscode native_probe tool exactly once when requested. Built-in tools are disabled.",
		tools: [],
		mcpServers: { vscode: server },
		strictMcpConfig: true,
		settingSources: [],
		skills: [],
		plugins: [],
		persistSession: false,
		includePartialMessages: false,
		effort: "low",
		canUseTool: async (name, toolInput) => name.startsWith("mcp__vscode__")
			? { behavior: "allow", updatedInput: toolInput }
			: { behavior: "deny", message: `Denied non-VS Code tool: ${name}` },
	},
});

if (process.argv.includes("--usage-only")) {
	const usageTimer = globalThis.setTimeout(() => {
		input.close();
		stream.close();
		console.error(JSON.stringify({ ok: false, reason: "usage timeout" }));
		process.exit(2);
	}, 20_000);
	await stream.initializationResult();
	const [snapshot, context] = await Promise.all([
		stream.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
		stream.getContextUsage(),
	]);
	globalThis.clearTimeout(usageTimer);
	console.log(JSON.stringify({
		ok: true,
		subscriptionType: snapshot.subscription_type,
		rateLimitsAvailable: snapshot.rate_limits_available,
		fiveHour: snapshot.rate_limits?.five_hour,
		sevenDay: snapshot.rate_limits?.seven_day,
		modelScoped: snapshot.rate_limits?.model_scoped,
		context: {
			model: context.model,
			totalTokens: context.totalTokens,
			maxTokens: context.maxTokens,
			rawMaxTokens: context.rawMaxTokens,
			percentage: context.percentage,
		},
	}));
	input.close();
	stream.close();
	process.exit(0);
}

input.push({
	type: "user",
	parent_tool_use_id: null,
	message: {
		role: "user",
		content: [{ type: "text", text: "Call native_probe with value 'native', then answer only OK." }],
	},
});

const timer = globalThis.setTimeout(() => {
	stream.close();
	console.error(JSON.stringify({ ok: false, reason: "timeout", nativeCalls }));
	process.exitCode = 2;
}, 60_000);

const turns = [];
for await (const message of stream) {
	if (message.type !== "result") {continue;}
	const usage = message.usage;
	turns.push({
		subtype: message.subtype,
		result: "result" in message ? message.result : undefined,
		inputTokens: usage.input_tokens,
		outputTokens: usage.output_tokens,
		cacheReadTokens: usage.cache_read_input_tokens,
		cacheCreationTokens: usage.cache_creation_input_tokens,
		numTurns: message.num_turns,
		durationMs: message.duration_ms,
	});
	if (turns.length === 1) {
		input.push({
			type: "user",
			parent_tool_use_id: null,
			message: {
				role: "user",
				content: [{ type: "text", text: "Without calling any tool, answer only WARM." }],
			},
		});
		continue;
	}
	globalThis.clearTimeout(timer);
	const ok = turns[0].subtype === "success"
		&& turns[0].result.includes("OK")
		&& turns[1].subtype === "success"
		&& turns[1].result.includes("WARM")
		&& nativeCalls === 1;
	console.log(JSON.stringify({ ok, nativeCalls, turns }));
	stream.close();
	if (!ok) {process.exitCode = 1;}
	break;
}
