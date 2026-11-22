use super::{cmd, music, now, Result};
use serde_json::{json, Value};
use std::{collections::HashSet, io::Write, process::Stdio, sync::Mutex, thread};

pub const LEVELS: [&str; 3] = ["easy", "medium", "hard"];
const RANGES: [(u64, u64); 3] = [(70, 100), (40, 70), (0, 40)];
const MAX_VIDEO: usize = 96 * 1024 * 1024;
static BROWSE: Mutex<Vec<Value>> = Mutex::new(Vec::new());

fn video_files(song: &Value) -> impl Iterator<Item = &str> {
    ["HQ", "MQ"]
        .into_iter()
        .filter_map(|field| song[field].as_str())
        .filter(|name| {
            name.rsplit_once('.').is_some_and(|(stem, ext)| {
                matches!(ext, "webm" | "mp4")
                    && !stem.is_empty()
                    && stem.len() <= 64
                    && stem
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
            })
        })
}
fn download_video(song: &Value) -> Option<Vec<u8>> {
    for file in video_files(song) {
        for host in ["eudist.animemusicquiz.com", "naedist.animemusicquiz.com"] {
            let r = cmd("curl.exe")
                .args([
                    "-q",
                    "-fsS",
                    "--proto",
                    "=https",
                    "--connect-timeout",
                    "5",
                    "--max-time",
                    "45",
                    "--max-filesize",
                ])
                .arg(MAX_VIDEO.to_string())
                .arg(format!("https://{host}/{file}"))
                .output()
                .ok()?;
            if r.status.success() && (1..=MAX_VIDEO).contains(&r.stdout.len()) {
                return Some(r.stdout);
            }
        }
    }
    None
}

fn verified_score(song: &Value, index: &Value) -> Option<f64> {
    score_key(
        &song["annId"],
        &song["songName"],
        &song["songArtist"],
        &song["songType"],
    )
    .and_then(|k| index[k].as_f64())
}

pub fn browse(kind: &str) -> Result<Value> {
    if !matches!(kind, "OP" | "ED") {
        return Err("Выберите OP или ED".into());
    }
    let mut songs = catalog(kind, 40, 0, 100)?;
    let index = scores()?;
    songs.retain(|s| {
        video_files(s).next().is_some()
            && s["audio"].is_string()
            && s["songDifficulty"].is_number()
            && s["amqSongId"].is_u64()
    });
    let mut rows = Vec::new();
    for song in &songs {
        let verified = verified_score(song, &index);
        let score = verified
            .or_else(|| song["songDifficulty"].as_f64())
            .ok_or("Сложность")?;
        rows.push(json!({"id":song["amqSongId"],"anime":anime_name(song),"title":song["songName"],"kind":kind,"version":song["songType"],"level":level_of(score),"amqDifficulty":score,"verified":verified.is_some()}));
    }
    *BROWSE.lock().map_err(|_| "Каталог занят")? = songs;
    Ok(json!(rows))
}

pub fn pick(id: u64, offset: u64) -> Result<Value> {
    let _guard = DOWNLOADS
        .try_lock()
        .map_err(|_| "Загрузка уже выполняется")?;
    let song = BROWSE
        .lock()
        .map_err(|_| "Каталог занят")?
        .iter()
        .find(|s| s["amqSongId"].as_u64() == Some(id))
        .cloned()
        .ok_or("Обновите список и выберите трек снова")?;
    let verified = verified_score(&song, &scores()?);
    let score = verified
        .or_else(|| song["songDifficulty"].as_f64())
        .ok_or("Сложность")?;
    let kind = if song["songType"]
        .as_str()
        .unwrap_or("")
        .starts_with("Opening")
    {
        "OP"
    } else {
        "ED"
    };
    let cached = music::list()?;
    let t = prepare(
        cached.as_array().unwrap(),
        &song,
        song["audio"].as_str().ok_or("Источник")?,
        kind,
        level_of(score),
        verified,
        2,
    )
    .ok_or("Не удалось скачать или преобразовать видео выбранного трека")?;
    music::set_offset(t["id"].as_str().ok_or("ID")?, offset)
}

fn anime_name(song: &Value) -> Option<&str> {
    song["animeENName"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| song["animeJPName"].as_str())
}

static DOWNLOADS: Mutex<()> = Mutex::new(());

fn catalog(kind: &str, n: usize, start: u64, end: u64) -> Result<Vec<Value>> {
    let query = json!({
        "n": n,
        "filters": {
            "song_types": [if kind == "OP" {"opening"} else {"ending"}],
            "difficulty": {"start": start, "end": end},
            "media_links": {"require_all": ["audio"]}
        }
    });
    let mut request = cmd("curl.exe")
        .args([
            "-q",
            "-fsS",
            "--proto",
            "=https",
            "--max-time",
            "20",
            "--max-filesize",
            "4000000",
            "-H",
            "Content-Type: application/json",
            "--data-binary",
            "@-",
            "https://anisongdb.com/api/get_n_random_songs",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Для подключения AnisongDB нужен системный curl.exe")?;
    let written = request
        .stdin
        .take()
        .unwrap()
        .write_all(query.to_string().as_bytes());
    let response = request.wait_with_output().map_err(|e| e.to_string())?;
    if written.is_err() || !response.status.success() {
        return Err(
            "Каталог AnisongDB недоступен. Проверьте подключение и повторите сборку.".into(),
        );
    }
    serde_json::from_slice(&response.stdout)
        .map_err(|_| "Не удалось прочитать каталог AnisongDB".into())
}

fn prepare(
    cached: &[Value],
    song: &Value,
    file: &str,
    kind: &str,
    level: &str,
    verified: Option<f64>,
    clip: u64,
) -> Option<Value> {
    let anime = anime_name(song)?.trim();
    let title = song["songName"].as_str()?.trim();
    let mut track = cached
        .iter()
        .find(|track| {
            track["source"] == "anisongdb"
                && track["sourceFile"] == file
                && track["anime"] == anime
                && track["title"] == title
                && track["kind"] == kind
                && track["durationMs"].as_u64().unwrap_or(0) >= clip * 1000
        })
        .cloned();
    let mut fields = json!({
        "level": level, "artist": song["songArtist"], "version": song["songType"],
        "annId": song["annId"], "catalogDifficulty": song["songDifficulty"],
        "amqDifficulty": verified.map_or_else(|| song["songDifficulty"].clone(), |v| json!(v)),
        "verified": verified.is_some(), "checkedAt": now()
    });
    if let Some(existing) = &track {
        if !existing["videoFile"].is_string() {
            fields["videoFile"] =
                json!(music::attach_video(existing, &download_video(song)?).ok()?);
        }
        track = Some(music::update(existing["id"].as_str()?, &fields).ok()?);
    } else {
        let bytes = download_video(song)?;
        for (key, value) in json!({"anime": anime, "title": title, "kind": kind, "offset": 0,
            "source": "anisongdb", "sourceFile": file})
        .as_object()?
        {
            fields[key] = value.clone();
        }
        track = music::store_media(&mut bytes.as_slice(), bytes.len(), fields, true).ok();
    }
    let mut track = track?;
    let max_start = (track["durationMs"].as_u64()? / 1000).checked_sub(clip)?;
    let earliest = max_start / 5;
    let latest = max_start * 4 / 5;
    let seed = track["id"]
        .as_str()?
        .parse::<u64>()
        .ok()?
        .wrapping_mul(7919)
        ^ now();
    track["offset"] = json!(earliest + seed % (latest - earliest + 1));
    Some(track)
}

fn score_key(ann: &Value, title: &Value, artist: &Value, version: &Value) -> Option<String> {
    Some(
        json!([
            ann.as_u64()?,
            title.as_str()?.trim().to_lowercase(),
            artist.as_str()?.trim().to_lowercase(),
            version.as_str()?.trim().to_lowercase()
        ])
        .to_string(),
    )
}

fn level_of(score: f64) -> &'static str {
    if score >= 70.0 {
        "easy"
    } else if score >= 40.0 {
        "medium"
    } else {
        "hard"
    }
}

fn score_file() -> std::path::PathBuf {
    super::base().join("tracks").join("amq-scores.json")
}

fn scores() -> Result<Value> {
    match std::fs::read(score_file()) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e.to_string()),
    }
}

pub fn import_scores(rows: &Value) -> Result<Value> {
    let _guard = DOWNLOADS.try_lock().map_err(|_| "Подбор уже выполняется")?;
    let mut index = scores()?;
    let rows = rows.as_array().ok_or("Выберите JSON из AMQ Song List UI")?;
    let mut imported = 0;
    for row in rows {
        let Some(key) = score_key(&row["annId"], &row["name"], &row["artist"], &row["type"]) else {
            continue;
        };
        let Some(score) = row["difficulty"]
            .as_f64()
            .or_else(|| row["difficulty"].as_str()?.parse().ok())
            .filter(|s| (0.0..=100.0).contains(s))
        else {
            continue;
        };
        index[key] = json!(score);
        imported += 1;
    }
    if imported == 0 {
        return Err("В файле нет распознанных треков с процентом AMQ".into());
    }
    let tracks = music::list()?;
    let tmp = score_file().with_extension("tmp");
    std::fs::write(&tmp, index.to_string())
        .and_then(|_| std::fs::rename(tmp, score_file()))
        .map_err(|e| e.to_string())?;
    let mut matched = 0;
    for t in tracks.as_array().unwrap() {
        if t["source"] != "anisongdb" {
            continue;
        }
        if let Some(score) = score_key(&t["annId"], &t["title"], &t["artist"], &t["version"])
            .and_then(|k| index[k].as_f64())
        {
            music::update(
                t["id"].as_str().ok_or("ID")?,
                &json!({"level":level_of(score),"amqDifficulty":score,"verified":true,"checkedAt":now()}),
            )?;
            matched += 1;
        }
    }
    Ok(json!({"imported":imported,"matched":matched}))
}

pub fn select(kind: &str, counts: [usize; 3], clip: u64) -> Result<Vec<Value>> {
    if counts == [0; 3] {
        return Ok(Vec::new());
    }
    let _download = DOWNLOADS
        .try_lock()
        .map_err(|_| "Подбор из AnisongDB уже выполняется")?;
    let index = scores()?;
    let cached = music::list()?;
    let cached = cached.as_array().unwrap();
    let mut used_files = HashSet::new();
    let mut result = Vec::new();
    for (i, wanted) in counts.into_iter().enumerate() {
        if wanted == 0 {
            continue;
        }
        let level = LEVELS[i];
        let (start, end) = RANGES[i];
        let songs = catalog(kind, (wanted * 5 + 20).min(500), start, end)?;
        let mut available = songs
            .iter()
            .filter_map(|song| {
                let verified = score_key(
                    &song["annId"],
                    &song["songName"],
                    &song["songArtist"],
                    &song["songType"],
                )
                .and_then(|k| index[k].as_f64());
                let score = verified.or_else(|| song["songDifficulty"].as_f64())?;
                let file = song["audio"].as_str()?;
                let stem = file.strip_suffix(".mp3")?;
                if video_files(song).next().is_none()
                    || !song["songType"].as_str()?.starts_with(if kind == "OP" {
                        "Opening"
                    } else {
                        "Ending"
                    })
                    || score < start as f64
                    || score > end as f64
                    || (i != 0 && score == end as f64)
                    || song["songLength"]
                        .as_f64()
                        .is_some_and(|seconds| seconds < clip as f64)
                    || stem.is_empty()
                    || stem.len() > 48
                    || !stem
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                    || !used_files.insert(file.to_owned())
                {
                    return None;
                }
                Some((song, file, verified))
            })
            .take(wanted + 9);
        let mut ready = 0;
        while ready < wanted {
            let batch: Vec<_> = available.by_ref().take((wanted - ready).min(3)).collect();
            if batch.is_empty() {
                break;
            }
            let prepared = thread::scope(|scope| {
                batch
                    .into_iter()
                    .map(|(song, file, verified)| {
                        scope
                            .spawn(move || prepare(cached, song, file, kind, level, verified, clip))
                    })
                    .collect::<Vec<_>>()
                    .into_iter()
                    .filter_map(|worker| worker.join().ok().flatten())
                    .collect::<Vec<_>>()
            });
            ready += prepared.len();
            result.extend(prepared);
        }
        if ready < wanted {
            let name = ["легко", "средне", "сложно"][i];
            return Err(format!("AnisongDB · {name}: удалось загрузить {ready} из {wanted} треков {kind} с отрывком {clip} с. Повторите сборку или уменьшите число раундов."));
        }
    }
    Ok(result)
}
