/**
 * Builds a distributable .mcpb bundle.
 *
 * MCPB bundles are self-contained: the host provides only a Node runtime, so
 * production dependencies are installed into the staging directory rather than
 * resolved from the developer's machine.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STAGE = "build/bundle";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));

if (manifest.version !== pkg.version) {
  throw new Error(
    `Version mismatch: package.json is ${pkg.version} but manifest.json is ${manifest.version}.`
  );
}

console.log(`Staging ${pkg.name} ${pkg.version} -> ${STAGE}`);
rmSync("build", { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

cpSync("dist", join(STAGE, "dist"), { recursive: true });
for (const file of ["manifest.json", "README.md", "LICENSE"]) {
  cpSync(file, join(STAGE, file));
}

// A trimmed package.json: production deps only, and "type": "module" because
// dist/ is ESM.
writeFileSync(
  join(STAGE, "package.json"),
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      type: pkg.type,
      main: pkg.main,
      license: pkg.license,
      dependencies: pkg.dependencies,
    },
    null,
    2
  ) + "\n"
);

console.log("Installing production dependencies...");
execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], {
  cwd: STAGE,
  stdio: "inherit",
});

// npm writes a lockfile into the staging dir; it has no purpose inside the bundle.
rmSync(join(STAGE, "package-lock.json"), { force: true });

const output = `build/${pkg.name}-${pkg.version}.mcpb`;
console.log(`Packing ${output}`);
execFileSync("npx", ["mcpb", "pack", STAGE, output], { stdio: "inherit" });
