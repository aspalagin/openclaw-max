// Refresh the MAX Bot API schema snapshot used by schema-conformance.test.ts.
//
//   npm run schema:update            # latest commit of max-messenger/api-schema
//   npm run schema:update -- <ref>   # a branch, tag or commit
//
// Clones the repository shallowly into a temp dir, writes
// src/__fixtures__/max-schema-<info.version>.yaml with a source header and
// removes older snapshots. Run `npm test` afterwards: a failing conformance
// test means the plugin sends or expects something the new schema changed.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "yaml";

const REPO = "https://github.com/max-messenger/api-schema";
const ref = process.argv[2];
const fixturesDir = new URL("../src/__fixtures__/", import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), "max-api-schema-"));
const git = (...args) => execFileSync("git", args, { cwd: work, encoding: "utf8" }).trim();

try {
  git("init", "-q");
  git("remote", "add", "origin", REPO);
  git("fetch", "-q", "--depth", "1", "origin", ref ?? "HEAD");
  git("checkout", "-q", "FETCH_HEAD");
  const commit = git("rev-parse", "HEAD");
  const date = git("show", "-s", "--format=%cd", "--date=format:%d.%m.%Y", "HEAD");
  const yamlText = readFileSync(join(work, "schema.yaml"), "utf8");
  const version = parse(yamlText)?.info?.version;
  if (!version) throw new Error("schema.yaml has no info.version");

  const target = `max-schema-${version}.yaml`;
  const header = [
    `# Snapshot of the MAX Bot API OpenAPI schema (info.version ${version}).`,
    `# Source: ${REPO}/blob/${commit}/schema.yaml`,
    `# Commit ${commit}, ${date}. Refresh with: npm run schema:update`,
    "",
  ].join("\n");
  writeFileSync(join(fixturesDir, target), `${header}\n${yamlText}`);
  for (const name of readdirSync(fixturesDir)) {
    if (/^max-schema-.+\.yaml$/.test(name) && name !== target) unlinkSync(join(fixturesDir, name));
  }
  console.log(`src/__fixtures__/${target} ← ${commit.slice(0, 7)} (${date}); now run npm test`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
