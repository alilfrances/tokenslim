# Security Policy

## Supported Versions

Security fixes are made against the latest version on the `main` branch.

## Reporting a Vulnerability

Please report suspected vulnerabilities privately through GitHub Security Advisories for this repository.

If advisories are unavailable, contact the maintainer directly and avoid opening a public issue with exploit details.

## Scope

In scope:

- TokenSlim hook scripts and compression logic.
- Plugin manifests and installable plugin packaging.
- Workflows and release artifacts maintained in this repository.

Out of scope:

- Vulnerabilities in Claude Code, Codex, GitHub, Node.js, or the host operating system.
- Issues that require already-compromised local machine access.

## Local Data and Privacy

TokenSlim has no telemetry, network client, or external service dependency. Hook payloads,
transcripts, analytics, and recovery output remain on the local machine unless the host agent
or user explicitly sends them elsewhere.

TokenSlim writes these local files:

- Session ledgers under `$XDG_CACHE_HOME/tokenslim/`.
- Raw recovery output under `$XDG_CACHE_HOME/tokenslim/tee/` when tee mode is enabled.
- Ninety-day aggregate history under `$XDG_DATA_HOME/tokenslim/history.json`.

Ledger, history, and tee files are created with owner-only permissions on POSIX systems.
Analytics persist only privacy-safe command families such as `git status`; command arguments,
URLs, headers, credentials, and inline environment values are not retained. Project paths are
stored locally for project-level reporting. Tee files intentionally contain raw command output,
which may itself contain sensitive data. Disable them with `TOKENSLIM_DISABLE=tee` or set
`tee.mode` to `never` in config.

`tokenslim discover` reads Claude transcripts only when explicitly invoked. Its report uses
privacy-safe command families rather than full transcript command lines.

## Bash Rewrite Trust Boundary

The Claude PreToolUse rewrite hook returns `permissionDecision: "allow"` only for its documented
same-binary allowlist. It declines shell operators, redirections, command substitution,
newlines, argument separators, explicit verbosity, and malformed quoting. Review
[`docs/REWRITE-RULES.md`](docs/REWRITE-RULES.md) before enabling the plugin in an untrusted
project. Rewriting can be disabled with `TOKENSLIM_DISABLE=rewrite`.

Project-local `.tokenslim.json` files are parsed defensively: size and filter counts are
bounded, unknown fields are discarded, and regular expressions are length-limited and
screened for common catastrophic-backtracking forms. Filter behavior is still
repository-controlled, so review `.tokenslim.json` before using an untrusted checkout. Hook
timeouts remain the final denial-of-service boundary.
