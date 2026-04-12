---
description: "Display AAHP project health dashboard from handoff state"
allowed-tools: "Read"
---

Read the AAHP handoff state and display a project health dashboard.

## Steps

1. Read `.ai/handoff/MANIFEST.json`
2. Display `quick_context` as the headline
3. Read `.ai/handoff/STATUS.md` (summary section only if sectioned)
4. Read `.ai/handoff/DASHBOARD.md` for build health

## Output Format

```
=== Project Health Dashboard ===

Quick Context: [from manifest]

Last Session: [agent] at [timestamp] ([duration] min)
Phase: [current phase]
AAHP Version: [version]

Build Health:
  build:      [status]
  test:       [status]
  lint:       [status]
  type-check: [status]

Open Tasks: [count]
  [T-XXX] [title] - [status] [priority]
  ...

Blockers: [count or "none"]
  ...

Trust Warnings: [expired items]
  ...

Token Budget: manifest=[X] | core=[Y] | full=[Z]
```

If MANIFEST.json is missing or invalid, report the error and suggest running `/handoff` to regenerate.
