const http = require("http");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const host = "127.0.0.1";
const port = 4180;
const browsersPath = path.resolve(__dirname, "..", ".playwright-browsers");
const env = {
  ...process.env,
  PLAYWRIGHT_BROWSERS_PATH: browsersPath,
  PORT: String(port),
};

function waitForServer(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Server not ready within ${timeoutMs} ms`));
          return;
        }
        setTimeout(tick, 250);
      });
    };
    tick();
  });
}

async function main() {
  const serverProcess = spawn("node", ["scripts/serve-dist.js"], {
    stdio: "inherit",
    shell: true,
    env,
  });

  let exitCode = 1;
  try {
    await waitForServer(`http://${host}:${port}`, 30000);
    const result = spawnSync("npx", ["playwright", "test"], {
      stdio: "inherit",
      shell: true,
      env,
    });
    exitCode = result.status ?? 1;
  } finally {
    if (!serverProcess.killed) {
      serverProcess.kill();
    }
  }

  process.exit(exitCode);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
