/**
 * The syntax-highlighting grammar registry for CodeBlockLowlight. Deliberately a hand-picked
 * subset of `lowlight`'s `common` bundle — the task's language selector should only ever offer
 * languages we actually registered, not lowlight's full ~35-language common set. `"html"` isn't
 * one of highlight.js's own grammar names (it's an alias baked in at the full-registration step
 * lowlight's `common` bundle skips), so it's registered explicitly under the `"xml"` grammar,
 * which is what highlight.js's HTML support actually is.
 */

import { common, createLowlight } from "lowlight";

export const CODE_BLOCK_LANGUAGES = [
  { value: "javascript", label: "JavaScript" },
  { value: "typescript", label: "TypeScript" },
  { value: "python", label: "Python" },
  { value: "bash", label: "Bash" },
  { value: "json", label: "JSON" },
  { value: "sql", label: "SQL" },
  { value: "html", label: "HTML" },
  { value: "css", label: "CSS" },
] as const;

export const lowlight = createLowlight();
for (const { value } of CODE_BLOCK_LANGUAGES) {
  const grammarName = value === "html" ? "xml" : value;
  const grammar = common[grammarName as keyof typeof common];
  if (grammar) lowlight.register(value, grammar);
}
