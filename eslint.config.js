import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  { ignores: ["node_modules", "dist", "dist-ui", ".delta/**", ".wrangler/**", "env.d.ts", "worker-configuration.d.ts", "eslint.config.js", "vitest.config.ts", "vite.config.ts", "public/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      parserOptions: { projectService: false, project: false },
      globals: { process: "readonly" },
    },
  },
];
