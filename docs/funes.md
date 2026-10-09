# Funes memory for agent sessions

[Funes](https://github.com/huggingface/funes) is Hugging Face's durable, searchable
memory for coding-agent sessions. This repository wires it into Amp threads: past
threads for this repo are exported into the Funes turns format, indexed locally, and
(optionally) published to a private dataset on the Hugging Face Hub. Any thread can
then recall prior decisions, rationale, and findings from them.

## What is installed

- `scripts/funes-sync.mjs` — exports Amp threads (`amp threads list/export`) into
  `~/.funes/spool/amp/` as `.funes.jsonl` turns files, then runs `funes index` and
  `funes push`. Conventions follow the community integrations
  ([funes-integrations](https://github.com/huggingface/funes-integrations)): stable
  turn ids (`protocolMessageID`), dense `seq` over emitted turns (empty turns kept),
  and the harness facet `amp`.
- `.agents/setup` installs the `funes` binary and TruffleHog in every orb.

## Orbs are ephemeral

The local index lives in `~/.funes`, which dies with the orb. Durability comes from
the Hub: `funes push` publishes the local chunks to a private `<user>/<repo>`
dataset, and `funes recall --memory <user>/<repo>` (or `funes mcp <user>/<repo>`)
reads it from anywhere, caching files locally after the first read. Pushing after
each sync keeps the remote memory current.

## Commands

```sh
# threads for this repo, newest first
node scripts/funes-sync.mjs list

# export + convert only (writes ~/.funes/spool/amp/)
node scripts/funes-sync.mjs convert [--since 2026-10-01] [--limit 20] [--all]

# convert + index + publish to your memory
node scripts/funes-sync.mjs sync --memory <user>/<repo> [--yes]

# same, but only threads updated since the last successful push
# (watermark in ~/.cache/funes-sync/last-sync; a full run when absent)
node scripts/funes-sync.mjs sync --memory <user>/<repo> --yes --all --incremental

# recall directly (works from any machine holding the token, or on the public memory)
funes recall "why did we switch TTS provider" --memory <user>/<repo>
funes get <session-id> --from 0 --to 5 --memory <user>/<repo>
```

## Requirements

- **Token**: `HF_TOKEN` (Amp Secrets & Env Vars) — read scope to recall a private
  memory, write scope on the target dataset repo to publish. Precedence:
  `HF_TOKEN`, `HUGGING_FACE_HUB_TOKEN`, `HUGGINGFACE_TOKEN`,
  `~/.cache/huggingface/token`. Public-memory recall needs no token.
- **TruffleHog** on PATH for any `funes push`: the secrets gate fails closed
  without it. Index time already redacts detected credentials when it is present.
- The push target must be a dataset repo you own; first publish writes its dataset
  card. The remote is append-only — nothing retracts a session once published, and
  `--yes` skips the wrong-memory guard for non-interactive runs.

## Reading from Amp threads

`funes mcp [MEMORY]` serves six read tools over stdio MCP — `recall`, `get`,
`scan`, `sessions`, `sketch`, `status` — bound to `acramatte/funes-memory`. This
repository registers it in `.amp/settings.json` under `amp.mcpServers`, so
threads in this project pick it up automatically. The MCP path is read-only —
publishing goes through `scripts/funes-sync.mjs sync`.

Workspace MCP servers need one-time trust per machine: when `amp mcp doctor`
reports `funes: awaiting approval`, run `amp mcp approve funes` once.

## Publication scoping

`funes push` publishes the local index wholesale, so filter flags only bound
what gets converted, not what gets published. The script closes that gap: a
scoped run (any filter active, `--incremental` included) pushes only the
sessions it just converted, via `push --sessions`; an unrestricted full run
publishes the whole local index by design. An empty selection skips the push.

## Automatic sync

A nightly Amp schedule ("Nightly Funes memory sync", hosted by the thread that
set it up) starts a fresh child thread at 02:00 Europe/Zurich that runs the
`--all --incremental` sync against `acramatte/funes-memory`, scrubs and
re-pushes when the secrets gate holds rows back, and stops with a short report.
Orbs are stateless workers here: thread data lives on ampcode.com, so one
scheduled run covers every non-archived thread on the account. The local index
survives pause/resume within an orb's lifetime; when an orb is replaced, the
watermark is gone, so the first run re-exports and re-embeds everything the
remote does not already have — a one-time cost per orb.

## Coverage and caveats

- `user`, `assistant`, and their tool blocks map to turns with `text`,
  `thinking`, `tool_use`, and `tool_result` blocks; unknown block types are
  dropped, and messages that map to nothing become empty turns so a re-emit
  reproduces the same dense `seq`.
- Chunk ids derive from `session_id`, `turn_uuid`, and block position — not
  text. A thread is append-only from the converter's point of view: edits made
  to already-published messages keep their identity, so Funes is append-only
  and the edited text appears as additional rows alongside the stale ones, and
  reordered or inserted messages can shift the stored `seq` of later turns.
  Treat the memory as a record of what was said when, not a mirror of the
  thread's current state.
- A thread being written concurrently can export a torn snapshot; the sync
  skips such a thread whole and picks it up on a later run.
- Excluding thinking blocks is an index-time flag (`funes index --no-thinking`),
  not a conversion-time one, so the spool stays faithful to the source.
