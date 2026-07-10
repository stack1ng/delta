// Publication gate: refuses to pack a tree whose build outputs are missing,
// empty, or invalid.
//
// dist/ and wasm/*.wasm are gitignored build products, so a clean checkout
// would otherwise pack a documentation-only tarball without failing. The
// required file set is DERIVED, not listed: every non-wildcard target in
// package.json `exports` must exist and be non-empty, and every wasm asset
// referenced from the built JS must exist, be non-empty, and validate as
// WebAssembly. Wired up as `prepack`; run `bun run build` (inside
// `nix develop`) first.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Not import.meta.dirname: that needs Node >= 20.11, and this gate must be
// able to fail loudly on every engines-supported runtime.
const root = resolve(fileURLToPath(import.meta.url), "..", "..");
const problems = [];

function checkFile(path, description) {
  try {
    const stats = statSync(join(root, path));
    if (stats.size === 0) {
      problems.push(`${path} is empty (${description})`);
    }
    return stats.size > 0;
  } catch {
    problems.push(`${path} is missing (${description})`);
    return false;
  }
}

// 1. Every concrete export target (skip wildcard patterns like ./wasm/*.wasm).
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
for (const [entry, target] of Object.entries(pkg.exports ?? {})) {
  if (entry.includes("*")) {
    continue;
  }
  const targets = typeof target === "string" ? [target] : Object.values(target);
  for (const path of targets) {
    checkFile(path, `exports["${entry}"]`);
  }
}

// 2. Every wasm asset the built JS actually references.
function jsFilesUnder(dir) {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((item) => {
    const path = join(dir, item.name);
    if (item.isDirectory()) {
      return jsFilesUnder(path);
    }
    return item.name.endsWith(".js") ? [path] : [];
  });
}

let distFiles = [];
try {
  distFiles = jsFilesUnder("dist");
} catch {
  problems.push("dist/ is missing entirely");
}
const wasmRefs = new Set();
for (const file of distFiles) {
  const source = readFileSync(join(root, file), "utf8");
  for (const match of source.matchAll(/new URL\("([^"]*\.wasm)"/g)) {
    wasmRefs.add(join(dirname(file), match[1]));
  }
}
for (const ref of [...wasmRefs].toSorted()) {
  if (
    checkFile(ref, "referenced from built JS") &&
    !WebAssembly.validate(readFileSync(join(root, ref)))
  ) {
    problems.push(`${ref} is not valid WebAssembly`);
  }
}
if (distFiles.length > 0 && wasmRefs.size === 0) {
  problems.push("built JS references no wasm assets — build looks corrupt");
}

if (problems.length > 0) {
  console.error("refusing to pack:");
  for (const problem of problems) {
    console.error(`  ${problem}`);
  }
  console.error("run `bun run build` (inside `nix develop`) first.");
  process.exit(1);
}
