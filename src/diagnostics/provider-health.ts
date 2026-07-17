export type HealthCheckStatus = "pass" | "warning" | "fail" | "info";

export interface HealthCheckItem {
	id: string;
	label: string;
	status: HealthCheckStatus;
	detail: string;
}

export interface ProviderHealthSourceReport {
	key: string;
	label: string;
	serverUrl: string;
	modelIds: string[];
	checks: HealthCheckItem[];
}

export interface ProviderHealthReport {
	generatedAt: string;
	extensionVersion: string;
	vscodeVersion: string;
	overallStatus: Exclude<HealthCheckStatus, "info">;
	configurationChecks: HealthCheckItem[];
	sources: ProviderHealthSourceReport[];
}

export function calculateOverallHealth(items: readonly HealthCheckItem[]): ProviderHealthReport["overallStatus"] {
	if (items.some(item => item.status === "fail")) {
		return "fail";
	}
	if (items.some(item => item.status === "warning")) {
		return "warning";
	}
	return "pass";
}

function statusLabel(status: HealthCheckStatus): string {
	return status === "pass" ? "PASS" : status === "warning" ? "WARN" : status === "fail" ? "FAIL" : "INFO";
}

export function renderProviderHealthMarkdown(report: ProviderHealthReport): string {
	const lines = [
		"# Local LLM Provider Health Check",
		"",
		`Generated: ${report.generatedAt}`,
		`Extension: ${report.extensionVersion}`,
		`VS Code: ${report.vscodeVersion}`,
		`Overall: ${report.overallStatus.toUpperCase()}`,
		"",
		"## Configuration",
		"",
		"| Status | Check | Detail |",
		"| --- | --- | --- |",
		...report.configurationChecks.map(item =>
			`| ${statusLabel(item.status)} | ${item.label.replace(/\|/g, "\\|")} | ${item.detail.replace(/\|/g, "\\|")} |`
		),
	];

	for (const source of report.sources) {
		lines.push(
			"",
			`## ${source.label}`,
			"",
			`Endpoint: ${source.serverUrl}`,
			`Models: ${source.modelIds.length > 0 ? source.modelIds.join(", ") : "none"}`,
			"",
			"| Status | Check | Detail |",
			"| --- | --- | --- |",
			...source.checks.map(item =>
				`| ${statusLabel(item.status)} | ${item.label.replace(/\|/g, "\\|")} | ${item.detail.replace(/\|/g, "\\|")} |`
			)
		);
	}

	lines.push(
		"",
		"## Interpretation",
		"",
		"- FAIL means the source cannot currently be used reliably.",
		"- WARN means the source works with a fallback or has a configuration risk.",
		"- INFO records provider-specific behavior that is expected and does not require action.",
		""
	);
	return lines.join("\n");
}
