//! Что именно теряет ответы: постоянный опрос отдельным хендлом или что-то ещё.
//! Вариант A: хендл B крутит чтение в потоке, хендл A пишет.
//! Вариант B: один хендл на всё — поток и читает, и пишет по команде через канал.
//! Запуск: cargo run --offline --example hid_probe2
use crossbeam_channel::{select, Receiver, Sender};
use hidapi::HidApi;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const PATH: &str = "\\\\?\\HID#VID_05AC&PID_024F&MI_02#9&2c934e8a&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}";

fn packet() -> Vec<u8> {
    let mut p = vec![0u8; 65];
    p[1] = 0xAA;
    p[2] = 0x10;
    p[3] = 0x30;
    p[6] = 0x01;
    p
}

fn preview(b: &[u8]) -> String {
    let head: Vec<String> = b.iter().take(8).map(|x| format!("{x:02x}")).collect();
    format!("[{} …({})]", head.join(" "), b.len())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let api = HidApi::new()?;
    let path = std::ffi::CString::new(PATH)?;

    println!("=== вариант A: чтение отдельным хендлом в потоке, пишет другой ===");
    {
        let writer = api.open_path(&path)?;
        let reader = api.open_path(&path)?;
        let stop = Arc::new(AtomicBool::new(false));
        let got = Arc::new(AtomicBool::new(false));
        let (s_stop, s_got) = (stop.clone(), got.clone());
        let t = std::thread::spawn(move || {
            let mut buf = vec![0u8; 65];
            let mut polls = 0;
            while !s_stop.load(Ordering::Relaxed) {
                polls += 1;
                match reader.read_timeout(&mut buf, 20) {
                    Ok(n) if n > 0 => {
                        println!("   поток прочитал {} байт {}", n, preview(&buf[..n]));
                        s_got.store(true, Ordering::Relaxed);
                    }
                    Ok(_) => {}
                    Err(e) => {
                        println!("   ошибка чтения: {e}");
                        break;
                    }
                }
            }
            println!("   поток сделал {polls} опросов");
        });
        std::thread::sleep(std::time::Duration::from_millis(300));
        println!("   записано {:?}", writer.write(&packet()));
        std::thread::sleep(std::time::Duration::from_millis(1500));
        stop.store(true, Ordering::Relaxed);
        let _ = t.join();
        println!("   итог A: ответ {}", if got.load(Ordering::Relaxed) { "есть" } else { "НЕ получен" });
    }

    println!("\n=== вариант B: один хендл читает и пишет сам ===");
    {
        let device = api.open_path(&path)?;
        let (tx, rx): (Sender<u8>, Receiver<u8>) = crossbeam_channel::unbounded();
        let stop = Arc::new(AtomicBool::new(false));
        let got = Arc::new(AtomicBool::new(false));
        let (s_stop, s_got) = (stop.clone(), got.clone());
        let t = std::thread::spawn(move || {
            let mut buf = vec![0u8; 65];
            let mut polls = 0;
            while !s_stop.load(Ordering::Relaxed) {
                select! {
                    recv(rx) -> msg => {
                        if msg.is_ok() {
                            match device.write(&packet()) {
                                Ok(n) => println!("   поток записал {n}"),
                                Err(e) => println!("   ошибка записи: {e}"),
                            }
                        }
                    }
                    default(std::time::Duration::from_millis(2)) => {}
                }
                polls += 1;
                match device.read_timeout(&mut buf, 20) {
                    Ok(n) if n > 0 => {
                        println!("   поток прочитал {} байт {}", n, preview(&buf[..n]));
                        s_got.store(true, Ordering::Relaxed);
                    }
                    Ok(_) => {}
                    Err(e) => {
                        println!("   ошибка чтения: {e}");
                        break;
                    }
                }
            }
            println!("   поток сделал {polls} опросов");
        });
        std::thread::sleep(std::time::Duration::from_millis(300));
        let _ = tx.send(1u8);
        std::thread::sleep(std::time::Duration::from_millis(1500));
        stop.store(true, Ordering::Relaxed);
        let _ = t.join();
        println!("   итог B: ответ {}", if got.load(Ordering::Relaxed) { "есть" } else { "НЕ получен" });
    }
    Ok(())
}
