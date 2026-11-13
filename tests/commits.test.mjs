import { test } from "node:test";
import assert from "node:assert/strict";
import { commitProblems } from "../scripts/check-commits.mjs";

test("commit messages need a known type prefix and a Tests: line", () => {
  const tested = "\n\nAdd X so that Y.\n\nTests: npm test; npm run build\n";
  for (const subject of ["fix: refuse a spool", "fix(security): hash-lock dependencies", "feat!: drop the WAV route", "chore(deps): npm audit fix"]) {
    assert.deepEqual(commitProblems(subject + tested), [], subject);
  }
  // Trailers may follow the Tests: line.
  assert.deepEqual(commitProblems("docs: x\n\nWhy.\n\nTests: docs-only change\n\nCo-Authored-By: A <a@example.com>\n"), []);
  for (const subject of ["Speak \"/\" as per", "feature: add X", "Fix: refuse a spool", "fix(Security): x", "fix:no space", "fix: ", "Merge pull request #29 from a/b"]) {
    assert.equal(commitProblems(subject + tested).length, 1, subject);
  }
  for (const body of ["\n\nWhy.\n", "\n\nWhy.\n\nTests:\n", "\n\nWhy. Tests: npm test\n", "\n\nWhy.\n\ntests: npm test\n"]) {
    assert.match(commitProblems("fix: x" + body).join(), /Tests:/, JSON.stringify(body));
  }
});
