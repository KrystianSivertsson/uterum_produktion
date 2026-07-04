/**
 * Minimal XML-läsare för BVX-filer. BVX består enbart av element med
 * attribut (inga textnoder), så en fullständig XML-parser behövs inte.
 */

export interface XmlElement {
  tag: string;
  attrs: Record<string, string>;
  children: XmlElement[];
}

const ATTR_RE = /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*"([^"]*)"/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9A-Fa-f]+|[a-z]+);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return String.fromCodePoint(parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) {
      return String.fromCodePoint(parseInt(body.slice(1), 10));
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function parseXml(text: string): XmlElement {
  const root: XmlElement = { tag: "", attrs: {}, children: [] };
  const stack: XmlElement[] = [root];

  const tagRe = /<([^>]+)>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(text)) !== null) {
    const body = match[1].trim();
    if (body.startsWith("?") || body.startsWith("!")) continue;

    if (body.startsWith("/")) {
      const tag = body.slice(1).trim();
      const closed = stack.pop();
      if (!closed || closed.tag !== tag) {
        throw new Error(`Oväntad sluttagg </${tag}>`);
      }
      continue;
    }

    const selfClosing = body.endsWith("/");
    const inner = selfClosing ? body.slice(0, -1) : body;
    const nameMatch = /^([A-Za-z_][A-Za-z0-9_.:-]*)/.exec(inner);
    if (!nameMatch) throw new Error(`Ogiltig tagg: <${body}>`);

    const element: XmlElement = { tag: nameMatch[1], attrs: {}, children: [] };
    ATTR_RE.lastIndex = nameMatch[1].length;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = ATTR_RE.exec(inner)) !== null) {
      element.attrs[attrMatch[1]] = decodeEntities(attrMatch[2]);
    }

    stack[stack.length - 1].children.push(element);
    if (!selfClosing) stack.push(element);
  }

  if (stack.length !== 1) {
    throw new Error(`Sluttagg saknas för <${stack[stack.length - 1].tag}>`);
  }
  if (root.children.length !== 1) {
    throw new Error(`Väntade exakt ett rotelement, hittade ${root.children.length}`);
  }
  return root.children[0];
}
