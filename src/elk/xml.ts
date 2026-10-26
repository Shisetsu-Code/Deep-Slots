import { XMLParser } from "fast-xml-parser";

/**
 * Utilidades XML para el protocolo capi de Elk.
 *
 * Elk responde XML "plano": atributos en las acciones y elementos para los
 * valores de primer nivel (`<errorcode>`, `<balance>`). El parser conserva
 * ambos y este modulo normaliza el acceso para no repetir `@` por todos lados.
 */

export type XmlNode = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  cdataPropName: "__cdata",
  processEntities: true,
  htmlEntities: false,
  allowBooleanAttributes: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Parsea un documento XML y devuelve el nodo raiz. Lanza si el XML es invalido. */
export function parseXml(text: string): XmlNode {
  const raw = stripBom(text).trim();
  const parsed = parser.parse(raw) as XmlNode;
  if (!parsed || typeof parsed !== "object" || Object.keys(parsed).length === 0) {
    throw new Error("XML vacio o invalido");
  }
  return parsed;
}

export function isNode(value: unknown): value is XmlNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** fast-xml-parser devuelve objeto cuando hay un solo hijo y array cuando hay varios. */
export function listOf<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Lee un atributo (`@name`) o, si no existe, el elemento hijo con ese nombre. */
export function xmlAttr(node: unknown, name: string): string | null {
  if (!isNode(node)) return null;
  const direct = node[`@${name}`];
  if (direct != null && !isNode(direct)) return String(direct);
  const child = node[name];
  const text = xmlText(child);
  return text;
}

/** Texto de un nodo: string, numero, `#text` o CDATA. */
export function xmlText(node: unknown): string | null {
  if (node == null) return null;
  if (typeof node === "string") return node;
  if (typeof node === "number" || typeof node === "boolean") return String(node);
  if (Array.isArray(node)) return node.map((v) => xmlText(v) ?? "").join("");
  if (!isNode(node)) return null;
  const cdata = node.__cdata;
  if (cdata != null) return xmlText(cdata);
  const text = node["#text"];
  if (text != null) return xmlText(text);
  return null;
}

export function xmlNumber(node: unknown, name: string): number | null {
  const raw = xmlAttr(node, name);
  if (raw == null) return null;
  const n = Number(String(raw).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export function xmlBool(node: unknown, name: string): boolean | null {
  const raw = xmlAttr(node, name);
  if (raw == null) return null;
  const v = raw.toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return null;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export type RequestAttrs = Record<string, string | number | boolean | null | undefined>;

/**
 * Construye `<request ... />` con el orden de atributos recibido.
 * Elk es sensible al orden solo en apariencia: el servidor acepta cualquier
 * orden, pero mantenerlo estable hace comparables los HAR y los tests.
 */
export function buildRequest(attrs: RequestAttrs, declaration = true): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    const text = typeof value === "boolean" ? String(value) : String(value);
    if (text === "") {
      parts.push(`${key}=""`);
      continue;
    }
    parts.push(`${key}="${escapeXml(text)}"`);
  }
  const body = `<request ${parts.join(" ")} />`;
  return declaration ? `<?xml version="1.0"?>${body}` : body;
}

/** Serializa un nodo arbitrario (util para los overrides de `elk_call`). */
export function buildElement(name: string, attrs: RequestAttrs, children = ""): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    parts.push(`${key}="${escapeXml(String(value))}"`);
  }
  const head = parts.length ? `${name} ${parts.join(" ")}` : name;
  return children ? `<${head}>${children}</${name}>` : `<${head}/>`;
}
