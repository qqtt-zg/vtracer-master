<div align="center">
  <img src="https://github.com/visioncortex/vtracer/raw/master/docs/images/visioncortex-banner.png">
</div>

# visioncortex VTracer Web 应用

这是一个将位图图像转换为矢量图的 Web 应用。

## 环境准备

1. 安装 Rust：https://www.rust-lang.org/tools/install
2. 安装 wasm-pack：https://rustwasm.github.io/wasm-pack/installer/
3. 安装 Node.js（建议 LTS 版本）

## 快速开始

1. 安装前端依赖

```sh
cd app
npm install
```

2. 构建 wasm 包

```sh
cd ..
wasm-pack build
```

3. 启动开发服务器

```sh
cd app
npm run start
```

浏览器访问：`http://localhost:8080/`

4. 构建生产包

```sh
npm run build
```
