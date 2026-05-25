use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use chrono::Local;
use serde::{Deserialize, Serialize};
use tauri::Manager;
use visioncortex::{ColorImage, PathSimplifyMode};
use vtracer::{ColorMode, Config, Hierarchical};

const APP_DIR_NAME: &str = "VTracer";
const EXPORT_SUBDIR: &str = "exports";
const WORKER_ARG: &str = "--worker-convert";
const WORKER_REQUEST_ARG: &str = "--request-file";
const WORKER_RESULT_ARG: &str = "--result-file";
const E2E_ENABLE_ENV: &str = "VTRACER_E2E_ENABLED";
const SETTINGS_DIR_ENV: &str = "VTRACER_SETTINGS_DIR";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AppError {
    code: String,
    message: String,
}

impl AppError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ImageInfo {
    path: String,
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ConvertRequest {
    input_path: String,
    params: ConvertParams,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ConvertParams {
    mode: String,
    clustering_mode: String,
    hierarchical: String,
    filter_speckle: usize,
    color_precision: i32,
    layer_difference: i32,
    corner_threshold: i32,
    length_threshold: f64,
    max_iterations: usize,
    splice_threshold: i32,
    path_precision: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ConvertMeta {
    duration_ms: u128,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ConvertResult {
    svg_text: String,
    meta: ConvertMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExportRequest {
    input_path: String,
    params: ConvertParams,
    svg_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExportResult {
    out_path: String,
    bytes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExportDirResult {
    ok: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExportDirPath {
    path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AppSettings {
    export_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkerRequest {
    request_id: u64,
    input_path: String,
    params: ConvertParams,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkerResponse {
    result: Option<ConvertResult>,
    error: Option<AppError>,
}

#[derive(Debug)]
struct ActiveWorker {
    request_id: u64,
    child: Arc<Mutex<Child>>,
}

#[derive(Debug)]
struct AppState {
    export_dir: Mutex<PathBuf>,
    settings_file: PathBuf,
    active_worker: Mutex<Option<ActiveWorker>>,
    cancelled_requests: Mutex<HashSet<u64>>,
    request_counter: AtomicU64,
    last_export_path: Mutex<Option<String>>,
    e2e_enabled: bool,
}

#[derive(Debug)]
struct WorkerFiles {
    request_path: PathBuf,
    result_path: PathBuf,
}

impl WorkerFiles {
    fn new(request_id: u64) -> Result<Self, AppError> {
        let base = std::env::temp_dir().join(format!(
            "vtracer-desktop-worker-{}-{}",
            std::process::id(),
            request_id
        ));
        Ok(Self {
            request_path: base.with_extension("request.json"),
            result_path: base.with_extension("result.json"),
        })
    }

    fn cleanup(&self) {
        let _ = fs::remove_file(&self.request_path);
        let _ = fs::remove_file(&self.result_path);
    }
}

impl AppState {
    fn load(app: &tauri::AppHandle) -> Result<Self, AppError> {
        let settings_file = settings_file(app)?;
        let default_dir = default_export_dir()?;
        let export_dir = load_export_dir_from_settings(&settings_file).unwrap_or(default_dir.clone());

        ensure_dir(&export_dir)?;
        let state = Self {
            export_dir: Mutex::new(export_dir),
            settings_file,
            active_worker: Mutex::new(None),
            cancelled_requests: Mutex::new(HashSet::new()),
            request_counter: AtomicU64::new(0),
            last_export_path: Mutex::new(None),
            e2e_enabled: std::env::var(E2E_ENABLE_ENV).ok().as_deref() == Some("1"),
        };
        if let Err(error) = state.persist() {
            eprintln!(
                "[vtracer-desktop] warning: failed to persist settings on startup: {}",
                error.message
            );
        }
        Ok(state)
    }

    fn get_export_dir(&self) -> Result<PathBuf, AppError> {
        self.export_dir
            .lock()
            .map(|v| v.clone())
            .map_err(|_| AppError::new("RUNTIME_ERROR", "export dir state unavailable"))
    }

    fn set_export_dir(&self, path: PathBuf) -> Result<(), AppError> {
        ensure_dir(&path)?;
        let mut locked = self
            .export_dir
            .lock()
            .map_err(|_| AppError::new("RUNTIME_ERROR", "export dir state unavailable"))?;
        *locked = path;
        drop(locked);
        self.persist()
    }

    fn persist(&self) -> Result<(), AppError> {
        if let Some(parent) = self.settings_file.parent() {
            ensure_dir(parent)?;
        }
        let dir = self.get_export_dir()?;
        let payload = AppSettings {
            export_dir: path_to_string(&dir)?,
        };
        let json = serde_json::to_string_pretty(&payload)
            .map_err(|e| AppError::new("IO_ERROR", format!("failed to encode settings: {e}")))?;
        fs::write(&self.settings_file, json)
            .map_err(|e| AppError::new("IO_ERROR", format!("failed to write settings: {e}")))?;
        Ok(())
    }

    fn next_request_id(&self) -> u64 {
        self.request_counter.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn register_worker(&self, request_id: u64, child: Arc<Mutex<Child>>) -> Result<(), AppError> {
        let mut active = self
            .active_worker
            .lock()
            .map_err(|_| AppError::new("RUNTIME_ERROR", "worker state unavailable"))?;
        *active = Some(ActiveWorker { request_id, child });
        Ok(())
    }

    fn clear_worker_if_matches(&self, request_id: u64) {
        if let Ok(mut active) = self.active_worker.lock() {
            if let Some(worker) = &*active {
                if worker.request_id == request_id {
                    *active = None;
                }
            }
        }
    }

    fn cancel_active_worker(&self) -> Result<bool, AppError> {
        let snapshot = {
            let active = self
                .active_worker
                .lock()
                .map_err(|_| AppError::new("RUNTIME_ERROR", "worker state unavailable"))?;
            if let Some(worker) = &*active {
                if let Ok(mut cancelled) = self.cancelled_requests.lock() {
                    cancelled.insert(worker.request_id);
                }
                Some((worker.request_id, Arc::clone(&worker.child)))
            } else {
                None
            }
        };

        let Some((request_id, child_arc)) = snapshot else {
            return Ok(false);
        };

        {
            let mut child = child_arc
                .lock()
                .map_err(|_| AppError::new("RUNTIME_ERROR", "worker process unavailable"))?;
            if child.try_wait().map_err(io_error)?.is_none() {
                let _ = child.kill();
            }
        }

        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(2) {
            let done = {
                let mut child = child_arc
                    .lock()
                    .map_err(|_| AppError::new("RUNTIME_ERROR", "worker process unavailable"))?;
                child.try_wait().map_err(io_error)?.is_some()
            };
            if done {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }

        self.clear_worker_if_matches(request_id);
        Ok(true)
    }

    fn is_request_cancelled(&self, request_id: u64) -> bool {
        self.cancelled_requests
            .lock()
            .map(|set| set.contains(&request_id))
            .unwrap_or(false)
    }

    fn clear_cancel_mark(&self, request_id: u64) {
        if let Ok(mut cancelled) = self.cancelled_requests.lock() {
            cancelled.remove(&request_id);
        }
    }

    fn set_last_export_path(&self, path: String) {
        if let Ok(mut last) = self.last_export_path.lock() {
            *last = Some(path);
        }
    }

    fn get_last_export_path(&self) -> Option<String> {
        self.last_export_path.lock().ok().and_then(|v| v.clone())
    }
}

#[tauri::command]
fn pick_input_image() -> Result<ImageInfo, AppError> {
    let file = rfd::FileDialog::new()
        .add_filter("Image", &["png", "jpg", "jpeg", "bmp", "gif", "webp"])
        .pick_file()
        .ok_or_else(|| AppError::new("CANCELLED", "no file selected"))?;
    image_info_from_path(&file)
}

#[tauri::command]
fn set_export_dir(path: String, state: tauri::State<'_, AppState>) -> Result<ExportDirResult, AppError> {
    let target = PathBuf::from(path.trim());
    if target.as_os_str().is_empty() {
        return Err(AppError::new("INVALID_PARAM", "export dir cannot be empty"));
    }
    state.set_export_dir(target)?;
    Ok(ExportDirResult { ok: true })
}

#[tauri::command]
fn pick_export_dir(state: tauri::State<'_, AppState>) -> Result<ExportDirPath, AppError> {
    let folder = rfd::FileDialog::new()
        .pick_folder()
        .ok_or_else(|| AppError::new("CANCELLED", "no folder selected"))?;
    state.set_export_dir(folder.clone())?;
    Ok(ExportDirPath {
        path: path_to_string(&folder)?,
    })
}

#[tauri::command]
fn get_export_dir(state: tauri::State<'_, AppState>) -> Result<ExportDirPath, AppError> {
    let dir = state.get_export_dir()?;
    Ok(ExportDirPath {
        path: path_to_string(&dir)?,
    })
}

#[tauri::command]
fn convert_realtime(
    request: ConvertRequest,
    state: tauri::State<'_, AppState>,
) -> Result<ConvertResult, AppError> {
    validate_and_build_config(&request.params)?;

    let request_id = state.next_request_id();
    let _ = state.cancel_active_worker();

    let files = WorkerFiles::new(request_id)?;
    let payload = WorkerRequest {
        request_id,
        input_path: request.input_path.clone(),
        params: request.params.clone(),
    };
    let payload_json = serde_json::to_string(&payload)
        .map_err(|e| AppError::new("RUNTIME_ERROR", format!("failed to encode worker request: {e}")))?;
    fs::write(&files.request_path, payload_json).map_err(io_error)?;

    let child = spawn_worker_process(&files)?;
    state.register_worker(request_id, Arc::clone(&child))?;

    let result = wait_worker_and_read(&state, request_id, &files);
    state.clear_worker_if_matches(request_id);
    state.clear_cancel_mark(request_id);
    files.cleanup();
    result
}

#[tauri::command]
fn export_svg(
    request: ExportRequest,
    state: tauri::State<'_, AppState>,
) -> Result<ExportResult, AppError> {
    let svg_text = load_or_convert_svg(&request)?;
    let export_dir = state.get_export_dir()?;
    let out_path = build_output_path(&export_dir, &request.input_path, "svg");
    fs::write(&out_path, svg_text.as_bytes())
        .map_err(|e| AppError::new("IO_ERROR", format!("failed to write svg: {e}")))?;
    let out_path_string = path_to_string(&out_path)?;
    state.set_last_export_path(out_path_string.clone());
    Ok(ExportResult {
        out_path: out_path_string,
        bytes: svg_text.len(),
    })
}

#[tauri::command]
fn export_pdf(
    request: ExportRequest,
    state: tauri::State<'_, AppState>,
) -> Result<ExportResult, AppError> {
    let svg_text = load_or_convert_svg(&request)?;
    let options = svg2pdf::usvg::Options::default();
    let tree = svg2pdf::usvg::Tree::from_str(&svg_text, &options)
        .map_err(|e| AppError::new("CONVERT_ERROR", format!("failed to parse svg: {e}")))?;
    let pdf_bytes = svg2pdf::to_pdf(
        &tree,
        svg2pdf::ConversionOptions::default(),
        svg2pdf::PageOptions::default(),
    );

    let export_dir = state.get_export_dir()?;
    let out_path = build_output_path(&export_dir, &request.input_path, "pdf");
    fs::write(&out_path, &pdf_bytes)
        .map_err(|e| AppError::new("IO_ERROR", format!("failed to write pdf: {e}")))?;
    let out_path_string = path_to_string(&out_path)?;
    state.set_last_export_path(out_path_string.clone());
    Ok(ExportResult {
        out_path: out_path_string,
        bytes: pdf_bytes.len(),
    })
}

#[tauri::command]
fn cancel_active_convert(state: tauri::State<'_, AppState>) -> Result<ExportDirResult, AppError> {
    state.cancel_active_worker()?;
    Ok(ExportDirResult { ok: true })
}

#[tauri::command]
fn test_open_image(path: String, state: tauri::State<'_, AppState>) -> Result<ImageInfo, AppError> {
    ensure_e2e_enabled(&state)?;
    image_info_from_path(Path::new(path.trim()))
}

#[tauri::command]
fn test_get_last_export_path(state: tauri::State<'_, AppState>) -> Result<ExportDirPath, AppError> {
    ensure_e2e_enabled(&state)?;
    let value = state
        .get_last_export_path()
        .ok_or_else(|| AppError::new("NOT_FOUND", "no export has been recorded yet"))?;
    Ok(ExportDirPath { path: value })
}

fn ensure_e2e_enabled(state: &AppState) -> Result<(), AppError> {
    if !cfg!(debug_assertions) {
        return Err(AppError::new(
            "FORBIDDEN",
            "test command is disabled in release runtime",
        ));
    }
    if state.e2e_enabled {
        return Ok(());
    }
    Err(AppError::new(
        "FORBIDDEN",
        "test command is disabled in current runtime",
    ))
}

fn spawn_worker_process(files: &WorkerFiles) -> Result<Arc<Mutex<Child>>, AppError> {
    let exe =
        std::env::current_exe().map_err(|e| AppError::new("RUNTIME_ERROR", format!("current_exe failed: {e}")))?;

    let child = Command::new(exe)
        .arg(WORKER_ARG)
        .arg(WORKER_REQUEST_ARG)
        .arg(path_to_string(&files.request_path)?)
        .arg(WORKER_RESULT_ARG)
        .arg(path_to_string(&files.result_path)?)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| AppError::new("RUNTIME_ERROR", format!("failed to start worker: {e}")))?;
    Ok(Arc::new(Mutex::new(child)))
}

fn wait_worker_and_read(
    state: &AppState,
    request_id: u64,
    files: &WorkerFiles,
) -> Result<ConvertResult, AppError> {
    loop {
        if state.is_request_cancelled(request_id) {
            return Err(AppError::new("CANCELLED", "conversion was cancelled"));
        }

        let status_opt = {
            let active = state
                .active_worker
                .lock()
                .map_err(|_| AppError::new("RUNTIME_ERROR", "worker state unavailable"))?;
            let Some(worker) = &*active else {
                return Err(AppError::new("CANCELLED", "conversion was replaced"));
            };
            if worker.request_id != request_id {
                return Err(AppError::new("CANCELLED", "conversion was replaced"));
            }
            let mut child = worker
                .child
                .lock()
                .map_err(|_| AppError::new("RUNTIME_ERROR", "worker process unavailable"))?;
            child.try_wait().map_err(io_error)?
        };

        if let Some(status) = status_opt {
            if !status.success() {
                if state.is_request_cancelled(request_id) {
                    return Err(AppError::new("CANCELLED", "conversion was cancelled"));
                }
                return Err(AppError::new(
                    "CONVERT_ERROR",
                    format!("worker exited with status: {status}"),
                ));
            }
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }

    let data = fs::read_to_string(&files.result_path).map_err(io_error)?;
    let response: WorkerResponse = serde_json::from_str(&data)
        .map_err(|e| AppError::new("RUNTIME_ERROR", format!("failed to parse worker result: {e}")))?;
    if let Some(result) = response.result {
        return Ok(result);
    }
    Err(response
        .error
        .unwrap_or_else(|| AppError::new("RUNTIME_ERROR", "worker returned empty result")))
}

fn load_or_convert_svg(request: &ExportRequest) -> Result<String, AppError> {
    if let Some(text) = &request.svg_text {
        if !text.trim().is_empty() {
            return Ok(text.to_string());
        }
    }
    let config = validate_and_build_config(&request.params)?;
    convert_image_file(Path::new(&request.input_path), config)
}

fn validate_and_build_config(params: &ConvertParams) -> Result<Config, AppError> {
    if !(0..=16).contains(&params.filter_speckle) {
        return Err(AppError::new(
            "INVALID_PARAM",
            format!("filter_speckle={} out of range [0,16]", params.filter_speckle),
        ));
    }
    if !(1..=8).contains(&params.color_precision) {
        return Err(AppError::new(
            "INVALID_PARAM",
            format!("color_precision={} out of range [1,8]", params.color_precision),
        ));
    }
    if !(0..=255).contains(&params.layer_difference) {
        return Err(AppError::new(
            "INVALID_PARAM",
            format!("layer_difference={} out of range [0,255]", params.layer_difference),
        ));
    }
    if !(0..=180).contains(&params.corner_threshold) {
        return Err(AppError::new(
            "INVALID_PARAM",
            format!("corner_threshold={} out of range [0,180]", params.corner_threshold),
        ));
    }
    if !(0..=180).contains(&params.splice_threshold) {
        return Err(AppError::new(
            "INVALID_PARAM",
            format!("splice_threshold={} out of range [0,180]", params.splice_threshold),
        ));
    }
    if !(3.5..=10.0).contains(&params.length_threshold) {
        return Err(AppError::new(
            "INVALID_PARAM",
            format!(
                "length_threshold={} out of range [3.5,10.0]",
                params.length_threshold
            ),
        ));
    }
    if params.max_iterations == 0 || params.max_iterations > 30 {
        return Err(AppError::new(
            "INVALID_PARAM",
            format!("max_iterations={} out of range [1,30]", params.max_iterations),
        ));
    }

    let color_mode = ColorMode::from_str(params.clustering_mode.trim()).map_err(|_| {
        AppError::new(
            "INVALID_PARAM",
            format!(
                "clustering_mode={} invalid, expected color/binary",
                params.clustering_mode
            ),
        )
    })?;
    let hierarchical = Hierarchical::from_str(params.hierarchical.trim()).map_err(|_| {
        AppError::new(
            "INVALID_PARAM",
            format!("hierarchical={} invalid, expected stacked/cutout", params.hierarchical),
        )
    })?;
    let mode = match params.mode.trim() {
        "none" => PathSimplifyMode::None,
        "polygon" => PathSimplifyMode::Polygon,
        "spline" => PathSimplifyMode::Spline,
        value => {
            return Err(AppError::new(
                "INVALID_PARAM",
                format!("mode={} invalid, expected none/polygon/spline", value),
            ));
        }
    };

    Ok(Config {
        color_mode,
        hierarchical,
        filter_speckle: params.filter_speckle,
        color_precision: params.color_precision,
        layer_difference: params.layer_difference,
        mode,
        corner_threshold: params.corner_threshold,
        length_threshold: params.length_threshold,
        max_iterations: params.max_iterations,
        splice_threshold: params.splice_threshold,
        path_precision: Some(params.path_precision),
    })
}

fn convert_image_file(path: &Path, config: Config) -> Result<String, AppError> {
    if !path.exists() {
        return Err(AppError::new(
            "IO_ERROR",
            format!("input file does not exist: {}", path.display()),
        ));
    }

    let rgba = image::open(path)
        .map_err(|e| AppError::new("IO_ERROR", format!("failed to read image: {e}")))?
        .to_rgba8();
    let width = rgba.width() as usize;
    let height = rgba.height() as usize;
    let img = ColorImage {
        pixels: rgba.as_raw().to_vec(),
        width,
        height,
    };

    let svg = vtracer::convert(img, config)
        .map_err(|e| AppError::new("CONVERT_ERROR", format!("conversion failed: {e}")))?;
    Ok(svg.to_string())
}

fn image_info_from_path(path: &Path) -> Result<ImageInfo, AppError> {
    if !path.exists() {
        return Err(AppError::new(
            "IO_ERROR",
            format!("input file does not exist: {}", path.display()),
        ));
    }
    let (width, height) = image::image_dimensions(path)
        .map_err(|e| AppError::new("IO_ERROR", format!("failed to read image size: {e}")))?;
    Ok(ImageInfo {
        path: path_to_string(path)?,
        width,
        height,
    })
}

fn default_export_dir() -> Result<PathBuf, AppError> {
    let mut dir =
        dirs::document_dir().ok_or_else(|| AppError::new("IO_ERROR", "failed to locate Documents"))?;
    dir.push(APP_DIR_NAME);
    dir.push(EXPORT_SUBDIR);
    Ok(dir)
}

fn settings_file(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    let mut dir = if let Ok(path) = std::env::var(SETTINGS_DIR_ENV) {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            app.path().app_config_dir().map_err(|e| {
                AppError::new("IO_ERROR", format!("failed to read app config dir: {e}"))
            })?
        } else {
            PathBuf::from(trimmed)
        }
    } else {
        app.path()
            .app_config_dir()
            .map_err(|e| AppError::new("IO_ERROR", format!("failed to read app config dir: {e}")))?
    };
    dir.push("settings.json");
    Ok(dir)
}

fn load_export_dir_from_settings(settings_file: &Path) -> Option<PathBuf> {
    if !settings_file.exists() {
        return None;
    }
    let content = match fs::read_to_string(settings_file) {
        Ok(value) => value,
        Err(error) => {
            eprintln!(
                "[vtracer-desktop] warning: failed to read settings file {}: {}",
                settings_file.display(),
                error
            );
            return None;
        }
    };
    let parsed: AppSettings = match serde_json::from_str(&content) {
        Ok(value) => value,
        Err(error) => {
            eprintln!(
                "[vtracer-desktop] warning: failed to parse settings file {}: {}",
                settings_file.display(),
                error
            );
            return None;
        }
    };
    let dir = PathBuf::from(parsed.export_dir);
    if dir.as_os_str().is_empty() {
        return None;
    }
    Some(dir)
}

fn ensure_dir(path: &Path) -> Result<(), AppError> {
    fs::create_dir_all(path).map_err(io_error)
}

fn build_output_path(export_dir: &Path, input_path: &str, ext: &str) -> PathBuf {
    let input = Path::new(input_path);
    let base = input
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("export");
    let timestamp = Local::now().format("%Y%m%d-%H%M%S");
    export_dir.join(format!("{}_{}.{}", base, timestamp, ext))
}

fn path_to_string(path: &Path) -> Result<String, AppError> {
    path.to_str()
        .map(|v| v.to_string())
        .ok_or_else(|| AppError::new("IO_ERROR", format!("path contains invalid UTF-8: {}", path.display())))
}

fn io_error(error: std::io::Error) -> AppError {
    AppError::new("IO_ERROR", error.to_string())
}

fn run_worker_mode(args: &[String]) -> i32 {
    let request_path = find_arg_value(args, WORKER_REQUEST_ARG);
    let result_path = find_arg_value(args, WORKER_RESULT_ARG);
    let Some(request_path) = request_path else {
        return 2;
    };
    let Some(result_path) = result_path else {
        return 2;
    };

    let response = (|| -> Result<WorkerResponse, AppError> {
        let raw = fs::read_to_string(&request_path).map_err(io_error)?;
        let request: WorkerRequest = serde_json::from_str(&raw).map_err(|e| {
            AppError::new(
                "RUNTIME_ERROR",
                format!("failed to parse worker request file: {e}"),
            )
        })?;
        let started = Instant::now();
        let config = validate_and_build_config(&request.params)?;
        let svg_text = convert_image_file(Path::new(&request.input_path), config)?;
        Ok(WorkerResponse {
            result: Some(ConvertResult {
                svg_text,
                meta: ConvertMeta {
                    duration_ms: started.elapsed().as_millis(),
                    warnings: Vec::new(),
                },
            }),
            error: None,
        })
    })()
    .unwrap_or_else(|error| WorkerResponse {
        result: None,
        error: Some(error),
    });

    let json = match serde_json::to_string(&response) {
        Ok(v) => v,
        Err(_) => return 3,
    };
    if fs::write(&result_path, json).is_err() {
        return 4;
    }
    if response.error.is_some() { 1 } else { 0 }
}

fn find_arg_value(args: &[String], key: &str) -> Option<String> {
    args.windows(2)
        .find(|window| window[0] == key)
        .map(|window| window[1].to_string())
}

#[tauri::command]
fn minimize_window(window: tauri::WebviewWindow) {
    let _ = window.minimize();
}

#[tauri::command]
fn maximize_window(window: tauri::WebviewWindow) {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
}

#[tauri::command]
fn close_window(window: tauri::WebviewWindow) {
    let _ = window.close();
}

#[tauri::command]
fn drag_window(window: tauri::WebviewWindow) {
    let _ = window.start_dragging();
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|arg| arg == WORKER_ARG) {
        std::process::exit(run_worker_mode(&args));
    }

    tauri::Builder::default()
        .setup(|app| {
            let state = AppState::load(app.handle()).map_err(|e| e.message)?;
            app.manage(state);

            if let Some(window) = app.get_webview_window("main") {
                if let Ok(Some(monitor)) = window.current_monitor() {
                    let size = monitor.size();
                    let target_width = (size.width as f64 * 0.8) as u32;
                    let target_height = (size.height as f64 * 0.8) as u32;
                    let min_width = 1120;
                    let min_height = 720;
                    
                    let final_width = target_width.max(min_width).min(size.width);
                    let final_height = target_height.max(min_height).min(size.height);
                    
                    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
                        width: final_width,
                        height: final_height,
                    }));
                    let _ = window.center();
                    let _ = window.maximize();
                }
            }

            if std::env::var("VTRACER_USE_SYSTEM_FRAME").ok().as_deref() == Some("1") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(true);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pick_input_image,
            set_export_dir,
            pick_export_dir,
            get_export_dir,
            convert_realtime,
            export_svg,
            export_pdf,
            cancel_active_convert,
            test_open_image,
            test_get_last_export_path,
            minimize_window,
            maximize_window,
            close_window,
            drag_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_params() -> ConvertParams {
        ConvertParams {
            mode: "spline".to_string(),
            clustering_mode: "color".to_string(),
            hierarchical: "stacked".to_string(),
            filter_speckle: 4,
            color_precision: 8,
            layer_difference: 32,
            corner_threshold: 60,
            length_threshold: 4.0,
            max_iterations: 10,
            splice_threshold: 45,
            path_precision: 8,
        }
    }

    #[test]
    fn validate_params_success() {
        let params = valid_params();
        let result = validate_and_build_config(&params);
        assert!(result.is_ok());
    }

    #[test]
    fn validate_params_invalid_enum() {
        let mut params = valid_params();
        params.mode = "curve".to_string();
        let result = validate_and_build_config(&params);
        assert!(result.is_err());
    }

    #[test]
    fn validate_params_out_of_range() {
        let mut params = valid_params();
        params.filter_speckle = 999;
        let result = validate_and_build_config(&params);
        assert!(result.is_err());
    }

    #[test]
    fn output_path_contains_ext() {
        let dir = std::env::temp_dir();
        let output = build_output_path(&dir, r"C:\images\demo.png", "svg");
        assert_eq!(output.extension().and_then(|v| v.to_str()), Some("svg"));
    }

    #[test]
    fn worker_arg_parse() {
        let args = vec![
            "a".to_string(),
            WORKER_REQUEST_ARG.to_string(),
            "req.json".to_string(),
            WORKER_RESULT_ARG.to_string(),
            "res.json".to_string(),
        ];
        assert_eq!(
            find_arg_value(&args, WORKER_REQUEST_ARG),
            Some("req.json".to_string())
        );
        assert_eq!(
            find_arg_value(&args, WORKER_RESULT_ARG),
            Some("res.json".to_string())
        );
    }
}
