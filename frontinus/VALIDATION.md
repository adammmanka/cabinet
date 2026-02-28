# Validation (smoke check)

This workspace (`frontinus/`) is not a standalone Node/TS package (no `package.json`/`tsconfig.json`), so the default "tests/typecheck" step for the PRD loop should be a **repo-level smoke check**.

## Minimal validation command

From the **repo root** (`/Users/adammanka/clawd/projects/openclaw_cabinet_profiles`):

```bash
# basic repo hygiene
git status --porcelain

# ensure we didn't break git metadata (cheap)
git diff --stat

# optional: ensure OpenClaw CLI is reachable (non-invasive)
openclaw --version
```

If/when the repo adds a package-level test/typecheck entrypoint, replace this with the real command(s).
