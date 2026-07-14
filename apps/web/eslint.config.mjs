import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import rootConfig from "../../eslint.config.mjs";

// eslint-plugin-react and eslint-plugin-jsx-a11y only declare support up to ESLint ^9 (and
// eslint-plugin-react actually throws under ESLint 10's flat-config Linter — context.getFilename
// was removed). eslint-plugin-react-hooks 7.x is the one that explicitly supports ^10.0.0, and
// it's the rule set that catches actual bugs (rules-of-hooks, exhaustive-deps), so it's kept;
// the other two are dropped rather than downgrading the repo-wide ESLint apps/server also uses.
export default [
  ...rootConfig,
  {
    ignores: [".next/**"],
  },
  {
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
];
