import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const read = path => readFileSync(join(root, path), "utf8");

// Dockerfile stages, each with the local sources of its COPY instructions (not --from copies).
function dockerStages() {
  const stages = [];
  for (const line of read("Dockerfile").replace(/\\\n/g, " ").split("\n")) {
    const [instruction, ...words] = line.trim().split(/\s+/);
    if (/^FROM$/i.test(instruction)) stages.push({ name: words.at(-1), sources: [] });
    if (/^COPY$/i.test(instruction) && !words.some(word => word.startsWith("--from="))) {
      stages.at(-1).sources.push(...words.filter(word => !word.startsWith("--")).slice(0, -1).map(source => normalize(source).replace(/\/$/, "")));
    }
  }
  return stages;
}

const files = path => statSync(join(root, path)).isDirectory()
  ? readdirSync(join(root, path), { recursive: true }).map(name => join(path, name)).filter(name => statSync(join(root, name)).isFile())
  : [path];

// Docker's rules: the last matching pattern wins, and a pattern matching a directory matches its contents.
function sentToBuilder(path) {
  let included = true;
  for (let pattern of read(".dockerignore").split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("#"))) {
    const negated = pattern.startsWith("!");
    pattern = normalize(pattern.slice(negated ? 1 : 0)).replace(/^\/|\/$/g, "");
    const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/|\*\*|\*|\?/g,
      token => ({ "**/": "(?:.*/)?", "**": ".*", "*": "[^/]*", "?": "[^/]" })[token])}(?:/.*)?$`);
    if (regex.test(path)) included = negated;
  }
  return included;
}

// Local files an entry point loads: relative imports, worker/module URLs, and an HTML page's root assets.
function localDependencies(entries) {
  const found = new Set();
  const visit = path => {
    if (found.has(path)) return;
    found.add(path);
    const source = read(path);
    const specifiers = path.endsWith(".html")
      ? [...source.matchAll(/(?:src|href)="\/([^"]+)"/g)].map(match => existsSync(join(root, match[1])) ? match[1] : join("public", match[1]))
      : [...source.matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"|new URL\("(\.{1,2}\/[^"]+)", import\.meta\.url\)/g)]
        .map(match => join(dirname(path), match[1] ?? match[2]));
    specifiers.forEach(visit);
  };
  entries.forEach(visit);
  return [...found];
}

test(".dockerignore sends every Dockerfile COPY source to the builder", () => {
  const sources = dockerStages().flatMap(stage => stage.sources);
  assert.ok(sources.length > 0);
  const withheld = sources.flatMap(files).filter(path => !sentToBuilder(path));
  assert.deepEqual(withheld, [], "Allowlist these in .dockerignore, or the image build fails with \"not found\"");
});

test(".dockerignore withholds files the image does not copy", () => {
  for (const path of [".env", "pocket-tts-service/app.py", "tests/server.test.mjs", "docs/README.md", "node_modules/vite/package.json"]) {
    assert.equal(sentToBuilder(path), false, path);
  }
});

test("each image stage copies every local module its entry points load", () => {
  const stages = Object.fromEntries(dockerStages().map(stage => [stage.name, stage.sources]));
  const copied = (stage, path) => stages[stage].some(source => path === source || path.startsWith(`${source}/`));
  // The runtime starts server.mjs, or streaming-server.mjs for the diagnostic page; Vite builds index.html.
  for (const [stage, entries] of [["runtime", ["server.mjs", "streaming-server.mjs"]], ["build", ["index.html", "vite.config.js"]]]) {
    const missing = localDependencies(entries).filter(path => !copied(stage, path));
    assert.deepEqual(missing, [], `Add these to the ${stage} stage's COPY in the Dockerfile`);
  }
});
