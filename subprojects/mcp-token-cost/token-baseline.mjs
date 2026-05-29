#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    input: "logs.log",
    output: "subprojects/mcp-token-cost/baseline/current-baseline.json",
    modelContains: "",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input" && argv[i + 1]) {
      args.input = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--output" && argv[i + 1]) {
      args.output = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--model-contains" && argv[i + 1]) {
      args.modelContains = argv[i + 1];
      i += 1;
      continue;
    }
  }
  return args;
}

function toNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function median(values) {
  return percentile(values, 50);
}

function parseRecord(line) {
  const trimmed = line.trim();
  if (!trimmed) return { ok: false, reason: "empty" };

  try {
    return { ok: true, record: JSON.parse(trimmed) };
  } catch {
    // Handle legacy broken line that starts with "ts":... without opening brace.
    if (!trimmed.startsWith("{") && trimmed.startsWith('"ts"')) {
      try {
        return { ok: true, record: JSON.parse(`{${trimmed}}`) };
      } catch {
        return { ok: false, reason: "invalid-json" };
      }
    }
    return { ok: false, reason: "invalid-json" };
  }
}

function getRequestId(data) {
  return typeof data?.requestId === "string" ? data.requestId : undefined;
}

function ensureTurn(turns, requestId) {
  if (!turns.has(requestId)) {
    turns.set(requestId, {
      requestId,
      modelId: "unknown",
      startedAt: undefined,
      completedAt: undefined,
      attempts: 0,
      continuationRetryCount: 0,
      retriedAfterOverflow: false,
      toolResultMode: undefined,
      contextUsage: undefined,
      metrics: undefined,
      streamTimings: {
        promptN: undefined,
        predictedN: undefined,
        predictedMs: undefined,
        promptMs: undefined,
      },
      flags: {
        emptyOutputAutoRetry: 0,
        emptyOutputFallback: 0,
      },
    });
  }
  return turns.get(requestId);
}

function round(value) {
  return Number(value.toFixed(2));
}

function extractNumberByRegex(input, regex) {
  if (typeof input !== "string" || input.length === 0) {
    return undefined;
  }
  const match = input.match(regex);
  if (!match || !match[1]) {
    return undefined;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function main() {
  const args = parseArgs(process.argv);
  const inputPath = path.resolve(process.cwd(), args.input);
  const outputPath = path.resolve(process.cwd(), args.output);

  if (!fs.existsSync(inputPath)) {
    console.error(`Input log file not found: ${inputPath}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(inputPath, "utf8").split(/\r?\n/);
  const turns = new Map();

  let parsedLines = 0;
  let invalidLines = 0;

  for (const line of lines) {
    const parsed = parseRecord(line);
    if (!parsed.ok) {
      if (parsed.reason === "invalid-json") invalidLines += 1;
      continue;
    }

    parsedLines += 1;
    const record = parsed.record;
    const event = record?.event;
    const data = record?.data;
    const requestId = getRequestId(data);
    if (!event || !requestId) {
      continue;
    }

    const turn = ensureTurn(turns, requestId);

    if (event === "chat.turn.start") {
      turn.modelId = typeof data?.modelId === "string" ? data.modelId : turn.modelId;
      turn.startedAt = typeof record?.ts === "string" ? record.ts : turn.startedAt;
      continue;
    }

    if (event === "chat.request.send") {
      const attemptNo = toNumber(data?.attemptNo);
      if (attemptNo) {
        turn.attempts = Math.max(turn.attempts, attemptNo);
      }
      continue;
    }

    if (event === "chat.context.usage") {
      const attemptNo = toNumber(data?.attemptNo) ?? 0;
      const currentAttemptNo = toNumber(turn.contextUsage?.attemptNo) ?? -1;
      if (attemptNo >= currentAttemptNo) {
        turn.contextUsage = data;
      }
      continue;
    }

    if (event === "chat.response.empty_output_autoretry") {
      turn.flags.emptyOutputAutoRetry += 1;
      continue;
    }

    if (event === "chat.response.empty_output_fallback") {
      turn.flags.emptyOutputFallback += 1;
      continue;
    }

    if (event === "chat.stream.chunk") {
      const chunkText = typeof data?.text === "string" ? data.text : "";
      const promptN = extractNumberByRegex(chunkText, /"prompt_n"\s*:\s*(\d+)/);
      const predictedN = extractNumberByRegex(chunkText, /"predicted_n"\s*:\s*(\d+)/);
      const predictedMs = extractNumberByRegex(chunkText, /"predicted_ms"\s*:\s*([0-9]+(?:\.[0-9]+)?)/);
      const promptMs = extractNumberByRegex(chunkText, /"prompt_ms"\s*:\s*([0-9]+(?:\.[0-9]+)?)/);

      if (promptN !== undefined) {
        const prev = toNumber(turn.streamTimings?.promptN) ?? 0;
        turn.streamTimings.promptN = Math.max(prev, promptN);
      }
      if (predictedN !== undefined) {
        const prev = toNumber(turn.streamTimings?.predictedN) ?? 0;
        turn.streamTimings.predictedN = Math.max(prev, predictedN);
      }
      if (predictedMs !== undefined) {
        const prev = toNumber(turn.streamTimings?.predictedMs) ?? 0;
        turn.streamTimings.predictedMs = Math.max(prev, predictedMs);
      }
      if (promptMs !== undefined) {
        const prev = toNumber(turn.streamTimings?.promptMs) ?? 0;
        turn.streamTimings.promptMs = Math.max(prev, promptMs);
      }
      continue;
    }

    if (event === "chat.turn.complete") {
      turn.completedAt = typeof record?.ts === "string" ? record.ts : turn.completedAt;
      turn.continuationRetryCount = toNumber(data?.continuationRetryCount) ?? turn.continuationRetryCount;
      turn.retriedAfterOverflow = data?.retriedAfterOverflow === true;
      turn.toolResultMode = typeof data?.toolResultMode === "string" ? data.toolResultMode : turn.toolResultMode;
      turn.attempts = Math.max(turn.attempts, toNumber(data?.attemptNo) ?? 0, turn.attempts);
      if (data?.contextUsage && typeof data.contextUsage === "object") {
        turn.contextUsage = data.contextUsage;
      }
      if (data?.metrics && typeof data.metrics === "object") {
        turn.metrics = data.metrics;
      }
    }
  }

  const modelFilter = String(args.modelContains || "").trim().toLowerCase();

  const turnList = [...turns.values()];
  const completed = turnList.filter(t => {
    if (t.completedAt === undefined) return false;
    if (!modelFilter) return true;
    return String(t.modelId || "").toLowerCase().includes(modelFilter);
  });

  const tokenRows = completed
    .map(t => {
      const usage = t.contextUsage ?? {};
      const metrics = t.metrics ?? {};

      const msgTokens = toNumber(usage?.messageTokensAfterCompact);
      const toolTokens = toNumber(usage?.toolTokens);
      const reserveTokens = toNumber(usage?.replyReserveTokens);
      const estimatedInputTokens =
        msgTokens !== undefined && toolTokens !== undefined && reserveTokens !== undefined
          ? msgTokens + toolTokens + reserveTokens
          : toNumber(usage?.estimatedUsedTokens) ?? toNumber(t.streamTimings?.promptN);

      const estimatedOutputTokens = toNumber(metrics?.estimatedOutputTokens) ?? toNumber(t.streamTimings?.predictedN);
      const estimatedTotalTokens =
        estimatedInputTokens !== undefined && estimatedOutputTokens !== undefined
          ? estimatedInputTokens + estimatedOutputTokens
          : undefined;

      const durationMs = toNumber(metrics?.durationMs) ?? toNumber(t.streamTimings?.promptMs);
      const queueWaitMs = toNumber(metrics?.queueWaitMs);
      const metricsTps = toNumber(metrics?.tokensPerSecond);
      const fallbackTps = (() => {
        const predictedN = toNumber(t.streamTimings?.predictedN);
        const predictedMs = toNumber(t.streamTimings?.predictedMs);
        if (predictedN === undefined || predictedMs === undefined || predictedMs <= 0) {
          return undefined;
        }
        return predictedN / (predictedMs / 1000);
      })();
      const tokensPerSecond = metricsTps ?? fallbackTps;

      return {
        requestId: t.requestId,
        modelId: t.modelId,
        attempts: t.attempts || 1,
        continuationRetryCount: t.continuationRetryCount,
        retriedAfterOverflow: t.retriedAfterOverflow,
        autoCompacted: usage?.autoCompacted === true,
        hardCompacted: usage?.hardCompacted === true,
        estimatedInputTokens,
        estimatedOutputTokens,
        estimatedTotalTokens,
        durationMs,
        queueWaitMs,
        tokensPerSecond,
      };
    })
    .filter(row => row.estimatedInputTokens !== undefined || row.estimatedOutputTokens !== undefined);

  const inputValues = tokenRows.map(r => r.estimatedInputTokens).filter(v => v !== undefined);
  const outputValues = tokenRows.map(r => r.estimatedOutputTokens).filter(v => v !== undefined);
  const totalValues = tokenRows.map(r => r.estimatedTotalTokens).filter(v => v !== undefined);
  const attemptsValues = tokenRows.map(r => r.attempts);
  const durationValues = tokenRows.map(r => r.durationMs).filter(v => v !== undefined);
  const queueWaitValues = tokenRows.map(r => r.queueWaitMs).filter(v => v !== undefined);
  const tpsValues = tokenRows.map(r => r.tokensPerSecond).filter(v => v !== undefined);

  const baseline = {
    generatedAt: new Date().toISOString(),
    source: {
      inputPath,
      parsedLines,
      invalidLines,
      totalRawLines: lines.length,
      modelFilter: modelFilter || undefined,
    },
    summary: {
      totalRequestsSeen: turnList.length,
      completedTurns: completed.length,
      turnsWithTokenEstimates: tokenRows.length,
      avgAttempts: round(mean(attemptsValues)),
      continuationRetryRatePct: tokenRows.length > 0 ? round((tokenRows.filter(r => r.continuationRetryCount > 0).length / tokenRows.length) * 100) : 0,
      overflowRetryRatePct: tokenRows.length > 0 ? round((tokenRows.filter(r => r.retriedAfterOverflow).length / tokenRows.length) * 100) : 0,
      autoCompactRatePct: tokenRows.length > 0 ? round((tokenRows.filter(r => r.autoCompacted).length / tokenRows.length) * 100) : 0,
      hardCompactRatePct: tokenRows.length > 0 ? round((tokenRows.filter(r => r.hardCompacted).length / tokenRows.length) * 100) : 0,
      estimatedInputTokens: {
        avg: round(mean(inputValues)),
        median: round(median(inputValues)),
        p95: round(percentile(inputValues, 95)),
      },
      estimatedOutputTokens: {
        avg: round(mean(outputValues)),
        median: round(median(outputValues)),
        p95: round(percentile(outputValues, 95)),
      },
      estimatedTotalTokens: {
        avg: round(mean(totalValues)),
        median: round(median(totalValues)),
        p95: round(percentile(totalValues, 95)),
      },
      performance: {
        durationMs: {
          avg: round(mean(durationValues)),
          median: round(median(durationValues)),
          p95: round(percentile(durationValues, 95)),
        },
        queueWaitMs: {
          avg: round(mean(queueWaitValues)),
          median: round(median(queueWaitValues)),
          p95: round(percentile(queueWaitValues, 95)),
        },
        tokensPerSecond: {
          avg: round(mean(tpsValues)),
          median: round(median(tpsValues)),
          p95: round(percentile(tpsValues, 95)),
        },
      },
    },
    turns: tokenRows,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");

  console.log(`Baseline written: ${outputPath}`);
  console.log(`Completed turns: ${baseline.summary.completedTurns}`);
  console.log(`Turns with token estimates: ${baseline.summary.turnsWithTokenEstimates}`);
  console.log(`Avg estimated total tokens/turn: ${baseline.summary.estimatedTotalTokens.avg}`);
  console.log(`P95 estimated total tokens/turn: ${baseline.summary.estimatedTotalTokens.p95}`);
  console.log(`Avg tokens/sec: ${baseline.summary.performance.tokensPerSecond.avg}`);
  console.log(`P95 duration ms: ${baseline.summary.performance.durationMs.p95}`);
}

main();
