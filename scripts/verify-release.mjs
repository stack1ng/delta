// Verifies the tag identity and `npm pack --json` result immediately before
// Trusted Publishing. Kept as a script so the same guard can be exercised
// locally without publishing or manufacturing a GitHub event.
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const packDirectory = requiredEnvironment("PACK_DIR");
const packManifest = requiredEnvironment("PACK_MANIFEST");
const outputFile = requiredEnvironment("GITHUB_OUTPUT");
const refName = requiredEnvironment("GITHUB_REF_NAME");
const refType = requiredEnvironment("GITHUB_REF_TYPE");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const packResult = JSON.parse(readFileSync(packManifest, "utf8"));
// npm 11 returns an array, while npm 12 keys the result by package name.
const packed = Array.isArray(packResult) ? packResult[0] : packResult[pkg.name];
const expectedRepository = "git+https://github.com/stack1ng/delta.git";
const expectedWasm = [
  "wasm/gdelta_decode.wasm",
  "wasm/gdelta_encode.wasm",
  "wasm/zstd_compress.wasm",
  "wasm/zstd_decompress.wasm",
];

if (!packed) {
  throw new Error(`npm pack did not return metadata for ${pkg.name}`);
}

if (refType !== "tag") {
  throw new Error(`release ref is not a tag: ${refType}`);
}
if (refName !== `v${pkg.version}`) {
  throw new Error(`tag ${refName} does not match package version v${pkg.version}`);
}
if (pkg.name !== "@stack1ng/delta" || packed.name !== pkg.name) {
  throw new Error(`unexpected package name: source=${pkg.name}, packed=${packed.name}`);
}
if (packed.version !== pkg.version) {
  throw new Error(`packed version ${packed.version} does not match package.json ${pkg.version}`);
}
if (pkg.repository?.url !== expectedRepository) {
  throw new Error(`repository.url must be ${expectedRepository}`);
}

const paths = packed.files.map(({ path }) => path);
const actualWasm = paths.filter((path) => path.endsWith(".wasm")).toSorted();
if (JSON.stringify(actualWasm) !== JSON.stringify(expectedWasm)) {
  throw new Error(`unexpected WASM package contents: ${actualWasm.join(", ")}`);
}
for (const required of [
  "CHANGELOG.md",
  "LICENSE",
  "NOTICE",
  "README.md",
  "dist/index.d.ts",
  "dist/index.js",
  ...expectedWasm.flatMap((path) => [path, path.replace(/\.wasm$/, ".js")]),
]) {
  if (!paths.includes(required)) {
    throw new Error(`packed package is missing ${required}`);
  }
}

const notice = readFileSync("NOTICE", "utf8");
if (!notice.includes("Copyright (c) 2016 Alexandre Bury")) {
  throw new Error("NOTICE is missing the zstd-sys MIT attribution");
}

const tarball = join(packDirectory, packed.filename);
if (statSync(tarball).size !== packed.size) {
  throw new Error(`tarball size does not match npm pack manifest: ${tarball}`);
}
appendFileSync(outputFile, `tarball=${tarball}\n`);
console.log(`Verified ${packed.name}@${packed.version}: ${tarball}`);
