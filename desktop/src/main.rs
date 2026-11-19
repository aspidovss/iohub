//! iohub-desktop — офлайн-программа для клавиатур IO.
//!
//! Renders the saved web.io.vision app (webview/ folder, baked into the binary) inside the
//! system webview and answers the WebHID calls that a browser would normally serve. Nothing is
//! ever downloaded: the content security policy in tauri.conf.json has no remote sources.

// Release build: no console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hid;

use std::fs;
use std::io::Write as _;
use std::path::PathBuf;
use std::time::SystemTime;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager, State};

use hid::{DeviceInfo, HidWorker, WorkerStatus};

// ---------------------------------------------------------------- small file logger

#[derive(Default)]
struct Logger {
    path: Option<PathBuf>,
}

impl Logger {
    fn write_line(&self, what: &str) {
        let Some(path) = self.path.as_ref() else { return };
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "{what}");
        }
    }

    fn tail(&self, limit: usize) -> String {
        let Some(path) = self.path.as_ref() else {
            return "лог не настроен".to_string();
        };
        match fs::read_to_string(path) {
            Ok(s) => {
                let lines: Vec<&str> = s.lines().collect();
                let start = lines.len().saturating_sub(limit);
                lines[start..].join("\n")
            }
            Err(_) => "лога пока нет".to_string(),
        }
    }

    /// Тот же хвост, но без служебного шума: в подробном режиме перечисление устройств и
    /// пустые чтения занимают сотни строк и вытесняют всё полезное из отчёта.
    fn tail_quiet(&self, limit: usize) -> String {
        let Some(path) = self.path.as_ref() else {
            return "лог не настроен".to_string();
        };
        match fs::read_to_string(path) {
            Ok(s) => {
                let lines: Vec<&str> = s
                    .lines()
                    .filter(|l| !l.contains("дескриптор ") && !l.contains("читатель ждёт данные"))
                    .collect();
                let start = lines.len().saturating_sub(limit);
                lines[start..].join("\n")
            }
            Err(_) => "лога пока нет".to_string(),
        }
    }
}

#[derive(Default)]
struct SharedState {
    worker: Arc<Mutex<Option<HidWorker>>>,
    logger: Mutex<Logger>,
    /// Device paths the user allowed. WebHID only shows devices the site was granted.
    allowed: Mutex<Vec<String>>,
}

fn allow_path(dir: &PathBuf) -> PathBuf {
    dir.join("hid-allow.json")
}

fn load_allowed(dir: &PathBuf) -> Vec<String> {
    fs::read_to_string(allow_path(dir))
        .ok()
        // Редакторы и PowerShell любят добавлять BOM, из-за которого json перестаёт читаться.
        .map(|s| s.trim_start_matches('\u{feff}').to_string())
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

fn save_allowed(dir: &PathBuf, list: &[String]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    fs::write(allow_path(dir), json).map_err(|e| e.to_string())
}

fn worker(state: &State<SharedState>) -> Result<HidWorker, String> {
    let guard = state.worker.lock().map_err(|_| "hid state is gone".to_string())?;
    guard.clone().ok_or_else(|| "_hid worker is not ready_".into())
}

// ---------------------------------------------------------------- commands

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    name: &'static str,
    version: &'static str,
    platform: &'static str,
    data_dir: String,
    native_hid: bool,
}

/// Адрес списка прошивок из файла firmware.url в папке данных. Пустая строка, если файла
/// нет или адрес не защищён — интерфейс тогда работает как раньше, только с файлом .hex.
#[tauri::command]
fn firmware_link(app: AppHandle) -> String {
    let Ok(dir) = app.path().app_data_dir() else {
        return String::new();
    };
    let Ok(text) = std::fs::read_to_string(dir.join("firmware.url")) else {
        return String::new();
    };
    let url = text.trim().trim_start_matches('\u{feff}').to_string();
    if url.starts_with("https://") {
        url
    } else {
        String::new()
    }
}

/// Шаги проверки интерфейса из файла autotask.txt в папке данных. Файл работает только
/// в подробном режиме — это инструмент разборки, а не часть программы.
#[tauri::command]
fn autotask(app: AppHandle) -> Vec<String> {
    if !hid::verbose() {
        return Vec::new();
    }
    let Ok(dir) = app.path().app_data_dir() else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(dir.join("autotask.txt")) else {
        return Vec::new();
    };
    text.lines()
        .map(|line| line.trim().trim_start_matches('\u{feff}').to_string())
        .filter(|line| !line.is_empty())
        .collect()
}

/// Whether the user turned on tracing (IOHUB_DEBUG=1 or the debug.on file). The page keeps
/// its packet trace and interface snapshots behind this switch.
#[tauri::command]
fn debug_flag() -> bool {
    hid::verbose()
}

#[tauri::command]
fn app_info(app: AppHandle, state: State<SharedState>) -> AppInfo {
    let dir = app
        .path()
        .app_data_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    AppInfo {
        name: "iohub-desktop",
        version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
        data_dir: dir,
        native_hid: state.worker.lock().map(|w| w.is_some()).unwrap_or(false),
    }
}

#[tauri::command]
fn hid_status(state: State<SharedState>) -> Result<WorkerStatus, String> {
    Ok(worker(&state)?.status())
}

#[tauri::command]
fn hid_list_devices(state: State<SharedState>) -> Result<Vec<DeviceInfo>, String> {
    worker(&state)?.enumerate()
}

#[tauri::command]
fn hid_describe(device_id: String, state: State<SharedState>) -> Result<DeviceInfo, String> {
    worker(&state)?.describe(&device_id)
}

#[tauri::command]
fn hid_open(device_id: String, state: State<SharedState>) -> Result<DeviceInfo, String> {
    worker(&state)?.open(device_id.clone()).inspect(|d| {
        if let Ok(s) = state.logger.lock() {
            s.write_line(&format!(
                "open {:04x}:{:04x} {}",
                d.vendor_id, d.product_id, d.product_name
            ));
        }
    })
}

#[tauri::command]
fn hid_close(device_id: String, state: State<SharedState>) -> Result<(), String> {
    worker(&state)?.close(device_id)
}

#[tauri::command]
fn hid_send_report(
    device_id: String,
    report_id: u8,
    data: Vec<u8>,
    state: State<SharedState>,
) -> Result<(), String> {
    worker(&state)?.send_output(device_id, report_id, data)
}

#[tauri::command]
fn hid_send_feature_report(
    device_id: String,
    report_id: u8,
    data: Vec<u8>,
    state: State<SharedState>,
) -> Result<(), String> {
    worker(&state)?.send_feature(device_id, report_id, data)
}

#[tauri::command]
fn hid_receive_feature_report(
    device_id: String,
    report_id: u8,
    length: usize,
    state: State<SharedState>,
) -> Result<Vec<u8>, String> {
    worker(&state)?.get_feature(device_id, report_id, length)
}

#[tauri::command]
fn hid_list_allowed(state: State<SharedState>) -> Vec<String> {
    state.allowed.lock().map(|a| a.clone()).unwrap_or_default()
}

#[tauri::command]
fn hid_allow_device(
    device_id: String,
    app: AppHandle,
    state: State<SharedState>,
) -> Result<Vec<String>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut list = state.allowed.lock().map_err(|_| "allow list is gone".to_string())?;
    if !list.contains(&device_id) {
        list.push(device_id);
        save_allowed(&dir, &list)?;
    }
    Ok(list.clone())
}

#[tauri::command]
fn hid_forget_device(
    device_id: String,
    app: AppHandle,
    state: State<SharedState>,
) -> Result<Vec<String>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut list = state.allowed.lock().map_err(|_| "allow list is gone".to_string())?;
    list.retain(|d| d != &device_id);
    save_allowed(&dir, &list)?;
    Ok(list.clone())
}

#[tauri::command]
fn debug_log(msg: String, state: State<SharedState>) {
    if let Ok(l) = state.logger.lock() {
        l.write_line(&format!("[js] {msg}"));
    }
}

#[tauri::command]
fn debug_logs(limit: Option<usize>, state: State<SharedState>) -> String {
    state
        .logger
        .lock()
        .map(|l| l.tail(limit.unwrap_or(200)))
        .unwrap_or_default()
}

#[tauri::command]
fn window_close(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.close();
    }
}

// ---------------------------------------------------------------- support

/// Календарь из числа суток с 1970 года (алгоритм Говарда Хиннанта). Специально без
/// внешней библиотеки: программа собирается офлайн, а дата нужна ровно одна строка.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as i64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { y + 1 } else { y }, month, day)
}

/// Дата и время в UTC: нужны и номеру отчёта, и его шапке.
fn utc_now() -> Option<(i64, u32, u32, u32, u32, u32)> {
    let secs = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).ok()?.as_secs() as i64;
    let (y, m, d) = civil_from_days(secs / 86_400);
    let rest = secs.rem_euclid(86_400);
    Some((y, m, d, (rest / 3600) as u32, (rest / 60 % 60) as u32, (rest % 60) as u32))
}

/// Номер отчёта. У веб-версии конфигуратора свой формат «IO-20261119-2CA14D0F» — берём ту
/// же форму с нашим префиксом, чтобы по номеру было видно, откуда пришёл случай.
fn new_ticket() -> String {
    let (y, m, d) = match utc_now() {
        Some(t) => (t.0, t.1, t.2),
        None => return "HUB-00000000-00000000".into(),
    };
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    // Перемешивание времени и идентификатора процесса вместо целого генератора случайных
    // чисел: номер не секретный, он должен лишь различать два отчёта одной секунды.
    let seed = now ^ ((std::process::id() as u64) << 32) ^ ((y as u64) << 16);
    let mut r = seed
        .wrapping_mul(6_364_136_223_846_793_005)
        .wrapping_add(1_442_695_040_888_963_407);
    r ^= r >> 31;
    format!("HUB-{y:04}{m:02}{d:02}-{r:08X}", r = (r >> 32) as u32)
}

/// Куда писать о проблемах. Наружу программа открывает только эту почту и свои задачи на
/// GitHub — других ссылок список не пропускает.
const SUPPORT_EMAIL: &str = "iohub@aspidov.ru";
const PROJECT_URL: &str = "https://github.com/aspidovss/iohub";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportInfo {
    email: &'static str,
    repo: &'static str,
    issues: String,
    log_path: String,
    version: &'static str,
    data_path: String,
}

fn data_dir(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap_or_default()
}

#[tauri::command]
fn support_info(app: AppHandle) -> SupportInfo {
    let dir = data_dir(&app);
    SupportInfo {
        email: SUPPORT_EMAIL,
        repo: PROJECT_URL,
        issues: format!("{PROJECT_URL}/issues/new?labels=bug"),
        log_path: dir.join("iohub-desktop.log").display().to_string(),
        // Номер программы и папка данных — то, что человек ищет в первой же справке.
        version: env!("CARGO_PKG_VERSION"),
        data_path: dir.display().to_string(),
    }
}

/// true, если url начинается с base и дальше идёт разделитель, а не чужое доменное имя
/// вида github.com/aspidovss/iohub.evil.ru.
fn link_matches(url: &str, base: &str) -> bool {
    let Some(rest) = url.strip_prefix(base) else {
        return false;
    };
    rest.is_empty() || matches!(rest.chars().next(), Some('/' | '?' | '#' | '&'))
}

/// Убирает из отчёта то, что не стоит отправять чужим людям: имя учётной записи в путях.
fn redact(text: &str) -> String {
    let mut out = text.to_string();
    for key in ["USERPROFILE", "HOME"] {
        if let Ok(dir) = std::env::var(key) {
            if dir.len() > 3 {
                out = out.replace(&dir, "<домашняя папка>");
            }
        }
    }
    if let Ok(user) = std::env::var("USERNAME") {
        if user.len() > 2 {
            out = out.replace(&user, "<пользователь>");
        }
    }
    out
}

/// Серийник оставляем только хвостом: для «это то же устройство» хватает, а полный номер
/// в свободный доступ отправлять не нужно.
fn mask_serial(serial: &str) -> String {
    let chars: Vec<char> = serial.chars().collect();
    if chars.is_empty() {
        return "—".to_string();
    }
    let keep = chars.len().min(3);
    let mut out = "•".repeat(chars.len() - keep);
    out.push_str(&chars[chars.len() - keep..].iter().collect::<String>());
    out
}

/// Имя файла для отчёта: убираем всё, что не может быть в имени файла, и всегда .txt в конце.
fn safe_file_name(name: Option<String>) -> String {
    let raw = name.unwrap_or_else(|| "iohub-report".to_string());
    let mut out: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    while out.contains("..") {
        out = out.replace("..", "_");
    }
    if out.starts_with('.') {
        out.insert_str(0, "iohub-");
    }
    if !out.to_ascii_lowercase().ends_with(".txt") {
        out.push_str(".txt");
    }
    if out.len() > 68 {
        out = format!("{}.txt", out.chars().take(64).collect::<String>());
    }
    if out.trim_matches(|c: char| c == '_' || c == '.').is_empty() {
        out = "iohub-report.txt".to_string();
    }
    out
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    text: String,
    file_name: String,
    email: String,
    issues: String,
}

/// Собирает отчёт о проблеме: версия, система, устройства и хвост журнала. problem — текст
/// пользователя, extra — что добавила страница (экран, версия интерфейса, счётчики),
/// actions — чем человек нажимал перед поломкой, ticket — номер случая из окна отчёта.
#[tauri::command]
fn report_bundle(
    app: AppHandle,
    state: State<SharedState>,
    problem: Option<String>,
    extra: Option<String>,
    actions: Option<String>,
    ticket: Option<String>,
    file_name: Option<String>,
) -> Report {
    let mut parts: Vec<String> = Vec::new();
    parts.push(format!(
        "iohub-desktop {} · {} · {}",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH
    ));
    let ticket = ticket
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(new_ticket);
    parts.push(format!("отчёт {ticket}"));
    match utc_now() {
        Some((y, mo, d, h, mi, s)) => parts.push(format!("составлен {y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02} UTC")),
        None => parts.push("составлен: время недоступно".to_string()),
    }
    parts.push(format!("папка данных: {}", redact(&data_dir(&app).display().to_string())));
    parts.push(String::new());
    parts.push("что не работает:".to_string());
    let problem = problem
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "—".to_string());
    parts.push(redact(&problem));
    if let Some(extra) = extra.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        parts.push(String::new());
        parts.push("со стороны страницы:".to_string());
        parts.push(redact(&extra));
    }
    if let Some(actions) = actions.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        parts.push(String::new());
        parts.push("действия перед обращением:".to_string());
        parts.push(redact(&actions));
    }

    parts.push(String::new());
    let allowed = state.allowed.lock().map(|a| a.clone()).unwrap_or_default();
    parts.push(format!(
        "разрешённые пары VID:PID: {}",
        if allowed.is_empty() { "нет".to_string() } else { allowed.join(", ") }
    ));
    let devices = worker(&state).and_then(|w| w.enumerate()).unwrap_or_default();
    if devices.is_empty() {
        parts.push("HID-устройств не видно".to_string());
    } else {
        parts.push(format!("HID-устройств видно: {}", devices.len()));
        for d in devices
            .iter()
            .filter(|d| d.opened || matches!(d.vendor_id, 0x05ac | 0x0c45 | 0x3554))
        {
            parts.push(format!(
                "  {:04x}:{:04x} {} · интерфейс {} · usage {:04x}/{:04x} · серийный {} · {}",
                d.vendor_id,
                d.product_id,
                d.product_name,
                d.interface_number,
                d.usage_page,
                d.usage,
                mask_serial(&d.serial_number),
                if d.opened { "открыто" } else { "закрыто" }
            ));
        }
    }

    parts.push(String::new());
    parts.push("журнал, последние 200 строк (без перечисления устройств):".to_string());
    let tail = state.logger.lock().map(|l| l.tail_quiet(200)).unwrap_or_default();
    parts.push(redact(&tail));

    let text = redact(&parts.join("\n"));
    if let Ok(l) = state.logger.lock() {
        l.write_line("собран отчёт о проблеме");
    }
    Report {
        text,
        file_name: safe_file_name(file_name),
        email: SUPPORT_EMAIL.to_string(),
        issues: format!("{PROJECT_URL}/issues/new?labels=bug"),
    }
}

/// Сохраняет отчёт в подпапку reports папки данных и возвращает полный путь.
#[tauri::command]
fn save_report(
    app: AppHandle,
    state: State<SharedState>,
    text: String,
    file_name: Option<String>,
) -> Result<String, String> {
    let folder = data_dir(&app).join("reports");
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let path = folder.join(safe_file_name(file_name));
    fs::write(&path, text).map_err(|e| e.to_string())?;
    if let Ok(l) = state.logger.lock() {
        l.write_line(&format!("отчёт сохранён: {}", path.display()));
    }
    Ok(path.display().to_string())
}

/// Открывает ссылку во внешнем приложении: только задачи проекта, сайт io.vision и почту
/// поддержки. Всё остальное остаётся закрытым — программа офлайн и ссылки наружу не кликает.
#[tauri::command]
fn open_link(state: State<SharedState>, url: String) -> Result<(), String> {
    let mail_to = url
        .strip_prefix("mailto:")
        .map(|rest| rest == SUPPORT_EMAIL || rest.starts_with(&format!("{SUPPORT_EMAIL}?")))
        .unwrap_or(false);
    // Сайт производителя разрешён целиком, но только по настоящему домену io.vision.
    let site = match url.strip_prefix("https://") {
        Some(rest) => {
            let host = rest.split(['/', '?', '#']).next().unwrap_or("");
            host == "io.vision" || host.ends_with(".io.vision")
        }
        None => false,
    };
    let allowed = mail_to || link_matches(&url, PROJECT_URL) || site;
    if !allowed {
        if let Ok(l) = state.logger.lock() {
            l.write_line(&format!("ссылка не открыта (не в списке разрешённых): {url}"));
        }
        return Err("программа открывает только свои задачи на GitHub, сайт io.vision и почту поддержки".to_string());
    }
    #[cfg(target_os = "windows")]
    let spawned = std::process::Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", url.as_str()])
        .spawn();
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(target_os = "linux")]
    let spawned = std::process::Command::new("xdg-open").arg(&url).spawn();
    match spawned {
        Ok(_) => {
            if let Ok(l) = state.logger.lock() {
                l.write_line(&format!("ссылка передана системе: {url}"));
            }
            Ok(())
        }
        Err(e) => Err(format!("не удалось открыть ссылку: {e}")),
    }
}

// ---------------------------------------------------------------- entry point

fn main() {
    let state = SharedState::default();

    tauri::Builder::default()
        .manage(state)
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            fs::create_dir_all(&dir)?;

            // WebView2 keeps its profile (that is where localStorage lives) next to the
            // executable by default; on a Program Files install that is not writable, so pin it
            // to the app data folder before any webview is created.
            #[cfg(target_os = "windows")]
            std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &dir);

            let shared = app.state::<SharedState>();
            if let Ok(mut l) = shared.logger.lock() {
                l.path = Some(dir.join("iohub-desktop.log"));
                l.write_line(&format!(
                    "=== run {} {}",
                    env!("CARGO_PKG_VERSION"),
                    std::env::consts::OS
                ));
            }
            if let Ok(mut a) = shared.allowed.lock() {
                *a = load_allowed(&dir);
            }
            let worker = hid::spawn(app.handle(), dir.clone());
            if let Ok(mut w) = shared.worker.lock() {
                *w = Some(worker);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Hand the device back to the OS cleanly so the next launch can open it at once.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let app = window.app_handle().clone();
                std::thread::spawn(move || {
                    if let Some(shared) = app.try_state::<SharedState>() {
                        if let Ok(Some(w)) = shared.worker.lock().map(|w| w.clone()) {
                            let _ = w.close_all();
                        }
                    }
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            hid_status,
            hid_list_devices,
            hid_describe,
            hid_open,
            hid_close,
            hid_send_report,
            hid_send_feature_report,
            hid_receive_feature_report,
            hid_list_allowed,
            hid_allow_device,
            hid_forget_device,
            debug_log,
            debug_logs,
            debug_flag,
            firmware_link,
            autotask,
            support_info,
            report_bundle,
            save_report,
            open_link,
            window_close
        ])
        .run(tauri::generate_context!())
        .expect("не удалось запустить iohub-desktop");
}
