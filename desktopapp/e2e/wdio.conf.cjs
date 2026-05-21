const path = require("path");

const appPath = process.env.DESKTOP_APP_PATH
  || path.resolve(__dirname, "../src-tauri/target/debug/vtracer-desktop.exe");
const tauriDriverPath = process.env.TAURI_DRIVER_PATH
  || path.resolve(process.env.USERPROFILE || process.env.HOME || "", ".cargo", "bin", "tauri-driver.exe");
const nativeDriverPath = process.env.NATIVE_DRIVER_PATH || "";
const logDir = process.env.VTRACER_E2E_LOG_DIR
  || path.resolve(__dirname, ".artifacts", "tauri-service");
const appSettingsDir = process.env.VTRACER_SETTINGS_DIR
  || path.resolve(__dirname, ".artifacts", "settings");

exports.config = {
  runner: "local",
  specs: ["./specs/**/*.e2e.js"],
  maxInstances: 1,
  logLevel: "info",
  outputDir: logDir,
  waitforTimeout: 30000,
  connectionRetryTimeout: 90000,
  connectionRetryCount: 2,
  services: [[
    "tauri",
    {
      appBinaryPath: appPath,
      application: appPath,
      driverProvider: "official",
      tauriDriverPath,
      nativeDriverPath: nativeDriverPath || undefined,
      env: {
        VTRACER_SETTINGS_DIR: appSettingsDir,
        VTRACER_E2E_ENABLED: "1",
        TAURI_AUTOMATION: "1",
        TAURI_WEBVIEW_AUTOMATION: "1",
      },
      autoInstallTauriDriver: false,
      autoDownloadEdgeDriver: true,
      tauriDriverPort: 4444,
      startTimeout: 60000,
      commandTimeout: 60000,
      captureBackendLogs: true,
      captureFrontendLogs: true,
      backendLogLevel: "debug",
      frontendLogLevel: "debug",
      logLevel: "debug",
      logDir,
    },
  ]],
  capabilities: [{
    browserName: "tauri",
    "tauri:options": {
      application: appPath,
      webviewOptions: {
        additionalBrowserArguments: ["--remote-debugging-port=9222"],
      },
    }
  }],
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 180000
  },
  before: async () => {
    await browser.pause(500);
  },
};
