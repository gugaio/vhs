export function validateStreamUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("stream URL must be valid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`stream URL protocol not allowed: ${url.protocol}`);
  }
}

export function parseAttrList(attrText: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < attrText.length) {
    while (i < attrText.length && (attrText[i] === "," || attrText[i] === " ")) i += 1;
    let key = "";
    while (i < attrText.length && attrText[i] !== "=" && attrText[i] !== ",") {
      key += attrText[i];
      i += 1;
    }
    if (!key || i >= attrText.length || attrText[i] !== "=") {
      while (i < attrText.length && attrText[i] !== ",") i += 1;
      continue;
    }
    i += 1;
    let value = "";
    if (attrText[i] === "\"") {
      i += 1;
      while (i < attrText.length) {
        const ch = attrText[i];
        if (ch === "\"") {
          i += 1;
          break;
        }
        value += ch;
        i += 1;
      }
    } else {
      while (i < attrText.length && attrText[i] !== ",") {
        value += attrText[i];
        i += 1;
      }
    }
    out[key.trim().toUpperCase()] = value.trim();
  }
  return out;
}

export function parseYesNoAttr(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.toUpperCase() === "YES";
}

export function resolveUrl(base: string, candidate: string): string {
  try {
    return new URL(candidate, base).toString();
  } catch {
    return candidate;
  }
}

export type XmlNode = {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
};

function parseXmlAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(raw)) !== null) {
    attrs[match[1]] = match[3] ?? match[4] ?? "";
  }
  return attrs;
}

export function parseXml(text: string): XmlNode {
  const root: XmlNode = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const tagRe = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[A-Za-z_][A-Za-z0-9_.:-]*(?:\s+[^<>]*?)?\/?>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(text)) !== null) {
    const between = text.slice(lastIndex, match.index).trim();
    if (between) {
      stack[stack.length - 1].text += decodeXmlEntities(between);
    }

    const token = match[0];
    lastIndex = tagRe.lastIndex;
    if (token.startsWith("<!--") || token.startsWith("<?")) {
      continue;
    }
    if (token.startsWith("<![CDATA[")) {
      stack[stack.length - 1].text += token.slice("<![CDATA[".length, -"]]>".length);
      continue;
    }
    if (token.startsWith("</")) {
      const closingName = token.slice(2, -1).trim();
      while (stack.length > 1) {
        const popped = stack.pop();
        if (popped?.name === closingName) {
          break;
        }
      }
      continue;
    }

    const selfClosing = token.endsWith("/>");
    const body = token.slice(1, selfClosing ? -2 : -1).trim();
    const spaceIndex = body.search(/\s/);
    const name = spaceIndex === -1 ? body : body.slice(0, spaceIndex);
    const attrText = spaceIndex === -1 ? "" : body.slice(spaceIndex + 1);
    const node: XmlNode = {
      name,
      attrs: parseXmlAttrs(attrText),
      children: [],
      text: "",
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) {
      stack.push(node);
    }
  }

  return root;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function localXmlName(name: string): string {
  return name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
}

export function childNodes(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => localXmlName(child.name) === name);
}

export function firstChild(node: XmlNode, name: string): XmlNode | undefined {
  return childNodes(node, name)[0];
}

export function firstChildText(node: XmlNode, name: string): string | undefined {
  const child = firstChild(node, name);
  const text = child?.text.trim();
  return text || undefined;
}

export function attr(node: XmlNode | undefined, name: string): string | undefined {
  if (!node) {
    return undefined;
  }
  return node.attrs[name] ?? node.attrs[name.toLowerCase()] ?? node.attrs[name.toUpperCase()];
}

export function numberAttr(node: XmlNode | undefined, name: string): number | undefined {
  const raw = attr(node, name);
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function parseIsoDurationSeconds(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const match = raw.match(/^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!match) {
    return undefined;
  }
  const days = Number(match[3] ?? 0);
  const hours = Number(match[4] ?? 0);
  const minutes = Number(match[5] ?? 0);
  const seconds = Number(match[6] ?? 0);
  const total = days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
  return Number.isFinite(total) ? total : undefined;
}

export function parseFrameRate(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const [left, right] = raw.split("/");
  const numerator = Number(left);
  const denominator = right ? Number(right) : 1;
  const value = denominator ? numerator / denominator : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
}

export async function fetchText(url: string, timeoutMs: number): Promise<{ finalUrl: string; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": "VHS/0.1 (+video-inspect)" },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const text = await res.text();
    return { finalUrl: res.url || url, text };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`fetch failed for ${url}: ${message}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}
