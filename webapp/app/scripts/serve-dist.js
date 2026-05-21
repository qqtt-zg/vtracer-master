const http = require("http");
const fs = require("fs");
const path = require("path");

const distDir = path.resolve(__dirname, "..", "dist");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4173);

const mimeMap = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".wasm": "application/wasm",
  ".ico": "image/x-icon",
};

if (!fs.existsSync(distDir)) {
  throw new Error("dist 目录不存在，请先运行 npm run build。");
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const targetPath =
    urlPath === "/" ? path.join(distDir, "index.html") : path.join(distDir, urlPath);

  const normalized = path.normalize(targetPath);
  if (!normalized.startsWith(distDir)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }

  fs.readFile(normalized, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }
    const ext = path.extname(normalized).toLowerCase();
    res.setHeader("Content-Type", mimeMap[ext] || "application/octet-stream");
    res.end(data);
  });
});

server.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`dist server ready at http://${host}:${port}`);
});
