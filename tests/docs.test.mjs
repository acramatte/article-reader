import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { limits } from "../streaming-api.mjs";

const root = new URL("..", import.meta.url).pathname;
const read = path => readFileSync(join(root, path), "utf8");

// The backend configuration table in docs/development.md: variable → documented default.
const table = new Map([...read("docs/development.md").matchAll(/^\| `([A-Z_]+)` \| ([^|]+?) \|/gm)]
  .map(([, name, fallback]) => [name, fallback.replace(/^`|`$/g, "")]));

test("the backend configuration table documents every environment variable the reader reads", () => {
  const runtime = readdirSync(root).filter(name => name.endsWith(".mjs") && !name.startsWith("playwright"));
  const used = new Set(runtime.flatMap(name => [...read(name).matchAll(/process\.env\.([A-Z_]+)/g)].map(match => match[1])));
  for (const [name] of Object.values(limits)) used.add(name);
  assert.deepEqual([...used].filter(name => !table.has(name)), [], "add these to docs/development.md#backend-configuration");
  assert.deepEqual([...table.keys()].filter(name => !used.has(name)), [], "the table documents variables nothing reads");
});

test("the table's defaults are the code's defaults", () => {
  for (const [name, fallback] of Object.values(limits)) assert.equal(table.get(name), String(fallback), name);
  // server.mjs is the reader's entry point; the diagnostic streaming-server.mjs has its own port.
  const defaults = [...read("server.mjs").matchAll(/process\.env\.([A-Z_]+) \|\| "?([^"\s)]+)"?/g)];
  assert.ok(defaults.length >= 4);
  for (const [, name, fallback] of defaults) assert.equal(table.get(name), fallback, name);
});
