const js = require("@eslint/js");

module.exports = [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "build/**",
      "coverage/**",
      "*.min.js",
    ],
  },

  js.configs.recommended,

  {
    files: ["**/*.js"],

    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        module: "readonly",
        require: "readonly",
        exports: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        clearTimeout: "readonly",
        clearInterval: "readonly",
      },
    },

    rules: {
      // Possible errors
      "no-console": "off",
      "no-debugger": "warn",
      "no-unreachable": "error",
      "no-duplicate-case": "error",

      // Variables
      "no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],

      // Code quality
      eqeqeq: ["error", "always"],
      curly: ["error", "multi-line"],
      "no-var": "error",
      "prefer-const": "error",
      "no-throw-literal": "error",

      // Best practices
      "no-return-await": "error",
      "no-self-assign": "error",
      "no-self-compare": "error",
      "no-unmodified-loop-condition": "error",

      // Style — keep this fairly light
      semi: ["error", "always"],
      quotes: ["error", "double", { avoidEscape: true }],
      "comma-dangle": ["error", "always-multiline"],
      "object-curly-spacing": ["error", "always"],
      "array-bracket-spacing": ["error", "never"],

      // Functions
      "no-extra-bind": "error",
      "no-extra-parens": "off",

      // Security-ish mistakes
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
    },
  },
];
