use std::path::Path;

/// Номер релиза лежит в файле VERSION в корне репозитория и совпадает с версией
/// интерфейса производителя: 0.8.5.1. Cargo и Tauri понимают только три части
/// (семантическое версионирование), поэтому в Cargo.toml стоит «0.8.5», а полная
/// версия приходит отсюда — её видит человек: в окне, в справке, в отчёте о проблеме
/// и в именах файлов релиза.
fn main() {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("../VERSION");
    println!("cargo:rerun-if-changed=../VERSION");
    match std::fs::read_to_string(&file) {
        Ok(text) => {
            let full = text.trim().to_string();
            if full.is_empty() {
                println!("cargo:warning=VERSION пуст — программа покажет версию Cargo");
            } else {
                println!("cargo:rustc-env=IOHUB_VERSION={full}");
            }
        }
        Err(e) => println!("cargo:warning=не прочитан {}: {e}", file.display()),
    }
    tauri_build::build()
}
