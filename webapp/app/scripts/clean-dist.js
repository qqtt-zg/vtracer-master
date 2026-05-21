const fs = require("fs");
const path = require("path");

const distDir = path.resolve(__dirname, "..", "dist");

if (fs.existsSync(distDir)) {
  fs.rmSync(distDir, { recursive: true, force: true });
}

fs.mkdirSync(distDir, { recursive: true });
