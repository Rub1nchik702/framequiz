#![cfg_attr(windows, windows_subsystem = "windows")]
mod anisong;
mod ffmpeg;
mod music;
use ffmpeg::FfmpegOutput;
use std::sync::OnceLock;

static SESSION: OnceLock<String> = OnceLock::new();
#[link(name = "bcrypt")]
extern "system" {
    fn BCryptGenRandom(
        algorithm: *mut std::ffi::c_void,
        buffer: *mut u8,
        size: u32,
        flags: u32,
    ) -> i32;
}
fn session() -> &'static str {
    SESSION.get_or_init(|| {
        let mut bytes = [0u8; 32];
        // BCRYPT_USE_SYSTEM_PREFERRED_RNG accepts a null algorithm handle.
        assert_eq!(
            unsafe { BCryptGenRandom(std::ptr::null_mut(), bytes.as_mut_ptr(), 32, 2) },
            0
        );
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    })
}
use serde_json::{json, Value};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
type Result<T> = std::result::Result<T, String>;
fn host() -> String {
    let port = std::env::var("FRAMEQUIZ_PORT")
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(39742);
    format!("127.0.0.1:{port}")
}
fn cmd(program: &str) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    c.creation_flags(0x08000000);
    c
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
fn base() -> PathBuf {
    std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .to_owned()
}
fn number(v: &Value, key: &str, min: u64, max: u64) -> Result<u64> {
    v[key]
        .as_u64()
        .filter(|x| (min..=max).contains(x))
        .ok_or(format!("Некорректный параметр {key}"))
}
fn remote(url: &str) -> Result<Value> {
    let o = cmd("curl.exe")
        .args(["-fsS", "--max-time", "25", "--max-filesize", "4000000", url])
        .output()
        .map_err(|_| "curl.exe недоступен")?;
    if !o.status.success() {
        return Err("Источник недоступен. Проверьте подключение, ключ или квоту сервиса.".into());
    }
    serde_json::from_slice(&o.stdout).map_err(|_| "Некорректный ответ источника".into())
}
fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
fn shuffle<T>(pool: &mut [T]) {
    let mut seed = now() | 1;
    for i in (1..pool.len()).rev() {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        pool.swap(i, seed as usize % (i + 1))
    }
}
fn select(v: &Value) -> Result<Value> {
    let mut pool = v["pool"].as_array().ok_or("Пустой каталог")?.clone();
    shuffle(&mut pool);
    let mut seen = std::collections::HashSet::new();
    pool.retain(|q| seen.insert(q["q"].as_str().unwrap_or("").trim().to_lowercase()));
    let n = number(v, "count", 1, 60)? as usize;
    pool.retain(|q| q["cat"] == v["cat"] && (v["level"] == "mix" || q["level"] == v["level"]));
    if pool.len() < n {
        return Err(format!("Доступно {} вопросов из {n}. Уменьшите число раундов, смешайте уровни или добавьте вопросы.",pool.len()));
    }
    pool.truncate(n);
    Ok(json!(pool))
}
fn job(id: &str) -> Result<PathBuf> {
    if id.len() > 24 || id.is_empty() || !id.bytes().all(|x| x.is_ascii_digit()) {
        return Err("Неизвестный экспорт".into());
    }
    Ok(std::env::temp_dir().join(format!("quiz-studio-{id}")))
}
fn soundtrack(path: &Path, count: u64, round: u64, reveal: u64) -> Result<()> {
    let rate = 22050u32;
    let samples = (count * round) as u32 * rate;
    let mut f = std::io::BufWriter::new(fs::File::create(path).map_err(|e| e.to_string())?);
    let mut hdr = b"RIFF".to_vec();
    hdr.extend((36 + samples * 2).to_le_bytes());
    hdr.extend(b"WAVEfmt ");
    hdr.extend(16u32.to_le_bytes());
    hdr.extend(1u16.to_le_bytes());
    hdr.extend(1u16.to_le_bytes());
    hdr.extend(rate.to_le_bytes());
    hdr.extend((rate * 2).to_le_bytes());
    hdr.extend(2u16.to_le_bytes());
    hdr.extend(16u16.to_le_bytes());
    hdr.extend(b"data");
    hdr.extend((samples * 2).to_le_bytes());
    f.write_all(&hdr).map_err(|e| e.to_string())?;
    for i in 0..samples {
        let sec = i / rate;
        let t = (i % rate) as f32 / rate as f32;
        let pos = sec as u64 % round;
        let freq = if pos == round - reveal {
            784.0
        } else if pos < round - reveal && round - reveal - pos <= 3 {
            392.0
        } else {
            0.0
        };
        let a = if freq > 0.0 && t < 0.32 {
            ((t * freq * std::f32::consts::TAU).sin() * (-14.0 * t).exp() * 4400.0) as i16
        } else {
            0
        };
        f.write_all(&a.to_le_bytes()).map_err(|e| e.to_string())?
    }
    f.flush().map_err(|e| e.to_string())
}
fn api(route: &str, b: &[u8]) -> Result<Value> {
    if let Some(rest) = route.strip_prefix("/api/frame/") {
        let (id, n) = rest.split_once('/').ok_or("Кадр")?;
        let n: usize = n.parse().map_err(|_| "Кадр")?;
        if n >= 120 || !b.starts_with(&[255, 216]) {
            return Err("Некорректный кадр".into());
        }
        fs::write(job(id)?.join(format!("{n}.jpg")), b).map_err(|e| e.to_string())?;
        return Ok(json!(true));
    }
    let v: Value = serde_json::from_slice(b).map_err(|_| "Некорректный JSON")?;
    match route {
        "/api/update-open" => {
            let lang = if v["language"] == "en" { "en" } else { "ru" };
            let helper = base().join("window").join("FramequizWindow.exe");
            cmd(helper.to_str().ok_or("Window path")?)
                .args([
                    "--update",
                    env!("CARGO_PKG_VERSION"),
                    &std::process::id().to_string(),
                    lang,
                ])
                .spawn()
                .map_err(|e| e.to_string())?;
            Ok(json!(true))
        }
        "/api/update-status" => {
            let text = fs::read_to_string(base().join("update-status.txt")).unwrap_or_default();
            Ok(json!(text.trim_start_matches('﻿').trim()))
        }
        "/api/quit" => {
            thread::spawn(|| {
                thread::sleep(std::time::Duration::from_millis(250));
                std::process::exit(0)
            });
            Ok(json!(true))
        }
        "/api/source" => {
            let url = v["url"]
                .as_str()
                .filter(|s| s.starts_with("https://") && s.len() <= 4096)
                .ok_or("Введите HTTPS-адрес источника")?;
            let output = cmd("curl.exe")
                .args([
                    "--globoff",
                    "--proto",
                    "=https",
                    "--proto-redir",
                    "=https",
                    "-fLsS",
                    "--max-redirs",
                    "3",
                    "--max-time",
                    "20",
                    "--max-filesize",
                    "2000000",
                    "--",
                    url,
                ])
                .output()
                .map_err(|_| "curl.exe недоступен")?;
            if !output.status.success() || output.stdout.len() > 2_000_000 {
                return Err("Проверьте адрес и доступность ленты или JSON-каталога".into());
            }
            Ok(json!(String::from_utf8(output.stdout)
                .map_err(|_| "Источник должен использовать UTF-8")?))
        }
        "/api/music-catalog" => anisong::browse(v["kind"].as_str().ok_or("Тип")?),
        "/api/music-pick" => anisong::pick(
            v["id"].as_u64().ok_or("ID")?,
            number(&v, "offset", 0, 3598)?,
        ),
        "/api/video-folder" => music::open_video(v["id"].as_str().ok_or("ID")?),
        "/api/amq-scores" => anisong::import_scores(&v),
        "/api/download-tracks" => {
            let kind = v["kind"]
                .as_str()
                .filter(|k| matches!(*k, "OP" | "ED"))
                .ok_or("Тип трека")?;
            let mut counts = [0; 3];
            for (i, level) in anisong::LEVELS.iter().enumerate() {
                counts[i] = number(&v["quota"], level, 0, 60)? as usize;
            }
            if !(1..=60).contains(&counts.iter().sum::<usize>()) {
                return Err("Выберите от 1 до 60 треков".into());
            }
            Ok(json!(anisong::select(kind, counts, 2)?))
        }
        "/api/tracks" => music::list(),
        "/api/waveform" => music::waveform(v["id"].as_str().ok_or("ID трека")?),
        "/api/track-offset" => music::set_offset(
            v["id"].as_str().ok_or("ID трека")?,
            number(&v, "offset", 0, 3598)?,
        ),

        "/api/music-plan" => {
            let clip = number(&v, "clip", 2, 59)?;
            let online = v["openingSource"] == "anisongdb";
            let mut total = 0;
            for kind in ["OP", "ED", "OST"] {
                for level in anisong::LEVELS {
                    total += number(&v["quota"][kind], level, 0, 60)?;
                }
            }
            if !(1..=60).contains(&total) {
                return Err("Выберите от 1 до 60 треков".into());
            }
            let tracks = music::list()?;
            let mut chosen = Vec::new();
            for kind in ["OP", "ED", "OST"] {
                if online && kind != "OST" {
                    continue;
                }
                for level in anisong::LEVELS {
                    let n = number(&v["quota"][kind], level, 0, 60)? as usize;
                    let mut pool: Vec<_> = tracks
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter(|t| {
                            t["kind"] == kind
                                && t["level"] == level
                                && t["durationMs"].as_u64().unwrap_or(0)
                                    >= (t["offset"].as_u64().unwrap_or(0) + clip) * 1000
                        })
                        .cloned()
                        .collect();
                    if pool.len() < n {
                        return Err(format!(
                            "{kind} / {level}: выбрано {n}, доступно {} с отрывком {clip} с.",
                            pool.len()
                        ));
                    }
                    shuffle(&mut pool);
                    chosen.extend(pool.into_iter().take(n));
                }
            }
            if online {
                for kind in ["OP", "ED"] {
                    let openings = &v["quota"][kind];
                    let counts =
                        anisong::LEVELS.map(|level| openings[level].as_u64().unwrap() as usize);
                    chosen.extend(anisong::select(kind, counts, clip)?);
                }
            }
            shuffle(&mut chosen);
            Ok(json!(chosen))
        }
        "/api/plan" => select(&v),
        "/api/questions" => {
            let cat = match v["cat"].as_str() {
                Some("anime") => 31,
                Some("film") => 11,
                Some("tv") => 14,
                Some("toon") => 32,
                _ => return Err("Категория".into()),
            };
            remote(&format!(
                "https://opentdb.com/api.php?amount=10&category={cat}&type=multiple&encode=url3986"
            ))
        }
        "/api/trends" => {
            let key = v["key"].as_str().ok_or("Введите ключ YouTube")?;
            let genre = v["genre"].as_str().ok_or("Жанр")?;
            let since = encode(v["since"].as_str().ok_or("Дата")?);
            let q = encode(&format!("{genre} quiz"));
            let region = encode(v["region"].as_str().unwrap_or("US"));
            let res=remote(&format!("https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=viewCount&maxResults=10&relevanceLanguage=en&regionCode={region}&publishedAfter={since}&q={q}&key={}",encode(key)))?;
            Ok(res["items"].clone())
        }
        "/api/start" => {
            let id = now().to_string();
            fs::create_dir(job(&id)?).map_err(|e| e.to_string())?;
            Ok(json!(id))
        }
        "/api/cancel" => {
            let p = job(v["id"].as_str().ok_or("ID")?)?;
            fs::remove_dir_all(p).map_err(|e| e.to_string())?;
            Ok(json!(true))
        }
        "/api/export" => {
            let id = v["id"].as_str().ok_or("ID")?;
            let dir = job(id)?;
            let count = number(&v, "count", 1, 60)?;
            let round = number(&v, "round", 4, 60)?;
            let reveal = number(&v, "reveal", 1, round - 1)?;
            if count * round > 600 {
                return Err("Максимум 10 минут".into());
            }
            let mut list = String::new();
            for i in 0..count * 2 {
                list += &format!(
                    "file '{i}.jpg'\nduration {}\n",
                    if i % 2 == 0 { round - reveal } else { reveal }
                )
            }
            list += &format!("file '{}.jpg'\n", count * 2 - 1);
            fs::write(dir.join("frames.txt"), list).map_err(|e| e.to_string())?;
            if v["clips"].is_null() {
                soundtrack(&dir.join("audio.wav"), count, round, reveal)?
            } else {
                music::soundtrack(&dir.join("audio.wav"), &v["clips"], count, round, reveal)?
            }
            let out = base().join("exports");
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            let path = out.join(format!("Quiz-{id}.mp4"));
            let pending = out.join(format!(".Quiz-{id}.partial"));
            let ff = base().join("ffmpeg.exe");
            let o = cmd(ff.to_str().ok_or("FFmpeg")?)
                .current_dir(&dir)
                .args([
                    "-nostdin",
                    "-y",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "concat",
                    "-safe",
                    "1",
                    "-i",
                    "frames.txt",
                    "-i",
                    "audio.wav",
                    "-vf",
                    "fps=24,format=yuv420p",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-threads",
                    "3",
                    "-crf",
                    "22",
                    "-c:a",
                    "aac",
                    "-b:a",
                    if v["clips"].is_null() { "64k" } else { "160k" },
                    "-t",
                    &(round * count).to_string(),
                    "-movflags",
                    "+faststart",
                    "-f",
                    "mp4",
                ])
                .arg(&pending)
                .stdout(Stdio::null())
                .limited_output()
                .map_err(|_| "Поместите ffmpeg.exe рядом с программой")?;
            if !o.status.success() {
                let _ = fs::remove_file(&pending);
                return Err(format!("FFmpeg: {}", String::from_utf8_lossy(&o.stderr)));
            }
            if let Err(error) = fs::rename(&pending, &path) {
                let _ = fs::remove_file(&pending);
                return Err(error.to_string());
            }
            let _ = fs::remove_dir_all(dir);
            Ok(json!(path.to_string_lossy()))
        }
        "/api/folder" => {
            cmd("explorer.exe")
                .arg(base().join("exports"))
                .spawn()
                .map_err(|e| e.to_string())?;
            Ok(json!(true))
        }
        _ => Err("Неизвестный запрос".into()),
    }
}
fn serve(mut s: TcpStream) -> std::io::Result<()> {
    s.set_read_timeout(Some(std::time::Duration::from_secs(30)))?;
    let mut buffered = BufReader::new(s.try_clone()?);
    let mut reader = Read::by_ref(&mut buffered).take(32768);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let first = line.clone();
    let mut len = 0;
    let mut host = false;
    let mut auth = false;
    let mut origin_ok = true;
    let mut track_meta = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 || reader.limit() == 0 {
            return Ok(());
        }
        if line == "\r\n" {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            match k.to_ascii_lowercase().as_str() {
                "x-track-meta" => track_meta = v.trim().to_owned(),
                "host" => host = v.trim() == crate::host(),
                "content-length" => len = v.trim().parse().unwrap_or(usize::MAX),
                "x-quiz-studio" => auth = v.trim() == session(),
                "origin" => origin_ok &= v.trim() == format!("http://{}", crate::host()),
                _ => (),
            }
        }
    }
    let parts: Vec<_> = first.split_whitespace().collect();
    if !host || parts.len() < 2 || (len > 8_000_000 && parts[1] != "/api/import") {
        return Ok(());
    }
    let clip = parts[1].strip_prefix("/clip/");
    let permitted_clip = clip
        .and_then(|path| path.split_once("?session="))
        .filter(|(_, token)| *token == session());
    if !origin_ok || (parts[0] == "POST" && !auth) || (clip.is_some() && permitted_clip.is_none()) {
        s.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")?;
        return Ok(());
    }
    let reader = &mut buffered;
    let (mime, data) = if parts[0] == "POST" && auth {
        let result = if parts[1] == "/api/import" {
            music::import(reader, len, &track_meta)
        } else {
            let mut b = vec![0; len];
            reader.read_exact(&mut b)?;
            api(parts[1], &b)
        };
        let reply = match result {
            Ok(v) => json!({"data":v}),
            Err(e) => json!({"error":e}),
        };
        ("application/json", reply.to_string().into_bytes())
    } else if parts[0] == "GET" {
        match parts[1] {
            "/" => (
                "text/html",
                include_bytes!(concat!(env!("OUT_DIR"), "/index.html")).to_vec(),
            ),
            route if route.starts_with("/clip/") => match music::preview(permitted_clip.unwrap().0)
            {
                Ok(wav) => ("audio/wav", wav),
                Err(e) => {
                    write!(s,"HTTP/1.1 422 Unprocessable Content\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",e.len(),e)?;
                    return Ok(());
                }
            },
            "/sun.svg" | "/favicon.ico" => {
                ("image/svg+xml", include_bytes!("../ui/sun.svg").to_vec())
            }
            "/en" => (
                "text/html",
                include_bytes!(concat!(env!("OUT_DIR"), "/en-index.html")).to_vec(),
            ),
            "/en/app.js" => (
                "text/javascript",
                include_bytes!(concat!(env!("OUT_DIR"), "/en-app.js")).to_vec(),
            ),
            "/en/music.js" => (
                "text/javascript",
                include_bytes!(concat!(env!("OUT_DIR"), "/en-music.js")).to_vec(),
            ),
            "/music.js" => ("text/javascript", include_bytes!("../ui/music.js").to_vec()),
            "/style.css" => ("text/css", include_bytes!("../ui/style.css").to_vec()),
            "/app.js" => ("text/javascript", include_bytes!("../ui/app.js").to_vec()),
            "/catalog.json" => (
                "application/json",
                include_bytes!("../ui/catalog.json").to_vec(),
            ),
            _ => return Ok(()),
        }
    } else {
        return Ok(());
    };
    write!(s,"HTTP/1.1 200 OK\r\nContent-Type: {mime}; charset=utf-8\r\nContent-Length: {}\r\nReferrer-Policy: no-referrer\r\nX-Frame-Options: DENY\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",data.len())?;
    s.write_all(&data)
}
fn serve_requests(listener: TcpListener) {
    for stream in listener.incoming().flatten() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static ACTIVE: AtomicUsize = AtomicUsize::new(0);
        if ACTIVE
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                (n < 32).then_some(n + 1)
            })
            .is_err()
        {
            continue;
        }
        thread::spawn(move || {
            struct Slot;
            impl Drop for Slot {
                fn drop(&mut self) {
                    ACTIVE.fetch_sub(1, Ordering::Relaxed);
                }
            }
            let _slot = Slot;
            let _ = serve(stream);
        });
    }
}
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let listener = TcpListener::bind(host());
    if args.iter().any(|x| x == "--headless") {
        if let Ok(listener) = listener {
            println!("http://{}/#{}", host(), session());
            serve_requests(listener);
        }
        return;
    }
    let shell = base().join("window").join("FramequizWindow.exe");
    let mut window = cmd(shell.to_str().unwrap());
    window.arg(format!("http://{}/#{}", host(), session()));
    let running = if let Ok(listener) = listener {
        thread::spawn(move || serve_requests(listener));
        window.arg(std::process::id().to_string());
        true
    } else {
        window.arg("activate");
        false
    };
    window.arg(if args.iter().any(|x| x == "--tray") {
        "tray"
    } else {
        "open"
    });
    if let Ok(mut child) = window.spawn() {
        let _ = child.wait();
    } else if running {
        let url = format!("http://{}/#{}", host(), session());
        let _ = cmd("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn();
        loop {
            thread::park();
        }
    }
}
