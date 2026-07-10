// Prepends release notes during the npm `version` lifecycle hook.
//
// Interactive use accepts one bullet per line and stops on a blank line.
// Piped/non-interactive use falls back to a generic entry instead of hanging.
import { readFileSync, writeFileSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";

const version = process.env.npm_package_version;
if (!version) {
  console.error("changelog: npm_package_version is not set");
  process.exit(1);
}

const changelog = "CHANGELOG.md";
const notes = await new Promise((resolve) => {
  const collected = [];
  if (stdout.isTTY) {
    stdout.write(
      `\nRelease notes for v${version}\n` +
        "Type one bullet per line, then press Enter on an empty line to finish.\n",
    );
    stdout.write("- ");
  }

  const rl = createInterface({ input: stdin, terminal: false });
  rl.on("line", (raw) => {
    const line = raw.trim();
    if (line === "") {
      rl.close();
      return;
    }
    collected.push(`- ${line}`);
    if (stdin.isTTY) {
      stdout.write("- ");
    }
  });
  rl.on("close", () => resolve(collected));
});

const finalNotes = notes.length > 0 ? notes : [`- Release ${version}`];
const section = `## ${version}\n\n${finalNotes.join("\n")}\n`;
const existing = readFileSync(changelog, "utf8");
const header = "# Changelog\n";
const updated = existing.startsWith(header)
  ? `${header}\n${section}\n${existing.slice(header.length).replace(/^\n+/, "")}`
  : `${header}\n${section}\n${existing}`;

writeFileSync(changelog, updated);
stdout.write(`\nAdded to ${changelog}:\n\n${section}\n`);
