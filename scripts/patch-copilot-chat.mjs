import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PATCH_ID = "llama-vscode-chat:copilot-native-model-controls:v5";
const PATCH_MARKER = `/* ${PATCH_ID} */`;
const LEGACY_PATCH_MARKERS = [
	"/* llama-vscode-chat:copilot-native-model-controls:v4 */",
	"/* llama-vscode-chat:copilot-native-model-controls:v3 */",
	"/* llama-vscode-chat:copilot-native-model-controls:v2 */",
];
const BACKUP_SUFFIX = ".llama-vscode-chat.backup";
const METADATA_SUFFIX = ".llama-vscode-chat.patch.json";

function parseArgs(argv) {
	const result = { action: "status", root: undefined, force: false };
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (["apply", "status", "restore"].includes(value)) {
			result.action = value;
		} else if (value === "--root") {
			result.root = argv[index + 1];
			index += 1;
		} else if (value === "--force") {
			result.force = true;
		} else {
			throw new Error(`Unknown argument: ${value}`);
		}
	}
	return result;
}

function sha256(filePath) {
	return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function addCandidate(candidates, candidate) {
	if (!candidate) {
		return;
	}
	const resolved = path.resolve(candidate);
	for (const variant of [
		resolved,
		path.join(resolved, "extension.js"),
		path.join(resolved, "dist", "extension.js"),
		path.join(resolved, "extensions", "copilot", "dist", "extension.js"),
		path.join(resolved, "resources", "app", "extensions", "copilot", "dist", "extension.js"),
	]) {
		if (!candidates.includes(variant)) {
			candidates.push(variant);
		}
	}
}

function addCodeInstallationCandidates(candidates, codeCommandPath) {
	if (!codeCommandPath || !fs.existsSync(codeCommandPath)) {
		return;
	}
	const installRoot = path.dirname(path.dirname(codeCommandPath));
	addCandidate(candidates, installRoot);

	const commandText = fs.readFileSync(codeCommandPath, "utf8");
	const versionDir = commandText.match(/\.\.\\([^\\"/]+)\\resources\\app\\out\\cli\.js/i)?.[1];
	if (versionDir) {
		addCandidate(candidates, path.join(installRoot, versionDir));
	}

	for (const entry of fs.readdirSync(installRoot, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			addCandidate(candidates, path.join(installRoot, entry.name));
		}
	}
}

function findCopilotBundle(explicitRoot) {
	const candidates = [];
	addCandidate(candidates, explicitRoot);

	if (process.platform === "win32") {
		try {
			const output = execFileSync("where.exe", ["code.cmd"], { encoding: "utf8" });
			for (const commandPath of output.split(/\r?\n/).filter(Boolean)) {
				addCodeInstallationCandidates(candidates, commandPath.trim());
			}
		} catch {
			// An explicit --root can still locate portable/test installations.
		}
	}

	for (const candidate of candidates) {
		if (path.basename(candidate) === "extension.js" && fs.existsSync(candidate)) {
			const packagePath = path.resolve(path.dirname(candidate), "..", "package.json");
			if (fs.existsSync(packagePath)) {
				const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
				if (manifest.name === "copilot-chat") {
					return { bundlePath: candidate, packagePath, manifest };
				}
			}
		}
	}

	throw new Error("Could not locate the bundled Copilot Chat extension. Pass --root <VS Code app root>.");
}

function replaceOnce(source, search, replacement, description) {
	const first = source.indexOf(search);
	if (first < 0) {
		throw new Error(`Copilot bundle shape changed: ${description} was not found.`);
	}
	if (source.indexOf(search, first + search.length) >= 0) {
		throw new Error(`Copilot bundle shape changed: ${description} is not unique.`);
	}
	return source.slice(0, first) + replacement + source.slice(first + search.length);
}

function replacePatternOnce(source, pattern, replacement, description) {
	const flags = pattern.flags.replaceAll("g", "");
	const matcher = new RegExp(pattern.source, flags);
	const first = matcher.exec(source);
	if (!first || first.index === undefined) {
		throw new Error(`Copilot bundle shape changed: ${description} was not found.`);
	}
	const tail = source.slice(first.index + first[0].length);
	if (matcher.test(tail)) {
		throw new Error(`Copilot bundle shape changed: ${description} is not unique.`);
	}
	const replaced = first[0].replace(new RegExp(pattern.source, flags), replacement);
	return source.slice(0, first.index) + replaced + source.slice(first.index + first[0].length);
}

function patchExtensionEndpointClass(source) {
	if (source.includes(PATCH_MARKER)) {
		return source;
	}

	const errorMarker = "processResponseFromChatEndpoint not supported for extension contributed endpoints";
	const markerIndex = source.indexOf(errorMarker);
	if (markerIndex < 0) {
		throw new Error("Copilot extension endpoint wrapper was not found.");
	}

	const classStart = source.lastIndexOf("var ", markerIndex);
	const classHeader = source.slice(classStart, markerIndex).match(/^var ([A-Za-z_$][\w$]*)=class\{/);
	if (classStart < 0 || !classHeader) {
		throw new Error("Could not identify the Copilot extension endpoint class.");
	}
	const className = classHeader[1];
	const classEnd = source.indexOf(`};${className}=`, markerIndex);
	if (classEnd < 0) {
		throw new Error("Could not identify the end of the Copilot extension endpoint class.");
	}

	let classSource = source.slice(classStart, classEnd + 1);
	const promptTokensAnchor = "get modelMaxPromptTokens(){return this._maxTokens}";
	const promptTokensReplacement =
		'get modelMaxPromptTokens(){return this.languageModel.vendor==="llamacpp"?' +
		'this._maxTokens+(this.languageModel.maxOutputTokens??0):this._maxTokens}';
	classSource = replaceOnce(
		classSource,
		promptTokensAnchor,
		promptTokensReplacement,
		"extension endpoint full context budget"
	);

	const outputTokensAnchor = "get maxOutputTokens(){return 8192}";
	const outputTokensReplacement =
		'get maxOutputTokens(){return this.languageModel.vendor==="llamacpp"?' +
		'this.languageModel.maxOutputTokens??8192:8192}';
	classSource = replaceOnce(
		classSource,
		outputTokensAnchor,
		outputTokensReplacement,
		"extension endpoint output token limit"
	);

	const getterAnchor = 'get supportsPrediction(){return!1}get policy(){return"enabled"}';
	const getterReplacement =
		`${PATCH_MARKER}get supportsPrediction(){return!1}` +
		'get supportsReasoningEffort(){if(this.languageModel.vendor!=="llamacpp")return;' +
		'let e=(this.languageModel.family||"").toLowerCase();' +
		'return e.includes("deepseek")?["high","max"]:["none","low","medium","high"]}' +
		'get policy(){return"enabled"}';
	classSource = replaceOnce(classSource, getterAnchor, getterReplacement, "extension endpoint capability getters");

	const methodSignature = /async makeChatRequest2\(\{([^{}]*\btelemetryProperties:[A-Za-z_$][\w$]*)([^{}]*)\},([A-Za-z_$][\w$]*)\)\{/;
	const signatureMatch = classSource.match(methodSignature);
	if (!signatureMatch) {
		throw new Error("Copilot extension endpoint request signature was not found.");
	}
	if (/\bmodelCapabilities:/.test(signatureMatch[1] + signatureMatch[2])) {
		throw new Error("Copilot request signature already contains modelCapabilities without this patch marker.");
	}
	classSource = classSource.replace(
		methodSignature,
		`async makeChatRequest2({${signatureMatch[1]}${signatureMatch[2]},modelCapabilities:__llamaModelCapabilities},${signatureMatch[3]}){`
	);

	const modelOptionsAnchor = "modelOptions:{";
	const modelOptionsReplacement =
		"modelOptions:{...(__llamaModelCapabilities?.reasoningEffort?" +
		"{reasoningEffort:__llamaModelCapabilities.reasoningEffort}:{}),";
	classSource = replaceOnce(
		classSource,
		modelOptionsAnchor,
		modelOptionsReplacement,
		"extension endpoint modelOptions"
	);

	const cloneAnchor =
		"cloneWithTokenOverride(e){return this._instantiationService.createInstance(" +
		`${className},{...this.languageModel,maxInputTokens:e})}`;
	const cloneReplacement =
		'cloneWithTokenOverride(e){let t=this.languageModel.vendor==="llamacpp"?' +
		'Math.max(1,e-(this.languageModel.maxOutputTokens??0)):e;return this._instantiationService.createInstance(' +
		`${className},{...this.languageModel,maxInputTokens:t})}`;
	classSource = replaceOnce(
		classSource,
		cloneAnchor,
		cloneReplacement,
		"extension endpoint token override"
	);

	let patched = source.slice(0, classStart) + classSource + source.slice(classEnd + 1);
	patched = replacePatternOnce(
		patched,
		/([A-Za-z_$][\w$]*)=t\.tools\?\.availableTools,([A-Za-z_$][\w$]*)=!!this\.endpoint\.supportsToolSearch,([A-Za-z_$][\w$]*)=\1\?\.length\?await this\.endpoint\.acquireTokenizer\(\)\.countToolTokens\(\1\):0/,
		'$1=t.tools?.availableTools,$2=!!this.endpoint.supportsToolSearch,$3=this.endpoint.modelProvider==="llamacpp"?0:$1?.length?await this.endpoint.acquireTokenizer().countToolTokens($1):0',
		"extension endpoint host tool reservation"
	);
	patched = replacePatternOnce(
		patched,
		/([A-Za-z_$][\w$]*)=typeof ([A-Za-z_$][\w$]*)=="number"&&\2<this\.endpoint\.modelMaxPromptTokens\?\2:this\.endpoint\.modelMaxPromptTokens/,
		'$1=this.endpoint.modelProvider==="llamacpp"?this.endpoint.modelMaxPromptTokens:typeof $2=="number"&&$2<this.endpoint.modelMaxPromptTokens?$2:this.endpoint.modelMaxPromptTokens',
		"extension endpoint session context override"
	);
	patched = replacePatternOnce(
		patched,
		/([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\.Advanced\.SummarizeAgentConversationHistoryThreshold\.id\),([A-Za-z_$][\w$]*)=Math\.min\(\1\?\?\4,\4\)/,
		'$1=$2($3,$4,$5.Advanced.SummarizeAgentConversationHistoryThreshold.id),$6=this.endpoint.modelProvider==="llamacpp"?$4:Math.min($1??$4,$4)',
		"extension endpoint summarization threshold"
	);
	patched = replaceOnce(
		patched,
		'B=_?this._getOrCreateBackgroundSummarizer(t.conversation?.sessionId):void 0',
		'B=_&&this.endpoint.modelProvider!=="llamacpp"?this._getOrCreateBackgroundSummarizer(t.conversation?.sessionId):void 0',
		"extension endpoint background compaction"
	);
	return patched;
}

function printStatus(target) {
	const backupPath = target.bundlePath + BACKUP_SUFFIX;
	console.log(`Copilot Chat: ${target.manifest.version ?? "unknown"}`);
	console.log(`Bundle: ${target.bundlePath}`);
	console.log(`Patch: ${fs.readFileSync(target.bundlePath, "utf8").includes(PATCH_MARKER) ? "applied" : "not applied"}`);
	console.log(`Backup: ${fs.existsSync(backupPath) ? backupPath : "not found"}`);
	console.log(`SHA-256: ${sha256(target.bundlePath)}`);
}

function applyPatch(target, force) {
	const backupPath = target.bundlePath + BACKUP_SUFFIX;
	const metadataPath = target.bundlePath + METADATA_SUFFIX;
	const installed = fs.readFileSync(target.bundlePath, "utf8");
	if (installed.includes(PATCH_MARKER)) {
		console.log("Copilot Chat patch is already applied.");
		printStatus(target);
		return;
	}
	const upgradingLegacyPatch = LEGACY_PATCH_MARKERS.some(marker => installed.includes(marker));
	if (upgradingLegacyPatch && !fs.existsSync(backupPath)) {
		throw new Error("Cannot upgrade the legacy Copilot patch because its original bundle backup is missing.");
	}
	const original = upgradingLegacyPatch ? fs.readFileSync(backupPath, "utf8") : installed;

	if (fs.existsSync(backupPath) && !force && !upgradingLegacyPatch) {
		throw new Error(`Backup already exists: ${backupPath}. Restore it first or use --force after inspecting it.`);
	}

	const patched = patchExtensionEndpointClass(original);
	const validationPath = target.bundlePath + ".llama-vscode-chat.tmp.js";
	fs.writeFileSync(validationPath, patched);
	const validation = spawnSync(process.execPath, ["--check", validationPath], { encoding: "utf8" });
	fs.rmSync(validationPath, { force: true });
	if (validation.status !== 0) {
		throw new Error(`Patched Copilot bundle failed syntax validation:\n${validation.stderr || validation.stdout}`);
	}

	if (!fs.existsSync(backupPath) || (force && !upgradingLegacyPatch)) {
		fs.copyFileSync(target.bundlePath, backupPath);
	}
	fs.writeFileSync(target.bundlePath, patched);
	fs.writeFileSync(
		metadataPath,
		JSON.stringify(
			{
				patchId: PATCH_ID,
				copilotVersion: target.manifest.version,
				appliedAt: new Date().toISOString(),
				originalSha256: sha256(backupPath),
				patchedSha256: sha256(target.bundlePath),
			},
			null,
			2
		) + "\n"
	);

	console.log("Applied native model controls patch. Reload all VS Code windows to activate it.");
	printStatus(target);
}

function restorePatch(target) {
	const backupPath = target.bundlePath + BACKUP_SUFFIX;
	const metadataPath = target.bundlePath + METADATA_SUFFIX;
	if (!fs.existsSync(backupPath)) {
		throw new Error(`Backup not found: ${backupPath}`);
	}
	fs.copyFileSync(backupPath, target.bundlePath);
	fs.rmSync(backupPath, { force: true });
	fs.rmSync(metadataPath, { force: true });
	console.log("Restored the original Copilot Chat bundle. Reload all VS Code windows to activate it.");
	printStatus(target);
}

const args = parseArgs(process.argv.slice(2));
const target = findCopilotBundle(args.root);
if (args.action === "apply") {
	applyPatch(target, args.force);
} else if (args.action === "restore") {
	restorePatch(target);
} else {
	printStatus(target);
}
