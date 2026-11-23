"use strict";
const $ = (id) => document.getElementById(id);
const cats = {
    anime: "ANIME",
    film: "MOVIE",
    tv: "TV SERIES",
    toon: "CARTOON",
  },
  levels = { easy: "Легко", medium: "Средне", hard: "Сложно" };
const defaults = {
  cat: "anime",
  format: "short",
  audience: "casual",
  level: "mix",
  count: 5,
  duration: 45,
  theme: "solar",
};
let state;
try {
  state = JSON.parse(localStorage.getItem("framequiz-v1"));
} catch {}
state = Object.assign(
  { settings: { ...defaults }, plan: [], custom: [], refs: [], title: "" },
  state || {},
);
let coverArt = null;
let cfg = state.settings,
  idx = 0,
  mode = "question",
  timer = 0,
  tick = 0,
  bank = [],
  busy = false;
const save = () => localStorage.setItem("framequiz-v1", JSON.stringify(state));
const fmt = (n) => Math.floor(n / 60) + ":" + String(n % 60).padStart(2, "0");
function toast(s) {
  $("toast").textContent = s;
  $("toast").hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => ($("toast").hidden = true), 4800);
}
const errorMessages = {};
function apiMessage(message) {
  if (Object.hasOwn(errorMessages, message)) return errorMessages[message];
  for (const [template, translation] of Object.entries(errorMessages)) {
    if (!template.includes("{")) continue;
    let rest = message;
    const parts = template.split(/\{\w*\}/);
    if (!rest.startsWith(parts[0])) continue;
    rest = rest.slice(parts[0].length);
    const values = [];
    for (const part of parts.slice(1)) {
      const end = part ? rest.indexOf(part) : rest.length;
      if (end < 0) break;
      const value = rest.slice(0,end);
      values.push(Object.hasOwn(errorMessages,value) ? errorMessages[value] : value);
      rest = rest.slice(end + part.length);
    }
    if (!rest && values.length === parts.length - 1) return translation.replace(/\{\w*\}/g, () => values.shift());
  }
  return message;
}
async function api(path, v, blob = false) {
  let r = await fetch("/api/" + path, {
    method: "POST",
    headers: {
      "X-Quiz-Studio": sessionStorage.getItem("framequiz-session") || "",
      "Content-Type": blob ? "image/jpeg" : "application/json",
    },
    body: blob ? v : JSON.stringify(v),
  });
  if (r.status === 403) throw Error("Откройте студию через меню трея для нового сеанса.");
  let j = await r.json();
  if (j.error) throw Error(apiMessage(j.error));
  return j.data;
}
function slugURL(s) {
  let u = new URL(s);
  if (!["http:", "https:"].includes(u.protocol))
    throw Error("Нужна ссылка http или https");
  return u.href;
}
function run(fn) {
  return async (e) => {
    try {
      await fn(e);
    } catch (err) {
      toast(err.message);
    }
  };
}
function button(id, fn) {
  $(id).onclick = run(fn);
}
function el(tag, txt) {
  let e = document.createElement(tag);
  if (txt != null) e.textContent = txt;
  return e;
}
function roundTime(s) {
  let n = Number(s.count),
    short = s.format === "short";
  if (!Number.isInteger(n) || n < 1 || n > 60) return 0;
  if (short && s.quiz === "music") {
    const seconds = (s.clip || 5) + (s.audience === "fans" ? 3 : 4);
    return n * seconds <= 60 ? seconds : 0;
  }
  let lo = Math.max(4, Math.ceil((short ? 1 : 300) / n)),
    hi = Math.min(60, Math.floor((short ? 60 : 600) / n));
  return lo > hi ? 0 : Math.min(hi, Math.max(lo, Math.round(s.duration / n)));
}
function reveal(s) {
  return Math.min(s.audience === "fans" ? 3 : 4, roundTime(s) - 2);
}
function durationMenu() {
  let short = cfg.format === "short";
  const manualClip = short && isMusic();
  document.querySelector('label[for="duration"]').textContent = manualClip
    ? "Длина отрывка"
    : "Длительность";
  if (manualClip) {
    $("duration").replaceChildren(
      ...[2, 5, 8, 12, 20, 26].map((n) => new Option(n + " с", n)),
    );
    $("duration").value = cfg.clip || 5;
    return;
  }
  $("duration").replaceChildren(
    ...(short ? [30, 45, 60] : [300, 420, 600]).map(
      (n) => new Option(fmt(n), n),
    ),
  );
  $("duration").value = cfg.duration;
}
function settings() {
  musicSettings();
  for (let k of ["cat", "audience", "level", "count", "theme"])
    $(k).value = cfg[k];
  durationMenu();
  document
    .querySelectorAll("[data-format]")
    .forEach((b) =>
      b.classList.toggle("selected", b.dataset.format === cfg.format),
    );
  let d = roundTime(cfg);
  $("summary").textContent = d
    ? cfg.count + (isMusic() ? " тр. · " : " вопр. · ") + fmt(d * cfg.count)
    : "Проверьте число вопросов";
}
function hasDraft() {
  return (
    !state.applied ||
    Object.keys(cfg).some(
      (k) => JSON.stringify(cfg[k]) !== JSON.stringify(state.applied[k]),
    )
  );
}
function mark() {
  settings();
  $("generate").textContent = hasDraft() ? "Собрать план ↗" : "Пересобрать ↗";
  $("export").disabled = hasDraft() || !state.plan.length;
  save();
}
document.querySelectorAll("[data-format]").forEach(
  (b) =>
    (b.onclick = () => {
      cfg.format = b.dataset.format;
      cfg.count = cfg.format === "short" ? 5 : 12;
      cfg.duration = cfg.format === "short" ? 45 : 420;
      mark();
    }),
);
for (let k of ["cat", "audience", "level", "count", "duration", "theme"])
  $(k).onchange = () => {
    if (k === "duration" && isMusic() && cfg.format === "short") {
      cfg.clip = Number($(k).value);
      mark();
      return;
    }
    cfg[k] = ["count", "duration"].includes(k)
      ? Number($(k).value)
      : $(k).value;
    if (k === "theme" && state.applied) {
      state.applied.theme = cfg.theme;
      draw();
    }
    mark();
  };
document.querySelectorAll("[data-tab]").forEach(
  (b) =>
    (b.onclick = () => {
      stop();
      for (let id of ["studio", "library", "trends", "tracks"])
        $(id).hidden = id !== b.dataset.tab;
      document
        .querySelectorAll("[data-tab]")
        .forEach((x) => x.classList.toggle("active", x === b));
      $("audition").pause();
      if (b.dataset.tab === "tracks")
        reloadTracks().catch((e) => toast(e.message));
      if (b.dataset.tab === "library") library();
    }),
);
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    let j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
async function generate() {
  if (!roundTime(cfg))
    throw Error("Измените число вопросов для этой длительности.");
  const editing = cfg;
  const requested = structuredClone(cfg);
  let pool = bank.concat(state.custom);
  let plan = isMusic()
    ? await api("music-plan", {
        quota: requested.quota,
        clip: roundTime(requested) - reveal(requested),
        openingSource: requested.openingSource,
      })
    : await api("plan", { ...requested, pool });
  if (cfg !== editing || JSON.stringify(cfg) !== JSON.stringify(requested)) {
    throw Error("Настройки изменились. Соберите план с новыми параметрами.");
  }
  for (let q of isMusic() ? [] : plan) {
    let others = q.wrong || pool.filter((x) => x.cat === q.cat).map((x) => x.a);
    q.options = shuffle([
      q.a,
      ...shuffle([...new Set(others)].filter((x) => x !== q.a)).slice(0, 2),
    ]);
  }
  stop();
  state.plan = plan;
  state.applied = structuredClone(cfg);
  state.title = isMusic()
    ? "GUESS THE ANIME SONG"
    : "GUESS THE " + cats[cfg.cat];
  idx = 0;
  mode = "question";
  save();
  refresh();
}
function stop() {
  stopRoundAudio();
  clearInterval(timer);
  timer = 0;
  tick = 0;
  $("play").textContent = "▶";
}
function setMode(m) {
  stop();
  mode = m;
  draw();
}
for (let k of ["question", "answer", "cover"]) button(k, () => setMode(k));
button("prev", () => {
  stop();
  idx = Math.max(0, idx - 1);
  draw();
});
button("next", () => {
  stop();
  idx = Math.min(state.plan.length - 1, idx + 1);
  draw();
});
button("play", () => {
  if (timer) {
    stop();
    draw();
    return;
  }
  if (state.applied?.quiz === "music") return playMusicRound();
  mode = "question";
  if (idx === state.plan.length - 1) idx = 0;
  tick = 0;
  draw();
  $("play").textContent = "Ⅱ";
  timer = setInterval(() => {
    tick++;
    let r = roundTime(state.applied);
    if (tick >= r) {
      tick = 0;
      if (idx + 1 === state.plan.length) {
        stop();
        draw();
        return;
      }
      idx++;
    }
    mode = tick >= r - reveal(state.applied) ? "answer" : "question";
    draw();
  }, 1000);
});
const palettes = {
  solar: ["#f5dcaa", "#e86739", "#93402e", "#512f31", "#2f2429"],
  ocean: ["#dee4dc", "#749db6", "#4b7190", "#314861", "#222a40"],
  forest: ["#e9dfbd", "#a2ae6b", "#68896a", "#395e51", "#233d37"],
};
function art(c, w, h, p) {
  c.fillStyle = p[0];
  c.fillRect(0, 0, w, h);
  let seed = 37;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let sx = w * 0.79,
    sy = h * 0.2,
    sr = Math.min(w, h) * 0.16;
  c.fillStyle = p[1];
  c.beginPath();
  c.arc(sx, sy, sr, 0, Math.PI * 2);
  c.fill();
  c.save();
  c.beginPath();
  c.arc(sx, sy, sr, 0, Math.PI * 2);
  c.clip();
  for (let i = 0; i < 6; i++) {
    c.fillStyle = p[0];
    c.fillRect(sx - sr, sy + sr * (i * 0.19), 2 * sr, sr * 0.025 * (i + 1));
  }
  c.restore();
  for (let layer = 0; layer < 3; layer++) {
    c.fillStyle = p[layer + 2];
    c.beginPath();
    let y0 = h * (0.72 + layer * 0.085);
    c.moveTo(0, h);
    for (let i = 0; i <= 90; i++) {
      let x = i / 90;
      let y =
        y0 -
        h *
          (0.08 * Math.sin(x * 11 + layer) +
            0.05 * Math.cos(x * 19 + layer * 3) +
            0.045 * rnd() +
            (1 - x) * 0.07);
      c.lineTo(x * w, y);
    }
    c.lineTo(w, h);
    c.fill();
  }
  for (let i = 0; i < 1250; i++) {
    c.fillStyle = i % 2 ? "#34190912" : "#fff5da27";
    let x = rnd() * w,
      y = rnd() * h;
    c.fillRect(x, y, 1 + rnd() * w * 0.002, 1 + rnd() * h * 0.0015);
  }
  // A small flock above the ridge.
  c.strokeStyle = p[3];
  c.lineWidth = w * 0.002;
  for (let i = 0; i < 5; i++) {
    let x = w * (0.08 + rnd() * 0.21),
      y = h * (0.12 + rnd() * 0.12),
      s = w * (0.006 + rnd() * 0.006);
    c.beginPath();
    c.moveTo(x - s, y - s * 0.3);
    c.quadraticCurveTo(x - s * 0.25, y - s * 0.25, x, y + s * 0.28);
    c.quadraticCurveTo(x + s * 0.3, y - s * 0.3, x + s, y - s * 0.12);
    c.stroke();
  }
}
function fitted(c, text, x, y, maxW, maxH, size, weight, color) {
  let lines = [];
  for (; size >= 8; size -= 2) {
    c.font = weight + " " + size + 'px "Segoe UI", Arial, sans-serif';
    lines = [""];
    for (let word of text.split(/\s+/)) {
      let i = lines.length - 1,
        line = (lines[i] + " " + word).trim();
      if (lines[i] && c.measureText(line).width > maxW) lines.push(word);
      else lines[i] = line;
    }
    if (
      lines.length * size * 1.12 <= maxH &&
      lines.every((l) => c.measureText(l).width <= maxW)
    )
      break;
  }
  c.fillStyle = color;
  c.textAlign = "center";
  c.textBaseline = "middle";
  lines.forEach((l, i) =>
    c.fillText(l, x, y + (i - (lines.length - 1) / 2) * size * 1.12, maxW),
  );
}
function paint(canvas, index, m, isCover = false) {
  let s = state.applied,
    q = state.plan[index];
  if (!s || !q) return;
  let portrait = s.format === "short" && !isCover;
  let w = portrait ? 1080 : 1920,
    h = portrait ? 1920 : 1080;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  let c = canvas.getContext("2d"),
    p = palettes[s.theme];
  art(c, w, h, p);
  if (isCover && coverArt) {
    let z = Math.max(w / coverArt.width, h / coverArt.height);
    c.drawImage(
      coverArt,
      (w - coverArt.width * z) / 2,
      (h - coverArt.height * z) / 2,
      coverArt.width * z,
      coverArt.height * z,
    );
    c.fillStyle = "#f5e2c2bd";
    c.fillRect(0, 0, w, h * 0.67);
    c.fillStyle = "#241d26a0";
    c.fillRect(0, h * 0.67, w, h * 0.33);
  }
  c.fillStyle = p[4];
  c.font = "bold " + (portrait ? 33 : 27) + "px Consolas, monospace";
  c.textAlign = "left";
  c.textBaseline = "middle";
  c.fillText("FRAMEQUIZ  /  " + cats[s.cat], w * 0.06, h * 0.065);
  let label =
    m === "cover"
      ? "QUIZ CHALLENGE"
      : m === "answer"
        ? "ANSWER REVEAL"
        : "QUESTION " +
          String(index + 1).padStart(2, "0") +
          " / " +
          String(state.plan.length).padStart(2, "0");
  let fs = portrait ? 30 : 28;
  c.font = "bold " + fs + "px Consolas, monospace";
  let lw = c.measureText(label).width + 50;
  c.fillStyle = p[3];
  c.fillRect((w - lw) / 2, h * 0.268, lw, fs * 1.8);
  c.textAlign = "center";
  c.fillStyle = "#fff3db";
  c.fillText(label, w * 0.5, h * 0.268 + fs * 0.9);
  const musical = s.quiz === "music";
  const kindName = { OP: "OPENING", ED: "ENDING", OST: "SOUNDTRACK" }[q.kind];
  let text =
    m === "cover"
      ? state.title
      : musical
        ? m === "answer"
          ? q.anime
          : "GUESS THE ANIME"
        : m === "answer"
          ? q.a
          : q.q;
  fitted(
    c,
    text,
    w * 0.5,
    h * 0.451,
    w * 0.85,
    h * 0.217,
    portrait ? 84 : m === "cover" ? 145 : 91,
    850,
    p[4],
  );
  if (musical && m !== "cover") {
    fitted(
      c,
      m === "answer" ? q.title : "LISTEN TO THE " + kindName,
      w * 0.5,
      h * 0.819,
      w * 0.84,
      h * 0.15,
      portrait ? 62 : 58,
      750,
      "#fff1da",
    );
  } else if (m === "question" && s.audience === "casual") {
    let opts = q.options;
    let start = h * 0.745;
    opts.forEach((o, i) => {
      let oh = h * 0.057;
      let yy = start + oh * i * 1.13;
      c.fillStyle = "#251f23ed";
      c.fillRect(w * 0.12, yy, w * 0.76, oh);
      fitted(
        c,
        String.fromCharCode(65 + i) + "   " + o,
        w * 0.5,
        yy + oh * 0.5,
        w * 0.72,
        oh * 0.9,
        portrait ? 38 : 32,
        650,
        "#fff1da",
      );
    });
  } else {
    fitted(
      c,
      m === "answer"
        ? "DID YOU GET IT RIGHT?"
        : m === "cover"
          ? state.plan.length +
            (musical ? " TRACKS" : " QUESTIONS") +
            "   /   ENGLISH EDITION"
          : "WHAT IS YOUR ANSWER?",
      w * 0.5,
      h * 0.846,
      w * 0.8,
      h * 0.09,
      portrait ? 35 : 39,
      700,
      "#ffecd0",
    );
  }
  c.fillStyle = "#f7d9b4";
  c.fillRect(
    w * 0.06,
    h * 0.95,
    (w * 0.88 * (index + 1)) / state.plan.length,
    h * 0.004,
  );
}
function draw() {
  const empty = !state.plan.length;
  $("emptyMusic").hidden = !empty;
  $("frame").hidden = empty;
  const stage = $("frame").parentElement;
  const paired =
    !empty &&
    !timer &&
    mode !== "cover" &&
    state.applied?.format === "short" &&
    stage.clientWidth >= 520;
  stage.classList.toggle("dual", paired);
  $("pairedFrame").hidden = !paired;
  if (paired) {
    const other = mode === "answer" ? "question" : "answer";
    paint($("pairedCanvas"), idx, other);
    $("pairedFrame").lastElementChild.textContent =
      other === "answer" ? "Ответ ↗" : "Вопрос ↗";
    $("pairedFrame").onclick = () => setMode(other);
  }
  for (const id of ["question", "answer", "cover", "play", "prev", "next"])
    $(id).disabled = empty;
  if (empty) {
    $("dimensions").textContent = "";
    $("counter").textContent = "0 / 0";
    $("coverTools").hidden = true;
    return;
  }
  paint($("frame"), idx, mode, mode === "cover");
  let cv = $("frame");
  $("dimensions").textContent = cv.width + " × " + cv.height;
  $("counter").textContent = idx + 1 + " / " + state.plan.length;
  $("coverTools").hidden = mode !== "cover";
  $("coverTitle").value = state.title;
  for (let m of ["question", "answer", "cover"])
    $(m).classList.toggle("selected", mode === m);
}
$("coverTitle").oninput = () => {
  state.title = $("coverTitle").value;
  save();
  draw();
};
button("png", () => {
  let a = el("a");
  a.href = $("frame").toDataURL("image/png");
  a.download = "framequiz-thumbnail.png";
  a.click();
});
function refresh() {
  mark();
  draw();
  $("rounds").replaceChildren();
  let s = state.applied;
  if (!state.plan.length) {
    $("planMeta").textContent = "";
    $("rounds").append(
      el("p", "Здесь появятся треки в порядке воспроизведения."),
    );
    return;
  }
  $("planMeta").textContent =
    state.plan.length +
    (s.quiz === "music" ? " тр. · " : " вопр. · ") +
    fmt(roundTime(s) * state.plan.length);
  state.plan.forEach((q, i) => {
    let row = el("div");
    row.className = "row";
    let num = el("button", String(i + 1).padStart(2, "0"));
    num.className = "num";
    num.onclick = () => {
      idx = i;
      setMode("question");
      $("frame").scrollIntoView({ block: "center", behavior: "smooth" });
    };
    row.append(num);
    for (let k of s.quiz === "music" ? ["anime", "title"] : ["q", "a"]) {
      let inp = el("input");
      inp.value = q[k];
      inp.maxLength = k === "q" ? 240 : 120;
      inp.setAttribute(
        "aria-label",
        { q: "Вопрос ", a: "Ответ ", anime: "Аниме ", title: "Трек " }[k] +
          (i + 1),
      );
      inp.onchange = () => {
        let v = inp.value.trim();
        if (!v) {
          inp.value = q[k];
          return;
        }
        if (k === "a") q.options = q.options.map((o) => (o === q.a ? v : o));
        q[k] = v;
        save();
        draw();
      };
      row.append(inp);
    }
    row.append(el("small", (q.kind ? q.kind + " · " : "") + levels[q.level]));
    if (s.quiz === "music") row.append(roundActions(q, i, s));
    if (s.quiz !== "music" && q.source) {
      let a = el("a", "↗");
      a.href = slugURL(q.source);
      a.target = "_blank";
      a.rel = "noopener";
      a.title = "Источник вопроса";
      row.append(a);
    }
    $("rounds").append(row);
  });
}
button("generate", async () => {
  const control = $("generate");
  const status = $("openingStatus");
  const online = isMusic() && cfg.openingSource === "anisongdb" &&
    [...Object.values(cfg.quota.OP), ...Object.values(cfg.quota.ED)].some(Boolean);
  control.disabled = true;
  status.hidden = !online;
  status.textContent = online ? "AnisongDB · подбор и загрузка OP и ED…" : "";
  try {
    await generate();
    status.hidden = true;
    if (online) await reloadTracks();
  } catch (error) {
    if (online) status.textContent = error.message;
    throw error;
  } finally {
    control.disabled = false;
  }
});
function library() {
  $("stats").textContent =
    "Встроено: " + bank.length + " · Добавлено: " + state.custom.length;
  $("refs").replaceChildren();
  state.refs.forEach((r, i) => {
    let d = el("div");
    d.className = "ref";
    let a = el("a", r.name);
    a.href = r.url;
    a.target = "_blank";
    a.rel = "noopener";
    let b = el("button", "×");
    b.onclick = () => {
      state.refs.splice(i, 1);
      save();
      library();
    };
    d.append(a, b);
    $("refs").append(d);
  });
}
function ref(name, url) {
  url = slugURL(url);
  if (!state.refs.some((r) => r.url === url))
    state.refs.push({ name: name || url, url });
  save();
  library();
}
button("addRef", () => {
  ref($("refName").value, $("refUrl").value);
  $("refName").value = $("refUrl").value = "";
  toast("Ссылка сохранена");
});
button("addQ", () => {
  let q = $("mq").value.trim(),
    a = $("ma").value.trim();
  if (!q || !a) throw Error("Введите вопрос и ответ");
  state.custom.push({
    q,
    a,
    cat: $("manualCat").value,
    level: $("manualLevel").value,
    source: $("ms").value ? slugURL($("ms").value) : "",
  });
  save();
  $("mq").value = $("ma").value = $("ms").value = "";
  library();
  toast("Вопрос добавлен в каталог");
});
button("fetchQ", async () => {
  let b = $("fetchQ");
  b.disabled = true;
  try {
    let cat = $("manualCat").value,
      r = await api("questions", { cat });
    if (r.response_code !== 0)
      throw Error(
        r.response_code === 5
          ? "Лимит Open Trivia DB. Повторите через несколько секунд."
          : "Источник пока не вернул вопросы.",
      );
    let n = 0;
    for (let x of r.results) {
      let q = decodeURIComponent(x.question);
      if (!state.custom.some((y) => y.q === q)) {
        state.custom.push({
          q,
          a: decodeURIComponent(x.correct_answer),
          wrong: x.incorrect_answers.map(decodeURIComponent),
          level: decodeURIComponent(x.difficulty),
          cat,
          source: "https://opentdb.com/",
        });
        n++;
      }
    }
    save();
    library();
    toast("Новых вопросов: " + n);
  } finally {
    b.disabled = false;
  }
});
button("search", async () => {
  let key = $("key").value.trim(),
    genre = $("genre").value.trim();
  if (!key || !genre) throw Error("Введите жанр и ключ YouTube Data API v3");
  let b = $("search");
  b.disabled = true;
  $("results").textContent = "Поиск…";
  try {
    let items = await api("trends", {
      key,
      genre,
      region: $("region").value,
      since: new Date(Date.now() - 30 * 86400000).toISOString(),
    });
    $("results").replaceChildren();
    for (let x of items) {
      let d = el("div");
      d.className = "ref";
      let url =
        "https://www.youtube.com/watch?v=" + encodeURIComponent(x.id.videoId);
      let a = el("a", x.snippet.title);
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener";
      let k = el("button", "В референсы");
      k.onclick = () => {
        ref(x.snippet.title, url);
        toast("Видео сохранено");
      };
      d.append(a, k);
      $("results").append(d);
    }
    if (!items.length) $("results").textContent = "Видео не найдены";
  } catch (e) {
    $("results").textContent = e.message;
  } finally {
    b.disabled = false;
  }
});
async function exportEpisode() {
  if (busy || hasDraft()) return;
  busy = true;
  stop();
  let d = $("dialog"),
    s = state.applied,
    id;
  if (!d.open) d.showModal();
  d.oncancel = (e) => {
    if (busy) e.preventDefault();
  };
  $("openFolder").hidden = $("closeDialog").hidden = $("retryExport").hidden = true;
  $("dTitle").textContent = "Экспорт выпуска";
  try {
    save();
    id = await api("start", {});
    let cv = el("canvas");
    for (let i = 0; i < state.plan.length; i++) {
      for (let j = 0; j < 2; j++) {
        $("dText").textContent =
          "Подготовка кадров · " + (i + 1) + " / " + state.plan.length;
        paint(cv, i, j ? "answer" : "question");
        let blob = await new Promise((r) => cv.toBlob(r, "image/jpeg", 0.92));
        if (!blob) throw Error("Не удалось подготовить кадр.");
        await api("frame/" + id + "/" + (2 * i + j), blob, true);
      }
    }
    $("dText").textContent = "Кодирование видео H.264 и звуковой дорожки AAC…";
    let path = await api("export", {
      id,
      clips:
        s.quiz === "music"
          ? state.plan.map(({ id, offset }) => ({ id, offset }))
          : null,
      count: state.plan.length,
      round: roundTime(s),
      reveal: reveal(s),
    });
    $("dTitle").textContent = "Ролик готов";
    $("dText").textContent = path;
    $("openFolder").hidden = false;
  } catch (e) {
    if (id) await api("cancel", { id }).catch(() => {});
    $("dTitle").textContent = "Ошибка экспорта";
    $("dText").textContent = e.message;
    $("retryExport").hidden = false;
  } finally {
    busy = false;
    $("closeDialog").hidden = false;
  }
}
button("export", exportEpisode);
button("retryExport", exportEpisode);
button("closeDialog", () => $("dialog").close());
button("openFolder", () => api("folder", {}));
if (window.chrome?.webview) {
  $("quit").textContent = "↘";
  $("quit").title = "Свернуть в трей";
  $("quit").setAttribute("aria-label", "Свернуть в трей");
}
button("quit", async () => {
  save();
  if (window.chrome?.webview) {
    window.chrome.webview.postMessage("hide");
    return;
  }
  await api("quit", {});
  document.body.replaceChildren(
    el("main", "Студия закрыта. Окно можно закрыть."),
  );
  window.close();
});
function decodeImage(url) {
  return new Promise((resolve, reject) => {
    let image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(Error("Не удалось открыть изображение"));
    image.src = url;
  });
}
$("coverImage").onchange = run(async () => {
  let file = $("coverImage").files[0];
  if (!file) return;
  let url = URL.createObjectURL(file);
  try {
    let im = await decodeImage(url);
    let cv = el("canvas"),
      scale = Math.min(1, 1200 / Math.max(im.width, im.height));
    cv.width = Math.max(1, Math.round(im.width * scale));
    cv.height = Math.max(1, Math.round(im.height * scale));
    cv.getContext("2d").drawImage(im, 0, 0, cv.width, cv.height);
    state.picture = cv.toDataURL("image/jpeg", 0.8);
    coverArt = await decodeImage(state.picture);
    $("clearImage").hidden = false;
    save();
    draw();
  } finally {
    URL.revokeObjectURL(url);
  }
});
button("clearImage", () => {
  coverArt = null;
  delete state.picture;
  $("coverImage").value = "";
  $("clearImage").hidden = true;
  save();
  draw();
});
button("loadFeed", async () => {
  let url = slugURL($("feedUrl").value),
    cat = $("manualCat").value,
    btn = $("loadFeed"),
    out = $("feedResults");
  btn.disabled = true;
  out.textContent = "Загрузка…";
  try {
    let data = (await api("source", { url })).trim();
    out.replaceChildren();
    if (data.startsWith("[")) {
      let items = JSON.parse(data);
      let fresh = [],
        known = new Set(
          [...bank, ...state.custom].map((q) => q.q.toLowerCase()),
        );
      for (let item of items) {
        let q = String(item.question || "").trim(),
          a = String(item.answer || "").trim();
        if (
          !q ||
          !a ||
          q.length > 240 ||
          a.length > 120 ||
          known.has(q.toLowerCase())
        )
          continue;
        known.add(q.toLowerCase());
        fresh.push({
          cat,
          q,
          a,
          level: Object.hasOwn(levels, item.difficulty)
            ? item.difficulty
            : "medium",
          source: url,
        });
        if (fresh.length >= 200) break;
      }
      state.custom.push(...fresh);
      save();
      library();
      out.textContent = "Добавлено вопросов: " + fresh.length;
      return;
    }
    let xml = new DOMParser().parseFromString(data, "text/xml"),
      items = Array.from(xml.querySelectorAll("item,entry")).slice(0, 20);
    if (!items.length)
      throw Error("По адресу нет RSS, Atom или JSON-массива вопросов.");
    for (let item of items) {
      let title = item.querySelector("title")?.textContent,
        link = item.querySelector('link[rel="alternate"],link');
      if (!title || !link) continue;
      let href;
      try {
        href = slugURL(
          new URL(link.getAttribute("href") || link.textContent, url).href,
        );
      } catch {
        continue;
      }
      let d = el("div");
      d.className = "ref";
      let a = el("a", title);
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener";
      let b = el("button", "Взять за основу");
      b.onclick = () => {
        $("ms").value = href;
        $("mq").focus();
        ref(title, href);
        toast("Источник привязан. Введите вопрос и проверенный ответ.");
      };
      d.append(a, b);
      out.append(d);
    }
  } catch (e) {
    out.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});
$("language").onclick = () => {
  if (busy) return;
  const next = document.documentElement.lang === "ru" ? "en" : "ru";
  save();
  localStorage.setItem("framequiz-language", next);
  location.assign(next === "en" ? "/en" : "/");
};
$("openUpdater").onclick = run(async () => {
  if (busy) throw Error("Дождитесь окончания экспорта.");
  save();
  await api("update-open",{language:document.documentElement.lang});
});
async function refreshUpdateStatus() {
  const states = {
    checking: "Проверяем релизы GitHub…", current: "Установлена последняя версия.",
    downloading: "Скачиваем и проверяем новый релиз…", ready: "Обновление готово. Выйдите через меню трея для установки.",
    auth: "Войдите в GitHub в окне обновления.", signedin: "Вход выполнен. Можно обновлять.",
    cli: "Нажмите «Обновить», чтобы войти в GitHub.", failed: "Обновление отложено. Подробности в update-status.txt.",
    installed: "Обновление установлено.", canceled: "Обновление отменено."
  };
  try {
    const raw = await api("update-status", {});
    const [state, version] = raw.split(" ");
    const message = states[state] || (raw ? states.failed : "Нажмите «Обновить», чтобы проверить релиз.");
    $("updateStatus").textContent = message + (/^v?[0-9]+\.[0-9]+\.[0-9]+$/.test(version || "") ? " (" + version + ")" : "");
    $("updateBadge").title = message;
    $("updateBadge").classList.toggle("updateReady", state === "ready");
  } catch (e) { $("updateStatus").textContent = e.message; }
}
$("updateBadge").onclick = () => {
  $("updatePanel").hidden = !$("updatePanel").hidden;
  $("updateBadge").setAttribute("aria-expanded", String(!$("updatePanel").hidden));
  refreshUpdateStatus();
};
async function init() {
  refreshUpdateStatus();
  setInterval(refreshUpdateStatus, 15000);
  if (state.picture) {
    coverArt = await decodeImage(state.picture);
    $("clearImage").hidden = false;
  }
  bank = await (await fetch("/catalog.json")).json();
  $("manualCat").innerHTML = $("cat").innerHTML;
  $("manualLevel").innerHTML = $("level").innerHTML;
  $("manualLevel").firstElementChild.remove();
  initMusic();
  new ResizeObserver(() => draw()).observe($("frame").parentElement);
  if (!state.plan.length && !isMusic()) await generate();
  else refresh();
  library();
  await reloadTracks();
}
init().catch((e) => toast(e.message));
