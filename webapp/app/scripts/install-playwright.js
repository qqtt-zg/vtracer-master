const path = require("path");
const { spawnSync } = require("child_process");

const browsersPath = path.resolve(__dirname, "..", ".playwright-browsers");
const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath };

const args = ["playwright", "install"];
if (process.env.CI) {
  args.push("--with-deps");
}
args.push("chromium");

const result = spawnSync("npx", args, {
  stdio: "inherit",
  shell: true,
  env,
});

process.exit(result.status ?? 1);
