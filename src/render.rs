use super::{base, cmd, music, number, Result};
use crate::ffmpeg::FfmpegOutput;
use serde_json::Value;
use std::{fs, path::Path, process::Stdio};

/// Overlap where the cover still dissolves into the video.
const FADE: f64 = 0.6;

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

/// A still card (intro / outro) with silence under it.
fn card(dir: &Path, name: &str, frame: u64, secs: u64, w: u64, h: u64) -> Result<()> {
    let mut args = strings(["-loop", "1", "-framerate", "24", "-t"]);
    args.extend([secs.to_string(), "-i".into(), format!("{frame}.jpg")]);
    args.extend(strings(["-f", "lavfi", "-t"]));
    args.extend([secs.to_string(), "-i".into(), "anullsrc=r=44100:cl=stereo".into()]);
    args.extend(["-vf".to_string(), format!("scale={w}:{h},setsar=1,format=yuv420p,fps=24")]);
    args.extend(strings(["-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2", "-t"]));
    args.extend([secs.to_string(), format!("{name}.mp4")]);
    ffmpeg(dir, &args)
}

/// Round = guess stills (countdown, smooth bar) + cover still, then a dissolve into the MP4 from the peak
/// moment (inside a framed window when the card style is on). Audio is the song, continuous across the round.
/// Intro / outro cards go around the rounds. Each part is encoded on its own and joined without re-encoding.
pub fn timeline(dir: &Path, rounds: &[Value], opts: &Value, width: u64, height: u64, out: &Path) -> Result<()> {
    let mut parts = String::new();
    let mut done = 0u64;
    let bar = bar_of(opts);
    let window = window_of(opts);
    let flash = opts["flash"] == true;
    let gfps = number(opts, "gfps", 1, 8).unwrap_or(1);
    let extra = |key: &str, name: &str, parts: &mut String, done: &mut u64| -> Result<()> {
        if let Some(c) = opts.get(key).filter(|c| c.is_object()) {
            let secs = number(c, "secs", 1, 30)?;
            card(dir, name, number(c, "frame", 0, 100_000)?, secs, width, height)?;
            *done += secs;
            fs::write(dir.join("done.txt"), done.to_string()).map_err(|e| e.to_string())?;
            *parts += &format!("file '{name}.mp4'\n");
        }
        Ok(())
    };
    extra("intro", "intro", &mut parts, &mut done)?;
    for (i, r) in rounds.iter().enumerate() {
        let guess = number(r, "guess", 3, 20)?;
        let reveal = number(r, "reveal", 1, 10)?;
        let video = number(r, "video", 2, 40)?;
        let offset = number(r, "offset", 0, 3600)?;
        let (first, cover) = (number(r, "frameQ", 0, 100_000)?, number(r, "frameC", 0, 100_000)?);
        let total = guess + reveal + video;
        let media = music::media(r["id"].as_str().ok_or("Не выбран трек")?)?;
        if (offset + total) * 1000 > media.duration_ms {
            return Err("Раунд выходит за пределы трека. Сократите его или сдвиньте момент.".into());
        }
        let clip = media.video.as_ref().map(|p| p.to_string_lossy().into_owned());
        let mut list = String::new();
        for k in 0..guess * gfps {
            list += &format!("file '{}.jpg'\nduration {:.4}\n", first + k, 1.0 / gfps as f64);
        }
        // Without a video file the cover simply stays on screen.
        let hold = if clip.is_some() { reveal } else { reveal + video };
        list += &format!("file '{cover}.jpg'\nduration {hold}\nfile '{cover}.jpg'\n");
        fs::write(dir.join(format!("round{i}.txt")), list).map_err(|e| e.to_string())?;

        let (w, h) = (width, height);
        let mut args = strings(["-f", "concat", "-safe", "1", "-i"]);
        args.push(format!("round{i}.txt"));
        let mut next_input = 1;
        let fade = if flash { ",fade=t=in:st=0:d=0.3:color=white" } else { "" };
        let base_filter;
        if let Some(b) = &bar {
            args.extend(["-f".into(), "lavfi".into(), "-i".into(), format!("color=c={}:s={}x{}:d={guess}:r=24", b.color, b.w, b.h)]);
            // ffmpeg не умеет менять ширину кадра внутри overlay, поэтому полосу сдвигают влево по времени,
            // а часть, выехавшую за левый край дорожки, закрывает кусок исходного кадра.
            base_filter = format!(
                "[0:v]fps=24,scale={w}:{h},setsar=1,format=yuv420p,settb=AVTB{fade},split[s0][ref];\
                 [ref]crop={bx}:{bh}:0:{by}[cov];\
                 [s0][{next_input}:v]overlay=x='{bx}-{bw}*t/{guess}':y={by}:eof_action=pass[o1];\
                 [o1][cov]overlay=x=0:y={by}[s];",
                bw = b.w, bh = b.h, bx = b.x, by = b.y
            );
            next_input += 1;
        } else {
            base_filter = format!("[0:v]fps=24,scale={w}:{h},setsar=1,format=yuv420p,settb=AVTB{fade}[s];");
        }
        let filter;
        if let Some(clip) = &clip {
            let start = (offset + guess + reveal) as f64 - FADE;
            let span = format!("{:.2}", video as f64 + FADE);
            let framed = window.zip(r.get("frameV").and_then(Value::as_u64));
            if let Some(([wx, wy, ww, wh], frame_v)) = framed {
                // Видео внутри белой рамки: фон с рамкой, видео в окне, поверх прозрачный слой с подписью.
                args.extend(["-loop".into(), "1".into(), "-framerate".into(), "24".into(), "-t".into(), span.clone(), "-i".into(), format!("{frame_v}.jpg")]);
                let bg = next_input;
                next_input += 1;
                args.extend(["-ss".into(), format!("{start:.2}"), "-t".into(), span.clone(), "-i".into(), clip.clone()]);
                let vid = next_input;
                next_input += 1;
                let mut chain = format!(
                    "[{bg}:v]fps=24,scale={w}:{h},setsar=1,format=yuv420p[bgv];\
                     [{vid}:v]fps=24,scale={ww}:{wh}:force_original_aspect_ratio=decrease,pad={ww}:{wh}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,setpts=PTS-STARTPTS[win];\
                     [bgv][win]overlay=x={wx}:y={wy}:shortest=1[v1];"
                );
                if let Some(label) = r.get("frameL").and_then(Value::as_u64) {
                    args.extend(["-loop".into(), "1".into(), "-framerate".into(), "24".into(), "-t".into(), span.clone(), "-i".into(), format!("{label}.png")]);
                    chain += &format!("[{next_input}:v]format=rgba[lab];[v1][lab]overlay=format=auto:shortest=1[v2];[v2]format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[v];");
                    next_input += 1;
                } else {
                    chain += "[v1]settb=AVTB,setpts=PTS-STARTPTS[v];";
                }
                filter = format!("{base_filter}{chain}[s][v]xfade=transition=fade:duration={FADE}:offset={:.2}[out]", (guess + reveal) as f64 - FADE);
            } else {
                args.extend(["-ss".into(), format!("{start:.2}"), "-t".into(), span, "-i".into(), clip.clone()]);
                filter = format!(
                    "{base_filter}[{next_input}:v]fps=24,scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,\
                     setsar=1,format=yuv420p,setpts=PTS-STARTPTS,settb=AVTB[v];\
                     [s][v]xfade=transition=fade:duration={FADE}:offset={:.2}[out]",
                    (guess + reveal) as f64 - FADE
                );
                next_input += 1;
            }
        } else {
            filter = format!("{base_filter}[s]null[out]");
        }
        args.extend(["-ss".into(), offset.to_string(), "-t".into(), total.to_string(), "-i".into(), media.flac.to_string_lossy().into()]);
        args.extend(["-filter_complex".to_string(), filter, "-map".into(), "[out]".into(), "-map".into(), format!("{next_input}:a")]);
        args.extend(strings(["-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2", "-t"]));
        args.push(total.to_string());
        args.push(format!("round{i}.mp4"));
        ffmpeg(dir, &args)?;
        done += total;
        fs::write(dir.join("done.txt"), done.to_string()).map_err(|e| e.to_string())?;
        parts += &format!("file 'round{i}.mp4'\n");
    }
    extra("outro", "outro", &mut parts, &mut done)?;
    fs::write(dir.join("all.txt"), parts).map_err(|e| e.to_string())?;
    let mut args = strings(["-f", "concat", "-safe", "1", "-i", "all.txt", "-c", "copy", "-movflags", "+faststart", "-f", "mp4"]);
    args.push(out.to_string_lossy().into());
    ffmpeg(dir, &args)
}
