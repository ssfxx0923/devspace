import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const outputRoot = resolve("dist/ui");
const manifest = JSON.parse(
  await readFile(resolve(outputRoot, ".vite/manifest.json"), "utf8"),
);
const entryKey = "workspace-app.html";
const entry = manifest[entryKey];

if (!entry?.file) {
  throw new Error(`UI bundle check: missing ${entryKey} manifest entry.`);
}

const staticKeys = new Set();
function visit(key) {
  if (staticKeys.has(key)) return;
  staticKeys.add(key);
  for (const imported of manifest[key]?.imports ?? []) visit(imported);
}
visit(entryKey);

for (const forbidden of ["heavy-payload.tsx", "review-payload.tsx"]) {
  if (staticKeys.has(forbidden)) {
    throw new Error(`UI bundle check: ${forbidden} must remain dynamically loaded.`);
  }
}

const entryBytes = (await stat(resolve(outputRoot, entry.file))).size;
const initialJsBytes = (
  await Promise.all(
    [...staticKeys].map(async (key) => {
      const file = manifest[key]?.file;
      return file?.endsWith(".js") ? (await stat(resolve(outputRoot, file))).size : 0;
    }),
  )
).reduce((total, bytes) => total + bytes, 0);

const kib = (bytes) => (bytes / 1024).toFixed(1);
if (entryBytes > 75 * 1024) {
  throw new Error(`UI bundle check: application entry is ${kib(entryBytes)} KiB; limit is 75 KiB.`);
}
if (initialJsBytes > 400 * 1024) {
  throw new Error(`UI bundle check: initial static JavaScript is ${kib(initialJsBytes)} KiB; limit is 400 KiB.`);
}

console.log(
  `UI bundle check passed: ${kib(entryBytes)} KiB application entry, `
    + `${kib(initialJsBytes)} KiB initial static JavaScript.`,
);
