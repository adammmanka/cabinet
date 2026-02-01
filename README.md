# OpenClaw Cabinet Profiles (All-Real-Humans)

This bundle contains **one workspace per agent** (persona). Each workspace includes:
- `IDENTITY.md`, `SOUL.md`, `AGENTS.md`, `TOOLS.md`, `USER.md`, `MEMORY.md`
- `memory/` daily logs (today + yesterday)

## Add agents
Unzip somewhere (example shown), then:

```bash
unzip openclaw_cabinet_profiles.zip -d ~/Downloads
openclaw agents add scipio --workspace ~/Downloads/openclaw_cabinet_profiles/scipio
openclaw agents add archimedes --workspace ~/Downloads/openclaw_cabinet_profiles/archimedes
# ...repeat...
openclaw agents list
```

## Notes
- Workspaces are meant to be isolated; avoid sharing files across agents unless you intend shared context.
- Only the main 1:1 agent sessions should read `MEMORY.md` (privacy).
