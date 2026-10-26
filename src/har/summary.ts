import type { HarEntry, HarFile } from "./loader.js";

export type Counted = { value: string; count: number; bytes: number };

export type EndpointSummary = {
  key: string;
  method: string;
  host: string;
  path: string;
  count: number;
  statuses: number[];
  mimeTypes: string[];
  bytes: number;
};

export type BuildSummary = {
  bundle: string;
  build: string;
  count: number;
};

export type GameRef = {
  gameId: string;
  names: string[];
  slugs: string[];
  hosts: string[];
};

export type ApiEntrySummary = {
  index: number;
  method: string;
  host: string;
  path: string;
  op: string | null;
  status: number;
  mimeType: string;
  bytes: number;
  startedDateTime: string;
};

export type HarSummary = {
  file: string;
  sizeMB: number;
  entries: number;
  dataUris: number;
  creator: { name?: string; version?: string };
  version: string;
  pages: string[];
  window: { from: string | null; to: string | null };
  hosts: Counted[];
  endpoints: EndpointSummary[];
  builds: BuildSummary[];
  games: GameRef[];
  api: ApiEntrySummary[];
};

const API_HOST = /contentmedia\.eu$/i;

export function isApiEntry(entry: HarEntry): boolean {
  if (entry.isDataUri) return false;
  if (!API_HOST.test(entry.host)) return false;
  return /\/(capi|papi)\//i.test(entry.path) || /^papi/i.test(entry.host) || /^gc\d/i.test(entry.host);
}

/** Ultima parte de `/capi/10222/play/purchase`; para papi, el recurso tras `/pub/`. */
export function opOf(entry: HarEntry): string | null {
  const pub = /\/pub\/([^/]+)/i.exec(entry.path);
  if (pub) return pub[1]!.toLowerCase();
  const parts = entry.path.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : null;
}

function bump(map: Map<string, { count: number; bytes: number }>, key: string, bytes: number): void {
  const current = map.get(key) ?? { count: 0, bytes: 0 };
  current.count++;
  current.bytes += bytes;
  map.set(key, current);
}

function toCounted(map: Map<string, { count: number; bytes: number }>): Counted[] {
  return [...map.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([value, stats]) => ({ value, count: stats.count, bytes: stats.bytes }));
}

function textBytes(entry: HarEntry): number {
  return entry.responseBytes || entry.responseBodyRaw?.length || 0;
}

export function summarizeHar(har: HarFile, options: { top?: number } = {}): HarSummary {
  const top = options.top ?? 40;
  const hosts = new Map<string, { count: number; bytes: number }>();
  const endpoints = new Map<string, EndpointSummary>();
  const builds = new Map<string, BuildSummary>();
  const games = new Map<string, GameRef>();
  const api: ApiEntrySummary[] = [];

  for (const entry of har.entries) {
    if (entry.isDataUri) continue;
    const bytes = textBytes(entry);
    bump(hosts, entry.host, bytes);

    const key = `${entry.method} ${entry.host}${entry.path}`;
    const endpoint = endpoints.get(key) ?? {
      key,
      method: entry.method,
      host: entry.host,
      path: entry.path,
      count: 0,
      statuses: [],
      mimeTypes: [],
      bytes: 0,
    };
    endpoint.count++;
    endpoint.bytes += bytes;
    if (!endpoint.statuses.includes(entry.status)) endpoint.statuses.push(entry.status);
    const mime = entry.mimeType.split(";")[0] ?? "";
    if (mime && !endpoint.mimeTypes.includes(mime)) endpoint.mimeTypes.push(mime);
    endpoints.set(key, endpoint);

    const buildMatch = /\/([a-z0-9][a-z0-9_-]*)\/build-(\d+)/i.exec(entry.path);
    if (buildMatch) {
      const buildKey = `${buildMatch[1]}@${buildMatch[2]}`;
      const build = builds.get(buildKey) ?? { bundle: buildMatch[1]!, build: buildMatch[2]!, count: 0 };
      build.count++;
      builds.set(buildKey, build);
    }

    const gameId = entry.query.gameid?.[0] ?? /\/capi\/(\d+)\//.exec(entry.path)?.[1] ?? null;
    if (gameId) {
      const game = games.get(gameId) ?? { gameId, names: [], slugs: [], hosts: [] };
      const name = entry.query.gamename?.[0];
      if (name && !game.names.includes(name)) game.names.push(name);
      const slug = /\/games\/([a-z0-9-]+)\//i.exec(entry.path)?.[1] ?? /^\/([a-z0-9-]+)\/build-/.exec(entry.path)?.[1];
      if (slug && !game.slugs.includes(slug)) game.slugs.push(slug);
      if (entry.host && !game.hosts.includes(entry.host)) game.hosts.push(entry.host);
      games.set(gameId, game);
    }

    if (isApiEntry(entry)) {
      api.push({
        index: entry.index,
        method: entry.method,
        host: entry.host,
        path: entry.path,
        op: opOf(entry),
        status: entry.status,
        mimeType: entry.mimeType,
        bytes,
        startedDateTime: entry.startedDateTime,
      });
    }
  }

  const sortedEndpoints = [...endpoints.values()].sort((a, b) => b.count - a.count).slice(0, top);

  // El bundle de `static-stage/<slug>/build-N` identifica el juego aunque esa
  // request no lleve gameid en la query. Se asocia por nombre observado.
  for (const game of games.values()) {
    for (const build of builds.values()) {
      if (game.names.includes(build.bundle) && !game.slugs.includes(build.bundle)) {
        game.slugs.push(build.bundle);
      }
    }
  }

  const windowFrom = har.entries.find((entry) => entry.startedDateTime)?.startedDateTime ?? null;
  const windowTo = [...har.entries].reverse().find((entry) => entry.startedDateTime)?.startedDateTime ?? null;

  return {
    file: har.path,
    sizeMB: Number((har.sizeBytes / 1024 / 1024).toFixed(2)),
    entries: har.entries.length,
    dataUris: har.entries.filter((entry) => entry.isDataUri).length,
    creator: har.creator,
    version: har.version,
    pages: har.pages.map((page) => page.title ?? "").filter(Boolean),
    window: { from: windowFrom, to: windowTo },
    hosts: toCounted(hosts).slice(0, top),
    endpoints: sortedEndpoints,
    builds: [...builds.values()].sort((a, b) => b.count - a.count).slice(0, top),
    games: [...games.values()],
    api,
  };
}
