import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FileShareConfig } from "./config.js";
import {
  contentTypeForPath,
  createObjectKey,
  publicObjectUrl,
  shareFileToR2,
} from "./file-share.js";

const config: FileShareConfig = {
  bucket: "devspace-transfer",
  publicBaseUrl: "https://public.example.r2.dev",
  wranglerAuth: "oauth",
  maxFileBytes: 1024,
};

test("contentTypeForPath covers common binary and fallback types", () => {
  assert.equal(contentTypeForPath("photo.JPG"), "image/jpeg");
  assert.equal(contentTypeForPath("report.pdf"), "application/pdf");
  assert.equal(contentTypeForPath("archive.zip"), "application/zip");
  assert.equal(contentTypeForPath("unknown.custom"), "application/octet-stream");
});

test("object keys are opaque and URL safe", () => {
  const key = createObjectKey(
    "demo 文件.png",
    new Date("2026-08-08T12:00:00.000Z"),
    "00000000-0000-4000-8000-000000000000",
  );
  assert.equal(
    key,
    "2026-08-08/00000000-0000-4000-8000-000000000000-demo_.png",
  );
  assert.equal(
    publicObjectUrl("https://public.example.r2.dev/", key),
    `https://public.example.r2.dev/${key}`,
  );
});

test("shareFileToR2 uploads through Wrangler without inheriting Cloudflare token in oauth mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-file-share-"));
  const file = join(root, "payload.bin");
  await writeFile(file, Buffer.from([0, 1, 2, 3]));
  process.env.CLOUDFLARE_API_TOKEN = "should-not-be-forwarded";

  let args: string[] | undefined;
  let forwardedToken: string | undefined;
  const shared = await shareFileToR2(
    { config, workspaceRoot: root, absolutePath: file },
    async (receivedArgs, options) => {
      args = receivedArgs;
      forwardedToken = options.env.CLOUDFLARE_API_TOKEN;
    },
  );

  delete process.env.CLOUDFLARE_API_TOKEN;
  assert.equal(forwardedToken, undefined);
  assert.deepEqual(args?.slice(0, 4), ["r2", "object", "put", `devspace-transfer/${shared.key}`]);
  assert.ok(args?.includes("--remote"));
  assert.ok(args?.includes("application/octet-stream"));
  assert.equal(shared.bytes, 4);
  assert.equal(shared.filename, "payload.bin");
  assert.match(shared.url, /^https:\/\/public\.example\.r2\.dev\/\d{4}-\d{2}-\d{2}\//);
});

test("shareFileToR2 rejects symlinks that escape the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-file-share-root-"));
  const outside = await mkdtemp(join(tmpdir(), "devspace-file-share-outside-"));
  await mkdir(join(root, "nested"));
  const secret = join(outside, "secret.bin");
  const link = join(root, "nested", "link.bin");
  await writeFile(secret, "secret");
  await symlink(secret, link);

  await assert.rejects(
    shareFileToR2(
      { config, workspaceRoot: root, absolutePath: link },
      async () => undefined,
    ),
    /outside workspace root/,
  );
});

test("shareFileToR2 enforces the configured size limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-file-share-limit-"));
  const file = join(root, "too-large.bin");
  await writeFile(file, Buffer.alloc(1025));

  await assert.rejects(
    shareFileToR2(
      { config, workspaceRoot: root, absolutePath: file },
      async () => undefined,
    ),
    /exceeds share limit/,
  );
});

test("oauth mode explains Wrangler's generic non-interactive token error", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-file-share-oauth-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "sample.bin");
  await writeFile(file, Buffer.from([1, 2, 3]));

  await assert.rejects(
    shareFileToR2(
      { config, workspaceRoot: root, absolutePath: file },
      async () => {
        throw new Error(
          "In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN environment variable for wrangler to work.",
        );
      },
    ),
    (error: unknown) => {
      assert.match(String(error), /OAuth session is unavailable or expired/i);
      assert.match(String(error), /intentionally ignores CLOUDFLARE_API_TOKEN/i);
      assert.match(String(error), /wrangler login/i);
      return true;
    },
  );
});
