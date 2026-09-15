import { cpSync, mkdirSync } from "node:fs";
mkdirSync("dist/jsx", { recursive: true });
cpSync("src/jsx", "dist/jsx", { recursive: true });
