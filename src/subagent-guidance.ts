export type SubagentProvider = "local" | "deepseek" | "codex" | "claude";

export interface SubagentModelProfile {
	id: string;
	label: string;
	provider: SubagentProvider;
	defaultEffort?: string;
	useWhen: string;
	availability?: "available" | "unavailable" | "unknown";
	availabilityReason?: string;
	availabilityCheckedAt?: number;
	unavailableUntil?: string;
}

const catalogs = new Map<SubagentProvider, SubagentModelProfile[]>();
const excludedSubagentModels = new Map<SubagentProvider, ReadonlySet<string>>([
	["codex", new Set(["gpt-5.6-sol"])],
	["claude", new Set(["claude-fable-5"])],
]);

function isEligibleSubagentProfile(profile: SubagentModelProfile): boolean {
	const modelId = profile.id.toLowerCase().split("::").at(-1) ?? profile.id.toLowerCase();
	return !excludedSubagentModels.get(profile.provider)?.has(modelId);
}

export function setSubagentModelProfiles(
	provider: SubagentProvider,
	profiles: readonly SubagentModelProfile[]
): void {
	const unique = new Map(profiles
		.filter(isEligibleSubagentProfile)
		.map(profile => [profile.id, profile]));
	catalogs.set(provider, [...unique.values()].sort((left, right) => left.label.localeCompare(right.label)));
}

export function getSubagentModelProfiles(): SubagentModelProfile[] {
	return ["local", "deepseek", "codex", "claude"]
		.flatMap(provider => catalogs.get(provider as SubagentProvider) ?? []);
}

export function isSubagentToolName(name: string): boolean {
	const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");
	return normalized === "runsubagent"
		|| normalized === "executionsubagent"
		|| normalized === "exploresubagent";
}

export function buildSubagentToolGuidance(): string {
	const profiles = getSubagentModelProfiles();
	const profileText = profiles.length > 0
		? profiles.map(profile => {
			const effort = profile.defaultEffort ? `, ${profile.defaultEffort} thinking` : "";
			return `${profile.label} [${profile.id}${effort}]: ${profile.useWhen}`;
		}).join(" ")
		: "Qwen/local: narrow economical tasks. DeepSeek V4 Pro (high): focused complex tasks. Codex (high): repository-wide and multi-step coding.";
	return [
		"Subagent model routing:",
		profileText,
		"Availability is enforced when the subagent starts; if the selected model is rejected, route to another current model-picker value.",
		"Without runSubagent.model, the general-purpose subagent inherits the parent model and system prompt.",
		"agentName selects behaviour/custom instructions independently of model. To switch model/provider, set runSubagent.model to the exact model-picker string (e.g. 'GPT-5.6 Codex'), never a profile id.",
		"Require one bounded, independently verifiable task, explicit allowed files, and expected output.",
	].join(" ");
}

export function enhanceSubagentToolDescription(name: string, description: string): string {
	if (!isSubagentToolName(name)) {
		return description;
	}
	return `${description}\n\n${buildSubagentToolGuidance()}`;
}
