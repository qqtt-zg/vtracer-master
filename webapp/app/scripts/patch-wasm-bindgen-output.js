const fs = require("fs");
const path = require("path");

const pkgFile = path.resolve(__dirname, "..", "..", "pkg", "vtracer_webapp.js");
const appRoot = path.resolve(__dirname, "..");
const generatedDir = path.join(appRoot, "generated");
const generatedFile = path.join(generatedDir, "vtracer_webapp_compat.js");

if (!fs.existsSync(pkgFile)) {
  throw new Error(`wasm-bindgen output not found: ${pkgFile}`);
}

const source = fs.readFileSync(pkgFile, "utf8");
const pattern = /new URL\('vtracer_webapp_bg\.wasm', import\.meta\.url\)/g;
const patched = source.replace(pattern, "'vtracer_webapp_bg.wasm'");

fs.mkdirSync(generatedDir, { recursive: true });
fs.writeFileSync(generatedFile, patched, "utf8");
console.log(`[patch-wasm-bindgen-output] generated ${generatedFile}`);
