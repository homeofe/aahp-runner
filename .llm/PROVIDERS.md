# LLM Provider Capabilities Matrix

> Reference for choosing between providers. Updated as models evolve.

## Provider Comparison

| Provider | Model | Context | Tools | Code Exec | Web Search | Vision | Cost (Input/Output per 1M) |
|----------|-------|---------|-------|-----------|------------|--------|---------------------------|
| Anthropic | Opus 4.6 | 1M | Yes | Via Bash | No | Yes | $5 / $25 |
| Anthropic | Sonnet 4.6 | 1M | Yes | Via Bash | No | Yes | $3 / $15 |
| Anthropic | Haiku 4.5 | 200K | Yes | Via Bash | No | Yes | $1 / $5 |
| OpenAI | GPT-5.4 | 128K | Yes | Yes | Yes | Yes | ~$2 / $10 |
| OpenAI | GPT-4-mini | 128K | Yes | Yes | Yes | Yes | ~$0.15 / $0.60 |
| OpenAI | Codex | 192K | Yes | Yes | No | No | ~$2 / $10 |
| OpenAI | o4-mini | 200K | Yes | Yes | Yes | Yes | ~$1 / $4 |
| Google | Gemini 2.5 Pro | 1M | Yes | Yes | Yes | Yes | ~$1.25 / $10 |
| Google | Gemini 2.5 Flash | 1M | Yes | Yes | Yes | Yes | ~$0.15 / $0.60 |
| xAI | Grok 4.20 | 131K | Yes | No | Yes | Yes | ~$2 / $10 |
| Perplexity | Sonar Pro | 200K | No | No | Built-in | No | ~$3 / $15 |
| Perplexity | Deep Research | 200K | No | No | Built-in | No | ~$5 / $25 |
| Local | LM Studio / Ollama | 4-128K | Limited | Via shell | No | Some | Free |

*Prices are approximate and change frequently. Check provider pricing pages for current rates.*

## Capability Deep Dive

### Best for Research
1. **Perplexity** - Built-in web search with citations
2. **Grok** - Real-time knowledge, good reasoning
3. **Gemini** - Can ground with Google Search

### Best for Coding
1. **Claude Sonnet/Opus** - Best code quality, understands complex codebases
2. **Codex** - Optimized for code, fast execution
3. **Gemini Pro** - Good code + massive context window

### Best for Reasoning
1. **Claude Opus** - Deep analysis, architecture decisions
2. **GPT-4** - Strong logical reasoning
3. **o4-mini** - Chain-of-thought reasoning, cost-effective

### Best for Large Context
1. **Gemini Pro/Flash** - 1M tokens, no surcharge
2. **Claude Opus/Sonnet** - 1M tokens (surcharge above 200K on API)
3. **Perplexity** - 200K but web-augmented

### Best for Privacy
1. **Local LLM** - Never leaves your machine
2. **Claude** - Strong privacy commitments
3. **Self-hosted** - Full control

### Best for Cost
1. **Local LLM** - Free
2. **Gemini Flash / GPT-4-mini** - Very cheap
3. **Haiku** - Cheap with good quality

## Tool Use Capabilities

| Provider | Function Calling | MCP | Computer Use | File I/O |
|----------|-----------------|-----|-------------|----------|
| Claude | Yes | Yes (native) | Yes | Via tools |
| GPT | Yes | Via adapters | No | Via code exec |
| Gemini | Yes | Via adapters | No | Via CLI |
| Grok | Yes | No | No | No |
| Perplexity | No | No | No | No |
| Local LLM | Some models | No | No | Via shell |

## Choosing by Use Case

### Daily Development
- **Default**: Claude Sonnet (balanced)
- **Budget**: Gemini Flash or local LLM
- **Quality**: Claude Opus

### Code Review
- **Security-focused**: Claude Opus + GPT-4 cross-check
- **General**: Use a different provider than implementer
- **Automated**: akido-mcp `akido_review_diff`

### Research & Learning
- **Quick facts**: Perplexity sonar
- **Deep analysis**: Perplexity deep-research
- **Code examples**: Gemini (large context for docs)

### Multi-Agent Workflows (AAHP)
- **Researcher**: Perplexity or Gemini (web-grounded)
- **Architect**: Opus or GPT-4 (reasoning)
- **Implementer**: Sonnet or Codex (fast coding)
- **Reviewer**: Different provider than implementer
