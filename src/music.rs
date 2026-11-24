use super::{base, cmd, now, number, Result};
use crate::ffmpeg::FfmpegOutput;
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

const RATE: u64 = 44100;
const BYTES_PER_SEC: u64 = RATE * 4;
static SERIAL: AtomicU64 = AtomicU64::new(0);
fn root() -> PathBuf {
    base().join("tracks")
}
fn track_path(id: &str) -> Result<PathBuf> {
    if id.len() > 32 || id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
        return Err("Некорректный ID трека".into());
    }
    Ok(root().join(id))
}
fn error(e: std::io::Error) -> String {
    e.to_string()
}
fn audio_identity(track: &Value, path: &Path) -> Option<String> {
    let mut header = [0u8; 42];
    fs::File::open(path).ok()?.read_exact(&mut header).ok()?;
    if &header[..4] != b"fLaC" || header[26..42].iter().all(|&b| b == 0) {
        return None;
    }
    Some(json!([track["kind"], format!("{:02x?}", &header[18..42])]).to_string())
}

static IMPORT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn delete(id: &str) -> Result<Value> {
    fs::remove_dir_all(track_path(id)?).map_err(error)?;
    list()
}

pub fn list() -> Result<Value> {
    let mut tracks = Vec::new();
    fs::create_dir_all(root()).map_err(error)?;
    for entry in fs::read_dir(root()).map_err(error)? {
        let p = entry.map_err(error)?.path();
        if !p
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .bytes()
            .all(|c| c.is_ascii_digit())
        {
            continue;
        }
        let bytes = fs::read(p.join("track.json")).map_err(error)?;
        tracks.push(serde_json::from_slice::<Value>(&bytes).map_err(|e| e.to_string())?);
    }
    tracks.sort_by_key(|t| {
        (
            !t["videoFile"].is_string(),
            std::cmp::Reverse(t["id"].as_str().unwrap_or("").to_owned()),
        )
    });
    let mut sources = std::collections::HashSet::new();
    let mut audio = std::collections::HashSet::new();
    tracks.retain(|t| {
        if let Some(key) = super::anisong::identity(t) {
            return sources.insert(key);
        }
        let fingerprint = t["id"]
            .as_str()
            .and_then(|id| track_path(id).ok())
            .and_then(|path| audio_identity(t, &path.join("track.flac")));
        fingerprint.is_none_or(|key| audio.insert(key))
    });
    tracks.sort_by(|a, b| b["id"].as_str().cmp(&a["id"].as_str()));
    Ok(json!(tracks))
}
pub fn import(reader: &mut impl Read, length: usize, header: &str) -> Result<Value> {
    if length == 0 || length > 128 * 1024 * 1024 {
        return Err("Размер файла должен быть от 1 байта до 128 МБ".into());
    }
    if header.len() > 8192 || !header.is_ascii() || header.len() % 2 != 0 {
        return Err("Некорректное описание трека".into());
    }
    let data = (0..header.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&header[i..i + 2], 16))
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|_| "Описание трека")?;
    let meta = serde_json::from_slice(&data).map_err(|_| "Описание трека")?;
    store(reader, length, meta)
}

pub fn store(reader: &mut impl Read, length: usize, meta: Value) -> Result<Value> {
    store_media(reader, length, meta, false)
}

fn video_name(meta: &Value) -> String {
    let text = format!(
        "{} - {}",
        meta["anime"].as_str().unwrap_or("Anime"),
        meta["title"].as_str().unwrap_or("Track")
    );
    let clean: String = text
        .chars()
        .take(82)
        .map(|c| {
            if c.is_control() || r#"<>:"/\|?*"#.contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    format!("{}.mp4", clean.trim_end_matches([' ', '.']))
}

fn convert_video(input: &Path, target: &Path) -> Result<()> {
    let output = cmd(base().join("ffmpeg.exe").to_str().ok_or("FFmpeg")?)
        .args([
            "-nostdin",
            "-y",
            "-v",
            "error",
            "-protocol_whitelist",
            "file",
            "-format_whitelist",
            "mov,matroska,webm",
            "-i",
        ])
        .arg(input)
        .args([
            "-map",
            "0:v:0",
            "-map",
            "0:a:0",
            "-t",
            "3600",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-threads",
            "2",
            "-pix_fmt",
            "yuv420p",
            "-vf",
            "pad=ceil(iw/2)*2:ceil(ih/2)*2",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
        ])
        .arg(target)
        .limited_output()
        .map_err(error)?;
    if !output.status.success() {
        return Err("Не удалось подготовить MP4 с видео и звуком".into());
    }
    Ok(())
}

pub fn attach_video(meta: &Value, bytes: &[u8]) -> Result<String> {
    let dir = track_path(meta["id"].as_str().ok_or("ID")?)?;
    let name = video_name(meta);
    let raw = dir.join("video-download.tmp");
    let temp = dir.join("video-converting.tmp.mp4");
    let result = (|| {
        fs::write(&raw, bytes).map_err(error)?;
        convert_video(&raw, &temp)?;
        fs::rename(&temp, dir.join(&name)).map_err(error)
    })();
    let _ = fs::remove_file(raw);
    let _ = fs::remove_file(temp);
    result.map(|_| name)
}

pub fn open_video(id: &str) -> Result<Value> {
    let dir = track_path(id)?;
    let meta = metadata(&dir)?;
    let name = meta["videoFile"].as_str().ok_or("У трека нет MP4")?;
    let path = dir.join(name);
    if path.parent() != Some(dir.as_path())
        || path.extension().and_then(|x| x.to_str()) != Some("mp4")
        || !path.is_file()
    {
        return Err("MP4 не найден".into());
    }
    cmd("explorer.exe")
        .arg("/select,")
        .arg(path)
        .spawn()
        .map_err(error)?;
    Ok(json!(true))
}

pub fn store_media(
    reader: &mut impl Read,
    length: usize,
    mut meta: Value,
    video: bool,
) -> Result<Value> {
    meta.as_object_mut()
        .ok_or("Карточка трека")?
        .remove("videoFile");
    for field in ["anime", "title"] {
        if !meta[field]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty() && s.chars().count() <= 160)
        {
            return Err("Укажите название аниме и трека (до 160 символов)".into());
        }
    }
    if !matches!(meta["kind"].as_str(), Some("OP" | "ED" | "OST"))
        || !matches!(meta["level"].as_str(), Some("easy" | "medium" | "hard"))
    {
        return Err("Проверьте тип и сложность".into());
    }
    let offset = number(&meta, "offset", 0, 3600)?;
    let id = format!(
        "{}{:06}",
        now(),
        SERIAL.fetch_add(1, Ordering::Relaxed) % 1000000
    );
    let tmp = root().join(format!("import-{id}"));
    fs::create_dir_all(root()).map_err(error)?;
    fs::create_dir(&tmp).map_err(error)?;
    let result = (|| {
        let input = tmp.join("input");
        let mut f = fs::File::create(&input).map_err(error)?;
        if std::io::copy(&mut reader.take(length as u64), &mut f).map_err(error)? != length as u64 {
            return Err("Загрузка прервана".into());
        }
        drop(f);
        let ff = base().join("ffmpeg.exe");
        let res = cmd(ff.to_str().ok_or("FFmpeg")?)
            .current_dir(&tmp)
            .args([
                "-nostdin",
                "-v",
                "error",
                "-protocol_whitelist",
                "file",
                "-format_whitelist",
                "mp3,wav,flac,ogg,mov,matroska,webm,aac,aiff",
                "-i",
                "input",
                "-map",
                "0:a:0",
                "-vn",
                "-ac",
                "2",
                "-ar",
                "44100",
                "-t",
                "3600",
                "-c:a",
                "flac",
                "track.flac",
            ])
            .limited_output()
            .map_err(error)?;
        if !res.status.success() {
            return Err(
                "FFmpeg не смог прочитать музыку. Выберите MP3, WAV, FLAC, OGG или M4A.".into(),
            );
        }
        let mut prefix = [0u8; 26];
        fs::File::open(tmp.join("track.flac"))
            .and_then(|mut f| f.read_exact(&mut prefix))
            .map_err(error)?;
        if &prefix[..4] != b"fLaC" {
            return Err("Ошибка подготовки аудио".into());
        }
        let packed = u64::from_be_bytes(prefix[18..26].try_into().unwrap());
        let samples = packed & 0xfffffffff;
        let duration_ms = samples * 1000 / RATE;
        if duration_ms < offset * 1000 + 2000 {
            return Err("После выбранной отметки должно оставаться минимум 2 секунды".into());
        }
        meta["durationMs"] = json!(duration_ms);
        meta["id"] = json!(id);
        if video {
            let name = video_name(&meta);
            convert_video(&input, &tmp.join(&name))?;
            meta["videoFile"] = json!(name);
        }
        let _import = IMPORT_LOCK.lock().map_err(|_| "Ошибка записи карточки")?;
        if meta["source"].is_null() {
            if let Some(key) = audio_identity(&meta, &tmp.join("track.flac")) {
                let tracks = list()?;
                for track in tracks
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|t| t["source"].is_null())
                {
                    let path = track_path(track["id"].as_str().ok_or("ID трека")?)?;
                    if audio_identity(track, &path.join("track.flac")).as_ref() == Some(&key) {
                        return Ok(track.clone());
                    }
                }
            }
        }
        fs::remove_file(input).map_err(error)?;
        fs::write(tmp.join("track.json"), meta.to_string()).map_err(error)?;
        fs::rename(&tmp, track_path(&id)?).map_err(error)?;
        Ok(meta)
    })();
    if tmp.exists() {
        let _ = fs::remove_dir_all(&tmp);
    }
    result
}
fn metadata(dir: &Path) -> Result<Value> {
    let bytes = fs::read(dir.join("track.json")).map_err(error)?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

static META_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
pub fn set_offset(id: &str, offset: u64) -> Result<Value> {
    let dir = track_path(id)?;
    let meta = metadata(&dir)?;
    if meta["durationMs"].as_u64().unwrap_or(0) < (offset + 2) * 1000 {
        return Err("Отрывок выходит за пределы записи".into());
    }
    update(id, &json!({"offset":offset}))
}
pub fn update(id: &str, fields: &Value) -> Result<Value> {
    let _guard = META_LOCK.lock().map_err(|_| "Ошибка записи карточки")?;
    let dir = track_path(id)?;
    let mut meta = metadata(&dir)?;
    for (key, value) in fields.as_object().ok_or("Поля трека")? {
        meta[key] = value.clone();
    }
    let tmp = dir.join(format!(
        "offset-{}.json",
        SERIAL.fetch_add(1, Ordering::Relaxed)
    ));
    fs::write(&tmp, meta.to_string()).map_err(error)?;
    if let Err(e) = fs::rename(&tmp, dir.join("track.json")) {
        let _ = fs::remove_file(tmp);
        return Err(error(e));
    }
    Ok(meta)
}

pub struct Media {
    pub flac: PathBuf,
    pub video: Option<PathBuf>,
    pub duration_ms: u64,
}

/// Files of a downloaded track: the FLAC for audio and the MP4 (if any) for footage.
pub fn media(id: &str) -> Result<Media> {
    let dir = track_path(id)?;
    let meta = metadata(&dir)?;
    let video = meta["videoFile"]
        .as_str()
        .map(|name| dir.join(name))
        .filter(|p| p.parent() == Some(dir.as_path()) && p.extension().and_then(|x| x.to_str()) == Some("mp4") && p.is_file());
    Ok(Media {
        flac: dir.join("track.flac"),
        video,
        duration_ms: meta["durationMs"].as_u64().ok_or("Длительность трека")?,
    })
}

/// Full-size cover (saved next to the track) as a data URL, falling back to the small one.
pub fn cover_full(id: &str) -> Result<Value> {
    let dir = track_path(id)?;
    match fs::read(dir.join("cover.jpg")) {
        Ok(bytes) => Ok(json!(format!("data:image/jpeg;base64,{}", super::shiki::base64(&bytes)))),
        Err(_) => Ok(metadata(&dir)?["cover"].clone()),
    }
}

pub fn save_cover(id: &str, bytes: &[u8]) -> Result<()> {
    fs::write(track_path(id)?.join("cover.jpg"), bytes).map_err(error)
}

pub fn open_tracks() -> Result<Value> {
    fs::create_dir_all(root()).map_err(error)?;
    cmd("explorer.exe").arg(root()).spawn().map_err(error)?;
    Ok(json!(true))
}

/// Fills `ru` from Shikimori by the English anime name; keeps a manual `ru`.
/// shortcut: first search hit (exact-name match preferred), wrong for ambiguous titles; user can edit the field.
pub fn shikimori(id: &str) -> Result<Value> {
    let meta = metadata(&track_path(id)?)?;
    if meta["ru"].as_str().is_some_and(|s| !s.is_empty()) || meta["ruChecked"] == true {
        return Ok(meta);
    }
    let name = meta["anime"].as_str().ok_or("Аниме")?;
    let out = cmd("curl.exe")
        .args(["-fsS", "--max-time", "15", "--max-filesize", "1000000", "-A", "Framequiz"])
        .arg(format!(
            "https://shikimori.io/api/animes?limit=5&order=popularity&search={}",
            super::encode(name)
        ))
        .output()
        .map_err(|_| "curl.exe недоступен")?;
    if !out.status.success() {
        return Err("Shikimori недоступен".into());
    }
    let found: Value = serde_json::from_slice(&out.stdout).map_err(|_| "Ответ Shikimori")?;
    let hits = found.as_array().ok_or("Ответ Shikimori")?;
    let hit = hits
        .iter()
        .find(|h| h["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name)))
        .or(hits.first());
    let ru = hit.and_then(|h| h["russian"].as_str()).unwrap_or("");
    update(id, &json!({ "ru": ru, "ruChecked": true }))
}

pub fn set_ru(id: &str, ru: &str) -> Result<Value> {
    let ru = ru.trim();
    if ru.chars().count() > 160 {
        return Err("Русское название: до 160 символов".into());
    }
    update(id, &json!({ "ru": ru }))
}

/// Start of the loudest `seconds`-long window, skipping the first 10% (intro).
/// shortcut: loudness proxy, not real chorus detection; upgrade to spectral analysis if picks feel wrong.
pub fn peak_offset(id: &str, seconds: u64) -> Result<u64> {
    let total = metadata(&track_path(id)?)?["durationMs"].as_u64().ok_or("Длительность")? / 1000;
    let max_start = total.checked_sub(seconds).ok_or("Отрывок длиннее трека")?;
    let peaks = waveform(id)?;
    let peaks: Vec<u64> = peaks.as_array().ok_or("Дорожка")?.iter().filter_map(|p| p.as_u64()).collect();
    if peaks.is_empty() {
        return Err("Пустая звуковая дорожка".into());
    }
    Ok(loudest_start(&peaks, total, seconds).min(max_start))
}

fn loudest_start(peaks: &[u64], total: u64, seconds: u64) -> u64 {
    let bucket = total as f64 / peaks.len() as f64;
    let width = ((seconds as f64 / bucket).ceil() as usize).clamp(1, peaks.len());
    let first = ((total as f64 * 0.1 / bucket) as usize).min(peaks.len() - width);
    let mut sum = peaks[first..first + width].iter().sum::<u64>();
    let (mut best, mut at) = (sum, first);
    for i in first + 1..=peaks.len() - width {
        sum = sum + peaks[i + width - 1] - peaks[i - 1];
        if sum > best {
            (best, at) = (sum, i);
        }
    }
    (at as f64 * bucket).round() as u64
}

#[cfg(test)]
mod tests {
    #[test]
    fn picks_loudest_window_after_intro() {
        // 100 buckets over 100 s: loud block at 40..50 s, a louder one inside the skipped intro (0..5 s)
        let mut p = vec![10u64; 100];
        p[40..50].fill(100);
        p[0..5].fill(500);
        assert_eq!(super::loudest_start(&p, 100, 10), 40);
    }
}

pub fn waveform(id: &str) -> Result<Value> {
    let dir = track_path(id)?;
    let ff = base().join("ffmpeg.exe");
    let output = cmd(ff.to_str().ok_or("FFmpeg")?)
        .args(["-nostdin", "-v", "error", "-i"])
        .arg(dir.join("track.flac"))
        .args(["-ac", "1", "-ar", "4000", "-f", "s16le", "pipe:1"])
        .limited_output()
        .map_err(error)?;
    if !output.status.success() || output.stdout.is_empty() {
        return Err("Не удалось прочитать звуковую дорожку".into());
    }
    let samples = output.stdout.len() / 2;
    let step = samples.div_ceil(720).max(1);
    let peaks: Vec<u16> = output
        .stdout
        .chunks(step * 2)
        .map(|chunk| {
            chunk
                .chunks_exact(2)
                .map(|s| i16::from_le_bytes([s[0], s[1]]).unsigned_abs())
                .max()
                .unwrap_or(0)
        })
        .collect();
    Ok(json!(peaks))
}

fn pcm(id: &str, offset: u64, seconds: u64) -> Result<Vec<u8>> {
    if !(1..=60).contains(&seconds) || offset > 3600 {
        return Err("Некорректный диапазон отрывка".into());
    }
    let path = track_path(id)?.join("track.flac");
    let ff = base().join("ffmpeg.exe");
    let res = cmd(ff.to_str().ok_or("FFmpeg")?)
        .args(["-nostdin", "-v", "error", "-ss", &offset.to_string(), "-i"])
        .arg(path)
        .args([
            "-t",
            &seconds.to_string(),
            "-f",
            "s16le",
            "-acodec",
            "pcm_s16le",
            "pipe:1",
        ])
        .limited_output()
        .map_err(error)?;
    if !res.status.success() || res.stdout.len() != (seconds * BYTES_PER_SEC) as usize {
        return Err("Трек недоступен или отрывок выходит за его границы".into());
    }
    Ok(res.stdout)
}
fn wav_header(seconds: u64) -> Vec<u8> {
    let size = (seconds * BYTES_PER_SEC) as u32;
    let mut h = b"RIFF".to_vec();
    h.extend((size + 36).to_le_bytes());
    h.extend(b"WAVEfmt ");
    h.extend(16u32.to_le_bytes());
    h.extend(1u16.to_le_bytes());
    h.extend(2u16.to_le_bytes());
    h.extend((RATE as u32).to_le_bytes());
    h.extend((BYTES_PER_SEC as u32).to_le_bytes());
    h.extend(4u16.to_le_bytes());
    h.extend(16u16.to_le_bytes());
    h.extend(b"data");
    h.extend(size.to_le_bytes());
    h
}
pub fn preview(route: &str) -> Result<Vec<u8>> {
    let mut p = route.split('/');
    let id = p.next().ok_or("ID")?;
    let start = p.next().and_then(|v| v.parse().ok()).ok_or("Начало")?;
    let seconds = p.next().and_then(|v| v.parse().ok()).ok_or("Длина")?;
    let bytes = pcm(id, start, seconds)?;
    let mut wav = wav_header(seconds);
    wav.extend(bytes);
    Ok(wav)
}
pub fn soundtrack(path: &Path, clips: &Value, count: u64, round: u64, reveal: u64) -> Result<()> {
    let clips = clips
        .as_array()
        .filter(|a| a.len() == count as usize)
        .ok_or("План музыки не совпадает с числом раундов")?;
    let mut f = fs::File::create(path).map_err(error)?;
    f.write_all(&wav_header(count * round)).map_err(error)?;
    let silence = vec![0; (reveal * BYTES_PER_SEC) as usize];
    for clip in clips {
        let bytes = pcm(
            clip["id"].as_str().ok_or("Не выбран трек")?,
            number(clip, "offset", 0, 3600)?,
            round - reveal,
        )?;
        f.write_all(&bytes).map_err(error)?;
        f.write_all(&silence).map_err(error)?
    }
    Ok(())
}
