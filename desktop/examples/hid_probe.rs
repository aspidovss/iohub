//! Мини-проверка моста: пишет кадр в служебный интерфейс и читает ответ разными способами.
//! Запуск: cargo run --offline --example hid_probe
use hidapi::HidApi;

const PATH: &str = "\\\\?\\HID#VID_05AC&PID_024F&MI_02#9&2c934e8a&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}";

fn preview(b: &[u8]) -> String {
    let head: Vec<String> = b.iter().take(10).map(|x| format!("{x:02x}")).collect();
    format!("[{} …({})]", head.join(" "), b.len())
}

fn send(w: &hidapi::HidDevice) {
    let mut p = vec![0u8; 65];
    p[1] = 0xAA;
    p[2] = 0x10;
    p[3] = 0x30;
    p[6] = 0x01;
    match w.write(&p) {
        Ok(n) => println!("записано {n}"),
        Err(e) => println!("ошибка записи: {e}"),
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let api = HidApi::new()?;
    let path = std::ffi::CString::new(PATH)?;
    let writer = api.open_path(&path)?;
    let reader = api.open_path(&path)?;
    println!("оба хендла открыты");

    println!("\n1) хендл A пишет, хендл B читает read_timeout(1500)");
    send(&writer);
    let mut buf = vec![0u8; 65];
    println!("   B: {:?}", reader.read_timeout(&mut buf, 1500).map(|n| preview(&buf[..n])));

    println!("\n2) хендл A пишет, хендл A читает read_timeout(1500)");
    send(&writer);
    println!("   A: {:?}", writer.read_timeout(&mut buf, 1500).map(|n| preview(&buf[..n])));

    println!("\n3) A пишет, B крутит read_timeout(150) десять раз");
    send(&writer);
    for i in 0..10 {
        match reader.read_timeout(&mut buf, 150) {
            Ok(0) => {}
            Ok(n) => {
                println!("   B#{i}: {}", preview(&buf[..n]));
                break;
            }
            Err(e) => {
                println!("   B#{i}: ошибка {e}");
                break;
            }
        }
    }

    println!("\n4) A пишет, B читает блокирующим read() с таймаутом сверху");
    send(&writer);
    let _ = reader.set_blocking_mode(true);
    match reader.read_timeout(&mut buf, 3000) {
        Ok(n) => println!("   B(read_timeout 3000): {}", preview(&buf[..n])),
        Err(e) => println!("   B: ошибка {e}"),
    }

    println!("\n5) неблокирующий B: A пишет, B читает read() 20 раз по 100 мс");
    reader.set_blocking_mode(false)?;
    send(&writer);
    for i in 0..20 {
        match reader.read(&mut buf) {
            Ok(0) => std::thread::sleep(std::time::Duration::from_millis(100)),
            Ok(n) => {
                println!("   B#{i}: {}", preview(&buf[..n]));
                break;
            }
            Err(e) => {
                println!("   B#{i}: ошибка {e}");
                break;
            }
        }
    }
    Ok(())
}
