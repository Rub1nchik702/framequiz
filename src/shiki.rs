use super::{cmd, music, number, Result};
use serde_json::{json, Value};
use std::{io::Write, process::Stdio};

const HOST: &str = "https://shikimori.io";

fn curl(url: &str, max: &str) -> Result<Vec<u8>> {
    let o = cmd("curl.exe")
        .args(["-fsS", "--max-time", "20", "--max-filesize", max, "-A", "Framequiz", url])
        .output()
        .map_err(|_| "curl.exe недоступен")?;
    if !o.status.success() {
        return Err("Shikimori недоступен. Проверьте подключение.".into());
    }
    Ok(o.stdout)
}
fn get(path: &str) -> Result<Value> {
    serde_json::from_slice(&curl(&format!("{HOST}/api/{path}"), "2000000")?)
        .map_err(|_| "Некорректный ответ Shikimori".into())
}
/// POST a JSON body (GraphQL) and return the parsed reply.
fn post(url: &str, body: &Value) -> Result<Value> {
    let mut child = cmd("curl.exe")
        .args(["-fsS", "--max-time", "25", "--max-filesize", "3000000", "-A", "Framequiz", "-H", "Content-Type: application/json", "--data-binary", "@-", url])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "curl.exe недоступен")?;
    let written = child.stdin.take().unwrap().write_all(body.to_string().as_bytes());
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if written.is_err() || !out.status.success() {
        return Err("Сервис каталога недоступен. Проверьте подключение.".into());
    }
    serde_json::from_slice(&out.stdout).map_err(|_| "Некорректный ответ сервиса".into())
}
fn gql(query: &str) -> Result<Value> {
    post(&format!("{HOST}/api/graphql"), &json!({ "query": query }))
}

pub fn genres() -> Result<Value> {
    let all = get("genres")?;
    let rows: Vec<Value> = all
        .as_array()
        .ok_or("Ответ Shikimori")?
        .iter()
        .filter(|g| g["entry_type"] == "Anime" && g["kind"] == "genre")
        .map(|g| json!({"id": g["id"], "name": g["name"], "russian": g["russian"]}))
        .collect();
    Ok(json!(rows))
}

/// A one-hour OVA/ONA is a film; a multi-episode 20–30 minute OVA/ONA behaves like a TV series.
fn is_movie(a: &Value) -> bool {
    match a["kind"].as_str().unwrap_or("") {
        "movie" => true,
        "ova" | "ona" | "special" => a["duration"].as_f64().unwrap_or(0.0) >= 40.0 && a["episodes"].as_u64().unwrap_or(1) <= 3,
        _ => false,
    }
}

fn page_query(v: &Value, page: u64, kinds: &str) -> Result<String> {
    let order = if v["order"] == "ranked" { "ranked" } else { "popularity" };
    let mut args = format!("page: {page}, limit: 30, order: {order}, kind: \"{kinds}\"");
    if let Some(g) = v["genre"].as_u64() {
        args += &format!(", genre: \"{g}\"");
    }
    let year = |k: &str| v[k].as_u64().filter(|y| (1950..=2100).contains(y));
    match (year("yearFrom"), year("yearTo")) {
        (Some(a), Some(b)) => args += &format!(", season: \"{a}_{b}\""),
        (Some(a), None) => args += &format!(", season: \"{a}_2100\""),
        (None, Some(b)) => args += &format!(", season: \"1950_{b}\""),
        _ => {}
    }
    if let Some(s) = v["query"].as_str().map(str::trim).filter(|s| !s.is_empty() && s.chars().count() <= 100) {
        args += &format!(", search: {}", serde_json::to_string(s).map_err(|e| e.to_string())?);
    }
    if let Some(level) = v["level"].as_str().filter(|l| !l.is_empty()) {
        let ids = super::anisong::level_ids(level, v["refresh"] == true)?;
        if ids.is_empty() {
            return Err("EMPTY".into());
        }
        args += &format!(", ids: \"{}\"", ids.iter().map(u64::to_string).collect::<Vec<_>>().join(","));
    }
    Ok(format!(
        "{{ animes({args}) {{ id name russian kind episodes duration score airedOn {{ year }} poster {{ previewUrl }} }} }}"
    ))
}

/// Catalog list: popularity or rating order, genre, years, title, AMQ difficulty and type (series / film).
/// Returns `{rows, next}`: `next` is the page to request for more, or null at the end.
pub fn list(v: &Value) -> Result<Value> {
    let mut page = number(v, "page", 1, 100)?;
    let kind_filter = v["type"].as_str().filter(|t| matches!(*t, "movie" | "series"));
    let kinds = match kind_filter {
        Some("movie") => "movie,ova,ona",
        Some("series") => "tv,ova,ona",
        _ => "tv,movie,ova,ona",
    };
    let mut rows: Vec<Value> = Vec::new();
    let mut next = None;
    // Filtering by length can empty a page, so keep reading a few pages until there is something to show.
    for _ in 0..4 {
        let query = match page_query(v, page, kinds) {
            Ok(q) => q,
            Err(e) if e == "EMPTY" => return Ok(json!({"rows": [], "next": null})),
            Err(e) => return Err(e),
        };
        let data = gql(&query)?;
        let list = data["data"]["animes"].as_array().ok_or("Ответ Shikimori")?;
        let full = list.len() >= 30;
        for a in list {
            if kind_filter.is_some_and(|t| is_movie(a) != (t == "movie")) {
                continue;
            }
            rows.push(json!({"id": a["id"].as_str().and_then(|s| s.parse::<u64>().ok()), "name": a["name"], "russian": a["russian"],
                "score": a["score"], "kind": a["kind"], "episodes": a["episodes"], "duration": a["duration"],
                "year": a["airedOn"]["year"], "cover": a["poster"]["previewUrl"]}));
        }
        next = full.then_some(page + 1);
        if rows.len() >= 10 || !full {
            break;
        }
        page += 1;
    }
    Ok(json!({"rows": rows, "next": next}))
}

pub fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            out.push(if i <= c.len() { T[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

/// Cover URL from AniList by MAL id (used when Shikimori has no poster).
pub fn cover_find(mal_id: u64) -> Result<Value> {
    let body = json!({
        "query": "query($id:Int){Media(idMal:$id,type:ANIME){coverImage{large extraLarge}}}",
        "variables": {"id": mal_id}
    });
    let reply = post("https://graphql.anilist.co", &body)?;
    let image = &reply["data"]["Media"]["coverImage"];
    image["large"]
        .as_str()
        .map(|u| json!({"preview": u, "full": image["extraLarge"].as_str().unwrap_or(u)}))
        .ok_or_else(|| "Обложка не найдена".to_string())
}

fn data_url(bytes: &[u8]) -> String {
    let mime = if bytes.starts_with(b"RIFF") { "image/webp" } else if bytes.starts_with(&[0x89, b'P']) { "image/png" } else { "image/jpeg" };
    format!("data:{mime};base64,{}", base64(bytes))
}

/// Only Shikimori's and AniList's own image hosts are fetched.
fn allowed(url: &str) -> bool {
    (url.starts_with("https://shikimori.io/uploads/") || url.starts_with("https://s4.anilist.co/file/")) && !url.contains("..")
}

/// Saves Shikimori's Russian name, genres, score and cover on a downloaded track.
pub fn attach(track_id: &str, anime_id: u64) -> Result<Value> {
    let data = gql(&format!(
        "{{ animes(ids: \"{anime_id}\", limit: 1) {{ id russian score genres {{ russian name }} poster {{ previewUrl originalUrl }} }} }}"
    ))?;
    let a = data["data"]["animes"].get(0).ok_or("Аниме не найдено")?;
    let genres: Vec<_> = a["genres"]
        .as_array()
        .map(|g| g.iter().filter_map(|x| x["russian"].as_str().or(x["name"].as_str())).collect())
        .unwrap_or_default();
    let mut fields = json!({"shikiId": anime_id, "shikiScore": a["score"], "genres": genres});
    if let Some(ru) = a["russian"].as_str().filter(|s| !s.is_empty()) {
        fields["ru"] = json!(ru);
        fields["ruChecked"] = json!(true);
    }
    let fetch = |url: Option<&str>, max: &str| url.filter(|u| allowed(u)).and_then(|u| curl(u, max).ok());
    let mut small = fetch(a["poster"]["previewUrl"].as_str(), "600000");
    let mut full = fetch(a["poster"]["originalUrl"].as_str(), "3000000");
    if small.is_none() || full.is_none() {
        if let Ok(found) = cover_find(anime_id) {
            small = small.or_else(|| fetch(found["preview"].as_str(), "600000"));
            full = full.or_else(|| fetch(found["full"].as_str(), "3000000"));
        }
    }
    if let Some(bytes) = &small {
        fields["cover"] = json!(data_url(bytes));
    }
    if let Some(bytes) = full.or(small) {
        let _ = music::save_cover(track_id, &bytes); // крупная обложка нужна только для экспорта
    }
    music::update(track_id, &fields)
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    #[test]
    fn base64_matches_reference() {
        assert_eq!(super::base64(b"Man"), "TWFu");
        assert_eq!(super::base64(b"Ma"), "TWE=");
        assert_eq!(super::base64(b"M"), "TQ==");
    }
    #[test]
    fn hour_long_ova_is_a_film_but_episodic_one_is_not() {
        assert!(super::is_movie(&json!({"kind": "movie"})));
        assert!(super::is_movie(&json!({"kind": "ova", "duration": 60.0, "episodes": 1})));
        assert!(!super::is_movie(&json!({"kind": "ova", "duration": 25.0, "episodes": 6})));
        assert!(!super::is_movie(&json!({"kind": "tv", "duration": 24.0, "episodes": 12})));
    }
}
