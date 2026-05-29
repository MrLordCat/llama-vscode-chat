#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    input: "logs.log",
    outputJson: "subprojects/mcp-token-cost/baseline/tool-inventory.json",
    outputMd: "subprojects/mcp-token-cost/baseline/tool-inventory.md",
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

function getToolBucket(map, name) {
  if (!map.has(name)) {
    map.set(name, {
      name,
      advertisedInRequestBodyTools: 0,
      referencedInRequestMessages: 0,
      observedInStreamToolCalls: 0,
      totalSignals: 0,
    });
  }
  return map.get(name);
}

function bump(map, name, field) {
  if (typeof name !== "string" || name.length === 0) return;
  const bucket = getToolBucket(map, name);
  bucket[field] += 1;
  bucket.totalSignals += 1;
}

function extractToolNamesFromChunkText(text) {
  const names = [];
  if (typeof text !== "string" || text.length === 0) return names;

  const regex = /"function":\{"name":"([^"\\]+)"/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match[1]) {
      names.push(match[1]);
    }
  }
  return names;
}

function toRows(map) {
  return [...map.values()].sort((a, b) => {
    if (b.totalSignals !== a.totalSignals) return b.totalSignals - a.totalSignals;
    return a.name.localeCompare(b.name);
  });
}

function toMarkdown(summary, rows, sourcePath) {
  const lines = [];
  lines.push("# Tool Inventory (From Logs)");
  lines.push("");
  lines.push(`Source log: ${sourcePath}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- parsed records: ${summary.parsedRecords}`);
  lines.push(`- unique tools: ${summary.uniqueTools}`);
  lines.push(`- tools advertised in request body: ${summary.toolsAdvertised}`);
  lines.push(`- tools observed in stream tool calls: ${summary.toolsObservedInStream}`);
  lines.push("");
  lines.push("## Tools");
  lines.push("");
  lines.push("| Tool | advertised | msg refs | stream calls | total signals |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const row of rows) {
    lines.push(
      `| ${row.name} | ${row.advertisedInRequestBodyTools} | ${row.referencedInRequestMessages} | ${row.observedInStreamToolCalls} | ${row.totalSignals} |`
    );
  }
  lines.push("");
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv);
  const inputPath = path.resolve(process.cwd(), args.input);
  const outputJsonPath = path.resolve(process.cwd(), args.outputJson);
  const outputMdPath = path.resolve(process.cwd(), args.outputMd);

  if (!fs.existsSync(inputPath)) {
    console.error(`Input log file not found: ${inputPath}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(inputPath, "utf8").split(/\r?\n/);
  const toolMap = new Map();

  let parsedRecords = 0;

  for (const line of lines) {
    const record = parseRecord(line);
    if (!record) continue;
    parsedRecords += 1;

    const event = record?.event;
    const data = record?.data;

    if (event === "chat.request.send") {
      const requestBodyTools = data?.requestBody?.tools;
      if (Array.isArray(requestBodyTools)) {
        for (const tool of requestBodyTools) {
          const toolName = tool?.function?.name;
          bump(toolMap, toolName, "advertisedInRequestBodyTools");
        }
      }

      const requestMessages = data?.requestBody?.messages;
      if (Array.isArray(requestMessages)) {
        for (const message of requestMessages) {
          const toolCalls = message?.tool_calls;
          if (!Array.isArray(toolCalls)) continue;
          for (const call of toolCalls) {
            const toolName = call?.function?.name;
            bump(toolMap, toolName, "referencedInRequestMessages");
          }
        }
      }
      continue;
    }

    if (event === "chat.stream.chunk") {
      const chunkText = data?.text;
      const names = extractToolNamesFromChunkText(chunkText);
      for (const name of names) {
        bump(toolMap, name, "observedInStreamToolCalls");
      }
    }
  }

  const rows = toRows(toolMap);
  const summary = {
    generatedAt: new Date().toISOString(),
    source: inputPath,
    parsedRecords,
    uniqueTools: rows.length,
    toolsAdvertised: rows.filter(r => r.advertisedInRequestBodyTools > 0).length,
    toolsObservedInStream: rows.filter(r => r.observedInStreamToolCalls > 0).length,
  };

  const jsonResult = {
    summary,
    tools: rows,
  };

  fs.mkdirSync(path.dirname(outputJsonPath), { recursive: true });
  fs.writeFileSync(outputJsonPath, `${JSON.stringify(jsonResult, null, 2)}\n`, "utf8");

  fs.mkdirSync(path.dirname(outputMdPath), { recursive: true });
  fs.writeFileSync(outputMdPath, `${toMarkdown(summary, rows, inputPath)}\n`, "utf8");

  console.log(`Tool inventory JSON: ${outputJsonPath}`);
  console.log(`Tool inventory MD: ${outputMdPath}`);
  console.log(`Unique tools: ${summary.uniqueTools}`);
  console.log(`Tools observed in stream calls: ${summary.toolsObservedInStream}`);
}

main();
