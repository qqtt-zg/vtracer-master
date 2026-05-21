mod config;
mod converter;
mod svg;

use clap::{App, Arg};
use config::{ColorMode, Config, Hierarchical, Preset};
use std::ffi::OsString;
use std::fmt;
use std::path::PathBuf;
use std::str::FromStr;
use visioncortex::PathSimplifyMode;

#[derive(Debug, Clone)]
enum CliError {
    Arguments(String),
    Validation(String),
    Convert(String),
}

impl CliError {
    fn exit_code(&self) -> i32 {
        match self {
            Self::Arguments(_) | Self::Validation(_) => 2,
            Self::Convert(_) => 1,
        }
    }
}

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Arguments(msg) => write!(f, "{msg}"),
            Self::Validation(msg) => write!(f, "参数错误: {msg}"),
            Self::Convert(msg) => write!(f, "转换失败: {msg}"),
        }
    }
}

fn build_app() -> App<'static, 'static> {
    App::new("visioncortex VTracer ".to_owned() + env!("CARGO_PKG_VERSION"))
        .about("将位图图像转换为矢量图形（SVG）的命令行工具。")
        .arg(
            Arg::with_name("input")
                .long("input")
                .short("i")
                .takes_value(true)
                .help("输入位图图像路径")
                .required(true),
        )
        .arg(
            Arg::with_name("output")
                .long("output")
                .short("o")
                .takes_value(true)
                .help("输出矢量图（SVG）路径")
                .required(true),
        )
        .arg(
            Arg::with_name("color_mode")
                .long("colormode")
                .takes_value(true)
                .help("颜色模式：`color`（默认，彩色）或 `bw`（黑白）"),
        )
        .arg(
            Arg::with_name("hierarchical")
                .long("hierarchical")
                .takes_value(true)
                .help("分层聚类：`stacked`（默认，叠层）或 `cutout`（非叠层）。仅在彩色模式下生效。"),
        )
        .arg(
            Arg::with_name("preset")
                .long("preset")
                .takes_value(true)
                .help("使用预设配置：`bw`、`poster`、`photo`"),
        )
        .arg(
            Arg::with_name("filter_speckle")
                .long("filter_speckle")
                .short("f")
                .takes_value(true)
                .help("过滤面积小于 X 像素的色块"),
        )
        .arg(
            Arg::with_name("color_precision")
                .long("color_precision")
                .short("p")
                .takes_value(true)
                .help("每个 RGB 通道保留的有效位数"),
        )
        .arg(
            Arg::with_name("gradient_step")
                .long("gradient_step")
                .short("g")
                .takes_value(true)
                .help("渐变层之间的颜色差值"),
        )
        .arg(
            Arg::with_name("corner_threshold")
                .long("corner_threshold")
                .short("c")
                .takes_value(true)
                .help("判定为拐角的最小瞬时角度（度）"),
        )
        .arg(
            Arg::with_name("segment_length")
                .long("segment_length")
                .short("l")
                .takes_value(true)
                .help("迭代细分平滑，直到所有线段长度都小于该值"),
        )
        .arg(
            Arg::with_name("splice_threshold")
                .long("splice_threshold")
                .short("s")
                .takes_value(true)
                .help("样条切分所需的最小角位移（度）"),
        )
        .arg(
            Arg::with_name("mode")
                .long("mode")
                .short("m")
                .takes_value(true)
                .help("曲线拟合模式：`pixel`、`polygon`、`spline`"),
        )
        .arg(
            Arg::with_name("path_precision")
                .long("path_precision")
                .takes_value(true)
                .help("SVG 路径小数位精度"),
        )
}

fn path_simplify_mode_from_str(s: &str) -> Result<PathSimplifyMode, CliError> {
    match s {
        "polygon" => Ok(PathSimplifyMode::Polygon),
        "spline" => Ok(PathSimplifyMode::Spline),
        "none" => Ok(PathSimplifyMode::None),
        _ => Err(CliError::Validation(format!("未知的路径简化模式: {s}"))),
    }
}

fn parse_i32_in_range(
    value: &str,
    arg_name: &str,
    min: i32,
    max: i32,
) -> Result<i32, CliError> {
    let parsed = value.trim().parse::<i32>().map_err(|_| {
        CliError::Validation(format!("{arg_name} 不是整数: {value}"))
    })?;
    if parsed < min || parsed > max {
        return Err(CliError::Validation(format!(
            "{arg_name}={parsed} 无效，必须在 [{min},{max}] 范围内"
        )));
    }
    Ok(parsed)
}

fn parse_usize_in_range(
    value: &str,
    arg_name: &str,
    min: usize,
    max: usize,
) -> Result<usize, CliError> {
    let parsed = value.trim().parse::<usize>().map_err(|_| {
        CliError::Validation(format!("{arg_name} 不是非负整数: {value}"))
    })?;
    if parsed < min || parsed > max {
        return Err(CliError::Validation(format!(
            "{arg_name}={parsed} 无效，必须在 [{min},{max}] 范围内"
        )));
    }
    Ok(parsed)
}

fn parse_f64_in_range(
    value: &str,
    arg_name: &str,
    min: f64,
    max: f64,
) -> Result<f64, CliError> {
    let parsed = value.trim().parse::<f64>().map_err(|_| {
        CliError::Validation(format!("{arg_name} 不是数字: {value}"))
    })?;
    if parsed < min || parsed > max {
        return Err(CliError::Validation(format!(
            "{arg_name}={parsed} 无效，必须在 [{min},{max}] 范围内"
        )));
    }
    Ok(parsed)
}

fn parse_u32(value: &str, arg_name: &str) -> Result<u32, CliError> {
    value.trim().parse::<u32>().map_err(|_| {
        CliError::Validation(format!("{arg_name} 不是无符号整数: {value}"))
    })
}

fn config_from_iter<I, T>(args: I) -> Result<(PathBuf, PathBuf, Config), CliError>
where
    I: IntoIterator<Item = T>,
    T: Into<OsString> + Clone,
{
    let matches = build_app()
        .get_matches_from_safe(args)
        .map_err(|e| CliError::Arguments(e.to_string()))?;

    let mut config = Config::default();
    let input_path = PathBuf::from(matches.value_of("input").unwrap_or_default());
    let output_path = PathBuf::from(matches.value_of("output").unwrap_or_default());

    if let Some(value) = matches.value_of("preset") {
        let preset =
            Preset::from_str(value).map_err(|_| CliError::Validation(format!("无效的 preset: {value}")))?;
        config = Config::from_preset(preset);
    }

    if let Some(value) = matches.value_of("color_mode") {
        let normalized = match value.trim().to_ascii_lowercase().as_str() {
            "bw" | "binary" => "binary",
            "color" => "color",
            _ => {
                return Err(CliError::Validation(format!(
                    "无效的 colormode: {value}，仅支持 color 或 bw"
                )))
            }
        };
        config.color_mode = ColorMode::from_str(normalized)
            .map_err(|_| CliError::Validation(format!("无效的 colormode: {value}")))?;
    }

    if let Some(value) = matches.value_of("hierarchical") {
        config.hierarchical = Hierarchical::from_str(value.trim()).map_err(|_| {
            CliError::Validation(format!(
                "无效的 hierarchical: {value}，仅支持 stacked 或 cutout"
            ))
        })?;
    }

    if let Some(value) = matches.value_of("mode") {
        let value = value.trim();
        config.mode = match value {
            "pixel" => path_simplify_mode_from_str("none")?,
            "polygon" => path_simplify_mode_from_str("polygon")?,
            "spline" => path_simplify_mode_from_str("spline")?,
            _ => {
                return Err(CliError::Validation(format!(
                    "无效的 mode: {value}，仅支持 pixel/polygon/spline"
                )))
            }
        };
    }

    if let Some(value) = matches.value_of("filter_speckle") {
        config.filter_speckle = parse_usize_in_range(value, "filter_speckle", 0, 16)?;
    }

    if let Some(value) = matches.value_of("color_precision") {
        config.color_precision = parse_i32_in_range(value, "color_precision", 1, 8)?;
    }

    if let Some(value) = matches.value_of("gradient_step") {
        config.layer_difference = parse_i32_in_range(value, "gradient_step", 0, 255)?;
    }

    if let Some(value) = matches.value_of("corner_threshold") {
        config.corner_threshold = parse_i32_in_range(value, "corner_threshold", 0, 180)?;
    }

    if let Some(value) = matches.value_of("segment_length") {
        config.length_threshold = parse_f64_in_range(value, "segment_length", 3.5, 10.0)?;
    }

    if let Some(value) = matches.value_of("splice_threshold") {
        config.splice_threshold = parse_i32_in_range(value, "splice_threshold", 0, 180)?;
    }

    if let Some(value) = matches.value_of("path_precision") {
        config.path_precision = Some(parse_u32(value, "path_precision")?);
    }

    Ok((input_path, output_path, config))
}

fn config_from_args() -> Result<(PathBuf, PathBuf, Config), CliError> {
    config_from_iter(std::env::args_os())
}

fn run_with_args<I, T>(args: I) -> Result<(), CliError>
where
    I: IntoIterator<Item = T>,
    T: Into<OsString> + Clone,
{
    let (input_path, output_path, config) = config_from_iter(args)?;
    converter::convert_image_to_svg(&input_path, &output_path, config).map_err(CliError::Convert)
}

fn run() -> Result<(), CliError> {
    let (input_path, output_path, config) = config_from_args()?;
    converter::convert_image_to_svg(&input_path, &output_path, config).map_err(CliError::Convert)
}

fn main() {
    if let Err(err) = run() {
        eprintln!("{err}");
        std::process::exit(err.exit_code());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_minimal_args_success() {
        let args = vec!["vtracer", "-i", "in.png", "-o", "out.svg"];
        let result = config_from_iter(args);
        assert!(result.is_ok());
    }

    #[test]
    fn parse_missing_required_arg_fails() {
        let args = vec!["vtracer", "-i", "in.png"];
        let result = config_from_iter(args);
        assert!(matches!(result, Err(CliError::Arguments(_))));
    }

    #[test]
    fn parse_invalid_mode_fails() {
        let args = vec!["vtracer", "-i", "in.png", "-o", "out.svg", "--mode", "curve"];
        let result = config_from_iter(args);
        assert!(matches!(result, Err(CliError::Validation(_))));
    }

    #[test]
    fn parse_invalid_filter_speckle_range_fails() {
        let args = vec![
            "vtracer",
            "-i",
            "in.png",
            "-o",
            "out.svg",
            "--filter_speckle",
            "999",
        ];
        let result = config_from_iter(args);
        assert!(matches!(result, Err(CliError::Validation(_))));
    }

    #[test]
    fn run_invalid_output_path_fails_without_panic() {
        let input_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("docs")
            .join("assets")
            .join("samples")
            .join("test-logo.png");

        if !input_path.exists() {
            return;
        }

        let output_path = std::env::temp_dir()
            .join(format!("vtracer-test-{}", std::process::id()))
            .join("missing")
            .join("out.svg");

        let args = vec![
            OsString::from("vtracer"),
            OsString::from("-i"),
            input_path.into_os_string(),
            OsString::from("-o"),
            output_path.into_os_string(),
        ];

        let result = run_with_args(args);
        assert!(matches!(result, Err(CliError::Convert(_))));
    }
}
