const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, spawnSync } = require("child_process");

function hasNonAscii(input) {
  return /[^\x00-\x7F]/.test(input || "");
}

function runSubst(args) {
  return spawnSync("subst", args, {
    windowsHide: true,
    encoding: "utf8",
  });
}

function createAsciiRepoAliasIfNeeded(sourcePath) {
  if (process.platform !== "win32" || !hasNonAscii(sourcePath)) {
    return null;
  }
  const preferredLetters = ["X", "Y", "Z", "W", "V", "U", "T", "S"];
  for (const letter of preferredLetters) {
    const drive = `${letter}:`;
    const result = runSubst([drive, sourcePath]);
    if (result.status === 0) {
      return {
        drive,
        mappedRoot: `${drive}\\`,
      };
    }
  }
  throw new Error("unable to allocate ASCII drive alias via subst for desktop e2e");
}

function releaseAsciiRepoAlias(alias) {
  if (!alias) {
    return;
  }
  runSubst([alias.drive, "/d"]);
}

function requestText({ host, port, requestPath, method = "GET", headers = {}, body = "", timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const payload = body || "";
    const reqHeaders = { ...headers };
    if (payload) {
      reqHeaders["Content-Length"] = Buffer.byteLength(payload);
    }

    const req = http.request(
      {
        host,
        port,
        path: requestPath,
        method,
        headers: reqHeaders,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: Number(res.statusCode || 0),
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    req.on("error", (error) => reject(error));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("request timeout"));
    });

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function waitForDriver(host, port, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await requestText({
        host,
        port,
        requestPath: "/status",
        method: "GET",
        timeoutMs: 2000,
      });
      if (response.statusCode >= 200 && response.statusCode < 300) {
        return;
      }
    } catch (_error) {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timeout waiting tauri-driver on ${host}:${port}`);
}

async function createSession({ host, port, appPath }) {
  const payload = {
    capabilities: {
      alwaysMatch: {
        browserName: "tauri",
        "tauri:options": {
          application: appPath,
          webviewOptions: {
            additionalBrowserArguments: ["--remote-debugging-port=9222"],
          },
        },
      },
      firstMatch: [{}],
    },
  };

  const response = await requestText({
    host,
    port,
    requestPath: "/session",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    timeoutMs: 60000,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`session create failed: status=${response.statusCode} body=${response.body}`);
  }
  const parsed = JSON.parse(response.body || "{}");
  const sessionId = parsed?.value?.sessionId || parsed?.sessionId || "";
  if (!sessionId) {
    throw new Error("session create missing sessionId");
  }
  return sessionId;
}

async function deleteSession({ host, port, sessionId }) {
  await requestText({
    host,
    port,
    requestPath: `/session/${sessionId}`,
    method: "DELETE",
    timeoutMs: 15000,
  });
}

async function executeSync({ host, port, sessionId, script, args = [] }) {
  const response = await requestText({
    host,
    port,
    requestPath: `/session/${sessionId}/execute/sync`,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ script, args }),
    timeoutMs: 60000,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`execute/sync failed: status=${response.statusCode} body=${response.body}`);
  }
  return JSON.parse(response.body || "{}").value;
}

async function executeAsync({ host, port, sessionId, script, args = [] }) {
  const response = await requestText({
    host,
    port,
    requestPath: `/session/${sessionId}/execute/async`,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ script, args }),
    timeoutMs: 120000,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`execute/async failed: status=${response.statusCode} body=${response.body}`);
  }
  return JSON.parse(response.body || "{}").value;
}

async function waitUntil(fn, timeoutMs, intervalMs, message) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fn()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(message);
}

async function runScenario({ host, port, sessionId, sampleImage }) {
  await waitUntil(
    async () => {
      const ready = await executeSync({
        host,
        port,
        sessionId,
        script: "return !!(window.__VTRACER_E2E && typeof window.__VTRACER_E2E.openImageByPath === 'function');",
      });
      return ready === true;
    },
    30000,
    300,
    "__VTRACER_E2E helper not ready",
  );

  const openResult = await executeAsync({
    host,
    port,
    sessionId,
    args: [sampleImage],
    script: `
const [targetPath, done] = arguments;
try {
  window.__VTRACER_E2E.openImageByPath(targetPath)
    .then((result) => done({ ok: true, result }))
    .catch((error) => done({ ok: false, error: String(error) }));
} catch (error) {
  done({ ok: false, error: String(error) });
}
`,
  });
  if (!openResult || openResult.ok !== true) {
    throw new Error(`openImageByPath failed: ${JSON.stringify(openResult)}`);
  }

  await waitUntil(
    async () => {
      const count = await executeSync({
        host,
        port,
        sessionId,
        script: "return document.querySelectorAll('#svg path').length;",
      });
      return Number(count || 0) > 0;
    },
    120000,
    400,
    "SVG path not generated",
  );

  const beforeSvg = await executeSync({
    host,
    port,
    sessionId,
    script: "const el = document.querySelector('#svg'); return el ? el.innerHTML : '';",
  });

  const paramUpdated = await executeSync({
    host,
    port,
    sessionId,
    script: `
const slider = document.querySelector('#colorprecision');
if (!slider) return false;
slider.value = '3';
slider.dispatchEvent(new Event('input', { bubbles: true }));
slider.dispatchEvent(new Event('change', { bubbles: true }));
slider.value = '7';
slider.dispatchEvent(new Event('input', { bubbles: true }));
slider.dispatchEvent(new Event('change', { bubbles: true }));
return true;
`,
  });
  if (!paramUpdated) {
    throw new Error("colorprecision slider not found");
  }

  await waitUntil(
    async () => {
      const currentSvg = await executeSync({
        host,
        port,
        sessionId,
        script: "const el = document.querySelector('#svg'); return el ? el.innerHTML : '';",
      });
      return currentSvg && currentSvg !== beforeSvg;
    },
    120000,
    400,
    "SVG did not change after parameter update",
  );

  const clickExport = await executeSync({
    host,
    port,
    sessionId,
    script: "const btn = document.querySelector('#export'); if (!btn) return false; btn.click(); return true;",
  });
  if (!clickExport) {
    throw new Error("export button not found");
  }

  const exportSvg = await executeAsync({
    host,
    port,
    sessionId,
    script: `
const done = arguments[arguments.length - 1];
try {
  window.__VTRACER_E2E.getLastExportPath()
    .then((result) => done({ ok: true, result }))
    .catch((error) => done({ ok: false, error: String(error) }));
} catch (error) {
  done({ ok: false, error: String(error) });
}
`,
  });
  if (!exportSvg || exportSvg.ok !== true || !exportSvg.result || !exportSvg.result.path) {
    throw new Error(`svg export path unavailable: ${JSON.stringify(exportSvg)}`);
  }
  if (!/\.svg$/i.test(exportSvg.result.path) || !fs.existsSync(exportSvg.result.path) || fs.statSync(exportSvg.result.path).size <= 0) {
    throw new Error(`svg export invalid: ${exportSvg.result.path}`);
  }

  const clickPdf = await executeSync({
    host,
    port,
    sessionId,
    script: "const btn = document.querySelector('#exportPdf'); if (!btn) return false; btn.click(); return true;",
  });
  if (!clickPdf) {
    throw new Error("exportPdf button not found");
  }

  const exportPdf = await executeAsync({
    host,
    port,
    sessionId,
    script: `
const done = arguments[arguments.length - 1];
try {
  window.__VTRACER_E2E.getLastExportPath()
    .then((result) => done({ ok: true, result }))
    .catch((error) => done({ ok: false, error: String(error) }));
} catch (error) {
  done({ ok: false, error: String(error) });
}
`,
  });
  if (!exportPdf || exportPdf.ok !== true || !exportPdf.result || !exportPdf.result.path) {
    throw new Error(`pdf export path unavailable: ${JSON.stringify(exportPdf)}`);
  }
  if (!/\.pdf$/i.test(exportPdf.result.path) || !fs.existsSync(exportPdf.result.path) || fs.statSync(exportPdf.result.path).size <= 0) {
    throw new Error(`pdf export invalid: ${exportPdf.result.path}`);
  }
}

async function main() {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const logsDir = process.env.VTRACER_E2E_LOG_DIR || path.resolve(__dirname, ".artifacts", "logs");
  fs.mkdirSync(logsDir, { recursive: true });

  const tauriDriverPath = process.env.TAURI_DRIVER_PATH
    || path.resolve(process.env.USERPROFILE || process.env.HOME || "", ".cargo", "bin", "tauri-driver.exe");

  let alias = null;
  let driver = null;
  let sessionId = "";
  const host = "127.0.0.1";
  const port = 4555;
  const nativePort = 9555;

  try {
    alias = createAsciiRepoAliasIfNeeded(repoRoot);
    const effectiveRepoRoot = alias ? alias.mappedRoot : repoRoot;

    const appPath = process.env.DESKTOP_APP_PATH
      || path.resolve(effectiveRepoRoot, "desktopapp", "src-tauri", "target", "debug", "vtracer-desktop.exe");
    const sampleImage = process.env.SAMPLE_IMAGE
      || path.resolve(effectiveRepoRoot, "webapp", "app", "public", "assets", "samples", "test-logo.png");
    const nativeDriverPath = process.env.NATIVE_DRIVER_PATH
      || path.resolve(effectiveRepoRoot, "msedgedriver.exe");

    if (!fs.existsSync(tauriDriverPath)) {
      throw new Error(`tauri-driver not found: ${tauriDriverPath}`);
    }
    if (!fs.existsSync(nativeDriverPath)) {
      throw new Error(`native driver not found: ${nativeDriverPath}`);
    }
    if (!fs.existsSync(appPath)) {
      throw new Error(`desktop app not found: ${appPath}`);
    }
    if (!fs.existsSync(sampleImage)) {
      throw new Error(`sample image not found: ${sampleImage}`);
    }

    const env = {
      ...process.env,
      TAURI_AUTOMATION: process.env.TAURI_AUTOMATION || "1",
      TAURI_WEBVIEW_AUTOMATION: process.env.TAURI_WEBVIEW_AUTOMATION || "1",
      VTRACER_E2E_ENABLED: process.env.VTRACER_E2E_ENABLED || "1",
      VTRACER_SETTINGS_DIR: process.env.VTRACER_SETTINGS_DIR || path.resolve(process.env.TEMP || process.env.TMP || __dirname, "vtracer-desktop-e2e", "settings"),
    };

    driver = spawn(tauriDriverPath, ["--native-driver", nativeDriverPath, "--port", String(port), "--native-port", String(nativePort)], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env,
    });
    const outPath = path.join(logsDir, "http-e2e.tauri-driver.stdout.log");
    const errPath = path.join(logsDir, "http-e2e.tauri-driver.stderr.log");
    const outStream = fs.createWriteStream(outPath, { flags: "a" });
    const errStream = fs.createWriteStream(errPath, { flags: "a" });
    driver.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      outStream.write(chunk);
    });
    driver.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      errStream.write(chunk);
    });

    await waitForDriver(host, port, 30000);
    sessionId = await createSession({ host, port, appPath });
    await runScenario({ host, port, sessionId, sampleImage });
    await deleteSession({ host, port, sessionId });
    sessionId = "";
    outStream.end();
    errStream.end();
  } finally {
    if (sessionId) {
      try {
        await deleteSession({ host, port, sessionId });
      } catch (_error) {
        // ignore cleanup failure
      }
    }
    if (driver && !driver.killed) {
      driver.kill();
    }
    releaseAsciiRepoAlias(alias);
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});

