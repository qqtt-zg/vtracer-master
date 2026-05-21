# DesktopApp（Tauri 路线）

## 方向决策

- 桌面端技术路线锁定为 **Tauri**。
- 当前阶段目标：先完成最小可执行骨架规范，避免“目录存在但职责不清”。

## 目录职责

- `desktopapp/ui`：桌面端前端壳层（可复用 `webapp/app` 产物或组件）。
- `desktopapp/src-tauri/src`：Tauri Rust 后端（窗口、命令、文件系统/导出能力）。
- `desktopapp/src-tauri/capabilities`：权限能力声明。
- `desktopapp/src-tauri/gen`：生成文件（schema 等），不作为业务逻辑编辑入口。
- `desktopapp/scripts`：桌面端开发/打包辅助脚本。

## 构建入口约定

- 开发：`cargo tauri dev`（在 `desktopapp/src-tauri` 执行）。
- 打包：`cargo tauri build`。

## 与 Web 产物对接

- 默认策略：优先复用 `webapp/app` 作为 UI 源，避免独立维护两套前端逻辑。
- 发布时可选择：
  - 直接加载同仓库构建产物；
  - 或在桌面端打包阶段拉取 `webapp/app/dist` 作为静态资源。

## 后续里程碑

1. 接入最小窗口 + 本地文件导入/导出命令。
2. 打通一次“导入位图 -> 输出 SVG”桌面流程。
3. 补桌面端冒烟测试与发布流水线。
