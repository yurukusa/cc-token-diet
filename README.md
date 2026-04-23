# cc-token-diet

Find where your Claude Code tokens are leaking — with $ impact and fixes.

```
npx cc-token-diet
```

Reads your local Claude Code conversation logs (`~/.claude/projects/`), detects
specific waste patterns, and tells you which sessions cost the most and what to
change. Nothing leaves your machine.

## What it finds

Other tools tell you **how much** you spent. `cc-token-diet` tells you **where
the waste is** and **how to stop it**:

- **Cache write ratio** — if you're rewriting the cache too often (>30 %),
  you're paying 12.5× what a stable context would cost.
- **Verbose output** — sessions where the model averages >3K output tokens per
  turn, usually because it's been asked to "explain everything."
- **Runaway sessions** — long single sessions (>100 assistant turns) that bloat
  context exponentially. These are where the money quietly disappears.

Each finding comes with a concrete fix and the Token Book chapter that covers
it in depth.

## Sample output

```
📉 cc-token-diet report (last 7 days)
────────────────────────────────────────────────────────
Sessions analysed: 62   Assistant turns: 11,204
Input:     138K   Output:         3.1M
Cache read: 1.8G   Cache write:   21M
Estimated API-equivalent spend: $3,240.12 (Opus pricing)
Cache hit ratio: 98.8% (higher is better, aim >85%)

🔥 Waste patterns:
  ❗ 18 runaway session(s) (>100 assistant turns) (≈ $912.40 wasted)
     Fix:  Long single sessions bloat context exponentially.
           Use /compact or restart for each logical task.
     See:  Token Book ch3 (context management)

🌡️  Hottest sessions:
  $431.08  projects-cc-loop           1103 turns / 180min
  $192.83  projects-cc-loop            664 turns / 143min
  $139.42  projects-cc-loop            526 turns / 96min
```

## Usage

```bash
# default — last 7 days
npx cc-token-diet

# wider window
npx cc-token-diet --days 30

# machine-readable
npx cc-token-diet --json > report.json
```

## Privacy

Runs 100 % locally. No network calls. No analytics. The tool only reads the
`.jsonl` logs Claude Code already writes to `~/.claude/projects/`. If you want
to verify, the source is one file: `cli.mjs`.

## Pricing assumption

Cost estimates use public Anthropic Opus 4.x API pricing (input $15/MTok,
output $75/MTok, cache read $1.50/MTok, cache create $18.75/MTok). Actual
subscription users (Pro/Max) aren't billed per token — treat the number as
"what your session would cost on the API" and watch it relative to your plan's
headroom.

If you mostly run on Sonnet, divide by ~5. The **patterns** still surface the
same inefficiencies either way.

## How it differs from other cc-* tools

- `cc-cost-check` — calculates cost per commit/hour/day from aggregate stats
- `cc-cost-forecast` — projects API-equivalent spend to month-end
- **`cc-token-diet`** — finds specific waste patterns in your sessions and tells you how to fix them

Use them together: forecast your pace, audit your waste, fix the leaks.

## Learn more

The full token-saving playbook (10 chapters, 40+ documented symptoms, real
incidents with hook examples):

- **Token Book** (¥2,500) — <https://ko-fi.com/s/fd44ef09a7>
- **Free first chapter** — <https://zenn.dev/yurukusa/books/token-savings-guide>

## Want ongoing incident alerts?
`cc-token-diet` shows you this month's waste. The patterns that cause it keep
changing as Claude Code evolves.
**[CC Safety Lab Founder](https://ko-fi.com/yurukusa)** (¥500/mo Ko-fi Membership) delivers a monthly
digest: 3–5 curated incidents from GitHub with fixes, 1 new safety hook, 1
measured token-saving technique with actual $ data, and early access to Token
Book updates. Issue #1 ships 2026-05-01. Founder price locked for charter
members.
## License

MIT
