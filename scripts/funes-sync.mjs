#!/usr/bin/env node
// Export Amp threads into the Funes turns format, index them into the local
// memory, and publish to a memory on the Hugging Face Hub.
//
//   node scripts/funes-sync.mjs list                       # threads for this repo
//   node scripts/funes-sync.mjs convert [options]          # export + write spool files
//   node scripts/funes-sync.mjs sync --memory <user>/<repo> [options]
//                                                          # convert + funes index + funes push
//
// Options:
//   --memory <user>/<repo>   Target memory for `sync` (or FUNES_MEMORY env).
//   --thread <id>            Only this thread (repeatable).
//   --all                    Include threads from every repository, not just this one.
//   --since <YYYY-MM-DD>     Only threads updated on or after this date.
//   --incremental            Only threads updated since the last successful push of
//                            the same scope (watermark in ~/.cache/funes-sync/);
//                            a full run when no watermark exists. Cannot be
//                            combined with --limit or --thread, and an explicit
//                            --since run does not advance the watermark.
//   --limit <n>              Cap the number of threads.
//   --dry-run                Convert and validate with `funes index --check`,
//                            but skip indexing and publishing.
//   --yes                    Forwarded to `funes push` (skips the wrong-memory
//                            guard; off a terminal, push refuses without it).
//
// Publication scoping: `funes push` publishes the local index wholesale, so a
// scoped run (any filter active) pushes only the sessions it just converted via
// `push --sessions`; an unrestricted run publishes everything the local memory
// holds. An empty selection skips the push entirely.
//
// Requires the `funes` binary on PATH. `sync` additionally needs:
//   - HF_TOKEN (read for private recall, write to the target dataset repo for push)
//   - TruffleHog on PATH: the push secrets gate refuses to run without it
//
// Conventions follow the community integrations (github.com/huggingface/
// funes-integrations): spool files at ~/.funes/spool/amp/, chunk-stable turn
// ids, and funes --no-thinking at index time rather than at conversion time.
// The turns contract is documented at
// https://github.com/huggingface/funes/blob/main/docs/funes-jsonl.md.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HARNESS = "amp";
// funes drains the spool after storing its content; a full re-emit each run
// keeps the spool the single source of truth, and chunk-id dedup makes it cheap.
const SPOOL_DIR = path.join(
  process.env.FUNES_HOME ?? path.join(os.homedir(), ".funes"),
  "spool",
  HARNESS,
);
const WATERMARK_DIR = path.join(os.homedir(), ".cache", "funes-sync");

function usage(message) {
  if (message) console.error(`funes-sync: ${message}`);
  console.error("Run with no arguments for usage.");
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    command: argv[0] ?? "usage",
    memory: process.env.FUNES_MEMORY ?? null,
    threads: [],
    all: false,
    since: null,
    incremental: false,
    limit: null,
    dryRun: false,
    yes: false,
  };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--memory":
        options.memory = argv[++i];
        break;
      case "--thread":
        options.threads.push(argv[++i]);
        break;
      case "--all":
        options.all = true;
        break;
      case "--since":
        options.since = argv[++i];
        break;
      case "--incremental":
        options.incremental = true;
        break;
      case "--limit":
        options.limit = Number(argv[++i]);
        if (!Number.isInteger(options.limit) || options.limit < 1) usage(`--limit needs a positive integer`);
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--yes":
        options.yes = true;
        break;
      default:
        usage(`unknown option ${arg}`);
    }
  }
  return options;
}

function run(command, args, { showStderr = false } = {}) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      // Inherit stdin so an interactive push can ask its wrong-memory
      // question; unattended runs see EOF and funes refuses, as designed.
      stdio: ["inherit", "pipe", showStderr ? "inherit" : "pipe"],
    });
  } catch (error) {
    // Do not echo captured child output: exports carry conversation content
    // and funes errors can quote turn text. Name the command, not the output.
    const status = error?.status ?? "unknown exit";
    throw new Error(`\`${command} ${args[0] ?? ""}\` failed (exit ${status})`.trim());
  }
}

function treeToPath(tree) {
  if (typeof tree !== "string") return null;
  try {
    return fileURLToPath(tree);
  } catch {
    return null;
  }
}

function listThreads() {
  const parsed = JSON.parse(run("amp", ["threads", "list", "--json"]));
  if (!Array.isArray(parsed)) throw new Error("unexpected `amp threads list --json` output");
  return parsed;
}

function selectThreads(options) {
  const root = process.cwd();
  let threads = listThreads();
  if (!options.all) {
    threads = threads.filter((t) => treeToPath(t.tree) === root);
    if (threads.length === 0) {
      console.error(`funes-sync: no threads found for ${root} (use --all to include every thread)`);
      process.exit(1);
    }
  }
  if (options.threads.length > 0) {
    const wanted = new Set(options.threads);
    threads = threads.filter((t) => wanted.has(t.id));
  }
  if (options.since) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(options.since)) usage(`--since needs a YYYY-MM-DD date`);
    const since = Date.parse(`${options.since}T00:00:00Z`);
    if (Number.isNaN(since)) usage(`--since needs a real calendar date`);
    threads = threads.filter((t) => Date.parse(t.updated) >= since);
  }
  threads.sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
  if (options.limit) threads = threads.slice(0, options.limit);
  return threads;
}

const MAX_BLOCK_TEXT = 512 * 1024;

function blockText(value) {
  const text = value ?? "";
  return typeof text === "string" && text.length > MAX_BLOCK_TEXT
    ? `${text.slice(0, MAX_BLOCK_TEXT)}\n… [truncated by funes-sync]`
    : text;
}

// Amp export block -> funes block. Unknown types are dropped: the turns
// contract rejects files carrying unrecognized block types.
function toFunesBlocks(blocks) {
  const out = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    switch (block?.type) {
      case "text":
        if (block.text) out.push({ block_type: "text", text: blockText(block.text) });
        break;
      case "thinking":
        if (block.text) out.push({ block_type: "thinking", text: blockText(block.text) });
        break;
      case "tool_use":
        out.push({
          block_type: "tool_use",
          tool_name: block.name ?? "unknown",
          tool_use_id: block.id,
          text: blockText(JSON.stringify(block.input ?? {}, null, 2)),
        });
        break;
      case "tool_result": {
        const output = block.run?.result?.output;
        const status = block.run?.status;
        const text = output != null ? String(output) : status ? `[status: ${status}]` : "";
        out.push({
          block_type: "tool_result",
          tool_use_id: block.toolUseID,
          text: blockText(text),
        });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

// A turn's identity must be stable across re-emits and free of ':' (it feeds
// the ':'-joined chunk id). Amp's protocolMessageID is that id; the numeric
// per-thread messageId is the fallback; anything else is refused rather than
// derived from array position, which a re-emit could not reproduce.
function turnIdentity(message, threadId, seq) {
  for (const candidate of [message.protocolMessageID, message.messageId]) {
    if (typeof candidate === "string" && /^[A-Za-z0-9_-]+$/.test(candidate)) return candidate;
    if (typeof candidate === "number" && Number.isInteger(candidate)) return String(candidate);
  }
  throw new Error(
    `message ${seq} of thread ${threadId} has no stable identifier (protocolMessageID or messageId)`,
  );
}

function turnTimestamp(message, threadId, seq) {
  const date = message.createdAt ? new Date(message.createdAt) : null;
  if (!date || Number.isNaN(date.getTime())) {
    throw new Error(`message ${seq} of thread ${threadId} has no usable createdAt timestamp`);
  }
  return date.toISOString();
}

// One message -> one turn. Messages with no mappable blocks become empty turns
// (they contribute no rows) so a re-emit always reproduces the same dense seq.
// cwd is the turn's own working directory when it exists on this machine —
// never the syncing checkout's, which would misattribute --all threads.
function convertThread(thread, cwd) {
  const lines = [];
  let seq = 0;
  let prev = null;
  for (const message of thread.messages) {
    const turnUuid = turnIdentity(message, thread.id, seq);
    const turn = {
      format: 1,
      session_id: thread.id,
      turn_uuid: turnUuid,
      seq: seq++,
      ts: turnTimestamp(message, thread.id, seq),
      role: message.role,
      harness: HARNESS,
      ...(cwd ? { cwd } : {}),
      ...(prev ? { parent_uuid: prev } : {}),
      blocks: toFunesBlocks(message.content),
    };
    lines.push(JSON.stringify(turn));
    prev = turnUuid;
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

function exportThread(threadId) {
  const thread = JSON.parse(run("amp", ["threads", "export", threadId]));
  if (!Array.isArray(thread.messages)) throw new Error(`thread ${threadId} has no messages array`);
  return thread;
}

function writeSpoolFile(threadId, content) {
  fs.mkdirSync(SPOOL_DIR, { recursive: true, mode: 0o700 });
  const target = path.join(SPOOL_DIR, `${threadId}.funes.jsonl`);
  // Temporary name off .jsonl: funes lists every .jsonl in the directory, and a
  // half-written turns file would reject the whole directory.
  const tmp = path.join(SPOOL_DIR, `.${threadId}.${process.pid}.tmp`);
  try {
    // The spool holds conversation text before funes redacts it: keep it
    // owner-only.
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return target;
}

// The watermark records a day D such that every thread updated before D has
// been synced for this scope. A run selects threads updated on/after D and,
// after a successful push, writes its *selection start day* back — not the
// completion day, so a thread updated between selection and midnight is still
// covered by the next run. Scoped or filtered runs must not advance it.
function watermarkFile(options) {
  const scope = options.all ? "all" : createHash("sha1").update(process.cwd()).digest("hex").slice(0, 12);
  return path.join(WATERMARK_DIR, `last-sync-${scope}`);
}

function resolveSince(options) {
  if (!options.incremental || options.since) return options;
  try {
    const stored = fs.readFileSync(watermarkFile(options), "utf8").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(stored)) options.since = stored;
  } catch {
    /* no watermark yet: full run */
  }
  return options;
}

function writeWatermark(options) {
  const day = options.selectionDay ?? new Date().toISOString().slice(0, 10);
  fs.mkdirSync(WATERMARK_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(watermarkFile(options), `${day}\n`, { mode: 0o600 });
  return day;
}

function convert(options) {
  resolveSince(options);
  const root = process.cwd();
  const threads = selectThreads(options);
  // Selection start day (UTC): what the next run's watermark may claim.
  options.selectionDay = options.since ?? new Date().toISOString().slice(0, 10);
  const sessions = [];
  for (const entry of threads) {
    let thread;
    try {
      thread = exportThread(entry.id);
      const treePath = treeToPath(entry.tree);
      const cwd = treePath && fs.existsSync(treePath) ? treePath : undefined;
      const content = convertThread(thread, cwd);
      writeSpoolFile(entry.id, content);
    } catch (error) {
      // A thread being written concurrently can export a torn snapshot (a
      // message without a timestamp or identifier yet). Skip it whole — its
      // next run picks it up complete — rather than emit a file that shifts
      // identity or seq on re-emit.
      console.error(`  skipped ${entry.id} (${entry.title ?? "untitled"}): ${error.message}`);
      continue;
    }
    sessions.push(entry.id);
    console.log(`  ${entry.id}  ${thread.messages.length} msgs  ${entry.title ?? ""}`);
  }
  console.log(`converted ${threads.length} thread(s), ${sessions.length} spool file(s) at ${SPOOL_DIR}`);
  return sessions;
}

function validateMemory(memory) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(memory ?? "")) {
    usage(`--memory needs an <org>/<repo> dataset name, got "${memory}"`);
  }
}

function indexAndPush(options, sessions) {
  if (options.dryRun) {
    // Validate everything currently in the spool without writing to the memory.
    run("funes", ["index", "--check", SPOOL_DIR], { showStderr: true });
    console.log("funes-sync: dry run — spool validated, index and push skipped");
    return;
  }
  run("funes", ["index", "--harness", HARNESS, "--yes"], { showStderr: true });
  if (!options.memory) {
    console.error("funes-sync: --memory <user>/<repo> is required for push");
    process.exit(2);
  }
  if (sessions.length === 0) {
    console.log("funes-sync: nothing converted — push skipped");
    return;
  }
  const pushArgs = ["push", options.memory];
  if (options.yes) pushArgs.push("--yes");
  // A scoped run must publish only what it converted: an unrestricted push
  // would send the whole local index, whatever filters selected.
  const scoped = !options.all || options.limit !== null || options.threads.length > 0 || options.since !== null;
  if (scoped) for (const id of sessions) pushArgs.push("--sessions", id);
  const out = run("funes", pushArgs, { showStderr: true });
  if (out.trim()) console.log(out.trim());
  // An explicit --since selection is narrower than the watermark's claim, so it
  // must not advance it.
  if (options.incremental && !options.explicitSince) {
    console.log(`watermark: ${writeWatermark(options)}`);
  }
}

const options = parseArgs(process.argv.slice(2));
switch (options.command) {
  case "list": {
    for (const t of selectThreads(options)) {
      console.log(`${t.id}  ${t.updated}  ${t.messageCount ?? "?"} msgs  ${t.title ?? ""}`);
    }
    break;
  }
  case "convert":
    convert(options);
    break;
  case "sync": {
    validateMemory(options.memory);
    if (options.incremental && (options.limit !== null || options.threads.length > 0)) {
      usage(
        "--incremental cannot be combined with --limit or --thread: advancing the " +
          "watermark would skip threads those options exclude",
      );
    }
    if (options.since) options.explicitSince = true;
    const sessions = convert(options);
    indexAndPush(options, sessions);
    break;
  }
  default:
    console.log("Usage: node scripts/funes-sync.mjs <list|convert|sync> [options]");
    console.log("  sync needs --memory <user>/<repo>; see the header of this file for all options.");
    process.exit(options.command === "usage" ? 0 : 2);
}
