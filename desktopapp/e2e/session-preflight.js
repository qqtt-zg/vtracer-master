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

  throw new Error("unable to allocate ASCII drive alias via subst for preflight");
}

function releaseAsciiRepoAlias(alias) {
  if (!alias) {
    return;
  }
  runSubst([alias.drive, "/d"]);
}

function requestText({ host, port, requestPath, method = "GET", headers = {}, body = "", timeoutMs = 5000 }) {
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

async function waitForPort(host, port, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await requestText({
        host,
        port,
        requestPath: "/status",
        method: "GET",
        timeoutMs: 3000,
      });
      if (response.statusCode >= 200 && response.statusCode < 300) {
        return;
      }
    } catch (_err) {
      // keep waiting
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`preflight timeout waiting for tauri-driver on ${host}:${port}`);
}

function append(stream, fileStream, chunk) {
  stream.write(chunk);
  fileStream.write(chunk);
}

async function readStatus(host, port) {
  try {
    const response = await requestText({
      host,
      port,
      requestPath: "/status",
      method: "GET",
      timeoutMs: 5000,
    });
    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      statusCode: response.statusCode,
      body: response.body,
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: 0,
      body: String(error && error.message ? error.message : error),
    };
  }
}

async function attemptCreateSession({ host, port, appPath, browserName }) {
  const tauriOptions = {
    application: appPath,
    webviewOptions: {
      additionalBrowserArguments: ["--remote-debugging-port=9222"],
    },
  };

  const payload = {
    capabilities: {
      alwaysMatch: {
        browserName,
        "tauri:options": tauriOptions,
      },
      firstMatch: [{}],
    },
  };
  const attempt = {
    browserName,
    startedAt: new Date().toISOString(),
    ok: false,
    statusCode: 0,
    responseBody: "",
    sessionId: "",
    deleteStatusCode: 0,
    error: "",
  };

  try {
    const response = await requestText({
      host,
      port,
      requestPath: "/session",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      timeoutMs: 45000,
    });
    attempt.statusCode = response.statusCode;
    attempt.responseBody = response.body;

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`session create failed with status ${response.statusCode}`);
    }

    let parsed = {};
    try {
      parsed = JSON.parse(response.body || "{}");
    } catch (_err) {
      // keep parsed empty
    }
    const sessionId = parsed?.value?.sessionId || parsed?.sessionId || "";
    if (!sessionId) {
      throw new Error("session create succeeded but sessionId missing");
    }
    attempt.sessionId = sessionId;

    const deleteResp = await requestText({
      host,
      port,
      requestPath: `/session/${sessionId}`,
      method: "DELETE",
      timeoutMs: 10000,
    });
    attempt.deleteStatusCode = deleteResp.statusCode;
    attempt.ok = true;
  } catch (error) {
    attempt.error = String(error && error.message ? error.message : error);
  } finally {
    attempt.finishedAt = new Date().toISOString();
  }

  return attempt;
}

async function runSessionPreflight(options) {
  const {
    tauriDriverPath,
    nativeDriverPath,
    appPath,
    logsDir,
    host = "127.0.0.1",
    port = 4555,
    nativePort = 9555,
  } = options;

  const outPath = path.join(logsDir, "preflight.tauri-driver.stdout.log");
  const errPath = path.join(logsDir, "preflight.tauri-driver.stderr.log");
  const reportPath = path.join(logsDir, "preflight.report.json");
  const outStream = fs.createWriteStream(outPath, { flags: "a" });
  const errStream = fs.createWriteStream(errPath, { flags: "a" });

  const args = ["--native-driver", nativeDriverPath, "--port", String(port), "--native-port", String(nativePort)];
  const driver = spawn(tauriDriverPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    env: {
      ...process.env,
      TAURI_AUTOMATION: process.env.TAURI_AUTOMATION || "1",
      TAURI_WEBVIEW_AUTOMATION: process.env.TAURI_WEBVIEW_AUTOMATION || "1",
    },
  });

  driver.stdout.on("data", (chunk) => append(process.stdout, outStream, chunk));
  driver.stderr.on("data", (chunk) => append(process.stderr, errStream, chunk));

  const report = {
    startedAt: new Date().toISOString(),
    tauriDriverPath,
    nativeDriverPath,
    appPath,
    host,
    port,
    nativePort,
    statusBeforeSession: null,
    attempts: [],
    sessionCreated: false,
    selectedBrowser: "",
    sessionId: "",
    error: "",
  };

  try {
    await waitForPort(host, port, 20000);
    report.statusBeforeSession = await readStatus(host, port);

    const candidates = ["tauri", "wry"];
    for (const browserName of candidates) {
      const attempt = await attemptCreateSession({ host, port, appPath, browserName });
      report.attempts.push(attempt);
      if (attempt.ok) {
        report.sessionCreated = true;
        report.selectedBrowser = browserName;
        report.sessionId = attempt.sessionId;
        break;
      }
    }

    if (!report.sessionCreated) {
      const brief = report.attempts
        .map((item) => `${item.browserName}:${item.statusCode || "ERR"}:${item.error || "no-error-field"}`)
        .join(" | ");
      throw new Error(`all session attempts failed -> ${brief}`);
    }
  } catch (error) {
    report.error = String(error && error.message ? error.message : error);
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    outStream.end();
    errStream.end();
    if (driver && !driver.killed) {
      driver.kill();
    }
  }
}

async function main() {
  const repoRoot = path.resolve(__dirname, "..", "..");
  let alias = null;
  try {
    alias = createAsciiRepoAliasIfNeeded(repoRoot);
    const effectiveRepoRoot = alias ? alias.mappedRoot : repoRoot;

    const logsDir = process.env.VTRACER_E2E_LOG_DIR || path.resolve(__dirname, ".artifacts", "logs");
    fs.mkdirSync(logsDir, { recursive: true });

    const tauriDriverPath = process.env.TAURI_DRIVER_PATH
      || path.resolve(process.env.USERPROFILE || process.env.HOME || "", ".cargo", "bin", "tauri-driver.exe");
    const nativeDriverPath = process.env.NATIVE_DRIVER_PATH
      || path.resolve(effectiveRepoRoot, "msedgedriver.exe");
    const appPath = process.env.DESKTOP_APP_PATH
      || path.resolve(effectiveRepoRoot, "desktopapp", "src-tauri", "target", "debug", "vtracer-desktop.exe");

    if (!tauriDriverPath || !fs.existsSync(tauriDriverPath)) {
      throw new Error(`TAURI_DRIVER_PATH missing or not found: ${tauriDriverPath || "<empty>"}`);
    }
    if (!nativeDriverPath || !fs.existsSync(nativeDriverPath)) {
      throw new Error(`NATIVE_DRIVER_PATH missing or not found: ${nativeDriverPath || "<empty>"}`);
    }
    if (!appPath || !fs.existsSync(appPath)) {
      throw new Error(`DESKTOP_APP_PATH missing or not found: ${appPath || "<empty>"}`);
    }

    await runSessionPreflight({
      tauriDriverPath,
      nativeDriverPath,
      appPath,
      logsDir,
    });
  } finally {
    releaseAsciiRepoAlias(alias);
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
