"use client";

import { useState } from "react";
import { useEditor, type Editor } from "@tiptap/react";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { Bold } from "@tiptap/extension-bold";
import { Italic } from "@tiptap/extension-italic";
import { Heading } from "@tiptap/extension-heading";
import { BulletList } from "@tiptap/extension-bullet-list";
import { OrderedList } from "@tiptap/extension-ordered-list";
import { ListItem } from "@tiptap/extension-list-item";
import { Code } from "@tiptap/extension-code";
import { CodeBlock } from "@tiptap/extension-code-block";
import { Link } from "@tiptap/extension-link";
import { HardBreak } from "@tiptap/extension-hard-break";
import { History } from "@tiptap/extension-history";
import { createStubCrdtBridge, type CRDTBridge } from "@/lib/crdt-bridge";

// prose-* below map to the `--tw-prose-*` custom properties configured in tailwind.config.ts,
// which in turn read our existing --foreground/--primary/etc HSL vars — so the editor already
// themes correctly in dark mode with no separate `prose-invert` class needed.
const EDITOR_CLASS =
  "prose dark:prose-invert max-w-none focus:outline-none " +
  "text-[18px] leading-[1.8] [&_p]:leading-[1.8]";

/**
 * Wraps TipTap setup for the document editor. Local-only for now (Prompt 18): typing and
 * formatting work against TipTap's own in-memory doc. `bridge` is the CRDT seam Prompt 19 wires
 * up — `onLocalChange`/`getCursorIds` are invoked here so the call sites already exist, but the
 * bridge itself is a stub until then (see lib/crdt-bridge.ts).
 *
 * History (undo/redo) is TipTap's own extension here; Prompt 19 removes it in favor of
 * CRDT-driven undo/redo per CLAUDE.md.
 */
export function useDocumentEditor(): { editor: Editor | null; bridge: CRDTBridge } {
  const [bridge] = useState(createStubCrdtBridge);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      Document,
      Paragraph,
      Text,
      Bold,
      Italic,
      Heading.configure({ levels: [1, 2, 3] }),
      BulletList,
      OrderedList,
      ListItem,
      Code,
      CodeBlock,
      Link.configure({ openOnClick: false, autolink: true }),
      HardBreak,
      History,
    ],
    editorProps: {
      attributes: {
        class: EDITOR_CLASS,
        "aria-label": "Document content",
      },
    },
    onUpdate: () => {
      // No real diffing yet — Prompt 19 converts the transaction's steps into LocalOp[] here.
      bridge.onLocalChange([]);
    },
    onSelectionUpdate: () => {
      bridge.getCursorIds();
    },
  });

  return { editor, bridge };
}
