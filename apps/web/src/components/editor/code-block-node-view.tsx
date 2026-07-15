"use client";

import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { CODE_BLOCK_LANGUAGES } from "@/lib/lowlight";

/**
 * React NodeView for `codeBlock`, pinning a language-selector `<select>` to the block's top-right
 * corner. `NodeViewContent` still renders the actual ProseMirror-managed `<code>` contents, so
 * CodeBlockLowlight's decoration plugin (the syntax highlighting) keeps working unmodified —
 * only the chrome around it is custom. Picking a language calls `updateAttributes`, a normal
 * ProseMirror transaction, so it flows through the CRDT bridge exactly like any other block
 * format change (see `codeLanguage` handling in `crdt-bridge.ts`).
 */
export function CodeBlockNodeView({ node, updateAttributes, editor }: NodeViewProps) {
  const language = typeof node.attrs.language === "string" ? node.attrs.language : "";

  return (
    <NodeViewWrapper className="relative">
      <select
        contentEditable={false}
        disabled={!editor.isEditable}
        aria-label="Code block language"
        value={language}
        onChange={(e) => updateAttributes({ language: e.target.value || null })}
        className="absolute right-2 top-2 z-10 rounded border border-border bg-background px-1.5 py-0.5 text-xs text-muted-foreground outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
      >
        <option value="">Plain text</option>
        {CODE_BLOCK_LANGUAGES.map(({ value, label }) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <pre>
        <NodeViewContent<"code"> as="code" />
      </pre>
    </NodeViewWrapper>
  );
}
