import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

test("inference images install only hash-locked requirements", () => {
  for (const service of ["pocket-tts-service", "kokoro-service"]) {
    const requirements = read(`${service}/requirements.txt`).replace(/\\\n/g, " ").split("\n")
      .map(line => line.trim()).filter(line => line && !line.startsWith("#") && !line.startsWith("--"));
    assert.ok(requirements.length > 0, service);
    // Regenerate with the command at the top of requirements.txt, which includes --generate-hashes.
    assert.deepEqual(requirements.filter(line => !/^\S+(?:==\S+| @ \S+) .*--hash=sha256:[0-9a-f]{64}/.test(line)), [], `${service}: unpinned or unhashed`);
    const installs = read(`${service}/Dockerfile`).split("\n").filter(line => /\bpip install\b/.test(line));
    assert.ok(installs.length > 0 && installs.every(line => line.includes("--require-hashes")), `${service}: pip install needs --require-hashes`);
  }
});

// Compose's own reading of compose.yaml, after interpolation. Needs the Docker Compose CLI, not a daemon; CI always runs it.
function composeConfig(env) {
  try {
    return JSON.parse(execFileSync("docker", ["compose", "-f", join(root, "compose.yaml"), "config", "--format", "json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, READER_IMAGE: "reader:test",
        TTS_URL: "https://tts.example.test/tts", READER_INFERENCE_ENV_FILE: "/dev/null", ...env } }));
  } catch (error) {
    if (error.code === "ENOENT" || /unknown (?:command|shorthand flag)|is not a docker command/.test(error.stderr)) return null;
    throw error;
  }
}

test("the Compose template publishes only on the WireGuard address, hardened and bounded", t => {
  for (const env of [{}, { READER_PORT: "9000" }]) {
    const config = composeConfig(env);
    if (!config) {
      assert.ok(!process.env.CI, "CI must have the Docker Compose CLI");
      return t.skip("Docker Compose CLI not installed");
    }
    for (const [name, service] of Object.entries(config.services)) {
      for (const port of service.ports ?? []) assert.equal(port.host_ip, "10.0.0.1", `${name} publishes ${port.published} beyond WireGuard`);
      assert.equal(service.network_mode, undefined, `${name}: no host networking`);
      assert.ok(!service.privileged, `${name}: not privileged`);
      assert.deepEqual(service.volumes ?? [], [], `${name}: no host mounts (the Docker socket least of all)`);
      assert.equal(service.read_only, true, `${name}: read-only root filesystem`);
      assert.deepEqual(service.cap_drop, ["ALL"], `${name}: drops all capabilities`);
      assert.deepEqual(service.cap_add ?? [], [], `${name}: adds no capabilities`);
      assert.ok(service.security_opt?.includes("no-new-privileges:true"), `${name}: no-new-privileges`);
      for (const limit of ["mem_limit", "cpus", "pids_limit"]) assert.ok(Number(service[limit]) > 0, `${name}: ${limit} set`);
      assert.ok(service.logging?.options?.["max-size"] && service.logging.options["max-file"], `${name}: bounded logs`);
    }
    assert.equal(config.services.reader.ports.length, 1);
  }
});

test("CI, orb setup and both image stages run the Node version in .nvmrc", () => {
  const version = read(".nvmrc").trim();
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const bases = [...read("Dockerfile").matchAll(/^FROM node:(\S+?)-/gm)].map(match => match[1]);
  assert.deepEqual(bases, [version, version], "update the Dockerfile's node:<version> tags and their digests together with .nvmrc");
  for (const workflow of readdirSync(join(root, ".github/workflows"))) {
    const source = read(join(".github/workflows", workflow));
    assert.doesNotMatch(source, /node-version:/, `${workflow}: use node-version-file: .nvmrc`);
    for (const step of source.split(/\n\s+- /).filter(step => step.includes("actions/setup-node@"))) {
      assert.match(step, /node-version-file: \.nvmrc/, `${workflow}: setup-node reads .nvmrc`);
    }
  }
  assert.match(read(".agents/setup"), /^node_version="\$\(tr -d '\[:space:\]' < \.nvmrc\)"$/m, "orb setup reads .nvmrc");
});
