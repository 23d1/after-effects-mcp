/**
 * Post-build: stage the ExtendScript runtime next to the compiled output, and
 * make the CLI entry point executable.
 */
import { chmodSync, cpSync, mkdirSync } from "node:fs";

mkdirSync("dist/jsx", { recursive: true });
cpSync("src/jsx", "dist/jsx", { recursive: true });

// `chmod +x` as a shell command does not exist on Windows. Node's chmodSync is
// a near no-op there, so guarding keeps the build identical on both platforms.
if (process.platform !== "win32") {
  chmodSync("dist/index.js", 0o755);
}
