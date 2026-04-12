# Handoff File Management Rules

## File Responsibilities

| File | Purpose | Updated When |
|------|---------|-------------|
| MANIFEST.json | Index, checksums, task graph | Every session end |
| STATUS.md | Current system state (rewritten, not appended) | Every session end |
| NEXT_ACTIONS.md | Max 5 active tasks, work top-down | When tasks change |
| LOG.md | Last 10 entries, reverse chronological | Every session end |
| LOG-ARCHIVE.md | Overflow entries (auto-managed) | When LOG.md exceeds 10 |
| DASHBOARD.md | Build health, pipeline state, task queue | Every completed task |
| CONVENTIONS.md | Project rules (rarely changes) | When conventions evolve |
| TRUST.md | Verification register with TTL | When trust state changes |
| WORKFLOW.md | Pipeline definition | When workflow changes |

## Writing Rules

### STATUS.md
- REWRITE entirely each session (not append)
- Reflects current reality, not history
- Use section markers: `<!-- SECTION: name -->`
- Include trust levels: (Verified), (Assumed), (Unknown)

### NEXT_ACTIONS.md
- Maximum 5 active (unblocked) tasks
- Each task must be self-contained with clear steps
- Blocked tasks go to bottom with blocker documented
- Completed tasks move to "Recently Completed" (max 5, then pruned)
- Overflow goes to DASHBOARD.md or BACKLOG.md

### LOG.md
- Reverse chronological order
- Maximum 10 entries in active file
- Older entries auto-move to LOG-ARCHIVE.md
- Every entry must include agent identity and timestamp:
  ```
  > **Agent:** model-name
  > **Session ID:** unique-id
  > **Timestamp:** ISO-8601
  ```

### MANIFEST.json
- Auto-generated at end of every session
- Contains SHA-256 checksums for all files
- Contains task dependency graph (v3)
- Contains quick_context for fast orientation
- Contains token budget estimates

## Agent Identity

Every handoff file update must include:
- Agent model name (e.g., claude-opus-4.6, gpt-4, gemini-pro)
- Session identifier
- ISO-8601 timestamp
- Git commit reference (before and after)
