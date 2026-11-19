//! Native HID bridge for IO Hub desktop.
//!
//! The web app talks WebHID (`navigator.hid`). WebView2 does not expose that API, so this
//! module answers the same calls through hidapi, and `webview/webhid-shim.js` turns them back
//! into the WebHID object model. All device work happens on one worker thread, so a blocking
//! USB transfer never stalls the UI thread.

use std::collections::{HashMap, HashSet};
use std::ffi::CString;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use crossbeam_channel::{Receiver, Sender};
use hidapi::{HidApi, HidDevice};
use serde::{Deserialize, Serialize};
use tauri::Emitter;

// ---------------------------------------------------------------- public data model

/// One field declaration inside a report, the way Chrome hands them to `navigator.hid`.
/// The web app multiplies `reportSize * reportCount` over all items to learn the frame size,
/// so every declaration has to be listed, constants and padding included.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReportItemInfo {
    pub report_size: u32,
    pub report_count: u32,
}

/// Reports are reported the way WebHID does it: `report_size` is the total bit width for that
/// report id, `items` the individual declarations behind it.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReportInfo {
    pub report_id: u8,
    pub report_size: u32,
    pub items: Vec<ReportItemInfo>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CollectionInfo {
    pub usage_page: u16,
    pub usage: u16,
    /// HID collection type: 0 physical, 1 application, 2 logical, 3 report, 4 named array.
    pub collection_type: u8,
    pub input_reports: Vec<ReportInfo>,
    pub output_reports: Vec<ReportInfo>,
    pub feature_reports: Vec<ReportInfo>,
    pub children: Vec<CollectionInfo>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    /// Stable key inside one session: the hidapi device path (on Windows it carries the
    /// interface number, so composite keyboards get one entry per top-level collection).
    pub id: String,
    pub vendor_id: u16,
    pub product_id: u16,
    pub product_name: String,
    pub manufacturer_name: String,
    pub serial_number: String,
    pub usage_page: u16,
    pub usage: u16,
    pub interface_number: i32,
    pub collections: Vec<CollectionInfo>,
    pub opened: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkerStatus {
    pub platform: &'static str,
    pub started: bool,
    pub error: Option<String>,
}

const DESCRIPTOR_MAX: usize = 16 * 1024;

/// Where the debug log goes. Set once by `spawn` so the parser can report what it found.
static LOG_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Tracing every report is a lot of noise, so it is off unless the user asks for it with
/// `IOHUB_DEBUG=1` or a `debug.on` file next to the log.
static VERBOSE: AtomicBool = AtomicBool::new(false);

pub fn verbose() -> bool {
    VERBOSE.load(Ordering::Relaxed)
}

/// Read once at startup: environment variable wins, then the flag file.
fn read_verbose_flag(dir: &Path) -> bool {
    if std::env::var("IOHUB_DEBUG").map(|v| v == "1").unwrap_or(false) {
        return true;
    }
    Path::new(dir).join("debug.on").exists()
}

// ---------------------------------------------------------------- report descriptor parser

/// Node while walking the descriptor tree.
#[derive(Debug, Default)]
struct Node {
    usage_page: u16,
    usage: u16,
    collection_type: u8,
    input: Vec<ReportInfo>,
    output: Vec<ReportInfo>,
    feature: Vec<ReportInfo>,
    children: Vec<Node>,
}

/// Record one field declaration under the report of `report_id`, creating that report first.
fn add_field(list: &mut Vec<ReportInfo>, report_id: u8, size: u32, count: u32) {
    let item = ReportItemInfo {
        report_size: size,
        report_count: count,
    };
    match list.iter_mut().find(|r| r.report_id == report_id) {
        Some(r) => {
            r.report_size += size * count;
            r.items.push(item);
        }
        None => list.push(ReportInfo {
            report_id,
            report_size: size * count,
            items: vec![item],
        }),
    }
}

/// Data length of a short item, from the two-bit size code: 0 means no data at all (that is why
/// "End Collection" is the bare byte 0xC0), then 1, 2 and 4 bytes.
fn item_size(code: u8) -> usize {
    match code {
        0 => 0,
        1 => 1,
        2 => 2,
        _ => 4,
    }
}

/// Walk a HID report descriptor and return one entry per top-level collection, nested ones under
/// `children`. That is the shape `navigator.hid` exposes, and the web app depends on it: it picks
/// the vendor channel by `usagePage`/`usage` and works out the frame size from `items`.
pub fn parse_report_descriptor(desc: &[u8]) -> Vec<CollectionInfo> {
    let mut root = Node::default();
    let mut stack: Vec<Node> = Vec::new();

    // Global items stay in effect until an item of the same kind replaces them.
    let mut g_usage_page: u32 = 0;
    let mut g_report_id: u32 = 0;
    let mut g_report_size: u32 = 0;
    let mut g_report_count: u32 = 0;

    // Local items apply to the next main item only.
    let mut usage: Option<u32> = None;
    let mut usage_min: Option<u32> = None;
    // Parsed and cleared with the other local usages; the collection model itself never reads it.
    let mut _usage_max: Option<u32> = None;

    let mut i = 0usize;
    while i < desc.len() {
        let prefix = desc[i];
        i += 1;

        if prefix == 0xFE {
            // Long item: prefix, data size, item type, then the data.
            if i + 1 >= desc.len() {
                break;
            }
            let data_size = desc[i] as usize;
            i += 2 + data_size;
            continue;
        }

        let size = item_size(prefix & 0x03);
        let item_type = (prefix >> 2) & 0x03; // 0 main, 1 global, 2 local, 3 reserved
        let tag = (prefix >> 4) & 0x0F;
        if i + size > desc.len() {
            break;
        }
        let mut raw: u32 = 0;
        for k in 0..size {
            raw |= (desc[i + k] as u32) << (8 * k);
        }
        i += size;

        match item_type {
            1 => match tag {
                0x0 => g_usage_page = raw,
                0x7 => g_report_size = raw,
                0x8 => g_report_id = raw & 0xFF,
                0x9 => g_report_count = raw,
                _ => {}
            },
            2 => match tag {
                0x0 => usage = Some(raw),
                0x1 => usage_min = Some(raw),
                0x2 => _usage_max = Some(raw),
                _ => {}
            },
            0 => {
                // Main items: 0x8 Input, 0x9 Output, 0xA Collection, 0xB Feature, 0xC End.
                if matches!(tag, 0x8 | 0x9 | 0xB) && g_report_size > 0 && g_report_count > 0 {
                    // Fields belong to the innermost open collection, like in Chrome.
                    let node = stack.last_mut().unwrap_or(&mut root);
                    let list = if tag == 0x8 {
                        &mut node.input
                    } else if tag == 0x9 {
                        &mut node.output
                    } else {
                        &mut node.feature
                    };
                    add_field(list, g_report_id as u8, g_report_size, g_report_count);
                } else if tag == 0xA {
                    stack.push(Node {
                        usage_page: g_usage_page as u16,
                        usage: usage.or(usage_min).unwrap_or(0) as u16,
                        collection_type: raw as u8,
                        ..Default::default()
                    });
                } else if tag == 0xC {
                    if let Some(done) = stack.pop() {
                        match stack.last_mut() {
                            Some(parent) => parent.children.push(done),
                            None => root.children.push(done),
                        }
                    }
                }
                usage = None;
                usage_min = None;
                _usage_max = None;
            }
            _ => {}
        }
    }

    // A descriptor that runs out before closing its collections still describes them.
    while let Some(done) = stack.pop() {
        match stack.last_mut() {
            Some(parent) => parent.children.push(done),
            None => root.children.push(done),
        }
    }

    let top: Vec<CollectionInfo> = root.children.into_iter().map(to_collection).collect();
    // One line per interface on every refresh: only useful while digging into a device.
    if verbose() {
        if let Some(dir) = LOG_DIR.get() {
            log_line(
                dir,
                &format!(
                    "дескриптор {} байт → коллекций {}{}",
                    desc.len(),
                    top.len(),
                    if top.is_empty() { " (пусто)" } else { "" }
                ),
            );
        }
    }
    top
}

fn to_collection(node: Node) -> CollectionInfo {
    CollectionInfo {
        usage_page: node.usage_page,
        usage: node.usage,
        collection_type: node.collection_type,
        input_reports: node.input,
        output_reports: node.output,
        feature_reports: node.feature,
        children: node.children.into_iter().map(to_collection).collect(),
    }
}

/// Короткое имя устройства для журнала: идентификаторы вместо длинного пути Windows.
fn short_id(path: &str) -> String {
    path.split('#').nth(1).unwrap_or(path).to_string()
}

/// Whether the device puts real report ids on its reports. hidapi keeps that byte in the read
/// buffer only in this case, so the page needs to know whether to split it off.
fn uses_report_ids(collections: &[CollectionInfo]) -> bool {
    collections.iter().any(|c| {
        c.input_reports.iter().any(|r| r.report_id != 0) || uses_report_ids(&c.children)
    })
}

/// Biggest input report of the device, in bytes, plus the report-id byte Windows always
/// prepends. ReadFile on Windows must get a buffer of at least this size, and giving it a
/// needlessly huge one is what makes reads come back empty on some devices.
fn input_buffer_len(collections: &[CollectionInfo]) -> usize {
    fn walk(cs: &[CollectionInfo]) -> usize {
        let mut best = 0usize;
        for c in cs {
            for r in &c.input_reports {
                best = best.max((r.report_size as usize + 7) / 8);
            }
            best = best.max(walk(&c.children));
        }
        best
    }
    (walk(collections) + 1).clamp(9, 8192)
}

/// Byte length of a report, excluding the report-id byte, as the device expects it.
fn report_bytes(collections: &[CollectionInfo], report_id: u8, kind: u8) -> Option<usize> {
    let mut best: Option<usize> = None;
    for c in collections {
        let list = match kind {
            0 => &c.input_reports,
            1 => &c.output_reports,
            _ => &c.feature_reports,
        };
        for r in list {
            if r.report_id == report_id {
                let bytes = (r.report_size as usize + 7) / 8;
                best = Some(best.map_or(bytes, |b| b.max(bytes)));
            }
        }
        if let Some(b) = report_bytes(&c.children, report_id, kind) {
            best = Some(best.map_or(b, |x| x.max(b)));
        }
    }
    best
}

fn read_descriptor(device: &HidDevice) -> Vec<CollectionInfo> {
    let mut buf = vec![0u8; DESCRIPTOR_MAX];
    match device.get_report_descriptor(&mut buf) {
        Ok(n) if n > 0 => parse_report_descriptor(&buf[..n.min(DESCRIPTOR_MAX)]),
        _ => Vec::new(),
    }
}

// ---------------------------------------------------------------- worker thread

pub enum Cmd {
    Enumerate {
        resp: mpsc::Sender<Result<Vec<DeviceInfo>, String>>,
    },
    Open {
        id: String,
        resp: mpsc::Sender<Result<DeviceInfo, String>>,
    },
    Close {
        id: String,
        resp: mpsc::Sender<Result<(), String>>,
    },
    SendOutput {
        id: String,
        report_id: u8,
        data: Vec<u8>,
        resp: mpsc::Sender<Result<(), String>>,
    },
    SendFeature {
        id: String,
        report_id: u8,
        data: Vec<u8>,
        resp: mpsc::Sender<Result<(), String>>,
    },
    GetFeature {
        id: String,
        report_id: u8,
        len: usize,
        resp: mpsc::Sender<Result<Vec<u8>, String>>,
    },
    CloseAll {
        resp: mpsc::Sender<Result<(), String>>,
    },
}

struct Entry {
    info: DeviceInfo,
    device: HidDevice,
}

#[derive(Default)]
struct WorkerState {
    devices: HashMap<String, Entry>,
    stop_flags: HashMap<String, Arc<AtomicBool>>,
}

fn log_line(dir: &PathBuf, what: &str) {
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("iohub-desktop.log"))
    {
        let _ = writeln!(f, "[hid] {what}");
    }
}

/// Input reports arrive on their own handle. `HidDevice` is `Send` but not `Sync`, so the
/// worker keeps a second handle for writes instead of sharing one across threads. Feature
/// reports use a different I/O path, so the two handles never steal each other's data.
fn reader_loop(
    device: HidDevice,
    id: String,
    app: tauri::AppHandle,
    stop: Arc<AtomicBool>,
    dir: PathBuf,
    buf_len: usize,
    uses_ids: bool,
) {
    let mut buf = vec![0u8; buf_len];
    let mut seen = 0usize;
    let mut empty = 0u32;
    log_line(&dir, &format!("читатель запущен: {} (буфер {buf_len})", short_id(&id)));
    while !stop.load(Ordering::Relaxed) {
        // Только блокирующий режим: в неблокирующем hidapi на Windows таймаут чтения игнорируется.
        match device.read_timeout(&mut buf, 150) {
            Ok(n) if n > 0 => {
                seen += 1;
                if verbose() && seen <= 20 {
                    log_line(&dir, &format!("вход {}: {n} байт {}", short_id(&id), hex_preview(&buf[..n])));
                }
                let _ = app.emit(
                    "hid-input-report",
                    serde_json::json!({
                        "deviceId": id,
                        "data": &buf[..n],
                        "usesReportIds": uses_ids,
                    }),
                );
            }
            Ok(_) => {
                empty += 1;
                if verbose() && empty % 100 == 1 {
                    log_line(&dir, &format!("читатель ждёт данные: {}, пустых чтений {empty}", short_id(&id)));
                }
            }
            Err(e) => {
                log_line(&dir, &format!("read error on {id}: {e}"));
                let _ = app.emit("hid-device-lost", serde_json::json!({ "deviceId": id }));
                break;
            }
        }
    }
    log_line(&dir, &format!("читатель остановлен: {}, отчётов {seen}", short_id(&id)));
}

/// Первые байты отчёта для журнала, чтобы не переписывать дамп по каждому нажатию.
fn hex_preview(data: &[u8]) -> String {
    let head: Vec<String> = data.iter().take(10).map(|b| format!("{b:02x}")).collect();
    let tail = if data.len() > 10 { format!("…({})", data.len()) } else { String::new() };
    format!("[{}{}]", head.join(" "), tail)
}

/// Windows rejects a write whose length does not match the report. WebHID callers do not
/// always send the exact size, so we grow the payload and never shrink it.
fn sized(mut data: Vec<u8>, want: Option<usize>) -> Vec<u8> {
    if let Some(w) = want {
        if w > data.len() {
            data.resize(w, 0);
        }
    }
    data
}

fn handle(cmd: Cmd, api: &mut HidApi, st: &mut WorkerState, app: &tauri::AppHandle, dir: &PathBuf) {
    match cmd {
        Cmd::Enumerate { resp } => {
            if let Err(e) = api.refresh_devices() {
                let _ = resp.send(Err(format!("refresh: {e}")));
                return;
            }
            let opened: HashSet<String> = st.devices.keys().cloned().collect();
            let mut cache: HashMap<String, Vec<CollectionInfo>> = HashMap::new();
            let mut list: Vec<DeviceInfo> = Vec::new();
            for d in api.device_list() {
                let id = d.path().to_string_lossy().to_string();
                let collections = match cache.get(&id) {
                    Some(c) => c.clone(),
                    None => match st.devices.get(&id) {
                        Some(entry) => entry.info.collections.clone(),
                        None => {
                            let c = match d.open_device(api) {
                                Ok(dev) => read_descriptor(&dev),
                                Err(_) => Vec::new(),
                            };
                            cache.insert(id.clone(), c.clone());
                            c
                        }
                    },
                };
                list.push(DeviceInfo {
                    opened: opened.contains(&id),
                    id,
                    vendor_id: d.vendor_id(),
                    product_id: d.product_id(),
                    product_name: d.product_string().unwrap_or("").to_string(),
                    manufacturer_name: d.manufacturer_string().unwrap_or("").to_string(),
                    serial_number: d.serial_number().unwrap_or("").to_string(),
                    usage_page: d.usage_page(),
                    usage: d.usage(),
                    interface_number: d.interface_number(),
                    collections,
                });
            }
            let _ = resp.send(Ok(list));
        }

        Cmd::Open { id, resp } => {
            if let Some(entry) = st.devices.get_mut(&id) {
                entry.info.opened = true;
                let _ = resp.send(Ok(entry.info.clone()));
                return;
            }
            let cstr = match CString::new(id.as_str()) {
                Ok(c) => c,
                Err(_) => {
                    let _ = resp.send(Err("bad device path".into()));
                    return;
                }
            };
            match api.open_path(&cstr) {
                Ok(device) => {
                    let _ = device.set_blocking_mode(false);
                    let collections = read_descriptor(&device);
                    let info = match device.get_device_info() {
                        Ok(d) => DeviceInfo {
                            opened: true,
                            id: id.clone(),
                            vendor_id: d.vendor_id(),
                            product_id: d.product_id(),
                            product_name: d.product_string().unwrap_or("").to_string(),
                            manufacturer_name: d.manufacturer_string().unwrap_or("").to_string(),
                            serial_number: d.serial_number().unwrap_or("").to_string(),
                            usage_page: d.usage_page(),
                            usage: d.usage(),
                            interface_number: d.interface_number(),
                            collections,
                        },
                        Err(e) => {
                            let _ = resp.send(Err(format!("device info: {e}")));
                            return;
                        }
                    };
                    let stop = Arc::new(AtomicBool::new(false));
                    st.stop_flags.insert(id.clone(), stop.clone());
                    match api.open_path(&cstr) {
                        Ok(reader) => {
                            let (r_app, r_dir, r_id) = (app.clone(), dir.clone(), id.clone());
                            let buf_len = input_buffer_len(&info.collections);
                            let uses_ids = uses_report_ids(&info.collections);
                            match std::thread::Builder::new()
                                .name(format!("hid-read-{id}"))
                                .spawn(move || reader_loop(reader, r_id, r_app, stop, r_dir, buf_len, uses_ids))
                            {
                                Ok(_) => {
                                    st.devices.insert(id.clone(), Entry { info: info.clone(), device });
                                    log_line(dir, &format!("opened {id}"));
                                    let _ = resp.send(Ok(info));
                                }
                                Err(e) => {
                                    log_line(dir, &format!("read thread failed {id}: {e}"));
                                    // The device still works without pushed input reports.
                                    st.devices.insert(id.clone(), Entry { info: info.clone(), device });
                                    let _ = resp.send(Ok(info));
                                }
                            }
                        }
                        Err(e) => {
                            // Same story: writes work, only the event stream is missing.
                            log_line(dir, &format!("second handle failed {id}: {e}"));
                            st.devices.insert(id.clone(), Entry { info: info.clone(), device });
                            let _ = resp.send(Ok(info));
                        }
                    }
                }
                Err(e) => {
                    log_line(dir, &format!("open failed {id}: {e}"));
                    let _ = resp.send(Err(format!("open: {e}")));
                }
            }
        }

        Cmd::Close { id, resp } => {
            if let Some(entry) = st.devices.remove(&id) {
                if let Some(flag) = st.stop_flags.remove(&id) {
                    flag.store(true, Ordering::Relaxed);
                }
                drop(entry);
                log_line(dir, &format!("closed {id}"));
            }
            let _ = resp.send(Ok(()));
        }

        Cmd::SendOutput {
            id,
            report_id,
            data,
            resp,
        } => {
            let Some(entry) = st.devices.get(&id) else {
                let _ = resp.send(Err("sendReport: device is not open".into()));
                return;
            };
            let want = report_bytes(&entry.info.collections, report_id, 1).map(|n| n + 1);
            // hidapi and Windows want the report id as the very first byte, also when it is 0.
            // Sending the body without it shifts the whole frame and the device ignores it.
            let mut payload = vec![report_id];
            payload.extend(data);
            let payload = sized(payload, want);
            if verbose() {
                log_line(
                    dir,
                    &format!("запись {} байт → {} {}", payload.len(), short_id(&id), hex_preview(&payload)),
                );
            }
            let r = entry
                .device
                .write(&payload)
                .map(|_| ())
                .map_err(|e| format!("sendReport: {e}"));
            let _ = resp.send(r);
        }

        Cmd::SendFeature {
            id,
            report_id,
            data,
            resp,
        } => {
            // Same rule as output reports: first byte is the report id, including id 0.
            let mut payload = vec![report_id];
            payload.extend(data);
            let r = match st.devices.get(&id) {
                Some(entry) => entry
                    .device
                    .send_feature_report(&payload)
                    .map_err(|e| format!("sendFeatureReport: {e}")),
                None => Err("sendFeatureReport: device is not open".into()),
            };
            let _ = resp.send(r);
        }

        Cmd::GetFeature {
            id,
            report_id,
            len,
            resp,
        } => {
            let mut buf = vec![report_id; len.max(1)];
            let r = match st.devices.get(&id) {
                Some(entry) => match entry.device.get_feature_report(&mut buf) {
                    Ok(n) => Ok(buf[..n].to_vec()),
                    Err(e) => Err(format!("receiveFeatureReport: {e}")),
                },
                None => Err("receiveFeatureReport: device is not open".into()),
            };
            let _ = resp.send(r);
        }

        Cmd::CloseAll { resp } => {
            for (id, entry) in st.devices.drain() {
                if let Some(flag) = st.stop_flags.remove(&id) {
                    flag.store(true, Ordering::Relaxed);
                }
                drop(entry);
            }
            st.stop_flags.clear();
            let _ = resp.send(Ok(()));
        }
    }
}

/// Cheap to clone: the only real handle is the channel to the worker thread.
#[derive(Clone)]
pub struct HidWorker {
    tx: Sender<Cmd>,
    status: Arc<Mutex<WorkerStatus>>,
}

impl HidWorker {
    fn request<T>(&self, build: impl FnOnce(mpsc::Sender<Result<T, String>>) -> Cmd, label: &str) -> Result<T, String>
    where
        T: Send + 'static,
    {
        let (tx, rx) = mpsc::channel::<Result<T, String>>();
        self.tx
            .send(build(tx))
            .map_err(|_| "hid worker is not running".to_string())?;
        rx.recv_timeout(Duration::from_secs(20))
            .map_err(|_| format!("hid worker did not answer `{label}`"))?
    }

    pub fn enumerate(&self) -> Result<Vec<DeviceInfo>, String> {
        self.request(|resp| Cmd::Enumerate { resp }, "enumerate")
    }

    pub fn describe(&self, id: &str) -> Result<DeviceInfo, String> {
        self.enumerate()?
            .into_iter()
            .find(|d| d.id == id)
            .ok_or_else(|| "device not found".to_string())
    }

    pub fn open(&self, id: String) -> Result<DeviceInfo, String> {
        self.request(|resp| Cmd::Open { id, resp }, "open")
    }

    pub fn close(&self, id: String) -> Result<(), String> {
        self.request(|resp| Cmd::Close { id, resp }, "close")
    }

    /// Release every open handle, used when the window closes.
    pub fn close_all(&self) -> Result<(), String> {
        self.request(|resp| Cmd::CloseAll { resp }, "closeAll")
    }

    pub fn send_output(&self, id: String, report_id: u8, data: Vec<u8>) -> Result<(), String> {
        self.request(
            |resp| Cmd::SendOutput {
                id,
                report_id,
                data,
                resp,
            },
            "sendReport",
        )
    }

    pub fn send_feature(&self, id: String, report_id: u8, data: Vec<u8>) -> Result<(), String> {
        self.request(
            |resp| Cmd::SendFeature {
                id,
                report_id,
                data,
                resp,
            },
            "sendFeatureReport",
        )
    }

    pub fn get_feature(&self, id: String, report_id: u8, len: usize) -> Result<Vec<u8>, String> {
        self.request(
            |resp| Cmd::GetFeature {
                id,
                report_id,
                len,
                resp,
            },
            "receiveFeatureReport",
        )
    }

    pub fn status(&self) -> WorkerStatus {
        match self.status.lock() {
            Ok(g) => WorkerStatus {
                platform: g.platform,
                started: g.started,
                error: g.error.clone(),
            },
            Err(_) => WorkerStatus {
                platform: "unknown",
                started: false,
                error: Some("status lock poisoned".into()),
            },
        }
    }
}

/// Start the HID worker. A failure here must not stop the window from opening: the status
/// struct carries the reason to the diagnostics screen.
pub fn spawn(app: &tauri::AppHandle, dir: PathBuf) -> HidWorker {
    let (tx, rx): (Sender<Cmd>, Receiver<Cmd>) = crossbeam_channel::unbounded();
    let status = Arc::new(Mutex::new(WorkerStatus {
        platform: std::env::consts::OS,
        started: false,
        error: None,
    }));
    let app = app.clone();
    let worker_status = status.clone();
    let _ = LOG_DIR.set(dir.clone());
    VERBOSE.store(read_verbose_flag(&dir), Ordering::Relaxed);
    let join_result = std::thread::Builder::new()
        .name("hid-worker".into())
        .spawn(move || {
            let mut st = WorkerState::default();
            let status = worker_status;
            let mut api = match HidApi::new() {
                Ok(api) => api,
                Err(e) => {
                    log_line(&dir, &format!("hidapi init failed: {e}"));
                    if let Ok(mut s) = status.lock() {
                        s.error = Some(format!("hidapi init: {e}"));
                    }
                    return;
                }
            };
            log_line(&dir, "hidapi initialised");
            if let Ok(mut s) = status.lock() {
                s.started = true;
            }
            while let Ok(cmd) = rx.recv() {
                handle(cmd, &mut api, &mut st, &app, &dir);
            }
        });
    if join_result.is_err() {
        if let Ok(mut s) = status.lock() {
            s.error = Some("cannot start hid worker thread".into());
        }
    }
    HidWorker { tx, status }
}




