import { ElkCapi, type ElkCallResult, type ElkClientOptions } from "./client.js";
import {
  elkFamilyKey,
  money,
  parseBalance,
  parseInit,
  parsePurchase,
  validateBalance,
  type ElkBmode,
  type ElkInitInfo,
  type ElkRound,
} from "./types.js";

export type ElkSessionOptions = ElkClientOptions & {
  /** Etiqueta para reconocer la sesion en `elk_status`. */
  label?: string;
  /** Variante declarada por `init` para juegos que la exigen (ej. Pirots 5 = "nest"). */
  variant?: string;
};

export type ElkBetChoice = {
  betlevel: number;
  bmode: string;
  amount: number;
  maxwinamount: number | null;
  coinvalue: number | null;
};

export type ElkSpinOptions = {
  betlevel?: number;
  bmode?: string;
  /** Variante del juego (solo si `init` declara `<variants>`). */
  variant?: string;
  /** Cerrar la ronda con `checkwin` y validar el saldo final. */
  settle?: boolean;
  pmode?: string;
  gamespeed?: "normal" | "quick";
  extraDelayMs?: number;
  extra?: Record<string, string | number | boolean | null | undefined>;
};

export type ElkSpinOutcome = {
  ok: boolean;
  round: ElkRound | null;
  error: string | null;
  errorcode: number | null;
  balance: number | null;
};

export type ElkRunResult = {
  spins: number;
  completed: number;
  failed: number;
  totalBet: number;
  totalWin: number;
  rtpPct: number | null;
  hits: number;
  biggestWin: number;
  balanceStart: number | null;
  balanceEnd: number | null;
  mismatches: number;
  errors: Array<{ spin: number; message: string }>;
  stopped: string | null;
  durationMs: number;
  rounds: Array<Pick<ElkRound, "index" | "roundid" | "betamount" | "winamount" | "bmode" | "validated">>;
};

const DEFAULT_BETLEVEL = 4;
const DEFAULT_BMODE = "DEF";

function nowIso(): string {
  return new Date().toISOString();
}

export class ElkGameSession {
  readonly id: string;
  readonly label: string;
  readonly client: ElkCapi;
  readonly createdAt = Date.now();
  info: ElkInitInfo | null = null;
  balance: number | null = null;
  variant: string | null;
  minSpindelay = 0;
  rounds: ElkRound[] = [];
  calls: ElkCallResult[] = [];
  lastActivityAt = Date.now();
  private lastCallEndedAt = 0;
  private initCall: ElkCallResult | null = null;

  constructor(id: string, options: ElkSessionOptions) {
    this.id = id;
    this.label = options.label ?? id;
    this.client = new ElkCapi(options);
    this.variant = options.variant ?? null;
  }

  get gameId(): string | null {
    return this.client.gameId;
  }

  async initialize(overrides: Record<string, string | number | boolean | null | undefined> = {}): Promise<ElkInitInfo> {
    const result = await this.client.init(overrides);
    this.initCall = result;
    this.calls.push(result);
    this.lastCallEndedAt = Date.now();
    this.lastActivityAt = Date.now();
    const info = parseInit(result.parsed);
    this.info = info;
    this.balance = info.balance;
    this.minSpindelay = info.minspindelay;
    return info;
  }

  /**
   * Init no declara `variant` en el XML; el launcher lo pone en la URL. Cuando
   * `elk_init` recibe `variant`, se guarda aca y se ecoa en `purchase`.
   */
  setVariant(variant: string | null): void {
    this.variant = variant;
  }

  betTable(): Array<{ betlevel: number; bmodes: Array<{ id: string; amount: number; maxwinamount: number | null }> }> {
    return (this.info?.betlevels ?? []).map((level) => ({
      betlevel: level.id,
      bmodes: level.bmodes.map((bmode) => ({
        id: bmode.id,
        amount: bmode.amount,
        maxwinamount: bmode.maxwinamount,
      })),
    }));
  }

  resolveBet(betlevel?: number, bmode?: string): ElkBetChoice {
    if (!this.info) throw new Error("sesion sin init: llama a elk_init primero");
    const level = betlevel ?? this.info.defaultBetLevel ?? DEFAULT_BETLEVEL;
    const mode = bmode ?? DEFAULT_BMODE;
    const found = this.info.betlevels.find((entry) => entry.id === level);
    if (!found) {
      throw new Error(
        `betlevel ${level} no existe. Validos: ${this.info.betlevels.map((entry) => entry.id).join(", ")}`,
      );
    }
    const foundMode: ElkBmode | undefined = found.bmodes.find((entry) => entry.id === mode);
    if (!foundMode) {
      throw new Error(
        `bmode ${mode} no existe en betlevel ${level}. Validos: ${found.bmodes.map((entry) => entry.id).join(", ")}`,
      );
    }
    return {
      betlevel: found.id,
      bmode: foundMode.id,
      amount: foundMode.amount,
      maxwinamount: foundMode.maxwinamount,
      coinvalue: foundMode.coinvalue,
    };
  }

  /**
   * Variante a mandar en `purchase`. Solo la exigen los juegos que declaran
   * `<variants>` en `init` (Pirots 4/5, Wild Toro 3, Huff N Puff Collectr):
   * sin ella el capi responde errorcode=1. Se descartan las variantes sin
   * paytable (`boss` de Pirots 5): el capi las rechaza y ademas descuenta saldo.
   */
  resolveVariant(preferred?: string): string | null {
    const declared = this.info?.variants ?? [];
    const ids = declared.map((variant) => variant.id);
    const wanted = preferred ?? this.variant ?? null;
    if (wanted) {
      if (ids.length > 0 && !ids.includes(wanted)) {
        throw new Error(`variant "${wanted}" no existe en este juego. Validas: ${ids.join(", ")}`);
      }
      const entry = declared.find((variant) => variant.id === wanted);
      if (entry && !entry.playable) {
        throw new Error(
          `variant "${wanted}" no es jugable (su paytable no declara simbolos). Jugables: ${declared
            .filter((variant) => variant.playable)
            .map((variant) => variant.id)
            .join(", ")}`,
        );
      }
      return wanted;
    }
    const playable = declared.filter((variant) => variant.playable);
    return (playable[0] ?? declared[0])?.id ?? null;
  }

  /** Respeta `minspindelay` contado desde el fin de la llamada anterior. */
  private async waitForPacing(extraDelayMs = 0): Promise<void> {
    const target = this.minSpindelay + Math.max(0, extraDelayMs);
    const elapsed = this.lastCallEndedAt === 0 ? target : Date.now() - this.lastCallEndedAt;
    const remaining = target - elapsed;
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  }

  async spin(options: ElkSpinOptions = {}): Promise<ElkSpinOutcome> {
    if (!this.info) throw new Error("sesion sin init: llama a elk_init primero");
    const choice = this.resolveBet(options.betlevel, options.bmode);
    if (this.balance != null && this.balance + 1e-9 < choice.amount) {
      return {
        ok: false,
        round: null,
        error: `saldo insuficiente: ${this.balance.toFixed(2)} < apuesta ${choice.amount.toFixed(2)}`,
        errorcode: null,
        balance: this.balance,
      };
    }

    await this.waitForPacing(options.extraDelayMs);
    const before = this.balance;
    const started = Date.now();
    const variant = this.resolveVariant(options.variant);
    const result = await this.client.purchase({
      gamesession: this.info.gamesession,
      amount: choice.amount,
      betlevel: choice.betlevel,
      // El shell real solo manda `bmode` cuando `init` lo declara (betlevels
      // bmode="true"). Mandarlo a un juego DEF-only devuelve errorcode=1.
      bmode: this.info.bmodeEnabled || choice.bmode !== DEFAULT_BMODE ? choice.bmode : undefined,
      gamespeed: options.gamespeed === "quick" ? "quick" : "normal",
      variant: variant ?? undefined,
      extra: options.extra,
    });
    this.calls.push(result);
    this.lastCallEndedAt = Date.now();
    this.lastActivityAt = Date.now();

    if (result.errorcode !== 0) {
      const variants = this.info.variants;
      const hint =
        result.errorcode === 1 && variants.length
          ? ` (variantes jugables: ${variants
              .filter((entry) => entry.playable)
              .map((entry) => entry.id)
              .join(", ")}; pasa variant= a elk_spin)`
          : "";
      const round: ElkRound = {
        index: this.rounds.length + 1,
        roundid: "",
        betlevel: choice.betlevel,
        bmode: choice.bmode,
        variant,
        betamount: choice.amount,
        winamount: 0,
        balanceBefore: before,
        balanceAfterPurchase: null,
        balanceAfterWin: null,
        balanceAfterSettle: null,
        settled: false,
        validated: null,
        errors: [`purchase errorcode=${result.errorcode}: ${result.error ?? ""}${hint}`],
        pubdata: null,
        durationMs: Date.now() - started,
        at: nowIso(),
      };
      this.rounds.push(round);
      return { ok: false, round, error: round.errors[0]!, errorcode: result.errorcode, balance: this.balance };
    }

    const purchase = parsePurchase(result.parsed);
    this.minSpindelay = purchase.minspindelay;
    this.balance = purchase.balanceAfterPurchase;

    const round: ElkRound = {
      index: this.rounds.length + 1,
      roundid: purchase.roundid,
      betlevel: purchase.betlevel || choice.betlevel,
      bmode: purchase.bmode || choice.bmode,
      variant,
      betamount: purchase.betamount || choice.amount,
      winamount: purchase.winamount,
      balanceBefore: before,
      balanceAfterPurchase: purchase.balanceAfterPurchase,
      balanceAfterWin: purchase.balanceAfterWin,
      balanceAfterSettle: null,
      settled: false,
      validated: null,
      errors: [],
      pubdata: purchase.pubdata,
      durationMs: Date.now() - started,
      at: nowIso(),
    };
    this.rounds.push(round);

    if (options.settle !== false) {
      await this.settle(round);
    } else {
      const check = validateBalance(before, round.betamount, round.winamount, round.balanceAfterPurchase, null);
      round.validated = check.ok || check.creditedAtPurchase ? true : false;
      if (!check.ok && !check.creditedAtPurchase) round.errors.push(...check.errors);
    }

    return { ok: round.errors.length === 0, round, error: round.errors[0] ?? null, errorcode: 0, balance: this.balance };
  }

  /**
   * Cierra la ronda abierta con `checkwin`. Sin argumentos usa la ultima.
   * Valida que el saldo final sea saldo_previo - apuesta + premio.
   */
  async settle(round?: ElkRound): Promise<{ ok: boolean; balance: number | null; round: ElkRound | null; error: string | null }> {
    if (!this.info) throw new Error("sesion sin init: llama a elk_init primero");
    const target = round ?? [...this.rounds].reverse().find((entry) => !entry.settled) ?? null;
    if (!target) return { ok: false, balance: this.balance, round: null, error: "no hay ronda pendiente" };
    if (target.settled) return { ok: target.errors.length === 0, balance: this.balance, round: target, error: target.errors[0] ?? null };

    await this.waitForPacing();
    let result = await this.client.checkwin(this.info.gamesession, target.roundid);
    this.calls.push(result);
    this.lastCallEndedAt = Date.now();
    this.lastActivityAt = Date.now();

    // `checkwin` es idempotente: el capi demo devuelve errorcode=1 de forma
    // esporadica bajo carga aunque la ronda sea valida.
    for (let attempt = 0; result.errorcode === 1 && attempt < 2; attempt++) {
      await this.waitForPacing(900);
      result = await this.client.checkwin(this.info.gamesession, target.roundid);
      this.calls.push(result);
      this.lastCallEndedAt = Date.now();
      this.lastActivityAt = Date.now();
    }

    if (result.errorcode !== 0) {
      target.errors.push(`checkwin errorcode=${result.errorcode}: ${result.error ?? ""}`);
      target.validated = false;
      return { ok: false, balance: this.balance, round: target, error: target.errors.at(-1)! };
    }

    const balance = parseBalance(result.parsed);
    target.balanceAfterSettle = balance.balance;
    target.settled = true;
    this.balance = balance.balance;
    if (balance.minspindelay) this.minSpindelay = balance.minspindelay;

    const check = validateBalance(
      target.balanceBefore,
      target.betamount,
      target.winamount,
      target.balanceAfterPurchase,
      target.balanceAfterSettle,
    );
    target.validated = check.ok || check.creditedAtPurchase;
    if (!check.ok && !check.creditedAtPurchase) target.errors.push(...check.errors);

    return { ok: target.validated !== false, balance: this.balance, round: target, error: target.errors[0] ?? null };
  }

  async refreshBalance(): Promise<number | null> {
    if (!this.info) throw new Error("sesion sin init: llama a elk_init primero");
    const result = await this.client.checkwin(this.info.gamesession);
    this.calls.push(result);
    this.lastCallEndedAt = Date.now();
    this.lastActivityAt = Date.now();
    if (result.errorcode !== 0) {
      throw new Error(`checkwin(errorcode=${result.errorcode}): ${result.error ?? ""}`);
    }
    const balance = parseBalance(result.parsed);
    this.balance = balance.balance;
    return this.balance;
  }

  async run(
    options: {
      spins: number;
      betlevel?: number;
      bmode?: string;
      variant?: string;
      settle?: boolean;
      extraDelayMs?: number;
      stopOnMismatch?: boolean;
      stopOnError?: boolean;
    },
  ): Promise<ElkRunResult> {
    const started = Date.now();
    const rounds: ElkRunResult["rounds"] = [];
    const errors: ElkRunResult["errors"] = [];
    let totalBet = 0;
    let totalWin = 0;
    let hits = 0;
    let biggestWin = 0;
    let mismatches = 0;
    let completed = 0;
    let failed = 0;
    let stopped: string | null = null;
    const balanceStart = this.balance;

    for (let i = 0; i < Math.max(1, options.spins); i++) {
      let outcome: ElkSpinOutcome;
      try {
        outcome = await this.spin({
          betlevel: options.betlevel,
          bmode: options.bmode,
          variant: options.variant,
          settle: options.settle,
          extraDelayMs: options.extraDelayMs,
        });
      } catch (err) {
        failed++;
        errors.push({ spin: i + 1, message: (err as Error).message });
        if (options.stopOnError !== false) {
          stopped = "error";
          break;
        }
        continue;
      }
      if (!outcome.round) {
        failed++;
        errors.push({ spin: i + 1, message: outcome.error ?? "fallo desconocido" });
        if (options.stopOnError !== false) {
          stopped = "error";
          break;
        }
        continue;
      }

      const round = outcome.round;
      if (round.roundid) {
        completed++;
        totalBet += round.betamount;
        totalWin += round.winamount;
        if (round.winamount > 0) hits++;
        if (round.winamount > biggestWin) biggestWin = round.winamount;
      }

      if (round.validated === false) {
        mismatches++;
        errors.push({ spin: i + 1, message: round.errors.join("; ") || "saldo inconsistente" });
        rounds.push({
          index: round.index,
          roundid: round.roundid,
          betamount: round.betamount,
          winamount: round.winamount,
          bmode: round.bmode,
          validated: round.validated,
        });
        if (options.stopOnMismatch !== false) {
          stopped = "balance-mismatch";
          break;
        }
        continue;
      }

      if (!outcome.ok) {
        failed++;
        errors.push({ spin: i + 1, message: outcome.error ?? "fallo desconocido" });
        if (options.stopOnError !== false) {
          stopped = "error";
          break;
        }
        continue;
      }

      rounds.push({
        index: round.index,
        roundid: round.roundid,
        betamount: round.betamount,
        winamount: round.winamount,
        bmode: round.bmode,
        validated: round.validated,
      });

      const nextBet = this.resolveBet(options.betlevel, options.bmode).amount;
      if (this.balance != null && this.balance + 1e-9 < nextBet) {
        stopped = "insufficient-balance";
        break;
      }
    }

    return {
      spins: Math.max(1, options.spins),
      completed,
      failed,
      totalBet: money(totalBet),
      totalWin: money(totalWin),
      rtpPct: totalBet > 0 ? Number(((totalWin / totalBet) * 100).toFixed(2)) : null,
      hits,
      biggestWin: money(biggestWin),
      balanceStart,
      balanceEnd: this.balance,
      mismatches,
      errors,
      stopped,
      durationMs: Date.now() - started,
      rounds,
    };
  }

  status(): Record<string, unknown> {
    const played = this.rounds.filter((round) => round.roundid);
    const totalBet = played.reduce((acc, round) => acc + round.betamount, 0);
    const totalWin = played.reduce((acc, round) => acc + round.winamount, 0);
    return {
      id: this.id,
      label: this.label,
      gameId: this.gameId,
      baseUrl: this.client.baseUrl,
      variant: this.variant,
      initialized: this.info != null,
      currency: this.info?.currency ?? this.client.opts.currency,
      balance: this.balance,
      betlevels: this.info?.betlevels.length ?? 0,
      defaultBetLevel: this.info?.defaultBetLevel ?? null,
      bmodeEnabled: this.info?.bmodeEnabled ?? null,
      bmodes: this.info?.bmodes ?? [],
      variants: this.info?.variants ?? [],
      rtpDeclared: this.info?.rtp ?? null,
      maxwin: this.info?.maxwin ?? null,
      hf: this.info?.hf ?? null,
      minSpindelay: this.minSpindelay,
      rounds: played.length,
      rtpObservedPct: totalBet > 0 ? Number(((totalWin / totalBet) * 100).toFixed(2)) : null,
      lastRound: this.rounds.at(-1) ?? null,
      calls: this.client.calls.length,
      createdAt: new Date(this.createdAt).toISOString(),
      lastActivityAt: new Date(this.lastActivityAt).toISOString(),
    };
  }

  /**
   * Ficha de capacidad (BSF) del juego: todo lo que el protocolo declara y lo
   * que se observo en la ultima ronda. No depende del navegador ni de pixeles.
   */
  card(): Record<string, unknown> {
    const info = this.info;
    const last = this.rounds.at(-1) ?? null;
    return {
      schema: "deep-slots/elk-card/v1",
      provider: "elk",
      gameId: this.gameId,
      variant: this.variant,
      familyKey: elkFamilyKey(info ? {
        rtp: info.rtp,
        maxwin: info.maxwin,
        betlevels: info.betlevels.length,
        bmodes: info.betModes,
        features: info.features,
      } : null, this.variant),
      transport: {
        protocol: "xml-http",
        baseUrl: this.client.baseUrl,
        contentType: "text/xml; charset=utf-8",
        ops: ["init", "purchase", "claim", "reject", "checkwin", "sessionupdate", "replay", "fetchbalance", "saveround"],
        headers: {
          "X-CAPI-VERSION": "2.0",
          "X-CLIENT-VERSION": this.client.opts.clientVersion ?? "263580",
          "X-ECF-VERSION": this.client.opts.ecfVersion ?? "369146",
        },
        spinOp: "purchase",
        spinBmode: "DEF",
      },
      declared: info
        ? {
            currency: info.currency,
            rtp: info.rtp,
            maxwin: info.maxwin,
            hf: info.hf,
            cpbb: info.cpbb,
            bmodeEnabled: info.bmodeEnabled,
            defaultBetLevel: info.defaultBetLevel,
            minSpindelay: info.minspindelay,
            jurisdiction: info.jurisdiction,
            papi: info.papi,
            betlevels: info.betlevels.length,
            betModes: info.betModes,
            featureBuys: info.betModes.filter((id) => id !== "DEF"),
            bmodes: info.bmodes,
            variants: info.variants,
            features: info.features,
          }
        : null,
      bets: this.betTable(),
      pacing: {
        minSpindelayMs: this.minSpindelay,
        autospin: info?.features.autospin ?? null,
        quickplay: info?.features.quickplay ?? null,
        realitycheck: info?.features.realitycheck ?? null,
      },
      replay: last?.pubdata
        ? {
            clientseed: last.pubdata.seed,
            revision: last.pubdata.revision,
            results: last.pubdata.results.length,
            modes: last.pubdata.modes,
            actions: last.pubdata.actions,
          }
        : null,
      observed: playedStats(this.rounds),
      validation: {
        debitAndCredit: "balance_after_purchase = balance_before - bet; balance_after_checkwin = balance_before - bet + win",
        roundClosed: last ? last.settled : null,
        lastValidated: last ? last.validated : null,
      },
    };
  }
}

function playedStats(rounds: ElkRound[]): Record<string, unknown> {
  const played = rounds.filter((round) => round.roundid);
  const totalBet = played.reduce((acc, round) => acc + round.betamount, 0);
  const totalWin = played.reduce((acc, round) => acc + round.winamount, 0);
  return {
    rounds: played.length,
    totalBet: money(totalBet),
    totalWin: money(totalWin),
    rtpObservedPct: totalBet > 0 ? Number(((totalWin / totalBet) * 100).toFixed(2)) : null,
    biggestWin: money(played.reduce((acc, round) => Math.max(acc, round.winamount), 0)),
    mismatches: played.filter((round) => round.validated === false).length,
  };
}
