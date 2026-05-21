const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..", "..");
const defaultNativeDriverPath = path.resolve(repoRoot, "msedgedriver.exe");

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

function ensureServiceExpectedBinary(rawAppPath) {
  const srcTauriDir = path.resolve(repoRoot, "desktopapp", "src-tauri");
  const tauriConfigPath = path.join(srcTauriDir, "tauri.conf.json");
  if (!fs.existsSync(rawAppPath) || !fs.existsSync(tauriConfigPath)) {
    return;
  }
  const tauriConfig = JSON.parse(fs.readFileSync(tauriConfigPath, "utf8"));
  const productName = String(tauriConfig.productName || "").trim();
  if (!productName) {
    return;
  }
  const expectedBinary = path.join(path.dirname(rawAppPath), `${productName}.exe`);
  if (path.resolve(expectedBinary).toLowerCase() === path.resolve(rawAppPath).toLowerCase()) {
    return;
  }
  const rawStat = fs.statSync(rawAppPath);
  if (fs.existsSync(expectedBinary)) {
    const expectedStat = fs.statSync(expectedBinary);
    if (expectedStat.mtimeMs >= rawStat.mtimeMs && expectedStat.size === rawStat.size) {
      return;
    }
  }
  try {
    fs.copyFileSync(rawAppPath, expectedBinary);
  } catch (error) {
    if (error && error.code === "EPERM" && fs.existsSync(expectedBinary)) {
      return;
    }
    throw error;
  }
}

function runWdioWithLogs(env, logsDir) {
  return new Promise((resolve, reject) => {
    const wdioCli = path.resolve(__dirname, "node_modules", "@wdio", "cli", "bin", "wdio.js");
    const outLogPath = path.join(logsDir, "wdio.stdout.log");
    const errLogPath = path.join(logsDir, "wdio.stderr.log");
    const outStream = fs.createWriteStream(outLogPath, { flags: "a" });
    const errStream = fs.createWriteStream(errLogPath, { flags: "a" });

    const child = spawn(process.execPath, [wdioCli, "run", "wdio.conf.cjs"], {
      cwd: __dirname,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      outStream.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      errStream.write(chunk);
    });
    child.on("error", (error) => {
      outStream.end();
      errStream.end();
      reject(error);
    });
    child.on("close", (code) => {
      outStream.end();
      errStream.end();
      resolve(code ?? 1);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runNodeScriptWithLogs(scriptPath, env, logsDir, prefix) {
  return new Promise((resolve, reject) => {
    const outLogPath = path.join(logsDir, `${prefix}.stdout.log`);
    const errLogPath = path.join(logsDir, `${prefix}.stderr.log`);
    const outStream = fs.createWriteStream(outLogPath, { flags: "a" });
    const errStream = fs.createWriteStream(errLogPath, { flags: "a" });

    const child = spawn(process.execPath, [scriptPath], {
      cwd: __dirname,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      outStream.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      errStream.write(chunk);
    });
    child.on("error", (error) => {
      outStream.end();
      errStream.end();
      reject(error);
    });
    child.on("close", (code) => {
      outStream.end();
      errStream.end();
      resolve(code ?? 1);
    });
  });
}

async function main() {
  let alias = null;
  try {
    alias = createAsciiRepoAliasIfNeeded(repoRoot);
    const effectiveRepoRoot = alias ? alias.mappedRoot : repoRoot;

    const rawAppPath = process.env.DESKTOP_APP_PATH
      || path.resolve(effectiveRepoRoot, "desktopapp", "src-tauri", "target", "debug", "vtracer-desktop.exe");
    if (!fs.existsSync(rawAppPath)) {
      throw new Error(`desktop app not found: ${rawAppPath}`);
    }
    const rawSampleImage = process.env.SAMPLE_IMAGE
      || path.resolve(effectiveRepoRoot, "webapp", "app", "public", "assets", "samples", "test-logo.png");
    if (!fs.existsSync(rawSampleImage)) {
      throw new Error(`sample image not found: ${rawSampleImage}`);
    }
    const nativeDriverPath = process.env.NATIVE_DRIVER_PATH || defaultNativeDriverPath;

    const tempRoot = path.resolve(process.env.TEMP || process.env.TMP || __dirname, "vtracer-desktop-e2e");
    const logsDir = path.resolve(__dirname, ".artifacts", "logs");
    fs.mkdirSync(tempRoot, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });
    const sampleImage = path.join(tempRoot, "sample-image.png");
    ensureServiceExpectedBinary(rawAppPath);
    fs.copyFileSync(rawSampleImage, sampleImage);

    const debugPort = Number(process.env.VTRACER_WEBVIEW_DEBUG_PORT || (13000 + (Date.now() % 10000)));
    const env = {
      ...process.env,
      DESKTOP_APP_PATH: rawAppPath,
      SAMPLE_IMAGE: sampleImage,
      VTRACER_SETTINGS_DIR: path.join(tempRoot, "settings"),
      VTRACER_E2E_LOG_DIR: logsDir,
      VTRACER_E2E_ENABLED: "1",
      TAURI_AUTOMATION: "1",
      TAURI_WEBVIEW_AUTOMATION: "1",
      VTRACER_WEBVIEW_DEBUG_PORT: String(debugPort),
    };
    if (fs.existsSync(nativeDriverPath)) {
      env.NATIVE_DRIVER_PATH = nativeDriverPath;
      const nativeDriverDir = path.dirname(nativeDriverPath);
      env.PATH = `${nativeDriverDir};${env.PATH || ""}`;
    }
    fs.mkdirSync(env.VTRACER_SETTINGS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(logsDir, "run.meta.json"),
      JSON.stringify(
        {
          appPath: rawAppPath,
          sampleImage,
          settingsDir: env.VTRACER_SETTINGS_DIR,
          asciiRepoAlias: alias ? alias.drive : "",
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    const preflightScript = path.resolve(__dirname, "session-preflight.js");
    let preflightExit = 1;
    for (let i = 1; i <= 3; i += 1) {
      preflightExit = await runNodeScriptWithLogs(preflightScript, env, logsDir, "preflight.exec");
      if (preflightExit === 0) {
        break;
      }
      await sleep(800);
    }
    if (preflightExit !== 0) {
      process.exit(preflightExit);
    }

    try {
      const preflightReportPath = path.join(logsDir, "preflight.report.json");
      if (fs.existsSync(preflightReportPath)) {
        const preflight = JSON.parse(fs.readFileSync(preflightReportPath, "utf8"));
        const selected = String(preflight.selectedBrowser || "").trim();
        if (selected) {
          env.VTRACER_WEBDRIVER_BROWSER = selected;
        }
      }
    } catch (_error) {
      // fallback to default browserName in wdio config
    }

    let exitCode = 1;
    for (let i = 1; i <= 2; i += 1) {
      exitCode = await runWdioWithLogs(env, logsDir);
      if (exitCode === 0) {
        break;
      }
      await sleep(800);
    }
    process.exit(exitCode);
  } finally {
    releaseAsciiRepoAlias(alias);
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});





