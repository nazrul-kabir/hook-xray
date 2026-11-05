import { defineConfig } from "vitest/config";

// Mod tests under mods/ run with `claude plugin test`, not vitest.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
