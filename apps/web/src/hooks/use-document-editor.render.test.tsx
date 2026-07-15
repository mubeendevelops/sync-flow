/**
 * Regression test for CLAUDE.md's polish-pass performance requirement: "the editor must not
 * re-render its root component on remote operations." `useDocumentEditor` wires a remote op
 * straight into ProseMirror via `crdt-bridge.ts`'s `applyRemoteOps` (see that file's own doc
 * comment) — entirely outside React state — so the component that owns the editor should not
 * re-render just because a peer typed something. This mounts the same `useEditor` +
 * `createCrdtBridge` pairing `useDocumentEditor` uses internally and proves it by count.
 */
import { describe, it, expect } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { Editor, EditorContent, useEditor } from "@tiptap/react";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { RGADocument, type Op } from "@sync-flow/crdt";
import { createCrdtBridge } from "@/lib/crdt-bridge";
import { docToText } from "@/lib/text-projection";

describe("editor root render count under remote ops", () => {
  it("does not re-render the owning component when a remote op is applied", async () => {
    let renderCount = 0;
    let bridge: ReturnType<typeof createCrdtBridge> | null = null;

    function Harness() {
      renderCount += 1;
      const editor = useEditor({
        immediatelyRender: false,
        extensions: [Document, Paragraph, Text],
      });
      const bridgeRef = useRef<ReturnType<typeof createCrdtBridge> | null>(null);

      useEffect(() => {
        if (!editor || bridgeRef.current) return;
        const doc = new RGADocument({ replicaId: "local", authorId: "local" });
        const built = createCrdtBridge({
          editor,
          doc,
          replicaId: "local",
          sendOps: () => {},
          sendCursor: () => {},
        });
        built.syncEditorFromDoc();
        bridgeRef.current = built;
        bridge = built;
      }, [editor]);

      return editor ? <EditorContent editor={editor} /> : null;
    }

    const { container } = render(<Harness />);
    await waitFor(() => expect(bridge).not.toBeNull());
    const countBeforeRemoteOp = renderCount;

    // A remote peer (never mounted in React — mirrors a socket callback) mints real insert ops.
    const peerEditor = new Editor({ extensions: [Document, Paragraph, Text] });
    const peerDoc = new RGADocument({ replicaId: "remote", authorId: "remote" });
    const sent: Op[] = [];
    const peerBridge = createCrdtBridge({
      editor: peerEditor,
      doc: peerDoc,
      replicaId: "remote",
      sendOps: (ops) => sent.push(...ops),
      sendCursor: () => {},
    });
    peerBridge.syncEditorFromDoc();
    peerEditor.commands.insertContent("Hello from a peer");
    peerBridge.onLocalChange();
    expect(sent.length).toBeGreaterThan(0);

    // Applied the same way production code does: a callback outside any React event/render.
    bridge!.applyRemoteOps(sent);

    expect(docToText(peerEditor.state.doc)).toBe("Hello from a peer");
    await waitFor(() => expect(container.textContent).toContain("Hello from a peer"));

    // The DOM updated (ProseMirror painted it directly), but the React component that owns
    // the editor never re-rendered.
    expect(renderCount).toBe(countBeforeRemoteOp);
  });
});
