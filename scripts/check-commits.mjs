// Checks the commits a push or pull request adds against the conventions in AGENTS.md: a
// Conventional-Commits type, a `Tests:` line, and a linear history (rebase, never merge).
// Usage: node scripts/check-commits.mjs BASE HEAD   (BASE may be all zeros or unknown: HEAD alone is checked)
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const types = ["feat", "fix", "refactor", "docs", "test", "chore"];

export function commitProblems(message) {
  const problems = [];
  const subject = message.split("\n", 1)[0];
  if (!new RegExp(`^(?:${types.join("|")})(?:\\([a-z0-9-]+\\))?!?: \\S`).test(subject)) {
    problems.push(`subject needs a type prefix (${types.join(", ")}), e.g. "fix(scope): imperative summary"`);
  }
  if (!/^Tests: \S/m.test(message)) problems.push('body needs a "Tests:" line listing the checks that were run');
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [base, head] = process.argv.slice(2);
  if (!head) throw new Error("Usage: node scripts/check-commits.mjs BASE HEAD");
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  let known = !/^0+$/.test(base);
  try { if (known) git("cat-file", "-e", `${base}^{commit}`); } catch { known = false; }
  const range = known ? `${base}..${head}` : `${head}^!`; // HEAD^! is HEAD alone, without its ancestors.
  const failures = [];
  for (const sha of git("rev-list", "--merges", range).split("\n").filter(Boolean)) {
    failures.push(`${sha.slice(0, 7)}: merge commit; rebase onto the target branch instead`);
  }
  for (const sha of git("rev-list", "--no-merges", range).split("\n").filter(Boolean)) {
    for (const problem of commitProblems(git("log", "-1", "--format=%B", sha))) failures.push(`${sha.slice(0, 7)}: ${problem}`);
  }
  if (failures.length) {
    console.error(`Commit conventions (AGENTS.md) not met:\n${failures.join("\n")}`);
    process.exitCode = 1;
  } else console.log(`Commit conventions met for ${known ? `${base.slice(0, 7)}..${head.slice(0, 7)}` : head.slice(0, 7)}.`);
}
