# tokenslim v0.6.0: spend-level savings without changing what the model reads

This plan answers the "proposal to make it worth it" maintainer brief, which was written against v0.4.0/0.4.1. The work goes to Sonnet 5.5 and is reviewed by the orchestrator. Ground rules from `docs/history/PLAN-v0.4.md` §1 still apply:

- No dependencies.
- Deterministic output.
- Hooks fail open.
- Nothing persists commands, paths or file contents.
- Tests use `isolatedEnv()`.
- The README benchmark table is regenerated only by `node scripts/benchmark.mjs --format md`.

---

## 0. Verdicts on the brief

I checked the brief against the current code and against the Claude Code docs (`/en/settings-reference`, `/en/prompt-caching`, `/en/statusline`, `/en/skills`). Several of its assumptions are out of date.

| Brief item | Verdict | Why |
| --- | --- | --- |
| Field data / bucket model | **Accepted as the right frame.** | Tool output is the smallest of the four spend buckets. v0.4–0.5 shrank it as far as lossless methods go. |
| **P5 spend report** | **Do it, first (WP0).** | Without it no other pillar can be judged. Transcripts have everything it needs: `usage.cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`, `compact_boundary` lines, `isSidechain` and `subagents/*.jsonl`. |
| **P1 overhead apply/revert** | **Do it (WP1), with a smaller target.** | Three settings now let tokenslim prune from `.claude/settings.local.json` alone. The docs confirm the scope rules below. The 6–10% target is not credible (see §3). |
| P1: `enabledPlugins: false` at project scope | **Verified.** | Precedence is local > project > user. The docs state that `false` in `.claude/settings.local.json` disables a plugin that is enabled at a lower scope. Managed force-enables still win. |
| P1: disable user-scope MCP servers per project | **Possible via `deniedMcpServers`, which the brief missed.** | `[{ "serverName": "…" }]` works from any file. It blocks user-scope, plugin and claude.ai connector servers. Today's report lists these as "manual". |
| P1: skills | **Possible via `skillOverrides`, which the brief missed.** | `"name-only"` keeps a skill invocable but drops its description from the listing. |
| P1: hook-injection ranking | **Do it, advice only.** | tokenslim never edits other plugins. |
| **P2 cache-expiry statusline** | **Do it (WP2), much cheaper than the brief assumes.** | Claude Code ≥ 2.1.251 already gives the statusline a `prompt_cache` object with `warm`, `ttl`, `expires_at`, `recache_tokens_if_cold`, `hit_ratio` and `last_miss_cause`. tokenslim only has to render it. |
| P2: "check whether a 1h TTL exists" | **Answered: it exists.** | `promptCacheTtl` / `subagentPromptCacheTtl` (`"5m"`/`"1h"`), plus env vars. Defaults: a subscription within plan usage already gets **1h for the main conversation**. Subagents, helpers, API keys, cloud providers and over-plan usage credits get **5m**. The brief's "57% of writes on 5m" is likely subagents, over-plan credits or API-key sessions. WP0's TTL simulator decides per user, from data, instead of guessing. |
| **P3 context-growth guard**: statusline thresholds | **Do it (part of WP2).** | Costs zero model tokens. |
| P3: PreToolUse "use a subagent" advisory | **Rejected.** | The advisory costs tokens on every firing. A subagent starts cold: its own system prompt is written at 1.25× on a 5m TTL. It returns a summary, which is lossy and puts accuracy at risk. Nothing shows a net saving. |
| P3: never auto-compact or auto-clear | **Agreed.** | Claude Code already has `idleCompaction` (on by default for 1h-TTL conversations ≥ 200k, at about 54 min idle), `autoCompactWindow` and tool-result clearing. tokenslim must not duplicate these or nudge toward lossy ones. |
| **P4 defect 1** (grep collapse drops hits) | **Already fixed in v0.4.1** (PR #33, `locationLoss` audit = 0). | |
| **P4 defect 2** (literal `\u001b`) | **Already fixed in v0.4.1.** | Both fixtures are kept. |
| P4 new shapes (timestamped logs, diff/stat) | **Not doing.** | v0.5.0 WP5 measured lossless shapes below the 0.5% bar. |
| P4 read deny / `capChars` default | **Still gated** (v0.5 WP6). | Waits on the shadow-mode data that v0.5.0 now collects. Not part of 0.6. |
| Node floor | **Do it (WP3).** | Runtime scripts run on Node 18. Tests need 20.11+ (`import.meta.dirname`). |

**Is 0.6 worth it?** Yes, as a different kind of release. v0.4/0.5 changed what the model reads; 0.6 changes almost nothing the model reads:

- WP0 and WP2 are zero-risk: they produce reports and a statusline, and change no model input.
- WP1 removes only items with zero recorded use, needs explicit confirmation, and reverts with one command.

That is the only way to reach the large buckets "without sacrificing accuracy". §3 gives realistic numbers.

---

## 1. Ground rules specific to 0.6

1. **Never write a settings file without explicit confirmation.** The script writes only with `--apply --yes`. The slash command asks the user first, as `/tokenslim:budget` already does.
2. **Never touch user-scope files.** That means `~/.claude/settings.json` and `~/.claude.json`. tokenslim writes only `<project>/.claude/settings.local.json`.
3. **Revert removes only what tokenslim added.** If the user has since changed an entry, revert leaves it alone and reports it.
4. **No cost claims in dollars.** Report in input-price units: input 1, cache read 0.1, cache write 5m 1.25, cache write 1h 2.0, output 5. The shares are model-independent. Say so in every report header.
5. **Spend reports persist nothing.** They print only. `--format json` lets the user save a baseline themselves.

---

## 2. Work packages

### WP0: `/tokenslim:spend`, the spend report and TTL simulator

**Files:** `scripts/lib/spend.mjs` (pure functions), `scripts/spend.mjs` (CLI, same argument handling as `budget.mjs`), `commands/spend.md` (same plugin-root locator one-liner as `commands/budget.md`), and `tests/spend.test.mjs`.

**Input.** Reuse `transcriptFiles` and `readLines` from `scripts/lib/transcripts.mjs`.
- Extend the call record in `callCounter` with: `timestamp`, `model`, `input`, `read`, `write5m`, `write1h` and `output`.
  - Fall back to `cache_creation_input_tokens` as 5m when the `cache_creation` split is missing.
- Mark a call `afterCompact` when a `compact_boundary` system line appears between it and the previous call.
- A file is a **subagent file** if its path contains `/subagents/` or its lines carry `isSidechain: true`.
- Keep `apiCalls` and `scanSessions` backward compatible. Existing budget and benchmark tests must pass unchanged.

**Per call** `i` in a file, with `prefix_i = input + read + write5m + write1h`:
- **Output:** `output × 5`.
- **Uncached input:** `input × 1`.
- **Cache reads** (`read × 0.1`), split into three additive sub-buckets:
  - `overhead = min(read, B)`, where `B` is the file's first-call `prefix`, capped at 100k. This is the always-on prefix.
  - `longContext = max(0, read − 100000)`.
  - `conversation` = the rest.
  - An overlay, not additive: `toolResults` = estimated tool-result tokens in context at that call. Use the sum of `tool_result` text chars / 4 since the last compact boundary, capped at `read`. Label it "of which (est.)".
- **Cache writes** (`write5m × 1.25 + write1h × 2.0`), exactly one bucket, in this order:
  1. First call of the file → `sessionStart`.
  2. `afterCompact` → `compaction`.
  3. A rebuild (`writes ≥ 0.5 × prefix` and `writes ≥ 2000`):
     - `gap > 60 min` → `idle>60m`.
     - `gap > ttlPrev` → `idle5-60m`, where `ttlPrev` is 5m if the previous call's writes were mostly 5m, else 60m.
     - Otherwise → `invalidation`.
  4. Otherwise → `incremental`.
- A subagent file's calls also add to a `subagents` overlay row.

**Report** (text by default, `--format json`):
- **Header:** the scanned window (`--since`, default 30 days), files, API calls, the unit note, and **spend per active hour**.
  - Active time = Σ over main-conversation files of Σ `min(gap, 15 min)` between consecutive calls.
- **Bucket table:** bucket, units, share of total. It mirrors the brief's table so the user can compare.
- **TTL split:** writes on 5m and on 1h, for main and for subagents separately.
- **Per-week rows** (ISO week) with total units and units per active hour. Add **per-project** rows with `--all` (project = top-level directory under the transcripts root).
- **TTL simulator,** run separately for main-conversation files and for subagent files. Replay each file's calls under T = 5m and T = 60m:
  - First call, `compaction` and `invalidation` rebuilds: `prefix_i × w_T` under both policies.
  - Otherwise, if `gap ≤ T`: `prefix_{i−1} × 0.1 + (prefix_i − prefix_{i−1}) × w_T`.
  - Otherwise: `prefix_i × w_T`.
  - Here `w_5m = 1.25` and `w_1h = 2.0`.
  - Print both totals and the delta. Recommend `promptCacheTtl` / `subagentPromptCacheTtl` = the cheaper value **only if** it saves ≥ 2% of that group's cache cost.
  - Always print the caveat: "on a Claude subscription within plan usage the main conversation already uses 1h; this affects plan limits, not your bill".
  - The simulator ignores output and uncached input because both policies treat them the same.
- **`--compare <file.json>`** reads an earlier `--format json` output and prints each bucket's change in **units per active hour**. This is the brief's success metric.

**Tests** (synthetic JSONL fixtures under a temporary transcripts dir via `TOKENSLIM_TRANSCRIPTS_DIR`):
- Every write bucket hit exactly once.
- Duplicate `message.id` streaming lines counted once.
- The missing `cache_creation` fallback.
- Subagent detection by path and by `isSidechain`.
- The simulator on a hand-computed 4-call example: gaps of 2m, 20m and 90m, with exact expected numbers.
- `--compare` deltas.
- Garbage lines skipped.
- No file written: assert that the transcripts dir and `$HOME` are byte-identical before and after.

### WP1: `/tokenslim:budget --apply` / `--revert`

Extend `scripts/lib/budget.mjs` and `scripts/budget.mjs`, and update `commands/budget.md`.

**1. Wider prune targets** in `pruneTarget`, written as a `.claude/settings.local.json` snippet:
- **Plugin** → `enabledPlugins["name@marketplace"] = false`.
  - Resolve the key from every settings file, as today. If no key exists, fall back to `~/.claude/plugins/installed_plugins.json`.
  - **Never disable a plugin that ships hooks, commands or an output style.** A zero count of Skill/Agent uses does not mean such a plugin is unused.
    - Find the plugin's install path from `installed_plugins.json` and look for `hooks/`, `hooks.json`, `commands/`, `output-styles/`, or a `hooks` field in `.claude-plugin/plugin.json`.
    - If the install path cannot be resolved, treat the plugin as having hooks.
  - Such plugins fall back to `skillOverrides` for their skills (see the skill bullet) or are listed as manual.
- **MCP server** that is not in the project's `.mcp.json` (user scope, plugin-provided or a claude.ai connector) → append `{ "serverName": "<configured name>" }` to `deniedMcpServers`.
  - The row name is the normalized `mcp__<server>__` form. Map it back to the configured name using `~/.claude.json` (`mcpServers` and `projects[<cwd>].mcpServers`, **read-only**), `.mcp.json`, and plugin `.mcp.json` / manifest `mcpServers`.
  - Write it only when **exactly one** configured name normalizes to the row name. Otherwise list it as manual.
  - For claude.ai connectors, use the display name only if the transcript's listing attachment records it verbatim.
  - The existing `disabledMcpjsonServers` path for `.mcp.json` servers stays.
- **Skill** → `skillOverrides["<name>"] = "name-only"`. Never `"off"`: the skill stays invocable and only its description leaves the listing.
  - For plugin skills (`plugin:skill`), first run a **live probe** of the key format: check whether `skillOverrides` matches `plugin:skill` or the bare name, and record the result in `docs/SHAPES.md`, as was done for the persistence probe.
  - Until the probe confirms the format, list plugin skills as manual.
- **Never** prune tokenslim itself.

**2. Stricter candidate rule.** An item is a candidate only if all of these hold:
- 0 uses over the window.
- It appeared in **≥ 5 sessions** of this project, so that absence of use is evidence.
- `weightedTokens ≥ --min-tokens`.

Count these as uses, in addition to today's rule: user-typed slash commands (`<command-name>/plugin:cmd</command-name>` in user messages), which give plugin and skill uses.

**3. `--apply --yes`**:
- Parse the existing `.claude/settings.local.json`. If it is invalid JSON, **abort without writing**.
- Merge:
  - `enabledPlugins` key by key.
  - `deniedMcpServers` and `disabledMcpjsonServers` as unions; never duplicate.
  - `skillOverrides` key by key. Never overwrite an existing user value.
- Write atomically (temp file + rename), as 2-space JSON with a trailing newline.
- Before writing:
  - Back up the original to `${XDG_CACHE_HOME:-~/.cache}/tokenslim/budget/<sha256(cwd)[0:16]>/<timestamp>.json`.
  - Write a ledger `applied.json` next to it. It lists each entry tokenslim added and the prior value or absence.
- Print what changed and: "takes effect in the next session (restart or `/clear`); MCP changes need a restart".
  - Settings reload live, but plugin MCP and server changes apply at session start, and skill/plugin listing changes are appended without breaking the cache (per the prompt-caching docs).

**4. `--revert --yes`**:
- For each ledger entry, restore the prior value **only if** the current value still equals what tokenslim wrote.
- List the entries that were skipped.
- Delete the ledger after a full revert.
- If there is no ledger, print "nothing to revert".

**5. Per-prompt and session-start injections** (advice only):
- Add a report section that groups hook-injected attachments by source and event, weighted like the other rows.
- First inspect real transcripts for which attachment fields name the hook or plugin, and document them in a code comment. Fall back to "unattributed".
- Print the remedy as text, for example: "disable plugin X in this project, or ask its author to shorten its UserPromptSubmit injection".

**6. Command flow** (`commands/budget.md`):
1. Report.
2. `--emit-settings`.
3. Show the diff.
4. Wait for explicit confirmation.
5. `--apply --yes`.
6. Remind the user about `/tokenslim:budget --revert`.

Keep the existing rule: never edit user-level files.

**Tests** (temporary `HOME`, `CLAUDE_CONFIG_DIR` and project dir):
- Each target type is emitted and applied.
- A plugin with hooks is not disabled, and an unresolvable install path is treated as hooks.
- A plugin with < 5 sessions is not a candidate.
- An ambiguous MCP name goes to manual.
- Invalid JSON aborts with the file byte-identical.
- An existing user `skillOverrides` value is preserved.
- Apply then revert restores the byte-identical original (when untouched).
- A user-edited entry survives revert.
- `~/.claude/settings.json` and `~/.claude.json` are byte-identical after every operation.
- `--apply` without `--yes` writes nothing.

### WP2: Statusline for cache and context

Rework `scripts/statusline.mjs`. It stays dependency-free and fast (a single JSON read), and its output costs zero model tokens.

**Segments**, in order, each omitted when its data is missing:
1. **Model:** `model.display_name`.
2. **Context:** `ctx 142k` from `context_window.total_input_tokens`. Fall back to `used_percentage`.
   - Use ANSI amber at ≥ `statusline.ctxAmber` (default 120000) and ANSI red at ≥ `statusline.ctxRed` (default 200000).
   - No color when `NO_COLOR` is set.
3. **Cache:** from `prompt_cache`.
   - Warm: `cache 1h·42m`, meaning the TTL and the time left until `expires_at`.
   - `warm === false` and `recache_tokens_if_cold > 0`: `cold: next prompt re-caches ~180k`. This is the user's cue to `/clear` or start fresh instead of resuming a big cold context.
   - Omit the segment when `caching_observed` is false.
4. **Saved:** the tokenslim saved figure, as today.

**Config:** `statusline: { ctxAmber, ctxRed, showCache: true }` in `DEFAULT_CONFIG`.

**README:**
- The documented `statusLine` snippet gains `"refreshInterval": 30`. Without it the countdown freezes while idle, because the statusline otherwise refreshes only on events.
- Note that `prompt_cache` needs Claude Code ≥ 2.1.251.

**Time** comes from `Date.now()`. Tests override it with `TOKENSLIM_NOW` (epoch seconds), read only by the statusline.

**Tests:**
- Fixture stdin JSON for warm, cold, cold with null `recache_tokens_if_cold`, no `prompt_cache` (older Claude Code), each threshold, `NO_COLOR`, garbage stdin and empty stdin. Assert exact output strings.
- It must never throw and must always print one line.

**Not doing:** any hook that injects context-size or subagent advice into the model, and any automatic `/compact` or `/clear`.

### WP3: Housekeeping

- **README "Requirements":** Node ≥ 18 to run the hooks; Node ≥ 20.11 to run the test suite. CI runs on 20 and 22.
- **`/tokenslim:doctor`:** print a warning (not a failure) when `process.versions.node` is below 20.11, saying only the tests are affected.
- **`/tokenslim:tokenstats`:** add a one-line pointer to `/tokenslim:spend` for the spend view.

### WP-R: Release v0.6.0

- Bump `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` to `0.6.0`. Check with `git diff --cached --stat` before committing.
- Update the README: a `spend` section, the `budget --apply/--revert` section with the safety rules above, and the statusline section.
- Move this plan to `docs/history/PLAN-v0.6.md` with a Status section.
- Run the full suite and the CI syntax loop locally, then open a PR. CI must be green before the squash-merge.

---

## 3. Expected effect (honest)

These are estimates, not promises. The final column of the brief's table is replaced by what is actually reachable.

| Lever | Ceiling in the brief's data | Realistic tokenslim effect | Why lower |
| --- | ---: | ---: | --- |
| WP1 overhead pruning | ~25% fixed overhead | **1–5% of spend**, setup-dependent | Most of the ~50k prefix is the system prompt and built-in tools, which can't be pruned. MCP tool schemas are already deferred by tool search, and the skill listing is already capped at 1% of the window. What remains: unused MCP server instructions, unused plugins' agents and skills, and hook injections. `budget` shows the exact figure before anything is applied. |
| WP0 TTL recommendation | 11.4% idle re-writes | **0–4%** | ~0 for subscription users within plan (the main conversation is already 1h). Real for API-key users and subagent-heavy idle patterns. The simulator says which, per user. |
| WP2 statusline nudges | idle re-writes + 16% long context | **0–5%, behavioral** | Works only if the user acts on it (`/clear` instead of resuming a cold 300k session). Not measurable in advance; WP0's per-week `idle*` and `longContext` units show whether it worked. |
| v0.4–0.5 tool output (already shipped) | ~12% | ~0.3% of spend lossless; more if `bashGuard`/`readGuard` deny is enabled after shadow data | Unchanged in 0.6. |

**Combined realistic target:** about **3–8% lower spend per active hour** from tokenslim's own levers. With the user acting on the statusline it could reach about 10–12%. The brief's 15–25% assumes most fixed overhead is prunable and that cache expiry can be avoided automatically. Neither holds without lossy measures (forced compaction, dropping context), which this plan rules out.

**How the user verifies:**
1. Before installing 0.6, or right after: `spend --format json > baseline.json`.
2. After a week: `spend --compare baseline.json`.

Success means a drop in units per active hour in the buckets each WP targets.

---

## 4. Order

WP0 → WP1 (including the plugin-skill `skillOverrides` probe) → WP2 → WP3 → WP-R.

WP0 lands first because it is both the measuring stick and the source of WP1's and WP2's numbers. Each WP is one reviewed commit.

---

## Status: shelved (not built)

On review the plan was not worth a release:
- Most of it duplicates features Claude Code already ships or is moving toward: usage-based skill-listing pruning, deferred MCP tools, the `prompt_cache` statusline fields, `/usage` attribution, TTL settings and idle compaction. Building it would mean tracking internal file formats that change quickly.
- The automatic parts (auto-prune, auto-TTL) were estimated at 1–5% and 0–4% of spend, with ongoing maintenance and breakage risk.
- WP0 and WP2 save nothing on their own: they only report.

Instead, v0.5.1 gives the Read guard the same measurement the Bash dump guard has. Both guards can then move from measuring to `deny` on the user's own data, which is the largest lever left that does not change accuracy.
