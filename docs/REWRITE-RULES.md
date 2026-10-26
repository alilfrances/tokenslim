# Bash rewrite rules

`rewrite-bash.mjs` is a conservative `PreToolUse` hook. It only appends or normalizes
flags on the original binary; it never proxies or replaces that binary. No rewrite emits
no hook output.

The same `PreToolUse` Bash hook also hosts the whole-file-dump guard (`bashGuard`, see the README):
it runs first, before the rewrite opt-in check, so it is active (in `shadow` mode: observe and count,
never output) even while rewrites are off. It only acts on commands containing `cat`, `nl`, `sed`,
`head` or `tail`; every other command returns before any file or state access. In `deny` mode a
refused dump ends the hook without reaching the rewrite rules; `disable: ["rewrite"]` does not
disable the guard and `disable: ["bashguard"]` does not disable rewrites (`all` disables both).

**Rewrites are off by default since 0.4.0.** With the default config the rewrite part of the hook
exits immediately: no rewrite output, no tokenizing. The only state it can write is the guard's
shadow counters, and only when a command is a whole-file dump over the threshold.

> **Security warning.** An applied rewrite returns `permissionDecision: "allow"`, which
> auto-approves the rewritten command and bypasses Claude Code's permission prompt for it.
> Several rewritten commands (`npm install`/`ci`, `pip install`, `cargo build`/`check`/`test`)
> can run arbitrary package scripts or build scripts. Enable rewrites only if you accept
> that those commands run without asking.

To opt in, set `{"rewrite":{"enabled":true}}` in `.tokenslim.json` or the user config (see
Configuration), or set `TOKENSLIM_REWRITE_ENABLED=true`. `/tokenslim:discover` reports
rewrite opportunities as if enabled, to help you decide.

## Rules

| Command | Rewrite |
| --- | --- |
| `npm install` / `npm ci` | append `--loglevel=error --no-fund --no-audit` |
| `pip install` | append `-q` |
| `cargo build`, `check`, `test` | append `--quiet` |
| `pytest` | append `-q` (never `-qq`) |
| `git status` | append `--porcelain=v1 -b` |
| `mvn …` / `gradle …` | append `-q` |
| `docker build` | append `--quiet` only when `rewrite.dockerBuild` is `true` |

Rules are idempotent: a command that already has the applicable quiet flag is left alone.
An explicit verbosity request (`-v`, `--verbose`, `--debug`, or `--loglevel`) is always
respected.

## Safety guards

The hook declines a command containing newlines, heredocs, command substitution, backticks,
`;`, `&&`, `||`, pipes, input/output redirection, backgrounding, or a standalone `--` argument
separator. It also declines malformed quoting, disabled rewriting, and commands matching
`rewrite.exclude`. These guards avoid treating shell programs or child-command arguments as a
single allowlisted invocation; the original command then runs unchanged.

## Runtime behavior

Claude Code receives `permissionDecision: "allow"`, a reason naming the applied rule, and
`updatedInput.command`. Codex receives an advisory in `additionalContext` by default because
live `updatedInput` support has not been confirmed. `TOKENSLIM_REWRITE_CODEX=1` opts into the
Claude-style shape at the user's risk.

## Configuration

Place optional JSON in `.tokenslim.json` in a project or in
`$XDG_CONFIG_HOME/tokenslim/config.json` (falling back to `~/.config`). Project settings
override user settings; environment variables override both.

```json
{
  "rewrite": {
    "enabled": true,
    "exclude": ["npm ci", "git status"],
    "dockerBuild": false
  }
}
```

`rewrite.enabled` defaults to `false`. Set `TOKENSLIM_DISABLE=rewrite` (or `all`) to turn the hook off even when enabled. Environment overrides also
include `TOKENSLIM_REWRITE_ENABLED`, `TOKENSLIM_REWRITE_EXCLUDE`, and
`TOKENSLIM_REWRITE_DOCKER_BUILD`.
