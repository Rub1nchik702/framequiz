use super::{base, cmd, music, number, Result};
use crate::ffmpeg::FfmpegOutput;
use serde_json::Value;
use std::{fs, path::Path, process::Stdio};

fn ffmpeg(dir: &Path, args: &[String]) -> Result<()> {
    let out = cmd(base().join("ffmpeg.exe").to_str().ok_or("FFmpeg")?)
        .current_dir(dir)
        .args(["-nostdin", "-y", "-hide_banner", "-loglevel", "error", "-progress", "progress.txt"])
        .args(args)
        .stdout(Stdio::null())
        .limited_output()
        .map_err(|_| "Поместите ffmpeg.exe рядом с программой")?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("FFmpeg: {}", String::from_utf8_lossy(&out.stderr)))
    }
}

fn strings<const N: usize>(items: [&str; N]) -> Vec<String> {
    items.map(String::from).into()
}

/// Smooth countdown bar drawn by ffmpeg: a solid strip that slides left over the still.
struct Bar {
    x: u64,
    y: u64,
    w: u64,
    h: u64,
    color: String,
}

fn bar_of(opts: &Value) -> Option<Bar> {
    let b = opts.get("bar").filter(|b| b.is_object())?;
    let color = b["color"].as_str().filter(|c| c.len() == 7 && c.starts_with('#') && c[1..].bytes().all(|x| x.is_ascii_hexdigit()))?;
    Some(Bar {
        x: number(b, "x", 0, 4000).ok()? / 2 * 2,
        y: number(b, "y", 0, 4000).ok()? / 2 * 2,
        w: number(b, "w", 4, 4000).ok()? / 2 * 2,
        h: number(b, "h", 2, 400).ok()? / 2 * 2,
        color: format!("0x{}", &color[1..]),
    })
}

/// Window for the footage inside the card frame (all values even).
fn window_of(opts: &Value) -> Option<[u64; 4]> {
    let w = opts.get("vwin").filter(|w| w.is_object())?;
    Some([number(w, "x", 0, 4000).ok()?, number(w, "y", 0, 4000).ok()?, number(w, "w", 16, 4000).ok()?, number(w, "h", 16, 4000).ok()?])
}

/// Один эффект как фильтр ffmpeg. Список разрешённых типов задан здесь, из запроса берутся только тип и сила.
fn effect_filter(kind: &str, strength: f64, enable: &str) -> Option<String> {
    let a = strength.abs().clamp(0.0, 1.0);
    let sg = if strength < 0.0 { -1.0 } else { 1.0 };
    let f = match kind {
        "bw" => format!("hue=s={:.2}", 1.0 - a),
        "sepia" => format!(
            "colorchannelmixer=rr={:.3}:rg={:.3}:rb={:.3}:gr={:.3}:gg={:.3}:gb={:.3}:br={:.3}:bg={:.3}:bb={:.3}",
            1.0 - a * 0.607, a * 0.769, a * 0.189, a * 0.349, 1.0 - a * 0.314, a * 0.168, a * 0.272, a * 0.534, 1.0 - a * 0.869
        ),
        "blur" => format!("gblur=sigma={:.1}", 1.0 + a * 14.0),
        "vignette" => format!("vignette=angle={:.2}", 0.25 + a * 0.75),
        "grain" => format!("noise=alls={}:allf=t", (a * 40.0).round() as u32),
        "bright" => format!("eq=brightness={:.2}", sg * a * 0.25),
        "contrast" => format!("eq=contrast={:.2}", 1.0 + sg * a * 0.8),
        "saturate" => format!("eq=saturation={:.2}", (1.0 + sg * a * 1.5).max(0.0)),
        "invert" => "negate".to_string(),
        "chromatic" => format!("rgbashift=rh={}:bh=-{}", (a * 14.0).round() as i32, (a * 14.0).round() as i32),
        "warm" => format!("colorbalance=rs={:.2}:bs=-{:.2}:rm={:.2}:bm=-{:.2}", a * 0.3, a * 0.3, a * 0.15, a * 0.15),
        "cold" => format!("colorbalance=rs=-{:.2}:bs={:.2}:rm=-{:.2}:bm={:.2}", a * 0.3, a * 0.3, a * 0.15, a * 0.15),
        _ => return None,
    };
    // У фильтра без параметров (negate) первый параметр отделяется знаком равно, у остальных двоеточием.
    let sep = if f.contains('=') { ':' } else { '=' };
    Some(if enable.is_empty() { f } else { format!("{f}{sep}enable='{enable}'") })
}

/// Эффекты раунда i (номера в запросе с единицы): каждому своё окно времени внутри раунда.
fn round_effects(opts: &Value, i: usize, guess: u64, reveal: u64, total: u64) -> String {
    let mut out = Vec::new();
    for e in opts["effects"].as_array().into_iter().flatten().take(40) {
        let rounds: Vec<u64> = e["rounds"].as_array().into_iter().flatten().filter_map(Value::as_u64).collect();
        if !rounds.is_empty() && !rounds.contains(&(i as u64 + 1)) {
            continue;
        }
        let (g, r, t) = (guess as f64, (guess + reveal) as f64, total as f64);
        let enable = match e["part"].as_str().unwrap_or("all") {
            "guess" => format!("between(t,0,{g})"),
            "reveal" => format!("between(t,{g},{r})"),
            "video" => format!("between(t,{r},{t})"),
            _ => String::new(),
        };
        let (Some(kind), Some(strength)) = (e["type"].as_str(), e["strength"].as_f64()) else { continue };
        if let Some(f) = effect_filter(kind, strength, &enable) {
            out.push(f);
        }
    }
    out.join(",")
}

/// Шторка между сценами: кадры закрывающего движения лежат в задании, их проигрывают вперёд (шторка уходит)
/// и назад (шторка закрывает). Между ними держится прозрачный кадр. Возвращает имя файла-списка.
struct Wipe {
    first: u64,
    count: u64,
}

fn wipe_of(opts: &Value) -> Option<Wipe> {
    if opts["transition"] != "wipe" {
        return None;
    }
    let w = opts.get("wipe").filter(|w| w.is_object())?;
    Some(Wipe { first: number(w, "first", 0, 100_000).ok()?, count: number(w, "count", 2, 60).ok()? })
}

fn wipe_list(dir: &Path, name: &str, wipe: &Wipe, gfps: u64, total: f64, lead: bool, tail: bool) -> Result<String> {
    let step = 1.0 / gfps as f64;
    let span = wipe.count as f64 * step;
    let mut list = String::new();
    if lead {
        for k in 0..wipe.count {
            list += &format!("file '{}.png'\nduration {step:.4}\n", wipe.first + k);
        }
    }
    let hold = (total - if lead { span } else { 0.0 } - if tail { span } else { 0.0 }).max(0.04);
    let blank = wipe.first + wipe.count - 1;
    list += &format!("file '{blank}.png'\nduration {hold:.4}\n");
    let mut last = blank;
    if tail {
        for k in (0..wipe.count).rev() {
            last = wipe.first + k;
            list += &format!("file '{last}.png'\nduration {step:.4}\n");
        }
    }
    list += &format!("file '{last}.png'\n");
    let file = format!("{name}.txt");
    fs::write(dir.join(&file), list).map_err(|e| e.to_string())?;
    Ok(file)
}

/// Цвет, из которого сцены появляются и в который уходят (строка вида #rrggbb); по умолчанию чёрный.
fn fade_color(opts: &Value) -> String {
    match opts["fcolor"].as_str() {
        Some(c) if c.len() == 7 && c.starts_with('#') && c[1..].bytes().all(|x| x.is_ascii_hexdigit()) => format!("0x{}", &c[1..]),
        _ => "black".to_string(),
    }
}

/// Допустимые переходы xfade между угадыванием и ответом; всё остальное заменяется обычным растворением.
fn xfade_kind(opts: &Value) -> &'static str {
    if opts["transition"] != "wipe" && opts["transition"] != "smooth" {
        return "fade";
    }
    match opts["xtype"].as_str().unwrap_or("fade") {
        "circleopen" => "circleopen",
        "circleclose" => "circleclose",
        "radial" => "radial",
        "diagbr" => "diagbr",
        "diagtl" => "diagtl",
        "smoothleft" => "smoothleft",
        "slideleft" => "slideleft",
        "dissolve" => "dissolve",
        "zoomin" => "zoomin",
        "wipeleft" => "wipeleft",
        "horzopen" => "horzopen",
        "vertopen" => "vertopen",
        _ => "fade",
    }
}

/// A still card (intro / outro) with silence under it. With wipes on, the shape curtain leaves at the start
/// of the outro and closes at the end of the intro.
#[allow(clippy::too_many_arguments)]
fn card(dir: &Path, name: &str, frame: u64, secs: u64, w: u64, h: u64, fade_in: f64, fade_out: f64, color: &str, wipe: Option<String>) -> Result<()> {
    let mut args = strings(["-loop", "1", "-framerate", "24", "-t"]);
    args.extend([secs.to_string(), "-i".into(), format!("{frame}.jpg")]);
    args.extend(strings(["-f", "lavfi", "-t"]));
    args.extend([secs.to_string(), "-i".into(), "anullsrc=r=44100:cl=stereo".into()]);
    // Появление и затухание в чёрный; затухание не длиннее оставшегося времени.
    let fade_out = fade_out.min(secs as f64 - fade_in).max(0.0);
    let mut fades = String::new();
    if fade_in > 0.0 {
        fades += &format!(",fade=t=in:st=0:d={fade_in:.2}:color={color}");
    }
    if fade_out > 0.0 {
        fades += &format!(",fade=t=out:st={:.2}:d={fade_out:.2}:color={color}", secs as f64 - fade_out);
    }
    let base = format!("[0:v]scale={w}:{h},setsar=1,format=yuv420p,fps=24");
    let filter = match &wipe {
        Some(list) => {
            args.extend(["-f".into(), "concat".into(), "-safe".into(), "1".into(), "-i".into(), list.clone()]);
            format!("{base}[b];[2:v]fps=24,format=rgba[wp];[b][wp]overlay=format=auto:eof_action=pass,format=yuv420p{fades}[o]")
        }
        None => format!("{base}{fades}[o]"),
    };
    args.extend(["-filter_complex".to_string(), filter]);
    args.extend(strings(["-map", "[o]", "-map", "1:a", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2", "-t"]));
    args.extend([secs.to_string(), format!("{name}.mp4")]);
    ffmpeg(dir, &args)
}

/// Собирает части в один ролик с настоящими перекрёстными растворениями: конец одной сцены наплывает на начало
/// следующей (видео xfade, звук acrossfade). Ролик из-за наплывов короче суммы частей на d секунд на каждый стык.
fn crossfade_all(dir: &Path, segs: &[(String, f64)], d: f64, out: &Path) -> Result<()> {
    let shortest = segs.iter().map(|s| s.1).fold(f64::MAX, f64::min);
    let d = d.min(shortest * 0.9).max(0.1);
    let mut args: Vec<String> = Vec::new();
    for (file, _) in segs {
        args.extend(["-i".into(), file.clone()]);
    }
    let mut filter = String::new();
    for k in 0..segs.len() {
        filter += &format!("[{k}:v]settb=AVTB,fps=24,format=yuv420p,setsar=1[v{k}];[{k}:a]aresample=44100,aformat=channel_layouts=stereo[a{k}];");
    }
    let (mut vl, mut al, mut len) = ("v0".to_string(), "a0".to_string(), segs[0].1);
    for k in 1..segs.len() {
        let (nv, na) = (format!("x{k}"), format!("c{k}"));
        filter += &format!("[{vl}][v{k}]xfade=transition=fade:duration={d:.2}:offset={:.2}[{nv}];", len - d);
        filter += &format!("[{al}][a{k}]acrossfade=d={d:.2}:c1=tri:c2=tri[{na}];");
        len += segs[k].1 - d;
        (vl, al) = (nv, na);
    }
    let filter = filter.trim_end_matches(';').to_string();
    args.extend(["-filter_complex".to_string(), filter, "-map".into(), format!("[{vl}]"), "-map".into(), format!("[{al}]")]);
    args.extend(strings(["-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2", "-movflags", "+faststart", "-f", "mp4"]));
    args.push(out.to_string_lossy().into());
    ffmpeg(dir, &args)
}

/// Round = guess screen (countdown, smooth bar) with its own song moment, then the answer scene: a framed player
/// with the MP4 from the peak moment, the cover card above it and captions. Guess screen rises from the bottom
/// together with its background and turns into the answer with an animated transition. Intro / outro cards go
/// around the rounds. Each part is encoded on its own; with smooth fades they are joined by real crossfades,
/// otherwise without re-encoding.
pub fn timeline(dir: &Path, rounds: &[Value], opts: &Value, width: u64, height: u64, out: &Path) -> Result<()> {
    let mut segs: Vec<(String, f64)> = Vec::new();
    let mut done = 0u64;
    let bar = bar_of(opts);
    let window = window_of(opts);
    let transition = opts["transition"].as_str().unwrap_or(if opts["flash"] == true { "flash" } else { "none" });
    let (flash, smooth) = (transition == "flash", transition == "smooth");
    let fade_s = opts["fade"].as_f64().unwrap_or(0.8).clamp(0.3, 2.0);
    let gfps = number(opts, "gfps", 1, 16).unwrap_or(1);
    let wipe = wipe_of(opts);
    let xkind = xfade_kind(opts);
    let fcolor = fade_color(opts);
    let extra = |key: &str, name: &str, segs: &mut Vec<(String, f64)>, done: &mut u64| -> Result<()> {
        if let Some(c) = opts.get(key).filter(|c| c.is_object()) {
            let secs = number(c, "secs", 1, 30)?;
            // Интро появляется из цвета стиля, аутро затухает в него дольше остальных; стыки в плавном режиме — наплывы.
            let (fin, fout) = match (key, transition) {
                ("outro", "wipe") => (0.0, (fade_s * 1.5).max(1.2)),
                ("outro", "smooth") => (0.0, (fade_s * 1.5).max(1.2)),
                ("outro", _) => (fade_s.max(0.8), (fade_s * 1.5).max(1.2)),
                ("intro", "smooth") => (fade_s.min(1.0), 0.0),
                (_, "none" | "wipe") => (0.0, 0.0),
                _ => (fade_s, fade_s),
            };
            let list = match &wipe {
                Some(wp) => Some(wipe_list(dir, &format!("wipe_{name}"), wp, gfps, secs as f64, key == "outro", key == "intro")?),
                None => None,
            };
            card(dir, name, number(c, "frame", 0, 100_000)?, secs, width, height, fin, fout, &fcolor, list)?;
            *done += secs;
            fs::write(dir.join("done.txt"), done.to_string()).map_err(|e| e.to_string())?;
            segs.push((format!("{name}.mp4"), secs as f64));
        }
        Ok(())
    };
    extra("intro", "intro", &mut segs, &mut done)?;
    for (i, r) in rounds.iter().enumerate() {
        let guess = number(r, "guess", 3, 20)?;
        let reveal = number(r, "reveal", 1, 10)?;
        let video = number(r, "video", 2, 40)?;
        let offset = number(r, "offset", 0, 3600)?;
        // Звук вопроса и ответа — два разных момента одной песни: вопрос с goff, ответ с пика.
        let peak = number(r, "peak", 0, 3600).unwrap_or(offset + guess + reveal);
        let goff = number(r, "goff", 0, 3600).unwrap_or(offset);
        let (first, cover) = (number(r, "frameQ", 0, 100_000)?, number(r, "frameC", 0, 100_000)?);
        let total = guess + reveal + video;
        let ans_secs = reveal + video;
        let media = music::media(r["id"].as_str().ok_or("Не выбран трек")?)?;
        if (peak + ans_secs) * 1000 > media.duration_ms || (goff + guess + 1) * 1000 > media.duration_ms {
            return Err("Раунд выходит за пределы трека. Сократите его или сдвиньте момент.".into());
        }
        let clip = media.video.as_ref().map(|p| p.to_string_lossy().into_owned());
        let mut list = String::new();
        for k in 0..guess * gfps {
            list += &format!("file '{}.jpg'\nduration {:.4}\n", first + k, 1.0 / gfps as f64);
        }
        list += &format!("file '{}.jpg'\n", first + guess * gfps - 1);
        fs::write(dir.join(format!("round{i}.txt")), list).map_err(|e| e.to_string())?;

        let (w, h) = (width, height);
        // Кадры угадывания идут с частотой gfps; недостающие до 24 фильтр смешивает, и движение выходит плавным.
        let pre = if gfps > 1 { format!("fps={gfps},framerate=fps=24,") } else { String::new() };
        let mut args = strings(["-f", "concat", "-safe", "1", "-i"]);
        args.push(format!("round{i}.txt"));
        let mut next_input = 1;
        // Угадывание перетекает в ответ анимированным переходом, а не склеивается резко.
        let xf1 = if transition == "none" { 0.04 } else if wipe.is_some() { 0.9 } else { fade_s.clamp(0.3, 0.7) };
        let fade = if flash { ",fade=t=in:st=0:d=0.3:color=white" } else { "" };
        let mut chain;
        if let Some(b) = &bar {
            args.extend(["-f".into(), "lavfi".into(), "-i".into(), format!("color=c={}:s={}x{}:d={guess}:r=24", b.color, b.w, b.h)]);
            // ffmpeg не умеет менять ширину кадра внутри overlay, поэтому полосу сдвигают влево по времени,
            // а часть, выехавшую за левый край дорожки, закрывает кусок исходного кадра.
            chain = format!(
                "[0:v]{pre}fps=24,scale={w}:{h},setsar=1,format=yuv420p,settb=AVTB{fade},split[s0][ref];\
                 [ref]crop={bx}:{bh}:0:{by}[cov];\
                 [s0][{next_input}:v]overlay=x='{bx}-{bw}*t/{guess}':y={by}:eof_action=pass[o1];\
                 [o1][cov]overlay=x=0:y={by}[g];",
                bw = b.w, bh = b.h, bx = b.x, by = b.y
            );
            next_input += 1;
        } else {
            chain = format!("[0:v]{pre}fps=24,scale={w}:{h},setsar=1,format=yuv420p,settb=AVTB{fade}[g];");
        }
        // Экран с таймером выезжает снизу вверх вместе с фоном и проявляется: основа цвета стиля, поверх едущий кадр.
        args.extend(["-f".into(), "lavfi".into(), "-i".into(), format!("color=c={fcolor}:s={w}x{h}:r=24:d={guess}")]);
        let base = next_input;
        next_input += 1;
        let travel = (h as f64 * 0.10).round() as u64;
        chain += &format!(
            "[g]format=yuva420p,fade=t=in:st=0:d=0.5:alpha=1[gs];[{base}:v]format=yuv420p,settb=AVTB[cb];\
             [cb][gs]overlay=x=0:y='{travel}*pow(max(0,1-t/0.9),3)':eof_action=pass:format=auto,format=yuv420p,settb=AVTB[g2];"
        );
        // Сцена ответа начинается под конец угадывания (на длину перехода) и идёт до конца раунда.
        let ans_len = ans_secs as f64 + xf1;
        let cn = number(r, "cn", 1, 5000).unwrap_or(1).max(1);
        let mut cl = String::new();
        for k in 0..cn {
            cl += &format!("file '{}.jpg'\nduration {:.4}\n", cover + k, 1.0 / gfps as f64);
        }
        cl += &format!("file '{}.jpg'\n", cover + cn - 1);
        fs::write(dir.join(format!("cover{i}.txt")), cl).map_err(|e| e.to_string())?;
        args.extend(["-f".into(), "concat".into(), "-safe".into(), "1".into(), "-i".into(), format!("cover{i}.txt")]);
        let bg = next_input;
        next_input += 1;
        chain += &format!(
            "[{bg}:v]{pre}fps=24,scale={w}:{h},setsar=1,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration={ans_len:.2}[bgv];"
        );
        let framed = window.zip(r.get("frameM").and_then(Value::as_u64));
        match (&clip, framed) {
            (Some(clip), Some(([wx, wy, ww, wh], mask))) => {
                // Видео идёт с пикового момента: к концу перехода (через xf1 от начала сцены) оно как раз на нём.
                let start = (peak as f64 - xf1).max(0.0);
                let span = format!("{ans_len:.2}");
                let vin = r["vin"].as_f64().unwrap_or(1.1).clamp(0.0, 5.0);
                args.extend(["-loop".into(), "1".into(), "-framerate".into(), "24".into(), "-t".into(), span.clone(), "-i".into(), format!("{mask}.png")]);
                let m = next_input;
                next_input += 1;
                args.extend(["-ss".into(), format!("{start:.2}"), "-t".into(), span.clone(), "-i".into(), clip.clone()]);
                let vid = next_input;
                next_input += 1;
                // Видео в окне со скруглёнными углами (маска) появляется, когда рамка уже на месте.
                chain += &format!(
                    "[{vid}:v]fps=24,scale={ww}:{wh}:force_original_aspect_ratio=decrease,pad={ww}:{wh}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,setpts=PTS-STARTPTS[win0];\
                     [{m}:v]scale={ww}:{wh},format=gray,setpts=PTS-STARTPTS[msk];\
                     [win0][msk]alphamerge,format=yuva420p,fade=t=in:st={vin:.2}:d=0.5:alpha=1[win];\
                     [bgv][win]overlay=x={wx}:y={wy}:shortest=1:format=auto[v1];"
                );
                if let Some(label) = r.get("frameL").and_then(Value::as_u64) {
                    args.extend(["-loop".into(), "1".into(), "-framerate".into(), "24".into(), "-t".into(), span, "-i".into(), format!("{label}.png")]);
                    chain += &format!(
                        "[{next_input}:v]format=rgba,fade=t=in:st={:.2}:d=0.5:alpha=1[lab];[v1][lab]overlay=format=auto:shortest=1[v2];[v2]format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[ans];",
                        vin + 0.3
                    );
                    next_input += 1;
                } else {
                    chain += "[v1]format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[ans];";
                }
            }
            _ => chain += "[bgv]null[ans];",
        }
        let filter = format!("{chain}[g2][ans]xfade=transition={xkind}:duration={xf1:.2}:offset={:.2}[out]", guess as f64 - xf1);
        // Звук: вопрос с одного момента песни, ответ с пика; на стыке короткое перекрытие, чтобы не щёлкало.
        let ax = 0.4;
        args.extend(["-ss".into(), goff.to_string(), "-t".into(), format!("{:.2}", guess as f64 + ax), "-i".into(), media.flac.to_string_lossy().into()]);
        let a1 = next_input;
        next_input += 1;
        args.extend(["-ss".into(), peak.to_string(), "-t".into(), ans_secs.to_string(), "-i".into(), media.flac.to_string_lossy().into()]);
        let a2 = next_input;
        let audio = format!("[{a1}:a][{a2}:a]acrossfade=d={ax:.2}:c1=tri:c2=tri[aout]");
        // Эффекты идут до шторок.
        let fx = round_effects(opts, i, guess, reveal, total);
        let (mut filter, mut last) = if fx.is_empty() { (filter, "[out]") } else { (format!("{filter};[out]{fx}[outx]"), "[outx]") };
        // Шторки закрывают начало и конец раунда: вход из предыдущей сцены и уход в следующую.
        if let Some(wp) = &wipe {
            let file = wipe_list(dir, &format!("wipe_r{i}"), wp, gfps, total as f64, true, true)?;
            args.extend(["-f".into(), "concat".into(), "-safe".into(), "1".into(), "-i".into(), file]);
            let wi = a2 + 1;
            filter += &format!(";[{wi}:v]fps=24,format=rgba[wp];{last}[wp]overlay=format=auto:eof_action=pass,format=yuv420p[outw]");
            last = "[outw]";
        }
        filter += &format!(";{audio}");
        args.extend(["-filter_complex".to_string(), filter, "-map".into(), last.into(), "-map".into(), "[aout]".into()]);
        args.extend(strings(["-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2", "-t"]));
        args.push(total.to_string());
        args.push(format!("round{i}.mp4"));
        ffmpeg(dir, &args)?;
        done += total;
        fs::write(dir.join("done.txt"), done.to_string()).map_err(|e| e.to_string())?;
        segs.push((format!("round{i}.mp4"), total as f64));
    }
    extra("outro", "outro", &mut segs, &mut done)?;
    if smooth && segs.len() > 1 {
        return crossfade_all(dir, &segs, fade_s.max(0.5), out);
    }
    let list: String = segs.iter().map(|s| format!("file '{}'\n", s.0)).collect();
    fs::write(dir.join("all.txt"), list).map_err(|e| e.to_string())?;
    let mut args = strings(["-f", "concat", "-safe", "1", "-i", "all.txt", "-c", "copy", "-movflags", "+faststart", "-f", "mp4"]);
    args.push(out.to_string_lossy().into());
    ffmpeg(dir, &args)
}
