import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

for (const flag of ["-v", "--version"]) {
  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", flag], {
    encoding: "utf8",
    env: { ...process.env, DEVSPACE_CONFIG_DIR: "/tmp/devspace-cli-version-test" },
  }).trim();

  assert.equal(output, packageJson.version);
}

const help = execFileSync("node", ["--import", "tsx", "src/cli.ts", "--help"], {
  encoding: "utf8",
  env: { ...process.env, DEVSPACE_CONFIG_DIR: "/tmp/devspace-cli-help-test" },
});
assert.match(help, /devspace serve/);
assert.doesNotMatch(help, /devspace agents/);

assert.throws(
  () => execFileSync("node", ["--import", "tsx", "src/cli.ts", "agents"], {
    encoding: "utf8",
    stdio: "pipe",
    env: { ...process.env, DEVSPACE_CONFIG_DIR: "/tmp/devspace-cli-agents-removed-test" },
  }),
  /Unknown command: agents/,
);
