# Bash rewrite rules

`rewrite-bash.mjs` is a conservative `PreToolUse` hook. It only appends or normalizes
flags on the original binary; it never proxies or replaces that binary. No rewrite emits
no hook output.

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

The hook declines a command containing a heredoc, command substitution, backticks,
`;`, `&&`, `||`, a pipe, redirection, or backgrounding. It also declines malformed quoting,
disabled rewriting, and commands matching `rewrite.exclude`. These guards avoid trying to
parse shell programs; the original command then runs unchanged.

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

Set `TOKENSLIM_DISABLE=rewrite` (or `all`) to turn the hook off. Environment overrides also
include `TOKENSLIM_REWRITE_ENABLED`, `TOKENSLIM_REWRITE_EXCLUDE`, and
`TOKENSLIM_REWRITE_DOCKER_BUILD`.
