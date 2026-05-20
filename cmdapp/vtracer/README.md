<div align="center">

  <img src="https://github.com/visioncortex/vtracer/raw/master/docs/images/visioncortex-banner.png">
  
  <h1>VTracer：Python 绑定</h1>

  <p>
    <strong>基于 visioncortex 的位图转矢量图转换器</strong>
  </p>

  <h3>
    <a href="//www.visioncortex.org/vtracer-docs">算法文档</a>
    <span> | </span>
    <a href="//www.visioncortex.org/vtracer/">在线演示</a>
    <span> | </span>
    <a href="//github.com/visioncortex/vtracer/releases/latest">下载</a>
  </h3>

</div>

## 简介

`visioncortex VTracer` 是将位图图像（如 `jpg/png`）转换为矢量图（`svg`）的开源工具。Python 绑定让你可以直接在 Python 项目中调用该能力。

## 安装（Python）

```shell
pip install vtracer
```

## 使用（Python）

```python
import vtracer

inp = "/path/to/input.jpg"
out = "/path/to/output.svg"

# 最小示例：使用默认参数
vtracer.convert_image_to_svg_py(inp, out)

# 黑白模式（适合线稿，通常更快）
vtracer.convert_image_to_svg_py(inp, out, colormode='binary')

# 从图片字节转换
input_img_bytes: bytes = get_bytes()
svg_str: str = vtracer.convert_raw_image_to_svg(input_img_bytes, img_format='jpg')

# 从 RGBA 像素转换
from PIL import Image
img = Image.open(inp).convert('RGBA')
pixels = list(img.getdata())
svg_str = vtracer.convert_pixels_to_svg(pixels, img.size)

# 完整参数示例
vtracer.convert_image_to_svg_py(
    inp,
    out,
    colormode='color',          # "color" 或 "binary"
    hierarchical='stacked',     # "stacked" 或 "cutout"
    mode='spline',              # "spline" / "polygon" / "none"
    filter_speckle=4,
    color_precision=6,
    layer_difference=16,
    corner_threshold=60,
    length_threshold=4.0,
    max_iterations=10,
    splice_threshold=45,
    path_precision=3
)
```

## Rust 版本

Rust 库见：
- //crates.io/crates/vtracer
- //crates.io/crates/vtracer-webapp
