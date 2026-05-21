# DesktopApp（Tauri 路线）

## 目标

- 保留浏览器版的同时，提供 Windows 可安装桌面端。
- 前端仍以 `webapp/app` 为唯一源码，桌面端只消费 `webapp/app/dist`。
- 实时转换与导出由 Tauri Rust 命令执行，不走 CLI 子进程。

## 当前强化点（v1+）

- 实时转换改为 worker 进程执行，支持“新请求到达即中断旧任务”。
- 桌面端参数变更策略：300ms 防抖 + 后端中断 + 仅最后一次结果回写。
- 新增无边框窗口样式与自绘标题栏按钮（最小化 / 最大化 / 关闭）。
- 保留回退开关：设置 `VTRACER_USE_SYSTEM_FRAME=1` 可启用系统边框。
- 新增桌面 E2E 脚手架（`desktopapp/e2e`），通过测试命令绕过文件对话框。

## 目录职责

- `desktopapp/src-tauri`：Tauri Rust 后端与配置。
- `desktopapp/scripts/dev.ps1`：先构建 webapp dist，再启动 `cargo tauri dev`。
- `desktopapp/scripts/build.ps1`：先构建 webapp dist，再执行 `cargo tauri build`。
- `desktopapp/e2e`：桌面端 E2E（tauri-driver + WebDriverIO）。

## 开发与打包

```powershell
# 桌面调试（默认先构建 webapp dist）
powershell -ExecutionPolicy Bypass -File .\desktopapp\scripts\dev.ps1

# 仅启动 tauri dev（跳过 web 构建）
powershell -ExecutionPolicy Bypass -File .\desktopapp\scripts\dev.ps1 -SkipWebBuild

# Windows 打包
powershell -ExecutionPolicy Bypass -File .\desktopapp\scripts\build.ps1
```

## 桌面 E2E（Windows）

```powershell
# 1) 构建桌面调试版
cargo build --manifest-path .\desktopapp\src-tauri\Cargo.toml

# 2) 准备 tauri-driver + msedgedriver（首次）
cargo install tauri-driver --locked
cargo install --git https://github.com/chippers/msedgedriver-tool
.\msedgedriver-tool.exe

# 3) 执行 E2E
$env:NATIVE_DRIVER_PATH="I:\path\to\msedgedriver.exe"
$env:TAURI_DRIVER_PATH="$env:USERPROFILE\.cargo\bin\tauri-driver.exe"
npm --prefix .\desktopapp\e2e test
```

## 产物位置

- 可执行文件：`desktopapp/src-tauri/target/release/vtracer-desktop.exe`
- NSIS 安装包：`desktopapp/src-tauri/target/release/bundle/nsis/VTracer Desktop_0.1.0_x64-setup.exe`
