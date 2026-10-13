# Funes memory for agent sessions

[Funes](https://github.com/huggingface/funes) is Hugging Face's durable, searchable
memory for coding-agent sessions. This repository wires it into Amp threads: any
thread in this project can recall prior decisions, rationale, and findings from
the private `acramatte/funes-memory` dataset on the Hugging Face Hub.

Publishing is not done from this repository. The nightly sync lives in the
dedicated [`acramatte/funes-memory-sync`](https://github.com/acramatte/funes-memory-sync)
repository, whose Amp schedule exports threads from every repository on the
account into the Funes turns format, indexes them, and pushes them to the Hub.
That repo also documents the turns contract and its coverage caveats.

## What is installed

- `.agents/setup` installs the `funes` binary in every orb.
- `.amp/settings.json` registers `funes mcp acramatte/funes-memory` under
  `amp.mcpServers`, so threads in this project pick up the read tools
  automatically.

## Orbs are ephemeral

Nothing memory-related is stored in the orb. Durability comes from the Hub:
`funes recall --memory acramatte/funes-memory` (or `funes mcp
acramatte/funes-memory`) reads it from anywhere, caching files locally after
the first read.

## Reading from Amp threads

`funes mcp [MEMORY]` serves six read tools over stdio MCP — `recall`, `get`,
`scan`, `sessions`, `sketch`, `status` — bound to `acramatte/funes-memory`.
The MCP path is read-only — publishing goes through
`acramatte/funes-memory-sync`.

Workspace MCP servers need one-time trust per machine: when `amp mcp doctor`
reports `funes: awaiting approval`, run `amp mcp approve funes` once.

## Commands

```sh
# recall directly (works from any machine holding the token)
funes recall "why did we switch TTS provider" --memory acramatte/funes-memory
funes get <session-id> --from 0 --to 5 --memory acramatte/funes-memory
```

## Requirements

- **Token**: `HF_TOKEN` (Amp Secrets & Env Vars) — read scope to recall a
  private memory. Precedence: `HF_TOKEN`, `HUGGING_FACE_HUB_TOKEN`,
  `HUGGINGFACE_TOKEN`, `~/.cache/huggingface/token`. Public-memory recall
  needs no token.
- The remote is append-only — nothing retracts a session once published.
  Treat the memory as a record of what was said when, not a mirror of the
  thread's current state (see the caveats in `funes-memory-sync`).
