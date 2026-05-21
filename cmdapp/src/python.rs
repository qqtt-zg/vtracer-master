use crate::*;
use image::{io::Reader, ImageFormat};
use pyo3::{exceptions::{PyRuntimeError, PyValueError}, prelude::*};
use std::io::{BufReader, Cursor};
use std::path::PathBuf;
use visioncortex::PathSimplifyMode;

/// Python binding
#[pyfunction]
fn convert_image_to_svg_py(
    image_path: &str,
    out_path: &str,
    colormode: Option<&str>,       // "color" or "binary"
    hierarchical: Option<&str>,    // "stacked" or "cutout"
    mode: Option<&str>,            // "polygon", "spline", "none"
    filter_speckle: Option<usize>, // default: 4
    color_precision: Option<i32>,  // default: 6
    layer_difference: Option<i32>, // default: 16
    corner_threshold: Option<i32>, // default: 60
    length_threshold: Option<f64>, // in [3.5, 10] default: 4.0
    max_iterations: Option<usize>, // default: 10
    splice_threshold: Option<i32>, // default: 45
    path_precision: Option<u32>,   // default: 8
) -> PyResult<()> {
    let input_path = PathBuf::from(image_path);
    let output_path = PathBuf::from(out_path);

    let config = construct_config(
        colormode,
        hierarchical,
        mode,
        filter_speckle,
        color_precision,
        layer_difference,
        corner_threshold,
        length_threshold,
        max_iterations,
        splice_threshold,
        path_precision,
    )
    .map_err(PyValueError::new_err)?;

    convert_image_to_svg(&input_path, &output_path, config).map_err(PyRuntimeError::new_err)?;
    Ok(())
}

#[pyfunction]
fn convert_raw_image_to_svg(
    img_bytes: Vec<u8>,
    img_format: Option<&str>, // Format of the image (e.g. 'jpg', 'png'... A full list of supported formats can be found [here](https://docs.rs/image/latest/image/enum.ImageFormat.html)). If not provided, the image format will be guessed based on its contents.
    colormode: Option<&str>,  // "color" or "binary"
    hierarchical: Option<&str>, // "stacked" or "cutout"
    mode: Option<&str>,       // "polygon", "spline", "none"
    filter_speckle: Option<usize>, // default: 4
    color_precision: Option<i32>, // default: 6
    layer_difference: Option<i32>, // default: 16
    corner_threshold: Option<i32>, // default: 60
    length_threshold: Option<f64>, // in [3.5, 10] default: 4.0
    max_iterations: Option<usize>, // default: 10
    splice_threshold: Option<i32>, // default: 45
    path_precision: Option<u32>, // default: 8
) -> PyResult<String> {
    let config = construct_config(
        colormode,
        hierarchical,
        mode,
        filter_speckle,
        color_precision,
        layer_difference,
        corner_threshold,
        length_threshold,
        max_iterations,
        splice_threshold,
        path_precision,
    )
    .map_err(PyValueError::new_err)?;
    let mut img_reader = Reader::new(BufReader::new(Cursor::new(img_bytes)));
    let img_format = img_format.and_then(|ext_name| ImageFormat::from_extension(ext_name));
    let img = match img_format {
        Some(img_format) => {
            img_reader.set_format(img_format);
            img_reader.decode()
        }
        None => img_reader
            .with_guessed_format()
            .map_err(|_| PyValueError::new_err("无法识别图像格式。"))?
            .decode(),
    };
    let img = match img {
        Ok(img) => img.to_rgba8(),
        Err(_) => return Err(PyValueError::new_err("无法解码 img_bytes。")),
    };
    let (width, height) = (img.width() as usize, img.height() as usize);
    let img = ColorImage {
        pixels: img.as_raw().to_vec(),
        width,
        height,
    };
    let svg = convert(img, config).map_err(PyRuntimeError::new_err)?;
    Ok(format!("{}", svg))
}

#[pyfunction]
fn convert_pixels_to_svg(
    rgba_pixels: Vec<(u8, u8, u8, u8)>,
    size: (usize, usize),
    colormode: Option<&str>,       // "color" or "binary"
    hierarchical: Option<&str>,    // "stacked" or "cutout"
    mode: Option<&str>,            // "polygon", "spline", "none"
    filter_speckle: Option<usize>, // default: 4
    color_precision: Option<i32>,  // default: 6
    layer_difference: Option<i32>, // default: 16
    corner_threshold: Option<i32>, // default: 60
    length_threshold: Option<f64>, // in [3.5, 10] default: 4.0
    max_iterations: Option<usize>, // default: 10
    splice_threshold: Option<i32>, // default: 45
    path_precision: Option<u32>,   // default: 8
) -> PyResult<String> {
    let expected_pixel_count = size.0 * size.1;
    if rgba_pixels.len() != expected_pixel_count {
        return Err(PyValueError::new_err(format!(
            "rgba_pixels 长度与图像尺寸不匹配。期望 {} ({} * {}), 实际 {}。",
            expected_pixel_count,
            size.0,
            size.1,
            rgba_pixels.len()
        )));
    }
    let config = construct_config(
        colormode,
        hierarchical,
        mode,
        filter_speckle,
        color_precision,
        layer_difference,
        corner_threshold,
        length_threshold,
        max_iterations,
        splice_threshold,
        path_precision,
    )
    .map_err(PyValueError::new_err)?;
    let mut flat_pixels: Vec<u8> = vec![];
    for (r, g, b, a) in rgba_pixels {
        flat_pixels.push(r);
        flat_pixels.push(g);
        flat_pixels.push(b);
        flat_pixels.push(a);
    }
    let mut img = ColorImage::new();
    img.pixels = flat_pixels;
    (img.width, img.height) = size;

    let svg = convert(img, config).map_err(PyRuntimeError::new_err)?;
    Ok(format!("{}", svg))
}

fn construct_config(
    colormode: Option<&str>,
    hierarchical: Option<&str>,
    mode: Option<&str>,
    filter_speckle: Option<usize>,
    color_precision: Option<i32>,
    layer_difference: Option<i32>,
    corner_threshold: Option<i32>,
    length_threshold: Option<f64>,
    max_iterations: Option<usize>,
    splice_threshold: Option<i32>,
    path_precision: Option<u32>,
) -> Result<Config, String> {
    let color_mode = match colormode.unwrap_or("color").trim().to_ascii_lowercase().as_str() {
        "color" => ColorMode::Color,
        "binary" => ColorMode::Binary,
        other => return Err(format!("无效的 colormode: {other}，仅支持 color 或 binary")),
    };

    let hierarchical = match hierarchical
        .unwrap_or("stacked")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "stacked" => Hierarchical::Stacked,
        "cutout" => Hierarchical::Cutout,
        other => return Err(format!("无效的 hierarchical: {other}，仅支持 stacked 或 cutout")),
    };

    let mode = match mode.unwrap_or("spline").trim().to_ascii_lowercase().as_str() {
        "spline" => PathSimplifyMode::Spline,
        "polygon" => PathSimplifyMode::Polygon,
        "none" => PathSimplifyMode::None,
        other => return Err(format!("无效的 mode: {other}，仅支持 spline/polygon/none")),
    };

    let filter_speckle = filter_speckle.unwrap_or(4);
    let color_precision = color_precision.unwrap_or(6);
    let layer_difference = layer_difference.unwrap_or(16);
    let corner_threshold = corner_threshold.unwrap_or(60);
    let length_threshold = length_threshold.unwrap_or(4.0);
    let splice_threshold = splice_threshold.unwrap_or(45);
    let max_iterations = max_iterations.unwrap_or(10);

    if filter_speckle > 16 {
        return Err(format!(
            "filter_speckle={filter_speckle} 超出范围，必须在 [0,16]"
        ));
    }
    if !(1..=8).contains(&color_precision) {
        return Err(format!(
            "color_precision={color_precision} 超出范围，必须在 [1,8]"
        ));
    }
    if !(0..=255).contains(&layer_difference) {
        return Err(format!(
            "layer_difference={layer_difference} 超出范围，必须在 [0,255]"
        ));
    }
    if !(0..=180).contains(&corner_threshold) {
        return Err(format!(
            "corner_threshold={corner_threshold} 超出范围，必须在 [0,180]"
        ));
    }
    if !(3.5..=10.0).contains(&length_threshold) {
        return Err(format!(
            "length_threshold={length_threshold} 超出范围，必须在 [3.5,10]"
        ));
    }
    if !(0..=180).contains(&splice_threshold) {
        return Err(format!(
            "splice_threshold={splice_threshold} 超出范围，必须在 [0,180]"
        ));
    }

    Ok(Config {
        color_mode,
        hierarchical,
        filter_speckle,
        color_precision,
        layer_difference,
        mode,
        corner_threshold,
        length_threshold,
        max_iterations,
        splice_threshold,
        path_precision,
        ..Default::default()
    })
}

/// A Python module implemented in Rust.
#[pymodule]
fn vtracer(_py: Python, m: &PyModule) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(convert_image_to_svg_py, m)?)?;
    m.add_function(wrap_pyfunction!(convert_raw_image_to_svg, m)?)?;
    m.add_function(wrap_pyfunction!(convert_pixels_to_svg, m)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn construct_config_rejects_invalid_mode() {
        let result = construct_config(
            Some("color"),
            Some("stacked"),
            Some("bad-mode"),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        assert!(result.is_err());
    }

    #[test]
    fn construct_config_rejects_invalid_color_mode() {
        let result = construct_config(
            Some("invalid"),
            Some("stacked"),
            Some("spline"),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        assert!(result.is_err());
    }

    #[test]
    fn construct_config_rejects_invalid_range() {
        let result = construct_config(
            Some("color"),
            Some("stacked"),
            Some("spline"),
            Some(32),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        assert!(result.is_err());
    }
}
