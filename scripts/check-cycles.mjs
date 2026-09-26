// Fails when src/*.ts local imports form a cycle. Type-only imports count too
// (pass --runtime to ignore them).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const runtimeOnly = process.argv.includes("--runtime");
const dir = new URL("../src/", import.meta.url).pathname;
const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
const graph = new Map();
const importRe = /^\s*(import|export)\s+(type\s+)?[^;]*?from\s+["']\.\/([\w.-]+)\.js["']/gms;
for (const file of files) {
  const text = readFileSync(join(dir, file), "utf8");
  const deps = new Set();
  for (const m of text.matchAll(importRe)) {
    if (runtimeOnly && m[2]) continue;
    deps.add(`${m[3]}.ts`);
  }
  graph.set(file, [...deps].filter((d) => files.includes(d)));
}
const cycles = [];
const state = new Map();
const stack = [];
const visit = (node) => {
  state.set(node, 1);
  stack.push(node);
  for (const dep of graph.get(node) ?? []) {
    if (state.get(dep) === 1) cycles.push([...stack.slice(stack.indexOf(dep)), dep].join(" → "));
    else if (!state.has(dep)) visit(dep);
  }
  stack.pop();
  state.set(node, 2);
};
for (const file of files) if (!state.has(file)) visit(file);
if (cycles.length) {
  console.error(`import cycles (${runtimeOnly ? "runtime" : "all"} imports):\n${cycles.join("\n")}`);
  process.exit(1);
}
console.log(`no import cycles among ${files.length} modules (${runtimeOnly ? "runtime" : "all"} imports)`);
