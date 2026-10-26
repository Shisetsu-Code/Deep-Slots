import fs from "node:fs";
import path from "node:path";

export type HarHeader = { name: string; value: string };

export type HarEntry = {
  index: number;
  startedDateTime: string;
  timeMs: number;
  method: string;
  url: string;
  host: string;
  path: string;
  search: string;
  query: Record<string, string[]>;
  status: number;
  statusText: string;
  mimeType: string;
  resourceType: string;
  requestHeaders: HarHeader[];
  responseHeaders: HarHeader[];
  requestMimeType: string;
  requestBodyRaw: string | null;
  requestEncoding: string | null;
  responseBodyRaw: string | null;
  responseEncoding: string | null;
  requestBytes: number;
  responseBytes: number;
  isDataUri: boolean;
};

export type HarFile = {
  path: string;
  sizeBytes: number;
  creator: { name?: string; version?: string };
  version: string;
  pages: Array<{ title?: string; startedDateTime?: string }>;
  entries: HarEntry[];
  loadedAt: string;
};

const BINARY_MIME =
  /^(image|audio|video|font)\/|octet-stream|application\/zip|application\/wasm|application\/x-protobuf/i;

function headers(list: unknown): HarHeader[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((h): h is { name: unknown; value: unknown } => typeof h === "object" && h !== null)
    .map((h) => ({ name: String(h.name ?? ""), value: String(h.value ?? "") }));
}

function queryOf(url: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, value] of new URL(url).searchParams) {
    (out[key] ??= []).push(value);
  }
  return out;
}

function byteSize(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function loadHar(file: string, options: { maxBytes?: number } = {}): HarFile {
  const resolved = path.resolve(file);
  const stat = fs.statSync(resolved);
  const limit = options.maxBytes ?? 512 * 1024 * 1024;
  if (stat.size > limit) {
    throw new Error(`HAR demasiado grande: ${(stat.size / 1024 / 1024).toFixed(1)} MB (limite ${limit / 1024 / 1024} MB)`);
  }
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8")) as {
    log?: {
      version?: string;
      creator?: { name?: string; version?: string };
      pages?: Array<{ title?: string; startedDateTime?: string }>;
      entries?: unknown[];
    };
  };
  const log = parsed.log ?? {};

  const entries: HarEntry[] = [];
  for (const raw of log.entries ?? []) {
    const entry = raw as {
      startedDateTime?: string;
      time?: number;
      request?: {
        method?: string;
        url?: string;
        headers?: unknown;
        postData?: { mimeType?: string; text?: string; encoding?: string };
      };
      response?: {
        status?: number;
        statusText?: string;
        headers?: unknown;
        content?: { mimeType?: string; text?: string; encoding?: string; size?: number };
      };
      _resourceType?: string;
    };
    const request = entry.request ?? {};
    const response = entry.response ?? {};
    const url = request.url ?? "";
    const isDataUri = url.startsWith("data:");
    let host = "";
    let pathname = url;
    let search = "";
    let query: Record<string, string[]> = {};
    if (!isDataUri) {
      try {
        const parsedUrl = new URL(url);
        host = parsedUrl.host;
        pathname = parsedUrl.pathname;
        search = parsedUrl.search;
        query = queryOf(url);
      } catch {
        host = "";
        pathname = url;
      }
    }

    entries.push({
      index: entries.length,
      startedDateTime: entry.startedDateTime ?? "",
      timeMs: typeof entry.time === "number" ? entry.time : 0,
      method: String(request.method ?? "GET").toUpperCase(),
      url,
      host,
      path: pathname,
      search,
      query,
      status: typeof response.status === "number" ? response.status : 0,
      statusText: String(response.statusText ?? ""),
      mimeType: String(response.content?.mimeType ?? ""),
      resourceType: String(entry._resourceType ?? ""),
      requestHeaders: headers(request.headers),
      responseHeaders: headers(response.headers),
      requestMimeType: String(request.postData?.mimeType ?? ""),
      requestBodyRaw: request.postData?.text ?? null,
      requestEncoding: request.postData?.encoding ?? null,
      responseBodyRaw: response.content?.text ?? null,
      responseEncoding: response.content?.encoding ?? null,
      requestBytes: byteSize(request.postData?.text?.length),
      responseBytes: byteSize(response.content?.size ?? response.content?.text?.length),
      isDataUri,
    });
  }

  return {
    path: resolved,
    sizeBytes: stat.size,
    creator: log.creator ?? {},
    version: String(log.version ?? "1.2"),
    pages: Array.isArray(log.pages) ? log.pages : [],
    entries,
    loadedAt: new Date().toISOString(),
  };
}

export function decodeBody(raw: string | null, encoding: string | null): string | null {
  if (raw == null) return null;
  if (encoding === "base64") return Buffer.from(raw, "base64").toString("utf8");
  return raw;
}

export function isBinary(entry: HarEntry): boolean {
  return BINARY_MIME.test(entry.mimeType) || entry.responseEncoding === "base64";
}

export type BodyText = {
  text: string;
  bytes: number;
  truncated: boolean;
  binary: boolean;
  encoding: "text" | "base64";
};

/** Cuerpo decodificado y truncado; para binarios devuelve base64 para no corromperlo. */
export function bodyText(entry: HarEntry, side: "request" | "response", maxChars = 4000): BodyText | null {
  const raw = side === "request" ? entry.requestBodyRaw : entry.responseBodyRaw;
  const encoding = side === "request" ? entry.requestEncoding : entry.responseEncoding;
  if (raw == null) return null;
  const decoded = decodeBody(raw, encoding) ?? "";
  const binary = side === "response" && isBinary(entry);
  const text = binary ? Buffer.from(decoded, "utf8").toString("base64") : decoded;
  const bytes = Buffer.byteLength(decoded, "utf8");
  return {
    text: text.length > maxChars ? `${text.slice(0, maxChars)}…` : text,
    bytes,
    truncated: text.length > maxChars,
    binary,
    encoding: binary ? "base64" : "text",
  };
}
