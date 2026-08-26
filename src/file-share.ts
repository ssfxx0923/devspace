import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { promisify } from "node:util";
import type { FileShareConfig } from "./config.js";
import { isPathInsideRoot } from "./roots.js";

const execFileAsync = promisify(execFile);

export interface SharedFile {
  key: string;
  url: string;
  bytes: number;
  mimeType: string;
  filename: string;
}

export type WranglerRunner = (
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => Promise<void>;

export async function shareFileToR2(
  input: {
    config: FileShareConfig;
    workspaceRoot: string;
    absolutePath: string;
    contentType?: string;
  },
  runWrangler: WranglerRunner = defaultWranglerRunner,
): Promise<SharedFile> {
  const workspaceRoot = await realpath(input.workspaceRoot);
  const filePath = await realpath(input.absolutePath);
  if (!isPathInsideRoot(filePath, workspaceRoot)) {
    throw new Error(`Path resolves outside workspace root: ${input.absolutePath}`);
  }

  const fileStats = await stat(filePath);
  if (!fileStats.isFile()) {
    throw new Error(`Path is not a regular file: ${input.absolutePath}`);
  }
  if (fileStats.size > input.config.maxFileBytes) {
    throw new Error(
      `File exceeds share limit of ${input.config.maxFileBytes} bytes: ${fileStats.size} bytes`,
    );
  }

  const filename = basename(filePath);
  const key = createObjectKey(filename);
  const mimeType = input.contentType?.trim() || contentTypeForPath(filename);
  const objectPath = `${input.config.bucket}/${key}`;
  const args = [
    "r2",
    "object",
    "put",
    objectPath,
    "--file",
    filePath,
    "--content-type",
    mimeType,
    "--remote",
  ];

  try {
    await runWrangler(args, {
      env: wranglerEnvironment(input.config.wranglerAuth),
    });
  } catch (error) {
    if (
      input.config.wranglerAuth === "oauth"
      && wranglerNeedsInteractiveLogin(error)
    ) {
      throw new Error(
        [
          "Wrangler OAuth session is unavailable or expired.",
          "DevSpace is configured for Wrangler OAuth and intentionally ignores CLOUDFLARE_API_TOKEN for this upload.",
          "Run `env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_API_KEY -u CLOUDFLARE_EMAIL wrangler login` once in an interactive terminal, then retry share_file.",
        ].join(" "),
      );
    }
    throw error;
  }

  return {
    key,
    url: publicObjectUrl(input.config.publicBaseUrl, key),
    bytes: fileStats.size,
    mimeType,
    filename,
  };
}

export function createObjectKey(filename: string, now = new Date(), uuid = randomUUID()): string {
  const day = now.toISOString().slice(0, 10);
  return `${day}/${uuid}-${safeFilename(filename)}`;
}

export function publicObjectUrl(baseUrl: string, key: string): string {
  const encodedKey = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${baseUrl.replace(/\/+$/, "")}/${encodedKey}`;
}

export function contentTypeForPath(path: string): string {
  const extension = extname(path).toLowerCase();
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

function safeFilename(filename: string): string {
  const safe = filename
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(-160);
  return safe || "file.bin";
}

function wranglerEnvironment(auth: FileShareConfig["wranglerAuth"]): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (auth === "oauth") {
    delete env.CLOUDFLARE_API_TOKEN;
    delete env.CLOUDFLARE_API_KEY;
    delete env.CLOUDFLARE_EMAIL;
  }
  return env;
}

async function defaultWranglerRunner(
  args: string[],
  options: { env: NodeJS.ProcessEnv },
): Promise<void> {
  try {
    await execFileAsync("wrangler", args, {
      env: options.env,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    const details = commandErrorDetails(error);
    throw new Error(`Unable to upload file with Wrangler${details ? `: ${details}` : ""}`);
  }
}

function commandErrorDetails(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const candidate = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
  for (const value of [candidate.stderr, candidate.stdout, candidate.message]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function wranglerNeedsInteractiveLogin(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("In a non-interactive environment")
    && message.includes("CLOUDFLARE_API_TOKEN")
  );
}

const CONTENT_TYPES: Record<string, string> = {
  ".7z": "application/x-7z-compressed",
  ".avif": "image/avif",
  ".bin": "application/octet-stream",
  ".bmp": "image/bmp",
  ".bz2": "application/x-bzip2",
  ".csv": "text/csv; charset=utf-8",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".flac": "audio/flac",
  ".gif": "image/gif",
  ".gz": "application/gzip",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".m4a": "audio/mp4",
  ".md": "text/markdown; charset=utf-8",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".rar": "application/vnd.rar",
  ".svg": "image/svg+xml",
  ".tar": "application/x-tar",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".txt": "text/plain; charset=utf-8",
  ".wav": "audio/wav",
  ".wasm": "application/wasm",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".zip": "application/zip",
};
