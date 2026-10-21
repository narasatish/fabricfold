import nextPlugin from "eslint-config-next";

const config = [
  ...nextPlugin,
  {
    ignores: [".next/**", "node_modules/**", "lib/generated/**"],
  },
  {
    rules: {
      /* React Compiler readiness checks — this project doesn't enable the
         compiler (no babel-plugin-react-compiler in next.config.ts), so
         these are forward-looking advisories, not bugs that affect runtime
         behavior today. Kept visible as warnings rather than silenced, so a
         future compiler adoption isn't starting from zero. */
      "react-hooks/purity": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      /* Cosmetic HTML-entity strictness on literal apostrophes/quotes inside
         JSX text — not a behavior bug, just unescaped punctuation that
         renders fine. Downgraded so it doesn't block CI; still visible. */
      "react/no-unescaped-entities": "warn",
    },
  },
];

export default config;
