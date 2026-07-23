export default [
  {
    files: ["netlify/functions/**/*.js", "app.v4.js", "test_*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        fetch: "readonly", Response: "readonly", Request: "readonly", URL: "readonly",
        console: "readonly", process: "readonly", setTimeout: "readonly", clearTimeout: "readonly",
        AbortController: "readonly", AbortSignal: "readonly", btoa: "readonly", atob: "readonly",
        document: "readonly", window: "readonly", localStorage: "readonly", Intl: "readonly",
        location: "readonly", history: "readonly", setInterval: "readonly", clearInterval: "readonly",
        HTMLDetailsElement: "readonly", HTMLElement: "readonly", Element: "readonly",
        TextEncoder: "readonly", TextDecoder: "readonly", crypto: "readonly", Buffer: "readonly",
        structuredClone: "readonly", performance: "readonly", navigator: "readonly"
      }
    },
    rules: {
      "no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^_" }],
      "no-undef": "error",
      "no-unreachable": "error",
      "no-dupe-keys": "error",
      "no-dupe-args": "error",
      "no-duplicate-case": "error",
      "no-constant-condition": "warn",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-self-compare": "error",
      "no-unsafe-negation": "error",
      "require-atomic-updates": "warn",
      "no-fallthrough": "error",
      "no-cond-assign": "error",
      "no-sparse-arrays": "warn"
    }
  }
];
