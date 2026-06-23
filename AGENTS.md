# VHS development rules

- Keep the public API small: `createVhs()` is the normal entry point.
- Keep types next to the domain that owns them. Do not create a catch-all types file.
- VHS must not import agent runtimes, sessions, jobs, MCP, or Kael code.
- CLI is a thin adapter over the same API used by TypeScript consumers.
- Prefer one clear module over a generic abstraction used once.
- Keep stdout clean when `--json` is requested; progress and diagnostics go to stderr.
- Before making a commit, review SKILL.md and update it if the feature set, API, or commands changed.
