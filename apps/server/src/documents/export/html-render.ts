/**
 * Serialize a hydrated CRDT document to styled, print-ready HTML.
 *
 * The server has no TipTap/ProseMirror document — it holds the RGA CRDT. This module
 * is the server-side mirror of the web client's `text-projection.ts` + `crdt-bridge.ts`
 * reconstruction: it walks the CRDT's visible chars, splits them into blocks on the
 * `"\n"` separator, reads each block's `blockType`/`listType` and each char's inline
 * marks (`bold`/`italic`/`code`/`link`) straight from the CRDT's per-`(charId, key)` LWW
 * format registers, and emits HTML that renders like the editor — not a raw text dump.
 *
 * Block-level attributes anchor exactly as the bridge stores them: `ROOT` for block 0,
 * or the CharId of the `"\n"` char that precedes block N (see `blockAnchors` in
 * `apps/web/src/lib/crdt-bridge.ts`). No new anchor concept is needed here.
 */

import { ROOT, type CharId, type RGADocument, type VisibleChar } from "@sync-flow/crdt";

const BLOCK_SEPARATOR = "\n";

// Inline mark keys the CRDT format layer tracks (matched 1:1 to the web `MARK_KEYS`) are read
// individually in `marksOf`: bold / italic / code / link.

type BlockType = "paragraph" | "heading1" | "heading2" | "heading3" | "codeBlock";
type ListType = "bulletList" | "orderedList" | null;

interface Block {
  readonly chars: VisibleChar[];
  readonly blockType: BlockType;
  readonly listType: ListType;
}

/** Escape text for use in HTML element content and double-quoted attributes. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only http/https/mailto links survive as anchors; anything else renders as plain text. */
function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  return null;
}

/** The marks active on a single char, read from the CRDT's LWW format registers. */
interface Marks {
  bold: boolean;
  italic: boolean;
  code: boolean;
  link: string | null;
}

function marksOf(doc: RGADocument, id: CharId): Marks {
  const link = doc.getFormat(id, "link");
  return {
    bold: doc.getFormat(id, "bold") === true,
    italic: doc.getFormat(id, "italic") === true,
    code: doc.getFormat(id, "code") === true,
    link: typeof link === "string" ? link : null,
  };
}

/** Two adjacent chars share an inline run iff every mark matches — lets us group tag spans. */
function marksEqual(a: Marks, b: Marks): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.code === b.code && a.link === b.link;
}

/** Wrap already-escaped text in its inline tags. Order is outer→inner: link, bold, italic, code. */
function wrapInline(escapedText: string, marks: Marks): string {
  let html = escapedText;
  if (marks.code) html = `<code>${html}</code>`;
  if (marks.italic) html = `<em>${html}</em>`;
  if (marks.bold) html = `<strong>${html}</strong>`;
  if (marks.link) {
    const href = safeHref(marks.link);
    if (href) html = `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${html}</a>`;
  }
  return html;
}

/**
 * Render a block's inline content: group consecutive chars with identical marks into one
 * escaped, tag-wrapped run. Code blocks pass `plain` to skip inline marks entirely (a code
 * block's text is verbatim — matching the editor, where `codeBlock` strips inline formatting).
 */
function renderInline(doc: RGADocument, chars: VisibleChar[], plain: boolean): string {
  if (chars.length === 0) return "";
  if (plain) return escapeHtml(chars.map((c) => c.char).join(""));

  let html = "";
  let runText = "";
  let runMarks = marksOf(doc, chars[0]!.id);
  for (const vc of chars) {
    const m = marksOf(doc, vc.id);
    if (!marksEqual(m, runMarks)) {
      html += wrapInline(escapeHtml(runText), runMarks);
      runText = "";
      runMarks = m;
    }
    runText += vc.char;
  }
  html += wrapInline(escapeHtml(runText), runMarks);
  return html;
}

/**
 * Split the document's visible chars into blocks on the `"\n"` separator, reading each
 * block's stored block-level attributes from its anchor char (ROOT for block 0, the
 * preceding `"\n"` for block N).
 */
function collectBlocks(doc: RGADocument): Block[] {
  const anchors: CharId[] = [ROOT];
  const grouped: VisibleChar[][] = [[]];
  for (const vc of doc.visibleChars()) {
    if (vc.char === BLOCK_SEPARATOR) {
      anchors.push(vc.id);
      grouped.push([]);
    } else {
      grouped[grouped.length - 1]!.push(vc);
    }
  }

  return grouped.map((chars, i) => {
    const anchor = anchors[i]!;
    const blockType = doc.getFormat(anchor, "blockType");
    const listType = doc.getFormat(anchor, "listType");
    return {
      chars,
      blockType: typeof blockType === "string" ? (blockType as BlockType) : "paragraph",
      listType: listType === "bulletList" || listType === "orderedList" ? listType : null,
    };
  });
}

function renderBlock(doc: RGADocument, block: Block): string {
  if (block.blockType === "codeBlock") {
    return `<pre><code>${renderInline(doc, block.chars, true)}</code></pre>`;
  }
  const inner = renderInline(doc, block.chars, false);
  switch (block.blockType) {
    case "heading1":
      return `<h1>${inner || "<br>"}</h1>`;
    case "heading2":
      return `<h2>${inner || "<br>"}</h2>`;
    case "heading3":
      return `<h3>${inner || "<br>"}</h3>`;
    default:
      // An empty paragraph keeps its vertical space in the editor — mirror that with <br>.
      return `<p>${inner || "<br>"}</p>`;
  }
}

/**
 * The document body as HTML: block elements in order, with consecutive same-type list
 * blocks grouped into a single `<ul>`/`<ol>` (each block becomes an `<li>`).
 */
export function renderDocumentBody(doc: RGADocument): string {
  const blocks = collectBlocks(doc);
  const out: string[] = [];
  let listTag: "ul" | "ol" | null = null;

  const closeList = () => {
    if (listTag) {
      out.push(`</${listTag}>`);
      listTag = null;
    }
  };

  for (const block of blocks) {
    if (block.listType) {
      const wanted = block.listType === "bulletList" ? "ul" : "ol";
      if (listTag !== wanted) {
        closeList();
        out.push(`<${wanted}>`);
        listTag = wanted;
      }
      out.push(`<li>${renderInline(doc, block.chars, false) || "<br>"}</li>`);
    } else {
      closeList();
      out.push(renderBlock(doc, block));
    }
  }
  closeList();

  return out.join("\n");
}

/**
 * Wrap the rendered body in a full HTML document styled to look like the editor's prose:
 * Inter (Google Fonts, with a safe system fallback if the CDN is unreachable), 720px max
 * width, 18px base, 1.8 line-height, real heading hierarchy, and monospace/light-bg code.
 */
export function renderHtmlDocument(title: string, doc: RGADocument): string {
  const body = renderDocumentBody(doc);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    font-size: 18px;
    line-height: 1.8;
    color: #1e293b;
    background: #ffffff;
    margin: 0;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  main {
    max-width: 720px;
    margin: 0 auto;
    padding: 8px 0;
  }
  h1, h2, h3 { line-height: 1.3; font-weight: 700; margin: 1.4em 0 0.5em; color: #0f172a; }
  h1 { font-size: 2em; }
  h2 { font-size: 1.5em; }
  h3 { font-size: 1.25em; }
  p { margin: 0 0 0.9em; }
  ul, ol { margin: 0 0 0.9em; padding-left: 1.6em; }
  li { margin: 0.2em 0; }
  a { color: #4f46e5; text-decoration: underline; }
  strong { font-weight: 700; }
  em { font-style: italic; }
  code {
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 0.9em;
    background: #f1f5f9;
    padding: 0.15em 0.35em;
    border-radius: 4px;
  }
  pre {
    background: #f1f5f9;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    padding: 14px 16px;
    overflow-x: auto;
    margin: 0 0 0.9em;
  }
  pre code {
    background: none;
    padding: 0;
    font-size: 0.9em;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  }
  @page { margin: 18mm 16mm; }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}
