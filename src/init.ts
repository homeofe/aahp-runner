/**
 * aahp init - Bootstrap AAHP v3 handoff files into a project directory.
 *
 * Creates .ai/handoff/ with all required files from the official AAHP v3
 * templates (https://github.com/homeofe/AAHP). Existing files are skipped
 * unless --force is passed.
 */

import * as fs from 'fs'
import * as path from 'path'

export interface InitResult {
  created: string[]
  skipped: string[]
  projectName: string
  handoffDir: string
}

// ── Template builders ─────────────────────────────────────────────────────────

function tplManifest(project: string, now: string): string {
  return JSON.stringify({
    aahp_version: '3.0',
    project,
    last_session: {
      agent: 'human',
      session_id: 'init',
      timestamp: now,
      commit: '',
      phase: 'setup',
      duration_minutes: 0,
    },
    files: {
      'STATUS.md':      { checksum: 'sha256:(pending)', updated: now, lines: 0, summary: 'Initial state' },
      'NEXT_ACTIONS.md':{ checksum: 'sha256:(pending)', updated: now, lines: 0, summary: 'No tasks yet' },
      'LOG.md':         { checksum: 'sha256:(pending)', updated: now, lines: 0, summary: 'Empty journal' },
      'DASHBOARD.md':   { checksum: 'sha256:(pending)', updated: now, lines: 0, summary: 'Initial dashboard' },
      'TRUST.md':       { checksum: 'sha256:(pending)', updated: now, lines: 0, summary: 'Trust register' },
      'CONVENTIONS.md': { checksum: 'sha256:(pending)', updated: now, lines: 0, summary: 'Agent conventions' },
      'WORKFLOW.md':    { checksum: 'sha256:(pending)', updated: now, lines: 0, summary: 'Pipeline definition' },
    },
    quick_context: `${project} initialized with AAHP v3. No tasks yet - add tasks to NEXT_ACTIONS.md to get started.`,
    token_budget: {
      manifest_only: 80,
      manifest_plus_core: 1200,
      full_read: 4500,
    },
    next_task_id: 1,
    tasks: {},
  }, null, 2) + '\n'
}

function tplStatus(project: string, date: string): string {
  return `# ${project}: Current State of the Nation

> Last updated: ${date} by human
> Commit: (none yet)
>
> **Rule:** This file is rewritten (not appended) at the end of every session.
> It reflects the *current* reality, not history. History lives in LOG.md.

---

<!-- SECTION: summary -->
## Summary

${project} - just initialized. No tasks defined yet.
<!-- /SECTION: summary -->

---

<!-- SECTION: build_health -->
## Build Health

| Check | Result | Notes |
|-------|--------|-------|
| \`build\` | (Unknown) | Not yet verified |
| \`test\` | (Unknown) | Not yet verified |
| \`lint\` | (Unknown) | Not yet verified |
| \`type-check\` | (Unknown) | Not yet verified |
<!-- /SECTION: build_health -->

---

<!-- SECTION: components -->
## Components

| Component | Path | State | Notes |
|-----------|------|-------|-------|
| (fill in your components) | \`src/\` | (Unknown) | |
<!-- /SECTION: components -->

---

<!-- SECTION: what_is_missing -->
## What is Missing

| Gap | Severity | Description |
|-----|----------|-------------|
| Initial tasks | HIGH | Add tasks to NEXT_ACTIONS.md |
<!-- /SECTION: what_is_missing -->
`
}

function tplNextActions(project: string): string {
  return `# ${project}: Next Actions for Incoming Agent

> Priority order. Work top-down.
> Each item should be self-contained - the agent must be able to start without asking questions.
> Blocked tasks go to the bottom. Completed tasks move to "Recently Completed".

---

## T-001: [Task Title]

**Goal:** One sentence describing the desired outcome.

**Context:**
- What is the current state?
- What has already been tried or decided?

**What to do:**
1. Step one (file path, command, expected output)
2. Step two
3. Step three

**Files:**
- \`path/to/relevant/file.ts\`: what it does

**Definition of done:**
- [ ] Tests pass
- [ ] Type-check passes
- [ ] \`STATUS.md\` updated

---

## Recently Completed

| Item | Resolution |
|------|-----------|
| (none yet) | |

---

## Reference: Key File Locations

| What | Where |
|------|-------|
| Main config | \`config/app.yml\` |
| Entry point | \`src/index.ts\` |
`
}

function tplLog(project: string, date: string): string {
  return `# ${project}: Agent Journal

> **Append-only.** Never delete or edit past entries.
> Every agent session adds a new entry at the top.
> This file is the immutable history of decisions and work done.

---

## [${date}] Init: AAHP v3 handoff files bootstrapped

> **Agent:** human (aahp init)
> **Timestamp:** ${new Date().toISOString()}

**What was done:**
- Ran \`aahp init\` to create .ai/handoff/ with AAHP v3 template files
- Project: ${project}

**Open items:**
- Add real tasks to NEXT_ACTIONS.md
- Update MANIFEST.json task graph
- Configure CONVENTIONS.md for this project's tech stack

---
`
}

function tplLogArchive(project: string): string {
  return `# ${project}: Agent Journal Archive

> Older entries from LOG.md are moved here when the main log exceeds 10 entries.
> This file is for human review and forensics. Agents should only read it when
> investigating historical decisions.

---

<!-- Archived entries will be appended here by \`aahp archive\` -->
`
}

function tplDashboard(project: string, date: string): string {
  return `# ${project}: Build Dashboard

> Single source of truth for build health, test coverage, and pipeline state.
> Updated by agents at the end of every completed task.

---

## Components

| Name | Path | Build | Tests | Status | Notes |
|------|------|-------|-------|--------|-------|
| (fill in) | \`src/\` | ⏳ | ⏳ | ⏳ | |

**Legend:** ✅ passing / ❌ failing / ⏳ pending / manual = tested manually only

---

## Test Coverage

| Suite | Tests | Status | Last Run |
|-------|-------|--------|----------|
| (none yet) | - | ⏳ | - |

---

## Infrastructure / Deployment

| Component | Status | Notes |
|-----------|--------|-------|
| Local dev | ⏳ | Not verified |
| Staging | ⏳ | Not deployed |
| Production | ⏳ | Not deployed |

---

## Pipeline State

| Field | Value |
|-------|-------|
| Current task | None - add tasks to NEXT_ACTIONS.md |
| Phase | setup |
| Last completed | (none) |
| Initialized | ${date} |

---

## Open Tasks

| ID | Task | Priority | Depends on | Ready? |
|----|------|----------|-----------|--------|
| T-001 | (add your first task) | high | - | Yes |

## Completed Tasks

| ID | Task | Completed |
|----|------|-----------|
| - | (none yet) | - |

---

## Update Instructions (for agents)

After completing any task:

1. Update the relevant row in Open/Completed Tasks
2. Update component status table
3. Update "Pipeline State"
4. Add newly discovered tasks with correct priority and task ID

**Pipeline rules:**
- Blocked task - skip, take next unblocked
- All tasks blocked - notify the project owner
- Notify project owner only on **fully completed tasks**
- Check \`depends_on\` in MANIFEST.json before starting a task
`
}

function tplConventions(project: string): string {
  return `# ${project}: Agent Conventions

> Every agent working on this project must read and follow these conventions.
> Update this file whenever a new standard is established.

---

## The Three Laws (Our Motto)

> **First Law:** A robot may not injure a human being or, through inaction, allow a human being to come to harm.
>
> **Second Law:** A robot must obey the orders given it by human beings except where such orders would conflict with the First Law.
>
> **Third Law:** A robot must protect its own existence as long as such protection does not conflict with the First or Second Laws.
>
> *- Isaac Asimov*

We are human beings and will remain human beings. Tasks are delegated to AI only when we choose to delegate them. **Do no damage** is the highest rule. Agents must never take autonomous action that could harm data, systems, or people.

---

## Language

- All code, comments, commits, and documentation in **English only**
- i18n/translation keys in camelCase English

## Code Style

<!-- Replace with your project's language/framework conventions -->

- **TypeScript:** strict mode, Prettier formatting
- **Python:** black + isort, type annotations required
- **Go:** \`gofmt\`, \`golangci-lint\`, idiomatic error handling

## Branching & Commits

\`\`\`
feat/<scope>-<short-name>    - new feature
fix/<scope>-<short-name>     - bug fix
docs/<scope>-<short-name>    - documentation only
refactor/<scope>-<name>      - no behaviour change

Commit format:
  feat(scope): add description [AAHP-auto]
  fix(scope): resolve issue [AAHP-auto]
\`\`\`

## Architecture Principles

<!-- Document your non-negotiable design rules here -->

- Example: **Human-in-the-Loop** - AI assists, humans decide
- Example: **Open Source First** - evaluate OSS before building custom

## Testing

- All new code must have unit tests
- Tests must pass before every commit
- Type-check must pass before every commit

## Formatting

- **No em dashes**: Never use Unicode em dashes in any file. Use a regular hyphen (-) instead.

## What Agents Must NOT Do

- Violate the Three Laws - never cause damage to data, systems, or people
- Push directly to \`main\`
- Install new dependencies without documenting the reason
- Write secrets or credentials into source files
- Delete existing tests (fix or replace instead)
- Use em dashes anywhere in the codebase

---

*This file is maintained by agents and humans together. Update it when conventions evolve.*
`
}

function tplTrust(project: string, date: string): string {
  return `# ${project}: Trust Register

> Tracks verification status of critical system properties.
> In multi-agent pipelines, hallucinations and drift are real risks.
> Every claim here has a confidence level tied to how it was verified.

---

## Confidence Levels

| Level | Meaning |
|-------|---------|
| **verified** | An agent executed code, ran tests, or observed output to confirm this |
| **assumed** | Derived from docs, config files, or chat - not directly tested |
| **untested** | Status unknown; needs verification |

---

## Build & Compilation

| Property | Status | Last Verified | Agent | TTL | Notes |
|----------|--------|---------------|-------|-----|-------|
| Build succeeds | untested | - | - | - | Not yet verified |
| Tests pass | untested | - | - | - | Not yet verified |
| Lint passes | untested | - | - | - | Not yet verified |

---

## Infrastructure

| Property | Status | Last Verified | Agent | TTL | Notes |
|----------|--------|---------------|-------|-----|-------|
| Local dev stack runs | untested | - | - | - | Not yet verified |
| DB connection works | untested | - | - | - | Not yet verified |

---

## Repository

| Property | Status | Last Verified | Agent | TTL | Notes |
|----------|--------|---------------|-------|-----|-------|
| No secrets in source | untested | - | - | - | Run \`git grep -i "sk-\\|token\\|password"\` |
| No em dashes | untested | - | - | - | Run \`grep -r "\xe2\x80\x94" src/\` |

---

## Update Rules (for agents)

- Change \`untested\` to \`verified\` only after **running actual code/tests**
- Change \`assumed\` to \`verified\` after direct confirmation
- Never downgrade \`verified\` without explaining why in \`LOG.md\`
- High-churn properties (scripts, checksums): 1-3 day TTL
- Stable properties (schema, templates, architecture): 30 day TTL
- Add new rows when new system properties become critical

---

*Initialized: ${date}. Trust degrades over time - re-verify periodically.*
`
}

function tplWorkflow(project: string): string {
  return `# ${project}: Autonomous Multi-Agent Workflow

> Based on the [AAHP Protocol](https://github.com/homeofe/AAHP).
> Agents read DASHBOARD.md and work autonomously through the task queue.

---

## Agent Roles

| Agent | Model | Role | Responsibility |
|-------|-------|------|---------------|
| Researcher | perplexity/sonar-pro | Researcher | Research best practices, library choices, API compatibility |
| Architect | claude-opus | Architect | System design, interface definitions, test strategy |
| Implementer | claude-sonnet | Implementer | Code, tests, refactoring, commits |
| Reviewer | different provider | Reviewer | Second opinion, edge cases, security review |

---

## The Pipeline

### Phase 1: Research & Context

\`\`\`
Reads:   NEXT_ACTIONS.md (top unblocked task)
         STATUS.md (current project state)

Does:    Researches relevant packages, APIs, patterns
         Checks compatibility with existing setup

Writes:  LOG.md - research findings + recommendation
\`\`\`

### Phase 2: Architecture Decision

\`\`\`
Reads:   Research output from LOG.md
         STATUS.md, existing source files

Does:    Decides on implementation approach
         Defines exactly what the Implementer should build

Writes:  LOG.md - ADR (Architecture Decision Record)
\`\`\`

### Phase 3: Implementation

\`\`\`
Reads:   ADR from LOG.md
         CONVENTIONS.md (MANDATORY before first commit)

Does:    Creates feature branch
         Writes/modifies source code
         Runs build and tests
         Commits and pushes branch
\`\`\`

### Phase 4: Discussion Round

\`\`\`
All agents review the completed work.
Architect  - "Does the implementation match the ADR?"
Reviewer   - "Is it robust? Does it break existing functionality?"
Researcher - "Were all task items fulfilled?"
\`\`\`

### Phase 5: Completion & Handoff

\`\`\`
DASHBOARD.md:    Update component status, pipeline state
STATUS.md:       Rewrite to reflect current state
LOG.md:          Append session summary
NEXT_ACTIONS.md: Check off completed task, add new tasks
MANIFEST.json:   Update checksums, mark task done

Notify: Project owner - only on fully completed tasks
\`\`\`

---

## Autonomy Boundaries

| Allowed | Not allowed |
|---------|-------------|
| Write & commit source code | Push directly to \`main\` without approval |
| Write & run tests | Modify version without discussion |
| Push feature branches | Write secrets or PII into any file |
| Research & propose improvements | Break existing functionality |
| Make architecture decisions | Delete source files without replacement |

---

## Task Selection Rules

1. Read \`DASHBOARD.md\`, take the top task where \`Ready? = Yes\`
2. If a task is **blocked** - skip it, take the next unblocked one
3. If **all tasks are blocked** - notify the project owner, pause
4. Never start a task without reading \`STATUS.md\` first
5. After completing a task - always update \`DASHBOARD.md\` before stopping

---

## Error Handling

If an agent fails or is uncertain:
- Mark affected component as \`(Unknown)\` in \`STATUS.md\`
- Document the specific blocker in \`LOG.md\`
- Notify the project owner
- **Never proceed on assumptions when certainty is missing**

---

*This document lives in the repo and is refined by agents and humans together.*
`
}

function tplAiignore(): string {
  return `# .aiignore - AAHP v3 Safety Firewall
# Patterns that must NEVER appear in handoff files.
# Validated by CI hooks and agents before committing.

# ============================================
# Secrets & API Keys
# ============================================
*_KEY=*
*_SECRET=*
*_TOKEN=*
*_PASSWORD=*
*_CREDENTIALS=*
Bearer *
sk-*
sk-ant-*
ghp_*
gho_*
glpat-*
xoxb-*
xoxp-*
AKIA*
-----BEGIN*PRIVATE KEY-----
-----BEGIN*RSA*-----

# ============================================
# PII (Personally Identifiable Information)
# ============================================
*@*.com
*@*.de
*@*.org
*@*.net
*@*.io

# ============================================
# Prompt Injection Patterns
# ============================================
ignore all previous*
ignore prior*
disregard*instructions*
you are now*
new system prompt*
override*safety*
act as*unrestricted*
jailbreak*

# ============================================
# Internal Infrastructure
# ============================================
# Add your internal hostnames, IPs, endpoints here
# 10.0.0.*
# 192.168.*
# *.internal.company.com
`
}

// ── Main init function ────────────────────────────────────────────────────────

/**
 * Bootstrap AAHP v3 handoff files in the given directory.
 *
 * @param targetDir  Root of the project to initialize (defaults to cwd)
 * @param force      Overwrite existing files
 */
export function initProject(targetDir: string, force: boolean): InitResult {
  const handoffDir = path.join(targetDir, '.ai', 'handoff')
  const logsDir    = path.join(handoffDir, 'logs')

  // Detect project name from package.json, fall back to directory name
  let projectName = path.basename(targetDir)
  const pkgPath = path.join(targetDir, 'package.json')
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string }
      if (pkg.name) {
        // Strip npm scope prefix (@scope/name -> name)
        projectName = pkg.name.replace(/^@[^/]+\//, '')
      }
    } catch { /* use directory name */ }
  }

  const now  = new Date().toISOString()
  const date = now.slice(0, 10)

  // Files to create: [relative path inside handoffDir, content]
  const files: Array<[string, string]> = [
    ['MANIFEST.json',   tplManifest(projectName, now)],
    ['STATUS.md',       tplStatus(projectName, date)],
    ['NEXT_ACTIONS.md', tplNextActions(projectName)],
    ['LOG.md',          tplLog(projectName, date)],
    ['LOG-ARCHIVE.md',  tplLogArchive(projectName)],
    ['DASHBOARD.md',    tplDashboard(projectName, date)],
    ['CONVENTIONS.md',  tplConventions(projectName)],
    ['TRUST.md',        tplTrust(projectName, date)],
    ['WORKFLOW.md',     tplWorkflow(projectName)],
    ['.aiignore',       tplAiignore()],
  ]

  // Ensure directories exist
  fs.mkdirSync(handoffDir, { recursive: true })
  fs.mkdirSync(logsDir,    { recursive: true })

  const created: string[] = []
  const skipped: string[] = []

  for (const [relPath, content] of files) {
    const fullPath = path.join(handoffDir, relPath)
    if (fs.existsSync(fullPath) && !force) {
      skipped.push(relPath)
    } else {
      fs.writeFileSync(fullPath, content, 'utf8')
      created.push(relPath)
    }
  }

  // Add .ai/logs/ to .gitignore if not already present
  maybeGitignore(targetDir)

  return { created, skipped, projectName, handoffDir }
}

function maybeGitignore(targetDir: string): void {
  const gitignorePath = path.join(targetDir, '.gitignore')
  const entry = '.ai/logs/'
  try {
    const existing = fs.existsSync(gitignorePath)
      ? fs.readFileSync(gitignorePath, 'utf8')
      : ''
    if (!existing.includes(entry)) {
      fs.writeFileSync(
        gitignorePath,
        existing + (existing.endsWith('\n') || existing === '' ? '' : '\n') + `\n# AAHP agent run logs (auto-generated)\n${entry}\n`,
        'utf8'
      )
    }
  } catch { /* best-effort */ }
}
