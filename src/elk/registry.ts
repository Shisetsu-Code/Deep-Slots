import { ElkGameSession, type ElkSessionOptions } from "./session.js";

/** Sesiones Elk vivas en este proceso MCP. Una por gameId (o por `id` explicito). */
export class ElkRegistry {
  private readonly sessions = new Map<string, ElkGameSession>();
  private lastId: string | null = null;

  create(id: string, options: ElkSessionOptions): ElkGameSession {
    const key = this.uniqueId(id);
    const session = new ElkGameSession(key, options);
    this.sessions.set(key, session);
    this.lastId = key;
    return session;
  }

  get(id?: string): ElkGameSession {
    const key = id ?? this.lastId;
    if (!key) throw new Error("no hay sesiones Elk: llama a elk_init primero");
    const session = this.sessions.get(key);
    if (!session) {
      throw new Error(`sesion Elk '${key}' no existe. Activas: ${[...this.sessions.keys()].join(", ") || "(ninguna)"}`);
    }
    return session;
  }

  list(): ElkGameSession[] {
    return [...this.sessions.values()];
  }

  close(id?: string): string[] {
    const keys = id ? [id] : [...this.sessions.keys()];
    const closed: string[] = [];
    for (const key of keys) {
      if (this.sessions.delete(key)) closed.push(key);
    }
    if (this.lastId && !this.sessions.has(this.lastId)) {
      this.lastId = [...this.sessions.keys()].at(-1) ?? null;
    }
    return closed;
  }

  private uniqueId(id: string): string {
    let candidate = id.trim() || "elk";
    if (!this.sessions.has(candidate)) return candidate;
    let n = 2;
    while (this.sessions.has(`${candidate}-${n}`)) n++;
    return `${candidate}-${n}`;
  }
}
