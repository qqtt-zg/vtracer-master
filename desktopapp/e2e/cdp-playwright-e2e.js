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
  throw new Error("unable to allocate ASCII drive alias via subst for cdp e2e");
}

function releaseAsciiRepoAlias(alias) {
  if (!alias) {
    return;
  }
  runSubst([alias.drive, "/d"]);
}

function loadPlaywrightChromium() {
  const candidates = [
    () => require("playwright"),
    () => require(path.resolve(__dirname, "..", "..", "webapp", "app", "node_modules", "playwright")),
    () => require(path.resolve(__dirname, "..", "..", "webapp", "app", "node_modules", "@playwright", "test")),
  ];
  for (const factory of candidates) {
    try {
      const mod = factory();
      if (mod && mod.chromium) {
        return mod.chromium;
      }
    } catch (_err) {
      // keep trying
    }
  }
  throw new Error("Playwright chromium API not found. Install deps in webapp/app or desktopapp/e2e.");
}

function requestJson(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          statusCode: Number(res.statusCode || 0),
          text,
        });
      });
    });
    req.on("error", (error) => reject(error));
    req.setTimeout(timeoutMs, () => req.destroy(new Error("request timeout")));
  });
}

async function waitForCdpReady(host, port, timeoutMs) {
  const started = Date.now();
  const url = `http://${host}:${port}/json/version`;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await requestJson(url, 3000);
      if (response.statusCode >= 200 && response.statusCode < 300) {
        return;
      }
    } catch (_err) {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timeout waiting for CDP endpoint ${url}`);
}

async function waitForPage(browser, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (const context of browser.contexts()) {
      const pages = context.pages();
      if (pages.length > 0) {
        return pages[0];
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("no page detected in CDP contexts");
}

async function runScenario(page, sampleImage) {
  await page.waitForFunction(
    () => !!(window.__VTRACER_E2E && typeof window.__VTRACER_E2E.openImageByPath === "function"),
    null,
    { timeout: 30000 },
  );

  const openResult = await page.evaluate(async (inputPath) => {
    try {
      const result = await window.__VTRACER_E2E.openImageByPath(inputPath);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }, sampleImage);
  if (!openResult || !openResult.ok) {
    throw new Error(`openImageByPath failed: ${JSON.stringify(openResult)}`);
  }

  await page.waitForFunction(
    () => document.querySelectorAll("#svg path").length > 0,
    null,
    { timeout: 120000 },
  );

  const beforeSvg = await page.locator("#svg").innerHTML();
  await page.evaluate(() => {
    const slider = document.querySelector("#colorprecision");
    if (!slider) {
      throw new Error("colorprecision slider missing");
    }
    slider.value = "3";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
    slider.value = "7";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
  });

  await page.waitForFunction(
    (before) => {
      const el = document.querySelector("#svg");
      return !!el && el.innerHTML !== before;
    },
    beforeSvg,
    { timeout: 120000 },
  );

  await page.locator("#export").click();
  const svgExport = await page.evaluate(async () => {
    try {
      const result = await window.__VTRACER_E2E.getLastExportPath();
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  });
  if (!svgExport || !svgExport.ok || !svgExport.result || !svgExport.result.path) {
    throw new Error(`svg export failed: ${JSON.stringify(svgExport)}`);
  }
  if (!/\.svg$/i.test(svgExport.result.path) || !fs.existsSync(svgExport.result.path)) {
    throw new Error(`svg export file missing: ${svgExport.result.path}`);
  }
  if (fs.statSync(svgExport.result.path).size <= 0) {
    throw new Error(`svg export file empty: ${svgExport.result.path}`);
  }

  await page.locator("#exportPdf").click();
  const pdfExport = await page.evaluate(async () => {
    try {
      const result = await window.__VTRACER_E2E.getLastExportPath();
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  });
  if (!pdfExport || !pdfExport.ok || !pdfExport.result || !pdfExport.result.path) {
    throw new Error(`pdf export failed: ${JSON.stringify(pdfExport)}`);
  }
  if (!/\.pdf$/i.test(pdfExport.result.path) || !fs.existsSync(pdfExport.result.path)) {
    throw new Error(`pdf export file missing: ${pdfExport.result.path}`);
  }
  if (fs.statSync(pdfExport.result.path).size <= 0) {
    throw new Error(`pdf export file empty: ${pdfExport.result.path}`);
  }
}

async function main() {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const logsDir = process.env.VTRACER_E2E_LOG_DIR || path.resolve(__dirname, ".artifacts", "logs");
  const settingsDir = process.env.VTRACER_SETTINGS_DIR || path.resolve(__dirname, ".artifacts", "settings");
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(settingsDir, { recursive: true });

  let alias = null;
  let appProc = null;
  let browser = null;
  let outStream = null;
  let errStream = null;

  try {
    alias = createAsciiRepoAliasIfNeeded(repoRoot);
    const effectiveRepoRoot = alias ? alias.mappedRoot : repoRoot;

    const appPath = process.env.DESKTOP_APP_PATH
      || path.resolve(effectiveRepoRoot, "desktopapp", "src-tauri", "target", "debug", "vtracer-desktop.exe");
    const sampleImage = process.env.SAMPLE_IMAGE
      || path.resolve(effectiveRepoRoot, "webapp", "app", "public", "assets", "samples", "test-logo.png");
    const host = process.env.VTRACER_CDP_HOST || "127.0.0.1";
    const cdpPort = Number(process.env.VTRACER_WEBVIEW_DEBUG_PORT || 9333);

    if (!fs.existsSync(appPath)) {
      throw new Error(`desktop app not found: ${appPath}`);
    }
    if (!fs.existsSync(sampleImage)) {
      throw new Error(`sample image not found: ${sampleImage}`);
    }

    const stdoutPath = path.join(logsDir, "cdp-e2e.app.stdout.log");
    const stderrPath = path.join(logsDir, "cdp-e2e.app.stderr.log");
    outStream = fs.createWriteStream(stdoutPath, { flags: "a" });
    errStream = fs.createWriteStream(stderrPath, { flags: "a" });

    appProc = spawn(appPath, [], {
      cwd: path.dirname(appPath),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        TAURI_AUTOMATION: process.env.TAURI_AUTOMATION || "1",
        TAURI_WEBVIEW_AUTOMATION: process.env.TAURI_WEBVIEW_AUTOMATION || "1",
        VTRACER_E2E_ENABLED: process.env.VTRACER_E2E_ENABLED || "1",
        VTRACER_WEBVIEW_DEBUG_PORT: String(cdpPort),
        VTRACER_SETTINGS_DIR: settingsDir,
      },
    });
    appProc.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      outStream.write(chunk);
    });
    appProc.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      errStream.write(chunk);
    });

    await waitForCdpReady(host, cdpPort, 30000);

    const chromium = loadPlaywrightChromium();
    browser = await chromium.connectOverCDP(`http://${host}:${cdpPort}`);
    const page = await waitForPage(browser, 30000);
    await page.bringToFront();

    await runScenario(page, sampleImage);

  } finally {
    if (outStream) {
      outStream.end();
    }
    if (errStream) {
      errStream.end();
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (appProc && !appProc.killed) {
      appProc.kill();
    }
    releaseAsciiRepoAlias(alias);
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
