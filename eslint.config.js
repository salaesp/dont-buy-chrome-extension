// Config plana de ESLint (v9). Sin plugins externos: globals de navegador +
// webextension + node (tests), reglas mínimas.
"use strict";

const globals = {
  chrome: "readonly",
  self: "readonly",
  globalThis: "readonly",
  window: "readonly",
  document: "readonly",
  location: "readonly",
  navigator: "readonly",
  console: "readonly",
  confirm: "readonly",
  alert: "readonly",
  MutationObserver: "readonly",
  importScripts: "readonly",
  URL: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  module: "writable",
  require: "readonly",
};

module.exports = [
  { ignores: ["node_modules/**", "web-ext-artifacts/**"] },
  {
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "script", globals },
    rules: {
      "no-unused-vars": [
        "warn",
        { args: "none", caughtErrors: "none", varsIgnorePattern: "^_" },
      ],
      "no-undef": "error",
    },
  },
];
