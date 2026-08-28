import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Keep docs/invariants.md honest.
 *
 * That document claims each invariant is enforced by a named test. A claim like
 * that is worth exactly as much as its weakest link: rename a test, and the
 * document silently starts describing a property nothing checks any more. Which
 * is the same failure mode as the rest of this project - something that looks
 * fine and quietly is not.
 *
 * So the documentation is verified the same way everything else here is.
 */

const TEST_DIR = "test";
const INVARIANTS_DOC = join("docs", "invariants.md");

/** Every `it("...")` name declared anywhere in the suite. */
function collectTestNames(): Set<string> {
  const names = new Set<string>();

  for (const file of readdirSync(TEST_DIR)) {
    if (!file.endsWith(".ts")) continue;
    const source = readFileSync(join(TEST_DIR, file), "utf8");

    for (const match of source.matchAll(/\bit\(\s*"((?:[^"\\]|\\.)*)"/g)) {
      names.add(match[1].replace(/\\"/g, '"'));
    }
  }

  return names;
}

/**
 * Test names cited by the document: backticked spans on bullet lines that begin
 * with a status marker. Prose in backticks elsewhere is left alone.
 */
function collectCitedNames(): string[] {
  const doc = readFileSync(INVARIANTS_DOC, "utf8");
  const cited: string[] = [];

  for (const line of doc.split("\n")) {
    const match = /^-\s+(?:✅|⚠️?)\s+`([^`]+)`\s*$/u.exec(line.trim());
    if (match) cited.push(match[1]);
  }

  return cited;
}

describe("Documentation matches the suite", function () {
  it("cites at least one test per invariant", async function () {
    const cited = collectCitedNames();

    // Twelve invariants are documented; each cites at least one test.
    assert.ok(
      cited.length >= 12,
      `expected invariants.md to cite tests, found ${cited.length}`,
    );
  });

  it("cites only tests that actually exist", async function () {
    const declared = collectTestNames();
    const cited = collectCitedNames();

    const missing = cited.filter((name) => !declared.has(name));

    assert.deepEqual(
      missing,
      [],
      `docs/invariants.md cites tests that no longer exist:\n  ${missing.join("\n  ")}\n` +
        `Either restore the test or update the document.`,
    );
  });
});
