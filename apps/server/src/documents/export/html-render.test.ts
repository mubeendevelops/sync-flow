/**
 * Pure server-side CRDT → HTML reconstruction. No Chromium/DB — just asserts that block
 * types, inline marks, lists, and code blocks serialize to the expected prose HTML.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RGADocument, ROOT, localInsert, localFormat, type CharId } from "@sync-flow/crdt";
import { renderDocumentBody, renderHtmlDocument } from "./html-render.js";

function buildDoc(flat: string): { doc: RGADocument; anchors: CharId[]; blocks: CharId[][] } {
  const doc = new RGADocument({ replicaId: randomUUID(), authorId: "author" });
  for (const ch of [...flat]) localInsert(doc, doc.length, ch);
  const anchors: CharId[] = [ROOT];
  const blocks: CharId[][] = [[]];
  for (const vc of doc.visibleChars()) {
    if (vc.char === "\n") {
      anchors.push(vc.id);
      blocks.push([]);
    } else {
      blocks[blocks.length - 1]!.push(vc.id);
    }
  }
  return { doc, anchors, blocks };
}

describe("renderDocumentBody", () => {
  it("renders a heading, bold run, list, and code block", () => {
    const { doc, anchors, blocks } = buildDoc(
      "Report\nThis is bold text.\nFirst\nSecond\nconst x = 1;",
    );
    localFormat(doc, anchors[0]!, "blockType", "heading1");
    localFormat(doc, anchors[2]!, "listType", "bulletList");
    localFormat(doc, anchors[3]!, "listType", "bulletList");
    localFormat(doc, anchors[4]!, "blockType", "codeBlock");
    // Bold "bold" (chars 8..11 of "This is bold text.").
    for (let i = 8; i < 12; i++) localFormat(doc, blocks[1]![i]!, "bold", true);

    const html = renderDocumentBody(doc);
    expect(html).toContain("<h1>Report</h1>");
    expect(html).toContain("<p>This is <strong>bold</strong> text.</p>");
    expect(html).toContain("<ul>\n<li>First</li>\n<li>Second</li>\n</ul>");
    expect(html).toContain("<pre><code>const x = 1;</code></pre>");
  });

  it("escapes HTML-special characters in text and hrefs", () => {
    const { doc, blocks } = buildDoc("a<b & c");
    // Link the whole run to a javascript: URL — must be dropped, not emitted as an anchor.
    for (const id of blocks[0]!) localFormat(doc, id, "link", "javascript:alert(1)");
    const html = renderDocumentBody(doc);
    expect(html).toBe("<p>a&lt;b &amp; c</p>");
    expect(html).not.toContain("javascript:");
  });

  it("emits a safe anchor for http links", () => {
    const { doc, blocks } = buildDoc("link");
    for (const id of blocks[0]!) localFormat(doc, id, "link", "https://example.com");
    expect(renderDocumentBody(doc)).toBe(
      '<p><a href="https://example.com" rel="noopener noreferrer">link</a></p>',
    );
  });

  it("wraps the body in a styled HTML document with the title and Inter font", () => {
    const { doc } = buildDoc("Hello");
    const html = renderHtmlDocument("My <Doc>", doc);
    expect(html).toContain("<title>My &lt;Doc&gt;</title>");
    expect(html).toContain("family=Inter");
    expect(html).toContain("max-width: 720px");
    expect(html).toContain("<p>Hello</p>");
  });
});
