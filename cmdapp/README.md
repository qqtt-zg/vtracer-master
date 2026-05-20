<div align="center">

  <img src="https://raw.githubusercontent.com/visioncortex/vtracer/master/docs/images/visioncortex-banner.png">
  <h1>VTracer</h1>

  <p>
    <strong>基于 visioncortex 的位图转矢量图工具</strong>
  </p>

  <h3>
    <a href="https://www.visioncortex.org/vtracer-docs">算法文档</a>
    <span> | </span>
    <a href="https://www.visioncortex.org/vtracer/">在线演示</a>
    <span> | </span>
    <a href="https://github.com/visioncortex/vtracer/releases/latest">下载</a>
  </h3>

</div>

## 简介

VTracer 是一个开源项目，用于将位图图像（`jpg/png`）转换为矢量图（`svg`）。

与仅支持二值图输入的 Potrace 相比，VTracer 支持彩色图像处理；与部分图形软件的自动描摹相比，VTracer 往往能得到更紧凑的输出形状。

## 命令行工具

```sh
visioncortex VTracer 0.6.0
一个将图像转换为矢量图的命令行工具。

USAGE:
    vtracer [OPTIONS] --input <input> --output <output>
```

## 安装

### 下载预编译二进制

https://github.com/visioncortex/vtracer/releases

### 从 crates.io 安装

```sh
cargo install vtracer
```

## 使用

```sh
./vtracer --input input.jpg --output output.svg
```
