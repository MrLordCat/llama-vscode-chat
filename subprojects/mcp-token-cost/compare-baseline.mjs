#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = { before: "", after: "" };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--before" && argv[i + 1]) {
      args.before = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--after" && argv[i + 1]) {
      args.after = argv[i + 1];
      i += 1;
      continue;
    }
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), filePath), "utf8"));
}

function pctDelta(before, after) {
  if (!Number.isFinite(before) || before === 0) return 0;
  return ((after - before) / before) * 100;
}

function out(name, before, after) {
  const abs = after - before;
  const pct = pctDelta(before, after);
  const sign = abs > 0 ? "+" : "";
  console.log(`${name}: ${before} -> ${after} (${sign}${abs.toFixed(2)}, ${sign}${pct.toFixed(2)}%)`);
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.before || !args.after) {
    console.error("Usage: node subprojects/mcp-token-cost/compare-baseline.mjs --before <path> --after <path>");
    process.exit(1);
  }

  const before = readJson(args.before);
  const after = readJson(args.after);

  console.log("Token baseline comparison");
  out("Avg total tokens/turn", before.summary.estimatedTotalTokens.avg, after.summary.estimatedTotalTokens.avg);
  out("Median total tokens/turn", before.summary.estimatedTotalTokens.median, after.summary.estimatedTotalTokens.median);
  out("P95 total tokens/turn", before.summary.estimatedTotalTokens.p95, after.summary.estimatedTotalTokens.p95);
  out("Avg input tokens/turn", before.summary.estimatedInputTokens.avg, after.summary.estimatedInputTokens.avg);
  out("Avg output tokens/turn", before.summary.estimatedOutputTokens.avg, after.summary.estimatedOutputTokens.avg);
  out("Avg attempts/turn", before.summary.avgAttempts, after.summary.avgAttempts);
  out("Auto-compact rate %", before.summary.autoCompactRatePct, after.summary.autoCompactRatePct);
  out("Hard-compact rate %", before.summary.hardCompactRatePct, after.summary.hardCompactRatePct);
}

main();
