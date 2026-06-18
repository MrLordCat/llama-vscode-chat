#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    input: "logs.log",
    outputJson: "subprojects/mcp-token-cost/baseline/live-snapshot.json",
    outputMd: "subprojects/mcp-token-cost/baseline/live-snapshot.md",
    modelContains: "",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input" && argv[i + 1]) {
      args.input = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--output-json" && argv[i + 1]) {
      args.outputJson = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--output-md" && argv[i + 1]) {
      args.outputMd = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--model-contains" && argv[i + 1]) {
      args.modelContains = argv[i + 1].toLowerCase();
      i += 1;
      continue;
    }
  }

  return args;
}

function parseRecord(line) {
  const trimmed = line.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed);
  } catch {
    if (!trimmed.startsWith("{") && trimmed.startsWith('"ts"')) {
      try {
        return JSON.parse(`{${trimmed}}`);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function inc(map, key, delta = 1) {
  map.set(key, (map.get(key) ?? 0) + delta);
}

function topRows(map, limit = 15) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function extractStreamToolNames(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const out = [];
  const rx = /"function":\{"name":"([^"\\]+)"/g;
  let m;
  while ((m = rx.exec(text)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

function getModelFromRecord(record) {
  const modelId = record?.data?.modelId;
  if (typeof modelId === "string") return modelId;
  const requestModel = record?.data?.requestBody?.model;
  if (typeof requestModel === "string") return requestModel;
  return undefined;
}

function keepByModel(modelContains, modelId) {
  if (!modelContains) return true;
  if (typeof modelId !== "string") return false;
  return modelId.toLowerCase().includes(modelContains);
}

function toMarkdown(result) {
  const lines = [];
  lines.push("# Live Log Snapshot");
  lines.push("");
  lines.push(`Source: ${result.source}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Parsed records: ${result.summary.parsedRecords}`);
  lines.push(`- Invalid lines: ${result.summary.invalidLines}`);
  lines.push(`- Time range: ${result.summary.firstTs ?? "n/a"} -> ${result.summary.lastTs ?? "n/a"}`);
  lines.push(`- Turn starts: ${result.summary.turnStarts}`);
  lines.push(`- Turn completes: ${result.summary.turnCompletes}`);
  lines.push(`- Turn fails: ${result.summary.turnFails}`);
  lines.push(`- In-flight turns: ${result.summary.inFlightTurns}`);
  lines.push(`- Error-like records: ${result.summary.errorLikeRecords}`);
  lines.push(`- Models seen: ${result.summary.modelsSeen.join(", ") || "n/a"}`);
  lines.push(`- Distinct used tools (coverage): ${result.summary.usedToolCount}`);
  lines.push(`- Coverage gate >=20: ${result.summary.usedToolCount >= 20 ? "PASS" : "NOT YET"}`);
  lines.push("");

  lines.push("## Top Used Tools");
  lines.push("");
  lines.push("| tool | signals |");
  lines.push("| --- | ---: |");
  for (const row of result.topUsedTools) {
    lines.push(`| ${row.name} | ${row.count} |`);
  }
  lines.push("");

  lines.push("## Event Distribution");
  lines.push("");
  lines.push("| event | count |");
  lines.push("| --- | ---: |");
  for (const row of result.topEvents) {
    lines.push(`| ${row.name} | ${row.count} |`);
  }
  lines.push("");

  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv);
  const inputPath = path.resolve(process.cwd(), args.input);
  const outJsonPath = path.resolve(process.cwd(), args.outputJson);
  const outMdPath = path.resolve(process.cwd(), args.outputMd);

  if (!fs.existsSync(inputPath)) {
    console.error(`Input log file not found: ${inputPath}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(inputPath, "utf8").split(/\r?\n/);

  const eventCounts = new Map();
  const usedToolCounts = new Map();
  const requestIdToModel = new Map();
  const startedTurns = new Set();
  const completedTurns = new Set();
  const failedTurns = new Set();
  const modelsSeen = new Set();

  let parsedRecords = 0;
  let invalidLines = 0;
  let errorLikeRecords = 0;
  let firstTs;
  let lastTs;

  for (const line of lines) {
    const record = parseRecord(line);
    if (!record) {
      if (line.trim().length > 0) invalidLines += 1;
      continue;
    }

    parsedRecords += 1;
    const ts = typeof record.ts === "string" ? record.ts : undefined;
    if (ts) {
      if (!firstTs || ts < firstTs) firstTs = ts;
      if (!lastTs || ts > lastTs) lastTs = ts;
    }

    const event = typeof record.event === "string" ? record.event : "unknown";
    inc(eventCounts, event, 1);

    const requestId = typeof record?.data?.requestId === "string" ? record.data.requestId : undefined;
    const modelId = getModelFromRecord(record);
    if (requestId && modelId) {
      requestIdToModel.set(requestId, modelId);
      modelsSeen.add(modelId);
    } else if (modelId) {
      modelsSeen.add(modelId);
    }

    const effectiveModel = requestId ? requestIdToModel.get(requestId) ?? modelId : modelId;
    if (!keepByModel(args.modelContains, effectiveModel)) {
      continue;
    }

    const recString = JSON.stringify(record);
    if (/error|failed|exception/i.test(recString)) {
      errorLikeRecords += 1;
    }

    if (event === "chat.turn.start" && requestId) {
      startedTurns.add(requestId);
    }
    if (event === "chat.turn.complete" && requestId) {
      completedTurns.add(requestId);
    }
    if (event === "chat.turn.failed" && requestId) {
      failedTurns.add(requestId);
    }
    if (event === "chat.queue.released" && requestId) {
      // Fallback terminal signal when complete/failed records are missing requestId.
      completedTurns.add(requestId);
    }

    if (event === "chat.request.send") {
      const bodyTools = record?.data?.requestBody?.tools;
      if (Array.isArray(bodyTools)) {
        for (const tool of bodyTools) {
          const name = tool?.function?.name;
          if (typeof name === "string" && name.length > 0) {
            if (!usedToolCounts.has(name)) usedToolCounts.set(name, 0);
          }
        }
      }

      const messages = record?.data?.requestBody?.messages;
      if (Array.isArray(messages)) {
        for (const message of messages) {
          const toolCalls = message?.tool_calls;
          if (!Array.isArray(toolCalls)) continue;
          for (const call of toolCalls) {
            const name = call?.function?.name;
            if (typeof name === "string" && name.length > 0) {
              inc(usedToolCounts, name, 1);
            }
          }
        }
      }
    }

    if (event === "chat.stream.chunk") {
      const text = record?.data?.text;
      const streamTools = extractStreamToolNames(text);
      for (const name of streamTools) {
        inc(usedToolCounts, name, 1);
      }
    }
  }

  const usedPositive = [...usedToolCounts.entries()].filter(([, count]) => count > 0);
  const terminalTurns = new Set([...completedTurns, ...failedTurns]);
  const inFlightTurns = [...startedTurns].filter((id) => !terminalTurns.has(id)).length;

  const result = {
    generatedAt: new Date().toISOString(),
    source: inputPath,
    filter: {
      modelContains: args.modelContains || undefined,
    },
    summary: {
      parsedRecords,
      invalidLines,
      firstTs,
      lastTs,
      turnStarts: startedTurns.size,
      turnCompletes: completedTurns.size,
      turnFails: failedTurns.size,
      inFlightTurns,
      errorLikeRecords,
      modelsSeen: [...modelsSeen].sort(),
      usedToolCount: usedPositive.length,
    },
    topUsedTools: topRows(new Map(usedPositive), 30),
    topEvents: topRows(eventCounts, 30),
  };

  fs.mkdirSync(path.dirname(outJsonPath), { recursive: true });
  fs.writeFileSync(outJsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  fs.mkdirSync(path.dirname(outMdPath), { recursive: true });
  fs.writeFileSync(outMdPath, `${toMarkdown(result)}\n`, "utf8");

  console.log(`Snapshot JSON: ${outJsonPath}`);
  console.log(`Snapshot MD: ${outMdPath}`);
  console.log(`Used tools: ${result.summary.usedToolCount}`);
  console.log(`Coverage gate >=20: ${result.summary.usedToolCount >= 20 ? "PASS" : "NOT YET"}`);
  console.log(`In-flight turns: ${result.summary.inFlightTurns}`);
}

main();
