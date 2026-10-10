import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: false }],
      "@typescript-eslint/no-floating-promises": "error",
      complexity: ["warn", 15],
      "max-depth": ["warn", 4],
    },
  },
  // node:test's test() returns a Promise. Existing tests call it as a statement;
  // that trips no-floating-promises 107 times and is listed for the Unreal pass.
  // Production **/*.ts stays fail-closed. Do not edit src/ here.
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
);
