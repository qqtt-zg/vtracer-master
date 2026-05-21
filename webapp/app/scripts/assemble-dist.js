const fs = require("fs");
const path = require("path");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) {
    return;
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  ensureDir(dest);
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(from, to);
    } else if (entry.isFile()) {
      copyFile(from, to);
    }
  }
}

const appRoot = path.resolve(__dirname, "..");
const distDir = path.join(appRoot, "dist");
const publicDir = path.join(appRoot, "public");
const pkgDir = path.resolve(appRoot, "..", "pkg");
const indexSrc = path.join(appRoot, "index.html");
const indexDest = path.join(distDir, "index.html");
const wasmSrc = path.join(pkgDir, "vtracer_webapp_bg.wasm");
const wasmDest = path.join(distDir, "vtracer_webapp_bg.wasm");

if (!fs.existsSync(distDir)) {
  throw new Error("dist directory does not exist. Run webpack build first.");
}

copyDirRecursive(publicDir, distDir);
copyFile(indexSrc, indexDest);
copyFile(wasmSrc, wasmDest);
