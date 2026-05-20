mod config;
mod converter;
mod svg;

use clap::{App, Arg};
use config::{ColorMode, Config, Hierarchical, Preset};
use std::path::PathBuf;
use std::str::FromStr;
use visioncortex::PathSimplifyMode;

fn path_simplify_mode_from_str(s: &str) -> PathSimplifyMode {
    match s {
        "polygon" => PathSimplifyMode::Polygon,
        "spline" => PathSimplifyMode::Spline,
        "none" => PathSimplifyMode::None,
        _ => panic!("未知的路径简化模式: {}", s),
    }
}

pub fn config_from_args() -> (PathBuf, PathBuf, Config) {
    let app = App::new("visioncortex VTracer ".to_owned() + env!("CARGO_PKG_VERSION"))
        .about("将位图图像转换为矢量图形（SVG）的命令行工具。");

    let app = app.arg(
        Arg::with_name("input")
            .long("input")
            .short("i")
            .takes_value(true)
            .help("输入位图图像路径")
            .required(true),
    );

    let app = app.arg(
        Arg::with_name("output")
            .long("output")
            .short("o")
            .takes_value(true)
            .help("输出矢量图（SVG）路径")
            .required(true),
    );

    let app = app.arg(
        Arg::with_name("color_mode")
            .long("colormode")
            .takes_value(true)
            .help("颜色模式：`color`（默认，彩色）或 `bw`（黑白）"),
    );

    let app = app.arg(
        Arg::with_name("hierarchical")
            .long("hierarchical")
            .takes_value(true)
            .help(
                "分层聚类：`stacked`（默认，叠层）或 `cutout`（非叠层）。仅在彩色模式下生效。",
            ),
    );

    let app = app.arg(
        Arg::with_name("preset")
            .long("preset")
            .takes_value(true)
            .help("使用预设配置：`bw`、`poster`、`photo`"),
    );

    let app = app.arg(
        Arg::with_name("filter_speckle")
            .long("filter_speckle")
            .short("f")
            .takes_value(true)
            .help("过滤面积小于 X 像素的色块"),
    );

    let app = app.arg(
        Arg::with_name("color_precision")
            .long("color_precision")
            .short("p")
            .takes_value(true)
            .help("每个 RGB 通道保留的有效位数"),
    );

    let app = app.arg(
        Arg::with_name("gradient_step")
            .long("gradient_step")
            .short("g")
            .takes_value(true)
            .help("渐变层之间的颜色差值"),
    );

    let app = app.arg(
        Arg::with_name("corner_threshold")
            .long("corner_threshold")
            .short("c")
            .takes_value(true)
            .help("判定为拐角的最小瞬时角度（度）"),
    );

    let app = app.arg(Arg::with_name("segment_length")
        .long("segment_length")
        .short("l")
        .takes_value(true)
        .help("迭代细分平滑，直到所有线段长度都小于该值"));

    let app = app.arg(
        Arg::with_name("splice_threshold")
            .long("splice_threshold")
            .short("s")
            .takes_value(true)
            .help("样条切分所需的最小角位移（度）"),
    );

    let app = app.arg(
        Arg::with_name("mode")
            .long("mode")
            .short("m")
            .takes_value(true)
            .help("曲线拟合模式：`pixel`、`polygon`、`spline`"),
    );

    let app = app.arg(
        Arg::with_name("path_precision")
            .long("path_precision")
            .takes_value(true)
            .help("SVG 路径小数位精度"),
    );

    // Extract matches
    let matches = app.get_matches();

    let mut config = Config::default();
    let input_path = matches
        .value_of("input")
            .expect("必须提供输入路径，请使用 --input 或 -i 指定。");
    let output_path = matches
        .value_of("output")
            .expect("必须提供输出路径，请使用 --output 或 -o 指定。");

    let input_path = PathBuf::from(input_path);
    let output_path = PathBuf::from(output_path);

    if let Some(value) = matches.value_of("preset") {
        config = Config::from_preset(Preset::from_str(value).unwrap());
    }

    if let Some(value) = matches.value_of("color_mode") {
        config.color_mode = ColorMode::from_str(if value.trim() == "bw" || value.trim() == "BW" {
            "binary"
        } else {
            "color"
        })
        .unwrap()
    }

    if let Some(value) = matches.value_of("hierarchical") {
        config.hierarchical = Hierarchical::from_str(value).unwrap()
    }

    if let Some(value) = matches.value_of("mode") {
        let value = value.trim();
        config.mode = path_simplify_mode_from_str(if value == "pixel" {
            "none"
        } else if value == "polygon" {
            "polygon"
        } else if value == "spline" {
            "spline"
        } else {
            panic!("参数解析错误：无效的曲线拟合模式: {}", value);
        });
    }

    if let Some(value) = matches.value_of("filter_speckle") {
        if value.trim().parse::<usize>().is_ok() {
            // is numeric
            let value = value.trim().parse::<usize>().unwrap();
            if value > 16 {
                panic!("范围错误：filter_speckle={} 无效，必须在 [0,16] 范围内。", value);
            }
            config.filter_speckle = value;
        } else {
            panic!(
                "参数解析错误：filter_speckle 不是正整数: {}。",
                value
            );
        }
    }

    if let Some(value) = matches.value_of("color_precision") {
        if value.trim().parse::<i32>().is_ok() {
            // is numeric
            let value = value.trim().parse::<i32>().unwrap();
            if value < 1 || value > 8 {
                panic!("范围错误：color_precision={} 无效，必须在 [1,8] 范围内。", value);
            }
            config.color_precision = value;
        } else {
            panic!(
                "参数解析错误：color_precision 不是整数: {}。",
                value
            );
        }
    }

    if let Some(value) = matches.value_of("gradient_step") {
        if value.trim().parse::<i32>().is_ok() {
            // is numeric
            let value = value.trim().parse::<i32>().unwrap();
            if value < 0 || value > 255 {
                panic!("范围错误：gradient_step={} 无效，必须在 [0,255] 范围内。", value);
            }
            config.layer_difference = value;
        } else {
            panic!("参数解析错误：gradient_step 不是整数: {}。", value);
        }
    }

    if let Some(value) = matches.value_of("corner_threshold") {
        if value.trim().parse::<i32>().is_ok() {
            // is numeric
            let value = value.trim().parse::<i32>().unwrap();
            if value < 0 || value > 180 {
                panic!("范围错误：corner_threshold={} 无效，必须在 [0,180] 范围内。", value);
            }
            config.corner_threshold = value
        } else {
            panic!("参数解析错误：corner_threshold 不是数字: {}。", value);
        }
    }

    if let Some(value) = matches.value_of("segment_length") {
        if value.trim().parse::<f64>().is_ok() {
            // is numeric
            let value = value.trim().parse::<f64>().unwrap();
            if value < 3.5 || value > 10.0 {
                panic!("范围错误：segment_length={} 无效，必须在 [3.5,10] 范围内。", value);
            }
            config.length_threshold = value;
        } else {
            panic!("参数解析错误：segment_length 不是数字: {}。", value);
        }
    }

    if let Some(value) = matches.value_of("splice_threshold") {
        if value.trim().parse::<i32>().is_ok() {
            // is numeric
            let value = value.trim().parse::<i32>().unwrap();
            if value < 0 || value > 180 {
                panic!("范围错误：splice_threshold={} 无效，必须在 [0,180] 范围内。", value);
            }
            config.splice_threshold = value;
        } else {
            panic!("参数解析错误：splice_threshold 不是数字: {}。", value);
        }
    }

    if let Some(value) = matches.value_of("path_precision") {
        if value.trim().parse::<u32>().is_ok() {
            // is numeric
            let value = value.trim().parse::<u32>().ok();
            config.path_precision = value;
        } else {
            panic!(
                "参数解析错误：path_precision 不是无符号整数: {}。",
                value
            );
        }
    }

    (input_path, output_path, config)
}

fn main() {
    let (input_path, output_path, config) = config_from_args();
    let result = converter::convert_image_to_svg(&input_path, &output_path, config);
    match result {
        Ok(()) => {
            println!("转换成功。");
        }
        Err(msg) => {
            panic!("转换失败，错误信息: {}", msg);
        }
    }
}
