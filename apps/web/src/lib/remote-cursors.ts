/**
 * Remote presence overlay: a TipTap/ProseMirror extension that paints other participants'
 * carets and selections as decorations (the DecorationSet API — never hand-mutated DOM).
 *
 * Each peer contributes up to two decorations:
 *   - a WIDGET caret: a 2px vertical bar in the peer's color, with a name label that fades
 *     after 2.5s of inactivity and reappears whenever the peer moves (a per-update `version`
 *     rebuilds the widget DOM, which restarts the label's CSS fade animation);
 *   - an INLINE selection highlight (anchor..head) — a translucent 30% wash of the peer's
 *     color — present only when the selection is non-empty.
 *
 * Position handling is split so decorations re-render only when a cursor update actually
 * arrives, never on every local keystroke: on a document change we cheaply `.map()` the
 * existing set forward (DOM preserved, label animation keeps counting down); we rebuild the
 * set from scratch only when a `set`/`remove` meta comes in.
 *
 * The realtime layer drives this via `setRemoteCursor` / `removeRemoteCursor`, which dispatch
 * a metadata-only, non-undoable transaction the plugin reads in `apply`.
 *
 * Performance note: this whole overlay lives in ProseMirror's own decoration/plugin-state layer,
 * never in React — a peer's cursor moving (or the `.map()` above on every local keystroke) never
 * touches React's reconciler at all, which is a stronger guarantee than `React.memo` could give a
 * component-based version (memo only skips a re-render when props are shallow-equal; this skips
 * React entirely). See `use-document-editor.render.test.tsx` for the regression test proving the
 * owning React component doesn't re-render on a remote operation.
 */

import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

interface PeerPresence {
  /** Selection anchor in ProseMirror positions (== head when collapsed). */
  readonly anchor: number;
  /** Selection head — where the caret bar is drawn. */
  readonly head: number;
  readonly color: string;
  readonly name: string;
  /** Bumped on every `set` so the caret widget's DOM (and label animation) is rebuilt. */
  readonly version: number;
}

type RemoteCursorMeta =
  | {
      readonly kind: "set";
      readonly userId: string;
      readonly anchor: number;
      readonly head: number;
      readonly color: string;
      readonly name: string;
    }
  | { readonly kind: "remove"; readonly userId: string };

interface PluginState {
  readonly peers: Map<string, PeerPresence>;
  readonly decorations: DecorationSet;
}

export const remoteCursorKey = new PluginKey<PluginState>("remoteCursors");

/** The blinking caret bar + its (auto-fading) name label, as a widget DOM node. */
function caretWidget(peer: PeerPresence): HTMLElement {
  const wrapper = document.createElement("span");
  wrapper.className = "remote-caret";
  wrapper.style.setProperty("--remote-caret-color", peer.color);

  const label = document.createElement("span");
  label.className = "remote-caret__label";
  label.textContent = peer.name;
  wrapper.appendChild(label);
  return wrapper;
}

function inRange(pos: number, doc: PMNode): boolean {
  return pos >= 0 && pos <= doc.content.size;
}

function buildDecorations(doc: PMNode, peers: Map<string, PeerPresence>): DecorationSet {
  const decorations: Decoration[] = [];
  for (const [userId, peer] of peers) {
    const from = Math.min(peer.anchor, peer.head);
    const to = Math.max(peer.anchor, peer.head);

    // Translucent selection wash (only when the peer has a real selection).
    if (from !== to && inRange(from, doc) && inRange(to, doc)) {
      decorations.push(
        Decoration.inline(from, to, {
          class: "remote-selection",
          style: `--remote-caret-color: ${peer.color}`,
        }),
      );
    }

    // The caret bar sits at the head. `version` in the key forces a DOM rebuild on each
    // update so the label's fade animation restarts (the label reappears on movement).
    if (inRange(peer.head, doc)) {
      decorations.push(
        Decoration.widget(peer.head, () => caretWidget(peer), {
          key: `${userId}#${peer.version}`,
          side: 1,
        }),
      );
    }
  }
  return DecorationSet.create(doc, decorations);
}

export const RemoteCursors = Extension.create({
  name: "remoteCursors",

  addProseMirrorPlugins() {
    return [
      new Plugin<PluginState>({
        key: remoteCursorKey,
        state: {
          init: () => ({ peers: new Map(), decorations: DecorationSet.empty }),
          apply(tr, value, _oldState, newState): PluginState {
            const meta = tr.getMeta(remoteCursorKey) as RemoteCursorMeta | undefined;
            let peers = value.peers;
            let decorations = value.decorations;

            if (tr.docChanged) {
              // A local/remote edit: cheaply remap existing decorations and peer positions
              // forward. No rebuild — the caret DOM (and its running fade) is preserved.
              decorations = value.decorations.map(tr.mapping, tr.doc);
              const remapped = new Map<string, PeerPresence>();
              for (const [id, peer] of value.peers) {
                remapped.set(id, {
                  ...peer,
                  anchor: tr.mapping.map(peer.anchor),
                  head: tr.mapping.map(peer.head),
                });
              }
              peers = remapped;
            }

            if (meta) {
              // A cursor update — the one case we rebuild the decoration set.
              peers = peers === value.peers ? new Map(peers) : peers;
              if (meta.kind === "set") {
                const prev = value.peers.get(meta.userId);
                peers.set(meta.userId, {
                  anchor: meta.anchor,
                  head: meta.head,
                  color: meta.color,
                  name: meta.name,
                  version: (prev?.version ?? 0) + 1,
                });
              } else {
                peers.delete(meta.userId);
              }
              decorations = buildDecorations(newState.doc, peers);
            }

            if (peers === value.peers && decorations === value.decorations) return value;
            return { peers, decorations };
          },
        },
        props: {
          decorations(state) {
            return remoteCursorKey.getState(state)?.decorations ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

/**
 * Place or move a peer's caret/selection. `anchor`/`head` are ProseMirror positions; pass
 * `null` for either to remove the peer entirely (no resolvable spot in the current doc).
 */
export function setRemoteCursor(
  editor: Editor,
  userId: string,
  anchor: number | null,
  head: number | null,
  color: string,
  name: string,
): void {
  if (anchor === null || head === null) {
    removeRemoteCursor(editor, userId);
    return;
  }
  const tr = editor.state.tr.setMeta(remoteCursorKey, {
    kind: "set",
    userId,
    anchor,
    head,
    color,
    name,
  } satisfies RemoteCursorMeta);
  tr.setMeta("addToHistory", false);
  editor.view.dispatch(tr);
}

/** Remove a peer's caret + selection (they left the document). */
export function removeRemoteCursor(editor: Editor, userId: string): void {
  const tr = editor.state.tr.setMeta(remoteCursorKey, {
    kind: "remove",
    userId,
  } satisfies RemoteCursorMeta);
  tr.setMeta("addToHistory", false);
  editor.view.dispatch(tr);
}
