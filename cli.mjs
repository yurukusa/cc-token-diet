#!/usr/bin/env node
// cc-token-diet — find waste patterns in your Claude Code token consumption.
// Reads ~/.claude/projects/*/**.jsonl, detects leaks, estimates $ impact,
// and suggests fixes. No data leaves your machine.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

const HOME = os.homedir();
const PROJECTS_DIR = path.join(HOME, ".claude", "projects");

// Opus 4.x API-equivalent pricing (USD / 1M tokens).
// Adjust if you run mostly on Sonnet — the ratios still surface the same patterns.
const PRICE = {
  input: 15.0,
  output: 75.0,
  cache_read: 1.5,
  cache_create: 18.75,
};

const DEFAULT_DAYS = 7;

function parseArgs(argv) {
  const args = { days: DEFAULT_DAYS, json: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days" || a === "-d") args.days = parseInt(argv[++i], 10);
    else if (a.startsWith("--days=")) args.days = parseInt(a.slice(7), 10);
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  if (!Number.isFinite(args.days) || args.days < 1) args.days = DEFAULT_DAYS;
  return args;
}

function printHelp() {
  console.log(`cc-token-diet — find where your Claude Code tokens are leaking.

Usage:
  cc-token-diet              # last 7 days
  cc-token-diet --days 30    # last 30 days
  cc-token-diet --json       # JSON output

What you'll see:
  - Total token spend (input / output / cache) with $ estimate
  - Cache hit ratio (low = wasting money on re-reads)
  - Top 3 hottest sessions by cost
  - Specific waste patterns with suggested fixes

Data source: ~/.claude/projects/*/**.jsonl (local only — nothing uploaded).
`);
}

function costOf(u) {
  if (!u) return 0;
  return (
    ((u.input_tokens || 0) * PRICE.input +
      (u.output_tokens || 0) * PRICE.output +
      (u.cache_read_input_tokens || 0) * PRICE.cache_read +
      (u.cache_creation_input_tokens || 0) * PRICE.cache_create) /
    1_000_000
  );
}

async function* walkJsonl(dir, sinceMs) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkJsonl(full, sinceMs);
    } else if (e.isFile() && e.name.endsWith(".jsonl")) {
      try {
        const stat = await fs.promises.stat(full);
        if (stat.mtimeMs < sinceMs) continue;
      } catch {
        continue;
      }
      yield full;
    }
  }
}

async function readSession(file) {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const session = {
    file,
    sessionId: path.basename(file, ".jsonl"),
    project: path.basename(path.dirname(file)),
    firstTs: null,
    lastTs: null,
    messages: 0,
    assistantTurns: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    outputPerTurn: [],
  };
  for await (const line of rl) {
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.timestamp) {
      const t = Date.parse(obj.timestamp);
      if (!session.firstTs || t < session.firstTs) session.firstTs = t;
      if (!session.lastTs || t > session.lastTs) session.lastTs = t;
    }
    if (obj.type === "assistant" && obj.message?.usage) {
      session.assistantTurns++;
      const u = obj.message.usage;
      session.usage.input_tokens += u.input_tokens || 0;
      session.usage.output_tokens += u.output_tokens || 0;
      session.usage.cache_read_input_tokens += u.cache_read_input_tokens || 0;
      session.usage.cache_creation_input_tokens +=
        u.cache_creation_input_tokens || 0;
      if (u.output_tokens) session.outputPerTurn.push(u.output_tokens);
    }
    if (obj.type === "user" || obj.type === "assistant") session.messages++;
  }
  return session;
}

function detectPatterns(sessions, totals) {
  const patterns = [];

  const totalCache =
    totals.usage.cache_read_input_tokens +
    totals.usage.cache_creation_input_tokens;
  const createRatio = totalCache
    ? totals.usage.cache_creation_input_tokens / totalCache
    : 0;
  if (totalCache > 0) {
    const ratioPct = (createRatio * 100).toFixed(1);
    const idealPct = 15;
    if (createRatio > 0.3) {
      const wastedCreate = Math.max(
        0,
        totals.usage.cache_creation_input_tokens -
          totalCache * (idealPct / 100),
      );
      const wastedUsd = (wastedCreate * PRICE.cache_create) / 1_000_000;
      patterns.push({
        id: "cache-miss",
        severity: "high",
        title: `Cache write ratio ${ratioPct}% (ideal <${idealPct}%)`,
        impactUsd: wastedUsd,
        fix: "Stabilise the top of your context — pin CLAUDE.md, skills, and system files above dynamic content. Cache writes cost 12.5× cache reads.",
        chapter: "Token Book ch2 (CLAUDE.md optimisation)",
      });
    } else if (createRatio > 0.15) {
      patterns.push({
        id: "cache-marginal",
        severity: "medium",
        title: `Cache write ratio ${ratioPct}% (some room to improve)`,
        impactUsd: 0,
        fix: "Look for mid-session edits to files that sit above long-lived context. Each edit invalidates the cache below it.",
        chapter: "Token Book ch3 (context management)",
      });
    }
  }

  const verbose = sessions.filter((s) => {
    if (s.assistantTurns < 5) return false;
    const avg = s.usage.output_tokens / s.assistantTurns;
    return avg > 3000;
  });
  if (verbose.length > 0) {
    const extraTokens = verbose.reduce((sum, s) => {
      const avg = s.usage.output_tokens / s.assistantTurns;
      return sum + (avg - 2000) * s.assistantTurns;
    }, 0);
    const impactUsd = (extraTokens * PRICE.output) / 1_000_000;
    patterns.push({
      id: "verbose-output",
      severity: "medium",
      title: `${verbose.length} verbose session(s) (avg output >3K tokens/turn)`,
      impactUsd,
      fix: "Tell the model to skip preamble and closing summaries. 'Output only the changed code' cuts output ~40%.",
      chapter: "Token Book ch6 (workflow design)",
    });
  }

  const longSessions = sessions.filter((s) => s.assistantTurns > 100);
  if (longSessions.length > 0) {
    patterns.push({
      id: "runaway-session",
      severity: "high",
      title: `${longSessions.length} runaway session(s) (>100 assistant turns)`,
      impactUsd: longSessions.reduce((s, x) => s + costOf(x.usage), 0) * 0.3,
      fix: "Long single sessions bloat context exponentially. Use /compact or restart for each logical task.",
      chapter: "Token Book ch3 (context management)",
    });
  }

  return patterns;
}

function formatUsd(n) {
  return "$" + n.toFixed(2);
}
function formatK(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function printReport(days, sessions, patterns, totals) {
  const totalCost = costOf(totals.usage);
  const hot = [...sessions]
    .map((s) => ({ ...s, cost: costOf(s.usage) }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 3);

  console.log();
  console.log(`📉 cc-token-diet report (last ${days} days)`);
  console.log("─".repeat(56));
  console.log(
    `Sessions analysed: ${sessions.length}   Assistant turns: ${totals.assistantTurns}`,
  );
  console.log(
    `Input:  ${formatK(totals.usage.input_tokens).padStart(7)}   Output:       ${formatK(totals.usage.output_tokens).padStart(7)}`,
  );
  console.log(
    `Cache read: ${formatK(totals.usage.cache_read_input_tokens).padStart(7)}   Cache write: ${formatK(totals.usage.cache_creation_input_tokens).padStart(7)}`,
  );
  console.log(
    `Estimated API-equivalent spend: ${formatUsd(totalCost)} (Opus pricing)`,
  );

  const totalCache =
    totals.usage.cache_read_input_tokens +
    totals.usage.cache_creation_input_tokens;
  if (totalCache > 0) {
    const hitPct = (
      (totals.usage.cache_read_input_tokens / totalCache) *
      100
    ).toFixed(1);
    console.log(`Cache hit ratio: ${hitPct}% (higher is better, aim >85%)`);
  }

  console.log();
  if (patterns.length === 0) {
    console.log("✅ No major waste patterns detected. Your setup is healthy.");
  } else {
    console.log("🔥 Waste patterns:");
    for (const p of patterns) {
      const sev = p.severity === "high" ? "❗" : "⚠ ";
      const impact =
        p.impactUsd > 0
          ? ` (≈ ${formatUsd(p.impactUsd)} wasted)`
          : "";
      console.log(`  ${sev} ${p.title}${impact}`);
      console.log(`     Fix:  ${p.fix}`);
      console.log(`     See:  ${p.chapter}`);
    }
  }

  console.log();
  console.log("🌡️  Hottest sessions:");
  for (const s of hot) {
    const dur = s.firstTs && s.lastTs
      ? Math.max(0, Math.round((s.lastTs - s.firstTs) / 60000))
      : 0;
    const proj = s.project.replace(/^-home-\w+-/, "").slice(0, 36);
    console.log(
      `  ${formatUsd(s.cost).padStart(7)}  ${proj.padEnd(36)}  ${s.assistantTurns} turns / ${dur}min`,
    );
  }

  console.log();
  console.log("─".repeat(56));
  console.log("Want the full token-saving playbook with hook examples?");
  console.log("→ Token Book (¥2,500): https://ko-fi.com/s/fd44ef09a7");
  console.log("→ Free first chapter: https://zenn.dev/yurukusa/books/token-savings-guide");
  console.log();
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return printHelp();

  const sinceMs = Date.now() - args.days * 24 * 60 * 60 * 1000;
  const sessions = [];
  const totals = {
    messages: 0,
    assistantTurns: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };

  if (!fs.existsSync(PROJECTS_DIR)) {
    console.error(
      `No Claude Code logs found at ${PROJECTS_DIR}. Run Claude Code at least once first.`,
    );
    process.exit(1);
  }

  for await (const file of walkJsonl(PROJECTS_DIR, sinceMs)) {
    const s = await readSession(file);
    if (!s.firstTs || s.firstTs < sinceMs) {
      if (s.assistantTurns === 0) continue;
    }
    sessions.push(s);
    totals.messages += s.messages;
    totals.assistantTurns += s.assistantTurns;
    for (const k of Object.keys(totals.usage)) {
      totals.usage[k] += s.usage[k];
    }
  }

  if (sessions.length === 0) {
    console.log(
      `No sessions found in the last ${args.days} days. Try --days 30.`,
    );
    return;
  }

  const patterns = detectPatterns(sessions, totals);

  if (args.json) {
    const out = {
      days: args.days,
      sessions: sessions.length,
      totals,
      estimatedUsd: costOf(totals.usage),
      patterns,
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  printReport(args.days, sessions, patterns, totals);
}

main().catch((err) => {
  console.error("cc-token-diet error:", err?.message || err);
  process.exit(1);
});
