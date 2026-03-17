# aahp-runner: Agent Conventions

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

We are human beings and will remain human beings. Tasks are delegated to AI only when we choose to delegate them. **Do no damage** is the highest rule.

---

## Language

- All code, comments, commits, and documentation in **English only**
- Use clear, direct language in handoff files (agents are the primary readers)

## Code Style

- **TypeScript:** strict mode, ESM (`"type": "module"`), no `any` unless unavoidable
- **Imports:** always use `.js` extension in ESM imports (e.g. `import { foo } from './bar.js'`)
- **JSON:** 2-space indentation, no trailing commas
- **Markdown:** ATX headers, tables with alignment, code blocks with language tags
- **No em dashes (`-`)**: never use Unicode em dashes anywhere - use a regular hyphen (`-`)

## Branching & Commits

```
feat/<scope>-<short-name>    - new feature
fix/<scope>-<short-name>     - bug fix
docs/<scope>-<short-name>    - documentation only
refactor/<scope>-<name>      - no behaviour change

Commit format:
  feat(scope): description [AAHP-auto]
  fix(scope): description [AAHP-auto]
  docs(scope): description [AAHP-auto]
```

## File Organization

- `src/` - TypeScript source files
  - `cli.ts` - Commander.js entry point (commands: list, run, config, schedule, status)
  - `agent.ts` - Backend implementations (claude-cli, copilot, sdk)
  - `scanner.ts` - Project scanning and system prompt building
  - `scheduler.ts` - Windows Task Scheduler + config persistence
  - `tools.ts` - Tool definitions for SDK/Copilot backends
  - `types.ts` - Shared TypeScript interfaces
- `dist/` - Compiled output (do not edit)
- `.ai/handoff/` - aahp-runner's own handoff files (dogfooding)

## Architecture Principles

- **Multi-backend:** claude-cli (Claude Code) > GitHub Copilot > Anthropic SDK - prefer in that order
- **No API key required:** when Claude Code VS Code extension is installed
- **Portable:** cli.ts must work on Windows, Linux, macOS
- **Git-native:** config in `~/.aahp-runner.json`, handoff files in repo

## Build & Compile

- `npm run build` - compiles TypeScript to `dist/`
- `npm run dev` - run with ts-node directly (dev only)
- Always run `npm run build` before committing to verify compilation

## Testing

- No automated tests yet (T-002 pending)
- Manually test `aahp list`, `aahp status` against the _Development folder before committing
- Verify `npm run build` passes cleanly

## What Agents Must NOT Do

- **Violate the Three Laws** - never cause damage to data, systems, or people
- Push directly to `main` without human approval
- Write secrets, credentials, or API keys into any file
- Delete existing source files without providing a replacement
- Use em dashes anywhere in the codebase
- Modify `~/.aahp-runner.json` directly (use the config command)

---

*This file is maintained by agents and humans together. Update it when conventions evolve.*

---

## 🚨 Release-Regel: Erst fertig, dann publishen (gilt für ALLE Plattformen)

**IMMER erst alles fertigstellen, danach publishen. Kein einziger Commit mehr dazwischen.**
Gilt für GitHub, npm, ClawHub, PyPI — egal ob ein Projekt auf einer oder mehreren Plattformen ist.
Sonst divergieren die Tarballs/Releases zwangsläufig.

### Reihenfolge (nie abweichen)
1. Alle Änderungen + Versionsbumps in **einem einzigen Commit** abschließen
2. `git push` → Plattform 1 (z.B. GitHub)
3. `npm publish` / `clawhub publish` / etc. — alle weiteren Plattformen
4. Kein weiterer Commit bis zum nächsten Release (außer reine interne Doku)

### Vor jedem Release: Alle Versionsstellen prüfen
```bash
grep -rn "X\.Y\.Z\|Current version\|Version:" \
  --include="*.md" --include="*.json" \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git
```
Typische vergessene Stellen: `README.md` Header, `SKILL.md` Footer, `package.json`,
`openclaw.plugin.json`, `.ai/handoff/STATUS.md` (Header + Plattform-Zeilen), Changelog-Eintrag.

### Secrets & private Pfade — NIEMALS in Repos
- Keine API Keys, Tokens, Passwörter, Secrets in Code oder Docs
- Keine absoluten lokalen Pfade (`/home/user/...`) in publizierten Dateien
- Keine `.env`-Dateien committen — immer in `.gitignore`
- Vor jedem Push: `git diff --staged` auf Secrets prüfen
