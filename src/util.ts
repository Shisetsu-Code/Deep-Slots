import fs from "node:fs";
import path from "node:path";

export function truncate(text: string, max = 4000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... [truncado ${text.length - max} chars]`;
}

export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Convierte "1.234,56", "$1,234.56", "0.50 EUR" o "1 234,56" a numero.
 * Devuelve null si no hay digitos.
 */
export function parseAmount(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  let s = String(raw).replace(/[^\d.,-]/g, "").trim();
  if (!s || !/\d/.test(s)) return null;

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");

  if (lastDot >= 0 && lastComma >= 0) {
    if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (lastComma >= 0) {
    const parts = s.split(",");
    const looksThousands =
      parts.length === 2 && parts[1]!.length === 3 && parts[0]!.length <= 3 && parts[0] !== "0";
    s = looksThousands ? s.replace(/,/g, "") : s.replace(",", ".");
  } else if (lastDot >= 0) {
    const parts = s.split(".");
    const looksThousands =
      parts.length === 2 && parts[1]!.length === 3 && parts[0]!.length <= 3 && parts[0] !== "0";
    if (looksThousands) s = s.replace(/\./g, "");
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Crea (si hace falta) un directorio de artefactos y devuelve su ruta absoluta. */
export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function artifactPath(dir: string, name: string, ext: string): string {
  ensureDir(dir);
  return path.join(dir, `${name}-${stamp()}.${ext}`);
}

/** Busca recursivamente claves monetarias (balance, win, amount...) en payloads del proveedor. */
export function extractMoneyFields(
  value: unknown,
  out: Record<string, number | string> = {},
  trail: string[] = [],
  depth = 0,
): Record<string, number | string> {
  if (depth > 6 || value == null) return out;
  if (Array.isArray(value)) {
    value.slice(0, 5).forEach((v, i) =>
      extractMoneyFields(v, out, [...trail, `[${i}]`], depth + 1),
    );
    return out;
  }
  if (typeof value !== "object") return out;

  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const keyPath = [...trail, k].join(".");
    if (
      /(balance|saldo|bet|apuesta|win|won|payout|amount|totalwin|credit|cash)/i.test(k) &&
      (typeof v === "number" || (typeof v === "string" && /\d/.test(v)))
    ) {
      const n = typeof v === "number" ? v : parseAmount(v);
      if (n != null) out[keyPath] = n;
      else out[keyPath] = String(v);
    }
    if (typeof v === "object" && v !== null) extractMoneyFields(v, out, [...trail, k], depth + 1);
  }
  return out;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1));
}
