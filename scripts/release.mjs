// Interactive release driver, run by `npm run release` inside `nix develop`.
//
// `npm version` runs the pinned Bun/Nix checks through `preversion`, prompts
// for CHANGELOG notes through the `version` hook, and creates the release
// commit and tag. This script then pushes the tag that triggers Trusted
// Publishing; it never runs `npm publish` locally.
//
// Set RELEASE_DRY_RUN=1 to print commands without changing git state.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

const dryRun = process.env.RELEASE_DRY_RUN === "1";
const { version: current } = JSON.parse(readFileSync("package.json", "utf8"));

const rl = createInterface({ input: stdin, output: stdout });
stdout.write(`\nCurrent version: ${current}\n`);
const answer = (await rl.question("New version — enter x.y.z, or patch / minor / major: ")).trim();
rl.close();

if (!answer) {
  console.error("No version entered; aborting release.");
  process.exit(1);
}

function run(command, args) {
  if (dryRun) {
    stdout.write(`[dry-run] ${command} ${args.join(" ")}\n`);
    return 0;
  }
  return spawnSync(command, args, { stdio: "inherit" }).status ?? 1;
}

const versionStatus = run("npm", ["version", answer]);
if (versionStatus !== 0) {
  process.exit(versionStatus);
}

process.exit(run("git", ["push", "--follow-tags"]));
