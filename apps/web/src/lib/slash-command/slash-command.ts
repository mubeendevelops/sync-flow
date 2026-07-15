import { Extension, type Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, { type SuggestionOptions } from "@tiptap/suggestion";
import { ReactRenderer } from "@tiptap/react";
import tippy, { type Instance, type GetReferenceClientRect } from "tippy.js";
import "tippy.js/dist/tippy.css";
import { filterCommands, type SlashCommand as SlashCommandItem } from "./commands";
import {
  SlashCommandMenu,
  type SlashCommandMenuProps,
  type SlashCommandMenuRef,
} from "./slash-command-menu";

/**
 * Shared handle between the slash-command Suggestion plugin (which lives in the editor's
 * extension list) and the CRDT bridge (built later, on hydrate). While `active` is true the
 * bridge suppresses op emission, so the `/` + filter text the user types to drive the menu is
 * pure local UI state and NEVER becomes a CRDT operation. `onDismiss` is fired on every menu
 * close so the bridge can reconcile whatever the editor now holds:
 *   - command selected → the transform already deleted the `/…` range; the flush emits only
 *     the block-type change.
 *   - Escape / click-away → the `/…` text stays in the document and the flush finally emits it
 *     as ordinary content (it was suppressed until now).
 */
export interface SlashCommandController {
  active: boolean;
  onDismiss?: () => void;
}

export const slashCommandPluginKey = new PluginKey("slashCommand");

/** Whether the slash-command menu is currently open (read by the CRDT bridge's suppression). */
export function isSlashMenuActive(state: {
  active?: boolean;
} | null | undefined): boolean {
  return state?.active === true;
}

export interface SlashCommandOptions {
  controller: SlashCommandController;
}

type SlashSuggestion = Omit<SuggestionOptions<SlashCommandItem, SlashCommandItem>, "editor">;

/**
 * Only trigger the menu at the start of an EMPTY block or immediately after whitespace — never
 * mid-word (so a URL like `a/b` or a fraction `1/2` won't pop the menu) and never inside a code
 * block. `range.from` is the position of the `/`.
 */
function allowSlash(state: {
  doc: import("@tiptap/pm/model").Node;
}, range: Range): boolean {
  const $from = state.doc.resolve(range.from);
  if ($from.parent.type.name === "codeBlock") return false;
  if ($from.parentOffset === 0) {
    // At block start: only when the block holds nothing but the `/…` query itself.
    return $from.parent.textContent.length === range.to - range.from;
  }
  const before = state.doc.textBetween(range.from - 1, range.from, undefined, " ");
  return /\s/.test(before);
}

function buildSuggestion(controller: SlashCommandController): SlashSuggestion {
  return {
    char: "/",
    pluginKey: slashCommandPluginKey,
    // Default is [' '] already; explicit so the "not mid-word" rule is visible here too.
    allowedPrefixes: [" "],
    allowSpaces: false,
    startOfLine: false,
    allow: ({ editor, state, range }) => {
      if (!editor.isEditable) return false;
      return allowSlash(state, range);
    },
    items: ({ query }) => filterCommands(query),
    // The one and only thing in the whole slash flow that reaches the CRDT bridge: a standard
    // TipTap transaction that deletes the `/…` range and re-types the block.
    command: ({ editor, range, props }) => props.run(editor, range),
    render: () => {
      let renderer: ReactRenderer<SlashCommandMenuRef, SlashCommandMenuProps> | null = null;
      let popup: Instance | null = null;

      const referenceRect =
        (clientRect: (() => DOMRect | null) | null | undefined): GetReferenceClientRect =>
        () =>
          clientRect?.() ?? new DOMRect();

      return {
        onStart: (props) => {
          controller.active = true;
          renderer = new ReactRenderer(SlashCommandMenu, {
            props: { items: props.items, command: props.command },
            editor: props.editor,
          });
          if (!props.clientRect) return;
          popup = tippy("body", {
            getReferenceClientRect: referenceRect(props.clientRect),
            appendTo: () => document.body,
            content: renderer.element,
            showOnCreate: true,
            interactive: true,
            trigger: "manual",
            placement: "bottom-start",
          })[0]!;
        },
        onUpdate: (props) => {
          renderer?.updateProps({ items: props.items, command: props.command });
          if (props.clientRect) {
            popup?.setProps({ getReferenceClientRect: referenceRect(props.clientRect) });
          }
        },
        onKeyDown: (props) => renderer?.ref?.onKeyDown(props.event) ?? false,
        onExit: () => {
          controller.active = false;
          popup?.destroy();
          popup = null;
          renderer?.destroy();
          renderer = null;
          // Reconcile the post-close document into the CRDT (block change, or the surviving
          // `/…` text after Escape). Safe to call unconditionally: the bridge diffs, so a
          // redundant call after a command selection is a no-op.
          controller.onDismiss?.();
        },
      };
    },
  };
}

/**
 * Slash-command menu. Typing `/` at the start of an empty block (or after whitespace) opens a
 * floating command palette; picking an entry transforms the current block. Built on TipTap's
 * Suggestion plugin for detection/filtering/keyboard-routing/dismissal — see `SlashCommandController`
 * for how the transient `/…` text is kept out of the CRDT.
 */
export const SlashCommand = Extension.create<SlashCommandOptions>({
  name: "slashCommand",

  addOptions() {
    return { controller: { active: false } };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion<SlashCommandItem, SlashCommandItem>({
        editor: this.editor,
        ...buildSuggestion(this.options.controller),
      }),
    ];
  },
});
