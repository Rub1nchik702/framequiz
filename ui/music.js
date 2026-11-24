"use strict";
const kinds = { OP: "Опенинги", ED: "Эндинги", OST: "Саундтреки" };
let tracks = [],
  roundAudio = null,
  playVersion = 0;
function newQuota() {
  return Object.fromEntries(
    Object.keys(kinds).map((k) => [
      k,
      { easy: k === "OP" ? 1 : 0, medium: 0, hard: 0 },
    ]),
  );
}
function isMusic() {
  return cfg.quiz === "music";
}
function switchQuiz(music) {
  if (isMusic() === music) return;
  stop();
  state.sessions ??= {};
  state.sessions[isMusic() ? "music" : "text"] = {
    settings: cfg,
    applied: state.applied,
    plan: state.plan,
    title: state.title,
  };
  let next = state.sessions[music ? "music" : "text"] || {
    settings: music
      ? {
          ...defaults,
          quiz: "music",
          quota: newQuota(),
          count: 1,
          duration: 30,
        }
      : { ...defaults },
    plan: [],
    title: "",
    applied: null,
  };
  Object.assign(state, next);
  cfg = state.settings;
  idx = 0;
  mode = "question";
  refresh();
  if (!music && !state.plan.length) generate().catch((e) => toast(e.message));
}
function clipURL(t, seconds) {
  return "/clip/" + t.id + "/" + t.offset + "/" + seconds + "?session=" + (sessionStorage.getItem("framequiz-session") || "");
}
function eligible(t, seconds) {
  return t.durationMs >= (t.offset + seconds) * 1000;
}
function musicSettings() {
  const music = isMusic();
  $("musicConfig").hidden = !music;
  $("catGroup").hidden = music;
  $("level").hidden = document.querySelector('label[for="level"]').hidden =
    music;
  $("count").readOnly = music;
  document.querySelector('label[for="count"]').textContent = music
    ? "Треков в плане"
    : "Вопросы";
  $("musicQuiz").classList.toggle("selected", music);
  $("textQuiz").classList.toggle("selected", !music);
  if (!music) return;
  $("openingSource").value = cfg.openingSource || "local";
  cfg.count = Object.values(cfg.quota).reduce(
    (n, row) => n + Object.values(row).reduce((a, b) => a + b, 0),
    0,
  );
  const r = roundTime(cfg),
    clip = r - reveal(cfg);
  $("clipTiming").textContent = r
    ? "Отрывок " + clip + " с · ответ " + reveal(cfg) + " с"
    : "Выберите количество треков для этого формата";
  for (const input of document.querySelectorAll("#quotas input")) {
    const { kind, level } = input.dataset;
    input.value = cfg.quota[kind][level];
    if (kind !== "OST" && cfg.openingSource === "anisongdb") {
      input.nextElementSibling.textContent = "AnisongDB";
      input.classList.remove("shortage");
      continue;
    }
    const available = tracks.filter(
      (t) => t.kind === kind && t.level === level && eligible(t, clip),
    ).length;
    input.nextElementSibling.textContent = "из " + available;
    input.classList.toggle("shortage", input.value > available);
  }
}
let failedDownloads = [];
async function reloadDownloadFailures() {
  failedDownloads = await api("download-failures", {});
  $("failedTracks").replaceChildren(...failedDownloads.map(track =>
    el("li", [track.anime, track.title, track.version].filter(Boolean).join(" · "))
  ));
  $("failedDownloads").hidden = !failedDownloads.length;
}
async function reloadTracks() {
  tracks = await api("tracks", {});
  await reloadDownloadFailures();
  $("trackCount").textContent = tracks.length + " тр.";
  const list = $("trackList");
  list.replaceChildren();
  if (!tracks.length)
    list.append(
      el("p", "Добавьте первый аудиофайл, чтобы собрать музыкальный выпуск."),
    );
  for (const t of tracks) {
    const row = el("div");
    row.className = "track-card";
    const badge = el("b", t.kind);
    badge.className = "kind";
    const names = el("div");
    names.append(
      el("strong", t.title),
      el("span", t.anime + " · " + levels[t.level] + " · с " + fmt(t.offset) +
        (t.source === "anisongdb" ? " · " + (t.artist ? t.artist + " · " : "") + (t.amqDifficulty ?? "—") + "% · " + (t.verified ? "Сверено по экспорту AMQ" : "По AnisongDB") : "")),
    );
    const ru = el("input");
    ru.className = "ru";
    ru.value = t.ru || "";
    ru.maxLength = 160;
    ru.placeholder = "Русское название";
    ru.setAttribute("aria-label", "Русское название: " + t.title);
    ru.onchange = run(async () => {
      Object.assign(t, await api("track-ru", { id: t.id, ru: ru.value }));
      toast("Русское название сохранено");
    });
    names.append(ru);
    const b = el("button", "▶");
    b.title = "Прослушать отрывок";
    b.onclick = run(async () => {
      const audio = $("audition");
      audio.hidden = false;
      audio.src = clipURL(
        t,
        Math.min(10, Math.floor(t.durationMs / 1000) - t.offset),
      );
      await audio.play();
    });
    const trim = el("button", "Отрывок");
    trim.onclick = run(() => {
      const seconds = Math.min(clipLength(), Math.floor(t.durationMs / 1000));
      return openClip(t, seconds, async (offset) => {
        await api("track-offset", {id: t.id, offset});
        await reloadTracks();
      });
    });
    const actions = el("div");
    actions.className = "track-actions";
    const choose = el("button", "Выбрать");
    choose.onclick = () => selectTrack(t,"library");
    actions.append(trim, b, choose);
    if (t.videoFile) {
      const video = el("button", "Показать MP4");
      video.onclick = run(() => api("video-folder",{id:t.id}));
      actions.append(video);
    }
    row.append(badge, names, actions);
    list.append(row);
  }
  if (isMusic()) settings();
  fillRussian();
}
// Подтягивает русские названия с Shikimori по одному (лимит сервиса ~5 запросов/с).
let fillingRu = false;
async function fillRussian() {
  if (fillingRu) return;
  fillingRu = true;
  try {
    for (const t of tracks.filter((t) => !t.ru && !t.ruChecked)) {
      Object.assign(t, await api("shikimori", { id: t.id }));
      for (const input of document.querySelectorAll("#trackList input.ru"))
        if (input.getAttribute("aria-label") === "Русское название: " + t.title && t.ru) input.value = t.ru;
      await new Promise((r) => setTimeout(r, 400));
    }
  } catch (e) {
    toast("Shikimori: " + e.message);
  } finally {
    fillingRu = false;
  }
}
let selectedTrack = null;
function selectTrack(track, origin) {
  selectedTrack = track ? {track, origin} : null;
  const active = !!track;
  $("trackFile").value = "";
  $("trackFile").required = !active;
  $("trackFile").hidden = document.querySelector('label[for="trackFile"]').hidden = active;
  $("clearPick").hidden = $("selectedSource").hidden = !active;
  $("animeName").readOnly = $("trackTitle").readOnly = $("trackRu").readOnly = active;
  $("trackKind").disabled = $("trackLevel").disabled = active;
  $("animeName").value = track?.anime || "";
  $("trackTitle").value = track?.title || "";
  $("trackRu").value = track?.ru || "";
  $("trackKind").value = track?.kind || "OP";
  $("trackLevel").value = track?.level || "easy";
  $("trackOffset").value = track?.offset || 0;
  $("importStatus").textContent = "";
  $("selectedSource").textContent = active ? [track.version || track.kind, track.amqDifficulty == null ? "Уровень из фонотеки" :
    track.amqDifficulty + "% · " + (track.verified ? "Сверено по экспорту AMQ" : "По AnisongDB")].join(" · ") : "";
  $("importTrack").textContent = !active ? "Добавить в фонотеку" : origin === "catalog" ? "Скачать MP4 и добавить" : "Сохранить начало отрывка";
  if (active) {
    $("uploadForm").scrollIntoView({block:"start"});
    $("trackOffset").focus({preventScroll:true});
  }
}
function initDownloads() {
  $("retryDownloads").onclick = run(async () => {
    const pending = [...failedDownloads];
    const status = $("retryDownloadReport");
    $("retryDownloads").disabled = $("downloadMusic").disabled = true;
    let completed = 0;
    const errors = [];
    try {
      for (const track of pending) {
        status.textContent = "Загрузка " + track.title + "…";
        try {
          await api("download-retry", {id: track.id});
          completed++;
        } catch (error) {
          errors.push(track.title + " — " + error.message);
        }
      }
      await reloadTracks();
      const message = "Скачано повторно: " + completed + " / " + pending.length;
      status.textContent = [message, ...errors].join(" · ");
      toast(message);
    } finally {
      $("retryDownloads").disabled = $("downloadMusic").disabled = false;
    }
  });
  $("clearPick").onclick = () => selectTrack(null);
  $("browseKind").onchange = () => { $("videoChoices").replaceChildren(); $("browseStatus").textContent = ""; };
  $("browseVideos").onclick = run(async () => {
    $("browseVideos").disabled = $("browseKind").disabled = true;
    $("videoChoices").replaceChildren();
    $("browseStatus").textContent = "Загрузка каталога…";
    try {
      const rows = await api("music-catalog",{kind:$("browseKind").value});
      for (const t of rows) {
        const button = el("button", t.anime + " · " + t.version + " · " + t.title + " · " + levels[t.level]);
        button.type = "button";
        button.onclick = () => selectTrack(t,"catalog");
        $("videoChoices").append(button);
      }
      $("browseStatus").textContent = rows.length ? "Выберите песню, чтобы заполнить форму «Добавить трек»." : "Нет видео. Запросите новую подборку.";
    } catch(e) { $("browseStatus").textContent = e.message; }
    finally { $("browseVideos").disabled = $("browseKind").disabled = false; }
  });
  const fields = {};
  for (const kind of ["OP", "ED"]) {
    const row = el("tr");
    row.append(el("th", kind));
    fields[kind] = {};
    for (const level of ["easy", "medium", "hard"]) {
      const input = el("input"), cell = el("td");
      Object.assign(input, {type:"number", min:0, max:60, required:true, value:kind === "OP" && level === "easy" ? 1 : 0});
      input.setAttribute("aria-label", kinds[kind] + " · " + levels[level]);
      fields[kind][level] = input;
      cell.append(input);
      row.append(cell);
    }
    $("downloadRows").append(row);
  }
  $("onlineTracks").onsubmit = run(async (event) => {
    event.preventDefault();
    const groups = Object.entries(fields).map(([kind, row]) => [kind, Object.fromEntries(
      Object.entries(row).map(([level, input]) => [level, input.valueAsNumber])
    )]);
    const total = groups.flatMap(([,row]) => Object.values(row)).reduce((a,b)=>a+b,0);
    const status = $("downloadReport");
    if (total < 1 || total > 60) {status.textContent = "Выберите от 1 до 60 треков."; return;}
    const before = new Set(tracks.map(t => t.id)), messages = [];
    let reused = 0;
    $("downloadMusic").disabled = $("retryDownloads").disabled = true;
    try {
      for (const [kind, quota] of groups) {
        for (const [level, count] of Object.entries(quota)) {
          if (!count) continue;
          status.textContent = "Загрузка " + kind + " · " + levels[level] + "…";
          try {
            const picked = await api("download-tracks", {kind, quota:{easy:0, medium:0, hard:0, [level]:count}});
            reused += picked.tracks.filter(t => before.has(t.id)).length;
            messages.push(...picked.shortages.map(apiMessage));
          } catch (e) { messages.push(e.message); }
        }
      }
      await reloadTracks();
      status.textContent = ["Добавлено: " + tracks.filter(t => !before.has(t.id)).length, "уже в фонотеке: " + reused, ...messages].join(" · ");
    } finally { $("downloadMusic").disabled = $("retryDownloads").disabled = false; }
  });
  $("amqExport").onchange = run(async () => {
    const file = $("amqExport").files[0];
    if (!file) return;
    try {
      const list = JSON.parse(await file.text());
      if (!Array.isArray(list)) throw Error("Выберите JSON-массив из AMQ Song List UI.");
      const rows = list.filter(Boolean).map(({annId,name,artist,type,difficulty})=>({annId,name,artist,type,difficulty}));
      const report = await api("amq-scores", rows);
      await reloadTracks();
      $("amqReport").textContent = "Прочитано оценок: " + report.imported + " · Сверено в фонотеке: " + report.matched;
    } catch(e) { $("amqReport").textContent = e.message; }
    finally { $("amqExport").value = ""; }
  });
}
function initMusic() {
  initDownloads();
  initCatalog();
  initBoard();
  initDesign();
  initTimeline();
  $("openingSource").onchange = () => {
    cfg.openingSource = $("openingSource").value;
    $("openingStatus").hidden = true;
    mark();
  };
  for (const [kind, title] of Object.entries(kinds)) {
    let tr = el("tr"),
      th = el("th");
    th.append(el("b", kind), el("span", title));
    tr.append(th);
    for (const level of Object.keys(levels)) {
      const td = el("td"),
        input = el("input");
      input.type = "number";
      input.min = 0;
      input.max = 60;
      input.step = 1;
      Object.assign(input.dataset, { kind, level });
      input.setAttribute("aria-label", title + " · " + levels[level]);
      input.onchange = () => {
        let n = input.valueAsNumber;
        if (!Number.isInteger(n) || n < 0 || n > 60) {
          toast("Введите целое число от 0 до 60");
          settings();
          return;
        }
        cfg.quota[kind][level] = n;
        mark();
      };
      td.append(input, el("small"));
      tr.append(td);
    }
    $("quotas").tBodies[0].append(tr);
  }
  button("textQuiz", () => switchQuiz(false));
  button("musicQuiz", () => switchQuiz(true));

  button("composeMusic", () => switchQuiz(true));
  initFolder();
  initClipDialog();
  $("trackFile").onchange = () => {
    const f = $("trackFile").files[0];
    if (f) $("trackTitle").value = f.name.replace(/\.[^.]+$/, "").slice(0, 160);
  };
  $("uploadForm").onsubmit = run(async (e) => {
    e.preventDefault();
    if (selectedTrack) {
      const selection = selectedTrack;
      const catalog = selection.origin === "catalog";
      $("importTrack").disabled = true;
      $("importStatus").textContent = catalog ? "Скачивание видео и подготовка MP4…" : "Сохранение…";
      try {
        const saved = await api(catalog ? "music-pick" : "track-offset",{id:selection.track.id,offset:$("trackOffset").valueAsNumber});
        await reloadTracks();
        if (selectedTrack === selection) {
          selectTrack(saved,"library");
          $("importStatus").textContent = catalog ? "Сохранено: " + saved.videoFile : "Изменения сохранены.";
        }
      } catch(e) { $("importStatus").textContent = e.message; await reloadDownloadFailures(); }
      finally { $("importTrack").disabled = false; }
      return;
    }
    const f = $("trackFile").files[0];
    if (!f || f.size > 128 * 1024 * 1024)
      throw Error("Выберите аудиофайл до 128 МБ");
    const meta = {
      title: $("trackTitle").value.trim(),
      anime: $("animeName").value.trim(),
      kind: $("trackKind").value,
      level: $("trackLevel").value,
      offset: $("trackOffset").valueAsNumber,
      ru: $("trackRu").value.trim(),
    };
    $("importTrack").disabled = true;
    $("importStatus").textContent = "Подготовка аудио…";
    try {
      await uploadTrack(f, meta);
      $("trackFile").value = $("trackTitle").value = $("trackRu").value = "";
      $("importStatus").textContent = "Добавлен трек " + meta.title;
      await reloadTracks();
    } catch (e) {
      $("importStatus").textContent = e.message;
    } finally {
      $("importTrack").disabled = false;
    }
  });
}
function stopRoundAudio() {
  playVersion++;
  if (roundAudio) {
    roundAudio.onended = roundAudio.onerror = null;
    roundAudio.pause();
    roundAudio.removeAttribute("src");
    roundAudio.load();
    roundAudio = null;
  }
}
async function playMusicRound() {
  const token = ++playVersion,
    s = state.applied,
    clip = roundTime(s) - reveal(s);
  const audio = new Audio(clipURL(state.plan[idx], clip));
  roundAudio = audio;
  timer = -1;
  mode = "question";
  draw();
  $("play").textContent = "Ⅱ";
  audio.onended = () => {
    if (token !== playVersion) return;
    mode = "answer";
    draw();
    timer = setTimeout(
      () => {
        if (token !== playVersion) return;
        if (idx === state.plan.length - 1) {
          stop();
          draw();
          return;
        }
        idx++;
        playMusicRound().catch((e) => toast(e.message));
      },
      reveal(s) * 1000,
    );
  };
  audio.onerror = () => {
    if (token !== playVersion) return;
    stop();
    toast("Не удалось воспроизвести отрывок");
  };
  try {
    await audio.play();
  } catch (e) {
    if (token === playVersion) {
      stop();
      draw();
      throw e;
    }
  }
}

async function uploadTrack(file, meta) {
  if (!file.size || file.size > 128 * 1024 * 1024)
    throw Error("Допустимый размер файла — до 128 МБ");
  const header = Array.from(
    new TextEncoder().encode(JSON.stringify(meta)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const response = await fetch("/api/import", {
    method: "POST",
    headers: {"X-Quiz-Studio": sessionStorage.getItem("framequiz-session") || "", "X-Track-Meta": header},
    body: file,
  });
  if (response.status === 403) throw Error("Откройте студию через меню трея для нового сеанса.");
  const result = await response.json();
  if (result.error) throw Error(apiMessage(result.error));
  return result.data;
}

function initFolder() {
  const picker = $("folderFiles"), queue = $("folderQueue");
  const status = $("folderStatus"), submit = $("importFolder");
  const anime = $("folderAnime"), kind = $("folderKind"), level = $("folderLevel");
  kind.innerHTML = $("trackKind").innerHTML;
  level.innerHTML = $("trackLevel").innerHTML;
  let entries = [];
  picker.onchange = () => {
    queue.replaceChildren();
    entries = Array.from(picker.files)
      .filter((file) => /\.(mp3|wav|flac|ogg|m4a|aac|aiff?)$/i.test(file.name))
      .map((file) => {
        const row = el("div"), title = el("input"), name = el("input"), note = el("small");
        row.className = "folder-row";
        const stem = file.name.replace(/\.[^.]+$/, "");
        const parts = stem.split(" - ");
        title.value = (parts.length > 1 ? parts.slice(1).join(" - ") : stem).slice(0, 160);
        name.value = (parts.length > 1 ? parts[0] : "").slice(0, 160);
        title.maxLength = name.maxLength = 160;
        title.setAttribute("aria-label", "Название трека " + file.name);
        name.setAttribute("aria-label", "Название аниме для " + file.name);
        name.placeholder = "Аниме";
        title.placeholder = "Трек";
        row.append(el("small", file.webkitRelativePath || file.name), name, title, note);
        queue.append(row);
        return {file, title, name, note, row};
      });
    submit.disabled = !entries.length;
    status.textContent = entries.length ? "Найдено аудиофайлов: " + entries.length : "В папке нет поддерживаемых аудиофайлов.";
  };
  $("folderForm").onsubmit = run(async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    const sharedAnime = anime.value.trim();
    if (entries.some(({name, title}) => !(name.value.trim() || sharedAnime) || !title.value.trim())) {
      status.textContent = "Заполните названия аниме и треков. Общее название заполняет пустые строки.";
      return;
    }
    const inputs = Array.from($("folderForm").querySelectorAll("input, select, button"));
    inputs.forEach(input => input.disabled = true);
    const remaining = [];
    try {
      for (const [index, entry] of entries.entries()) {
        status.textContent = "Импорт " + (index + 1) + " / " + entries.length;
        try {
          await uploadTrack(entry.file, {
            anime: entry.name.value.trim() || sharedAnime, title: entry.title.value.trim(),
            kind: kind.value, level: level.value, offset: 0,
          });
          entry.row.remove();
        } catch (error) {
          entry.note.textContent = error.message;
          remaining.push(entry);
        }
      }
      status.textContent = "Добавлено: " + (entries.length - remaining.length) +
        (remaining.length ? " · Ошибок: " + remaining.length + ". Эти файлы можно импортировать повторно." : "");
      entries = remaining;
      if (!entries.length) picker.value = "";
      await reloadTracks();
    } finally {
      inputs.forEach(input => input.disabled = false);
      submit.disabled = !entries.length;
    }
  });
}

function clipLength(settings = cfg) {
  return roundTime(settings) ? roundTime(settings) - reveal(settings) : 5;
}

let clipEditor;
function drawWave() {
  const {peaks, track, seconds} = clipEditor;
  const canvas = $("waveform"), context = canvas.getContext("2d");
  const {width, height} = canvas, total = track.durationMs / 1000;
  const start = $("waveStart").valueAsNumber;
  const left = start / total * width, right = (start + seconds) / total * width;
  context.fillStyle = "#1b181a";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#563a33";
  context.fillRect(left, 0, right - left, height);
  const unit = width / Math.max(1, peaks.length);
  const scale = Math.max(1, ...peaks);
  peaks.forEach((peak, i) => {
    const x = i * unit, h = Math.max(1, peak / scale * height * 0.86);
    context.fillStyle = x >= left && x <= right ? "#ffb49d" : "#a5979e";
    context.fillRect(x, (height - h) / 2, Math.max(1, unit - 1), h);
  });
  context.fillStyle = "#ffb49d";
  context.fillRect(left, 0, 2, height);
  context.fillRect(Math.min(width - 2, right), 0, 2, height);
  $("waveTiming").textContent = fmt(start) + " – " + fmt(start + seconds) + " · " + seconds + " с";
}

async function openClip(track, seconds, saveOffset) {
  stop();
  $("audition").pause();
  const request = {track, seconds, saveOffset, peaks: []};
  clipEditor = request;
  const slider = $("waveStart"), dialog = $("clipDialog");
  slider.max = Math.max(0, Math.floor(track.durationMs / 1000) - seconds);
  slider.value = Math.min(track.offset, Number(slider.max));
  $("clipName").textContent = track.anime + " · " + track.title;
  $("waveStatus").textContent = "Загрузка звуковой дорожки…";
  drawWave();
  dialog.showModal();
  try {
    const peaks = await api("waveform", {id: track.id});
    if (clipEditor !== request) return;
    request.peaks = peaks;
    $("waveStatus").textContent = "Нажмите на дорожку или передвиньте ползунок. Цветом выделен отрывок.";
    drawWave();
  } catch (error) {
    if (clipEditor === request) $("waveStatus").textContent = error.message;
  }
}

function initClipDialog() {
  const dialog = $("clipDialog"), slider = $("waveStart"), audio = $("waveAudio");
  const stopAudio = () => { audio.pause(); audio.hidden = true; };
  slider.oninput = () => { stopAudio(); drawWave(); };
  const canvas = $("waveform");
  const seek = (event) => {
    const bounds = canvas.getBoundingClientRect();
    const fraction = (event.clientX - bounds.left) / bounds.width;
    slider.value = Math.round(fraction * clipEditor.track.durationMs / 1000);
    slider.oninput();
  };
  canvas.onpointerdown = (event) => { canvas.setPointerCapture(event.pointerId); seek(event); };
  canvas.onpointermove = (event) => { if (canvas.hasPointerCapture(event.pointerId)) seek(event); };
  button("wavePeak", async () => {
    $("waveStatus").textContent = "Ищу самый громкий момент…";
    slider.value = Math.min(await api("peak", {id: clipEditor.track.id, seconds: clipEditor.seconds}), slider.max);
    $("waveStatus").textContent = "Выбран самый громкий отрывок. Прослушайте и сохраните.";
    slider.oninput();
  });
  button("wavePlay", async () => {
    audio.src = clipURL({...clipEditor.track, offset: slider.valueAsNumber}, clipEditor.seconds);
    audio.hidden = false;
    await audio.play();
  });
  button("waveSave", async () => {
    const saveButton = $("waveSave");
    saveButton.disabled = true;
    try {
      await clipEditor.saveOffset(slider.valueAsNumber);
      dialog.close();
    } catch (error) {
      $("waveStatus").textContent = error.message;
    } finally {
      saveButton.disabled = false;
    }
  });
  button("waveClose", () => { if (!$("waveSave").disabled) dialog.close(); });
  dialog.oncancel = (event) => { if ($("waveSave").disabled) event.preventDefault(); };
  dialog.onclose = () => { stopAudio(); clipEditor = null; };
  button("replaceClose", () => $("replaceDialog").close());
  button("addClose", () => $("addDialog").close());
  button("openTracks", () => api("open-tracks", {}));
  button("addRound", async () => {
    stop();
    const s = state.applied, seconds = clipLength(s), select = $("addChoice"), submit = $("addSave");
    const used = new Set(state.plan.map(t => t.id));
    const candidates = (await api("tracks", {})).filter(t => !used.has(t.id) && eligible(t, seconds));
    select.replaceChildren(...candidates.map(t => new Option(t.kind + " · " + t.anime + " · " + t.title + (t.videoFile ? " · MP4" : ""), t.id)));
    select.disabled = submit.disabled = !candidates.length;
    $("addInfo").textContent = candidates.length ? "Трек добавится в конец плана. Потом перетащите его на нужное место." : "Нет свободных треков с отрывком нужной длины.";
    button("addSave", () => {
      const choice = candidates.find(t => t.id === select.value);
      if (!choice) return;
      const next = [...state.plan, choice];
      syncCount(next);
      state.plan = next;
      $("addDialog").close();
      refresh();
    });
    $("addDialog").showModal();
  });
}

function roundActions(track, index, settings) {
  const actions = el("div");
  actions.className = "round-actions";
  const trim = el("button", "Отрывок");
  const replace = el("button", "Заменить");
  const seconds = clipLength(settings);
  trim.title = "Начало отрывка: " + fmt(track.offset);
  trim.onclick = run(() => openClip(track, seconds, (offset) => {
    track.offset = offset;
    refresh();
  }));
  replace.onclick = run(async () => {
    stop();
    const dialog = $("replaceDialog"), select = $("replacement"), submit = $("replaceSave");
    const used = new Set(state.plan.map(t => t.id));
    const catalog = await api("tracks", {});
    const candidates = catalog.filter(t => !used.has(t.id) &&
      t.kind === track.kind && t.level === track.level && eligible(t, seconds));
    select.replaceChildren(...candidates.map(t => new Option(t.anime + " · " + t.title, t.id)));
    select.disabled = submit.disabled = !candidates.length;
    $("replaceInfo").textContent = "Раунд " + (index + 1) + " · " + track.kind + " · " + levels[track.level] +
      (candidates.length ? "" : " · Нет свободного трека с отрывком нужной длины.");
    button("replaceSave", () => {
      const choice = candidates.find(t => t.id === select.value);
      if (!choice || state.plan[index] !== track) return;
      state.plan[index] = choice;
      dialog.close();
      refresh();
    });
    dialog.showModal();
  });
  actions.append(trim, replace);
  return actions;
}

// ---- Метки OP/ED: «OP 1», «ED 2» ----
const tagOf = (t) => {
  const n = String(t.version || "").match(/\d+/)?.[0];
  return (t.kind || "") + (n ? " " + n : "");
};
const vintageKey = (v) => {
  const m = String(v || "").match(/(Winter|Spring|Summer|Fall)\s+(\d{4})/);
  return m ? Number(m[2]) * 10 + ["Winter", "Spring", "Summer", "Fall"].indexOf(m[1]) : 0;
};
const verNum = (v) => Number(String(v || "").match(/\d+/)?.[0] ?? 0);

// ---- Каталог: общий список по популярности + фильтры справа ----
const SHIKI = "https://shikimori.io";
const catFilters = { genre: null, yearFrom: null, yearTo: null, level: "", type: "", order: "popularity", query: "", refresh: false };
let animePage = 1, animeNext = null, songRows = [], catalogReady = false, pickedAnime = null;
const pickedSongs = new Map(); // выбор песен по всем тайтлам, переживает смену аниме
async function openCatalog() {
  tracks = await api("tracks", {}).catch(() => tracks);
  if (pickedAnime) renderSongs();
  if (catalogReady) return;
  catalogReady = true;
  const genres = await api("shiki-genres", {});
  $("genrePick").replaceChildren(new Option("Все жанры", ""), ...genres.map((g) => new Option(g.russian || g.name, g.id)));
  await reloadAnime();
}
function reloadAnime() {
  animePage = 1;
  $("animeList").replaceChildren();
  return loadAnime();
}
const coverUrls = () => (state.covers ??= {});
let coverQueue = Promise.resolve();
// Запасная обложка из интернета (AniList): для тайтлов, у которых на Shikimori нет постера.
function findCover(a, img, manual) {
  coverQueue = coverQueue.then(async () => {
    try {
      const found = await api("cover-find", { id: a.id });
      coverUrls()[a.id] = found.preview;
      img.src = found.preview;
      save();
    } catch (e) {
      if (manual) toast("Обложка не найдена: " + e.message);
    }
    await new Promise((r) => setTimeout(r, 700)); // AniList ограничивает частоту запросов
  });
}
const kindLabel = { tv: "TV", movie: "Фильм", ova: "OVA", ona: "ONA", special: "Спецвыпуск", tv_special: "TV-спец." };
async function loadAnime() {
  $("moreAnime").disabled = true;
  $("catalogStatus").textContent = "Загрузка…";
  try {
    const { rows, next } = await api("shiki-list", { ...catFilters, page: animePage });
    catFilters.refresh = false;
    animeNext = next;
    for (const a of rows) {
      const card = el("button");
      card.type = "button";
      card.className = "anime-card";
      card.title = a.name;
      const img = el("img");
      img.alt = "";
      img.loading = "lazy";
      const saved = coverUrls()[a.id];
      if (saved) img.src = saved;
      else if (a.cover) img.src = a.cover;
      else findCover(a, img);
      img.onerror = () => {
        if (!img.dataset.retried) {
          img.dataset.retried = "1";
          findCover(a, img);
        }
      };
      const text = el("span");
      const meta = [a.year, kindLabel[a.kind] ?? a.kind];
      text.append(el("b", a.russian || a.name), el("small", meta.filter(Boolean).join(" · ")));
      const score = el("span", "★ " + a.score);
      score.className = "score";
      const refresh = el("span", "↻");
      refresh.className = "cover-refresh";
      refresh.title = "Обновить обложку из интернета";
      refresh.setAttribute("role", "button");
      refresh.onclick = (e) => {
        e.stopPropagation();
        findCover(a, img, true);
      };
      card.append(img, score, refresh, text);
      card.onclick = run(() => pickAnime(a, card));
      $("animeList").append(card);
    }
    $("moreAnime").hidden = !next;
    $("catalogStatus").textContent = animePage === 1 && !rows.length ? "Ничего не найдено. Ослабьте фильтры." : "";
  } catch (e) {
    $("catalogStatus").textContent = e.message;
  } finally {
    $("moreAnime").disabled = false;
  }
}
const norm = (x) => String(x ?? "").trim().toLowerCase();
// Песня уже скачана: то же название и версия, и тот же тайтл (по имени или Shikimori-id выбранного аниме).
const inLibrary = (r) => tracks.some((t) => t.source === "anisongdb" && norm(t.title) === norm(r.title) && norm(t.version) === norm(r.version) &&
  (norm(t.anime) === norm(r.anime) || (pickedAnime && t.shikiId && Number(t.shikiId) === pickedAnime.id)) && (!t.vintage || !r.vintage || t.vintage === r.vintage));
async function pickAnime(a, card) {
  document.querySelectorAll(".anime-card.selected").forEach((c) => c.classList.remove("selected"));
  card.classList.add("selected");
  pickedAnime = a;
  $("songsTitle").textContent = a.russian || a.name;
  $("songList").replaceChildren();
  $("songStatus").textContent = "Ищу опенинги и эндинги…";
  // Поиск частичный и захватывает продолжения; оставляем только песни именно этого тайтла
  // (id Shikimori = id MyAnimeList), чтобы сезоны с разными названиями не склеивались.
  const all = await api("anime-songs", { name: a.name });
  const same = all.filter((r) => (r.malId ? Number(r.malId) === a.id : norm(r.anime) === norm(a.name)));
  const rows = same;
  songRows = rows.sort((x, y) => x.anime.localeCompare(y.anime) || vintageKey(x.vintage) - vintageKey(y.vintage) ||
    (x.kind === y.kind ? verNum(x.version) - verNum(y.version) : x.kind === "OP" ? -1 : 1));
  $("songStatus").textContent = songRows.length ? "" : "В AnisongDB нет видео опенингов и эндингов для этого аниме.";
  renderSongs();
}
function renderSongs() {
  const nodes = [];
  let last = null;
  // Уже скачанное в списке не показываем: оно лежит в библиотеке.
  const hidden = songRows.filter(inLibrary).length;
  songRows.forEach((r, i) => {
    if (inLibrary(r)) return;
    const group = r.anime + "|" + (r.vintage || "");
    if (group !== last) {
      last = group;
      const head = el("div", r.anime + (r.vintage ? " · " + r.vintage : ""));
      head.className = "song-head";
      nodes.push(head);
    }
    const have = inLibrary(r);
    const row = el("label");
    row.className = "song-row " + r.kind.toLowerCase() + (have ? " have" : "");
    const box = el("input");
    box.type = "checkbox";
    box.dataset.i = i;
    box.disabled = have;
    box.checked = !have && pickedSongs.has(r.id);
    box.onchange = () => {
      box.checked ? pickedSongs.set(r.id, r) : pickedSongs.delete(r.id);
      renderBasket();
    };
    const kind = el("b", tagOf(r));
    kind.className = "kind";
    const name = el("span", [r.title, r.artist].filter(Boolean).join(" — "));
    name.title = [r.anime, r.vintage, r.version, r.title, r.artist].filter(Boolean).join(" · ");
    row.append(box, kind, name, el("small", have ? "✓ скачано" : levels[r.level] + " " + Math.round(r.amqDifficulty) + "%"));
    nodes.push(row);
  });
  $("songList").replaceChildren(...nodes);
  if (songRows.length && hidden === songRows.length) $("songStatus").textContent = "Всё из этого тайтла уже скачано.";
  else if (hidden && pickedAnime) $("songStatus").textContent = "Уже скачано и скрыто: " + hidden;
  renderBasket();
}
// Корзина: всё отмеченное по всем тайтлам; кнопка скачивает её целиком.
function renderBasket() {
  const items = [...pickedSongs.values()];
  $("downloadSongs").hidden = !items.length;
  $("downloadSongs").textContent = "Скачать выбранные (" + items.length + ")";
  $("basket").hidden = !items.length;
  $("basket").replaceChildren(...items.map((r) => {
    const x = el("button", tagOf(r) + " · " + r.anime + " ✕");
    x.type = "button";
    x.title = r.title;
    x.onclick = () => {
      pickedSongs.delete(r.id);
      renderSongs();
    };
    return x;
  }));
}
function checkSongs(kind) {
  // Меняем выбор только у текущего тайтла, у остальных он сохраняется.
  for (const r of songRows) {
    if (inLibrary(r)) continue;
    if (kind && r.kind === kind) pickedSongs.set(r.id, r);
    else pickedSongs.delete(r.id);
  }
  renderSongs();
}
function setType(type) {
  catFilters.type = type;
  document.querySelectorAll("[data-type]").forEach((b) => b.classList.toggle("selected", b.dataset.type === type));
}
function setLevel(level) {
  catFilters.level = level;
  catFilters.order = level ? "ranked" : "popularity"; // по сложности — от высокого рейтинга к низкому
  $("orderPick").value = catFilters.order;
  document.querySelectorAll("[data-diff]").forEach((b) => b.classList.toggle("selected", b.dataset.diff === level));
  $("levelNote").hidden = $("levelRefresh").hidden = !level;
}
function initCatalog() {
  const reload = run(reloadAnime);
  $("genrePick").onchange = () => {
    catFilters.genre = Number($("genrePick").value) || null;
    reload();
  };
  for (const [id, key] of [["yearFrom", "yearFrom"], ["yearTo", "yearTo"]])
    $(id).onchange = () => {
      const y = Math.round($(id).valueAsNumber);
      catFilters[key] = y >= 1950 && y <= 2100 ? y : null;
      reload();
    };
  document.querySelectorAll("[data-diff]").forEach((b) => {
    b.onclick = () => {
      setLevel(b.dataset.diff);
      reload();
    };
  });
  document.querySelectorAll("[data-type]").forEach((b) => {
    b.onclick = () => {
      setType(b.dataset.type);
      reload();
    };
  });
  button("levelRefresh", () => {
    catFilters.refresh = true;
    return reloadAnime();
  });
  $("orderPick").onchange = () => {
    catFilters.order = $("orderPick").value;
    reload();
  };
  const search = () => {
    catFilters.query = $("animeSearch").value.trim();
    reload();
  };
  $("animeSearchGo").onclick = search;
  $("animeSearch").onkeydown = (e) => {
    if (e.key === "Enter") search();
  };
  button("resetFilters", () => {
    Object.assign(catFilters, { genre: null, yearFrom: null, yearTo: null, query: "" });
    setType("");
    $("genrePick").value = $("yearFrom").value = $("yearTo").value = $("animeSearch").value = "";
    setLevel("");
    return reloadAnime();
  });
  button("moreAnime", async () => {
    animePage = animeNext;
    await loadAnime();
  });
  button("pickOP", () => checkSongs("OP"));
  button("pickED", () => checkSongs("ED"));
  button("pickNone", () => checkSongs(null));
  button("downloadSongs", async () => {
    const chosen = [...pickedSongs.values()];
    if (!chosen.length) throw Error("Отметьте хотя бы одну песню.");
    const bar = $("songBar");
    bar.hidden = false;
    bar.value = 0;
    $("downloadSongs").disabled = true;
    const errors = [];
    try {
      for (const [n, r] of chosen.entries()) {
        $("songStatus").textContent = "Скачивание " + (n + 1) + " / " + chosen.length + " · " + tagOf(r) + " " + r.title;
        try {
          await api("music-pick", { id: r.id, offset: 0, shikiId: r.malId ?? undefined, autoPeak: true });
          pickedSongs.delete(r.id);
        } catch (e) {
          errors.push(tagOf(r) + " " + r.title + " — " + e.message);
        }
        bar.value = (n + 1) / chosen.length;
      }
      await reloadTracks();
      renderSongs();
      $("songStatus").textContent = ["Скачано: " + (chosen.length - errors.length) + " / " + chosen.length, ...errors].join(" · ");
    } finally {
      $("downloadSongs").disabled = false;
    }
  });
}

// ---- Раунды: библиотека с обложками и плитки раундов ----
let activeRound = 0;
const boardEntry = (x) => (x ? (typeof x === "string" ? { id: x } : x) : null);
async function openBoard() {
  tracks = await api("tracks", {});
  renderBoard();
}
function trackCard(t) {
  const card = el("div");
  card.className = "lib-card";
  card.draggable = true;
  card.ondragstart = (e) => {
    e.dataTransfer.setData("text/plain", "t:" + t.id);
    e.dataTransfer.effectAllowed = "copy";
  };
  const img = el("img");
  img.alt = "";
  if (t.cover) img.src = t.cover;
  const chip = el("em", tagOf(t));
  chip.className = "chip " + (t.kind || "").toLowerCase();
  const sub = el("small");
  sub.append(chip, " " + t.title + (t.vintage ? " · " + t.vintage : "") + (t.ru ? " · " + t.anime : ""));
  const text = el("span");
  text.append(el("b", t.ru ? t.ru : t.anime), sub);
  card.append(img, text);
  return card;
}
// Фильтры библиотеки раундов: жанр, сложность (как в AMQ) и годы выхода.
const yearOf = (t) => Number(/\d{4}/.exec(t.vintage || "")?.[0]) || null;
function boardPool(lv = $("boardLevel").value) {
  const g = $("boardGenre").value, from = Number($("boardFrom").value) || 0, to = Number($("boardTo").value) || 9999;
  return tracks.filter((t) => {
    const y = yearOf(t);
    return (!g || (t.genres || []).includes(g)) && (!lv || t.level === lv) && (!(from > 0 || to < 9999) || (y && y >= from && y <= to));
  });
}
// Случайная песня для раунда i; level "" — случайная сложность. Песни из других раундов не берём.
let rndLevel = "";
function randomizeRound(i) {
  const used = new Set((state.board ?? []).map(boardEntry).filter((e, j) => e && j !== i).map((e) => e.id));
  const pool = boardPool(rndLevel).filter((t) => !used.has(t.id));
  if (!pool.length) throw Error("Нет подходящих песен, которых ещё нет в других раундах.");
  assignRound(i, pool[Math.floor(Math.random() * pool.length)].id);
}
function renderBoard() {
  state.board = (state.board ?? []).map(boardEntry);
  const genres = [...new Set(tracks.flatMap((t) => t.genres || []))].sort();
  const select = $("boardGenre"), current = select.value;
  select.replaceChildren(new Option("Все жанры", ""), ...genres.map((g) => new Option(g, g)));
  select.value = genres.includes(current) ? current : "";
  select.onchange = renderBoard;
  const shown = boardPool();
  $("boardCount").textContent = shown.length + " тр.";
  // Песни одного тайтла (сезона) — в одной карточке.
  const groups = new Map();
  for (const t of shown) {
    const k = t.shikiId ? "s" + t.shikiId : (t.anime || "").toLowerCase() + "|" + (t.vintage || "");
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  $("boardLib").replaceChildren(...[...groups.values()].map((list) => {
    const first = list[0];
    const card = el("div");
    card.className = "lib-card group";
    const img = el("img");
    img.alt = "";
    if (first.cover) img.src = first.cover;
    const text = el("span");
    text.append(el("b", first.ru ? first.ru : first.anime), el("small", (first.ru ? first.anime + " · " : "") + (first.vintage || "")));
    for (const t of list) {
      const row = el("div");
      row.className = "song-line";
      row.draggable = true;
      row.ondragstart = (e) => {
        e.dataTransfer.setData("text/plain", "t:" + t.id);
        e.dataTransfer.effectAllowed = "copy";
      };
      const chip = el("em", tagOf(t));
      chip.className = "chip " + (t.kind || "").toLowerCase();
      const name = el("span", t.title);
      const add = el("button", "+");
      add.title = "В раунд " + (activeRound + 1);
      add.onclick = () => assignRound(activeRound, t.id);
      const del = el("button", "🗑");
      del.title = "Удалить скачанное";
      del.onclick = run(async (e) => {
        e.stopPropagation();
        if (!confirm("Удалить «" + t.title + "» с диска?")) return;
        tracks = await api("track-delete", { id: t.id });
        state.board = state.board.map((x) => (x && x.id === t.id ? null : x));
        save();
        renderBoard();
      });
      // Двойной клик — в последний созданный раунд.
      row.ondblclick = () => {
        activeRound = Math.max(0, state.board.length - 1);
        assignRound(activeRound, t.id);
      };
      row.append(chip, name, add, del);
      text.append(row);
    }
    card.append(img, text);
    return card;
  }));
  $("boardRounds").replaceChildren(...state.board.map((entry, i) => {
    const plank = el("div");
    plank.className = "round-plank" + (i === activeRound ? " active" : "");
    const head = el("div");
    head.className = "panelhead";
    const drop = el("button", "×");
    drop.title = "Убрать раунд";
    drop.onclick = (e) => {
      e.stopPropagation();
      state.board.splice(i, 1);
      activeRound = Math.max(0, Math.min(activeRound, state.board.length - 1));
      save();
      renderBoard();
    };
    head.append(el("h3", "Раунд " + (i + 1)), drop);
    // Раунды переставляются перетаскиванием за заголовок.
    head.draggable = true;
    head.style.cursor = "grab";
    head.ondragstart = (e) => {
      e.dataTransfer.setData("text/plain", "r:" + i);
      e.dataTransfer.effectAllowed = "move";
    };
    const t = entry && tracks.find((x) => x.id === entry.id);
    plank.append(head);
    const rnd = el("div");
    rnd.className = "round-opts";
    const lvl = el("select");
    lvl.title = "Сложность случайной песни";
    lvl.append(new Option("Случайная сложность", ""), new Option("Лёгкий", "easy"), new Option("Нормальный", "medium"), new Option("Сложный", "hard"));
    lvl.value = rndLevel;
    lvl.onclick = (e) => e.stopPropagation();
    lvl.onchange = () => (rndLevel = lvl.value);
    const dice = el("button", "🎲 Случайная песня");
    dice.onclick = run(async (e) => {
      e.stopPropagation();
      activeRound = i;
      randomizeRound(i);
    });
    rnd.append(lvl, dice);
    plank.append(rnd);
    if (t) {
      plank.append(trackCard(t));
      const peak = Math.min(entry.offset ?? t.offset, Math.max(0, Math.floor(t.durationMs / 1000) - TEMPLATE.video));
      const opts = el("div");
      opts.className = "round-opts";
      const pick = el("button", "Пиковый момент: " + fmt(peak));
      pick.title = "Выбрать, с какого места пойдёт видео";
      pick.onclick = run(async (e) => {
        e.stopPropagation();
        await openClip({ ...t, offset: peak }, TEMPLATE.video, (o) => {
          entry.offset = o;
          save();
          renderBoard();
        });
      });
      const clear = el("button", "Убрать тайтл");
      clear.title = "Очистить раунд (песня останется в библиотеке)";
      clear.onclick = (e) => {
        e.stopPropagation();
        state.board[i] = null;
        save();
        renderBoard();
      };
      opts.append(pick, clear);
      plank.append(opts);
    } else {
      plank.append(el("p", "Перетащите сюда тайтл из библиотеки"));
    }
    plank.onclick = () => {
      activeRound = i;
      renderBoard();
    };
    plank.ondragover = (e) => {
      e.preventDefault();
      plank.classList.add("over");
    };
    plank.ondragleave = () => plank.classList.remove("over");
    plank.ondrop = (e) => {
      e.preventDefault();
      const data = e.dataTransfer.getData("text/plain");
      if (data.startsWith("t:")) assignRound(i, data.slice(2));
      else if (data.startsWith("r:")) {
        const from = Number(data.slice(2));
        if (from !== i && state.board[from] !== undefined) {
          state.board.splice(i, 0, ...state.board.splice(from, 1));
          activeRound = i;
          save();
          renderBoard();
        }
      }
    };
    return plank;
  }));
}
function assignRound(i, id) {
  if (!state.board.length) state.board.push(null);
  state.board[Math.min(i, state.board.length - 1)] = { id };
  save();
  renderBoard();
}
function boardTracks() {
  return (state.board || []).map(boardEntry).filter((e) => e && tracks.some((t) => t.id === e.id));
}
function newRound(t, peak) {
  const dur = Math.floor(t.durationMs / 1000);
  const r = { id: t.id, offset: 0, ...TEMPLATE };
  r.video = clamp(Math.min(r.video, dur - r.guess - r.reveal), 2, 40);
  r.offset = clamp(peak - r.guess - r.reveal, 0, Math.max(0, dur - rlen(r)));
  return r;
}
function initBoard() {
  ["boardLevel", "boardFrom", "boardTo"].forEach((id) => ($(id).onchange = renderBoard));
  button("addBoardRound", () => {
    state.board ??= [];
    state.board.push(null);
    activeRound = state.board.length - 1;
    save();
    renderBoard();
  });
  button("toTimeline", () => {
    const entries = boardTracks();
    if (!entries.length) throw Error("Добавьте хотя бы один тайтл в раунд.");
    state.applied ??= { ...defaults, quiz: "music" };
    state.applied.quiz = "music";
    state.applied.theme ??= defaults.theme;
    state.title = "GUESS THE ANIME SONG";
    tl.rounds = entries.map((e) => {
      const t = tracks.find((x) => x.id === e.id);
      return newRound(t, e.offset ?? t.offset);
    });
    Object.assign(tl, { sel: 0, head: 0, undo: [], redo: [] });
    state.timeline = tl.rounds;
    save();
    document.querySelector('[data-tab="timeline"]').click();
  });
}

// ---- Дизайн: шаблон сцен (интро, угадывание, ответ, аутро), который можно сгенерировать по описанию ----
const FONTS = {
  Arial: 'Arial, sans-serif',
  Impact: 'Impact, "Arial Black", sans-serif',
  Georgia: 'Georgia, serif',
  "Trebuchet MS": '"Trebuchet MS", sans-serif',
  Verdana: 'Verdana, sans-serif',
  Consolas: 'Consolas, monospace',
};
const BACKGROUNDS = ["pop", "sunset", "gradient", "stars", "grid", "solid"];
const PICTURES = ["vinyl", "frame", "equalizer", "none"];
const TIMERS = ["disc", "number", "ring", "none"];
const BARS = ["line", "none"];
const SIDES = ["eq", "none"];
const FRAMES = ["card", "rounded", "polaroid", "circle"];
const VIDEO_FRAMES = ["card", "plain"];
const TRANSITIONS = ["wipe", "smooth", "flash", "none"];
// Цвета фона «Поп» по кругу: у каждого раунда свой (верх, низ).
const POP_COLORS = [
  ["#9ad8fb", "#4aa3de"], ["#ff8cc4", "#d63f93"], ["#a6f77a", "#4ec53a"], ["#b79bff", "#6a46e0"],
  ["#ffb27a", "#e0663a"], ["#e0f57a", "#a8c02e"], ["#86f2d6", "#32c29b"], ["#ec8bff", "#a83bd6"],
];
// Мягкие пастельные пары для стиля Soft: сакура, мята, небо, лаванда, персик, масло, матча, сирень.
const SOFT_COLORS = [
  ["#ffd9e6", "#f1a0c0"], ["#d3f3e2", "#86cfa9"], ["#d6eaff", "#92bfec"], ["#e5dcff", "#b09ce8"],
  ["#ffe4cd", "#f2b085"], ["#fff2c2", "#eccd6e"], ["#e2f0c6", "#a2c974"], ["#f8d8ef", "#d595c4"],
];
// Тёмные пары для стиля Neon: багрянец, чернила и фиолет, угли, ночная сталь.
const NEON_COLORS = [
  ["#2a060d", "#0b0306"], ["#120b26", "#050310"], ["#33100a", "#0d0404"], ["#0a1626", "#030812"],
  ["#2b0a1f", "#0a0309"], ["#1c0a0a", "#070303"],
];
const DESIGN_POP = {
  name: "Pop",
  palette: { bg: "#9ad8fb", accent: "#ffffff", mid: "#4aa3de", dark: "#2d6fb0", text: "#1c3a63", light: "#ffffff" },
  background: "pop",
  soft: false,
  neon: false,
  barColor: "#ffffff",
  cycle: true,
  font: "Impact",
  guess: { title: "QUESTION {n}", picture: "none", timer: "disc", timerLabel: "TIME TO ANSWER", bar: "line", sides: "eq", titleStyle: "outline" },
  reveal: { label: "ANSWER", frame: "card" },
  video: { frame: "card", label: true },
  transition: "smooth",
  fade: 0.9,
  intro: { on: true, title: "GUESS THE ANIME OPENING", subtitle: "Name the anime from the opening", secs: 4, langs: true },
  outro: { on: true, title: "THANKS FOR WATCHING", subtitle: "Like and subscribe for more", secs: 3, langs: false },
};
const DESIGN_SOLAR = {
  name: "Solar",
  palette: { bg: "#f5dcaa", accent: "#e86739", mid: "#93402e", dark: "#512f31", text: "#2f2429", light: "#fff3db" },
  background: "sunset",
  soft: false,
  neon: false,
  barColor: "#ffffff",
  cycle: false,
  font: "Arial",
  guess: { title: "WHAT ANIME IS THIS?", picture: "vinyl", timer: "number", timerLabel: "TIME TO ANSWER", bar: "line", sides: "none", titleStyle: "plain" },
  reveal: { label: "ANSWER", frame: "rounded" },
  video: { frame: "plain", label: false },
  transition: "none",
  fade: 0.8,
  intro: { on: true, title: "GUESS THE ANIME SONG", subtitle: "Name the anime from the opening", secs: 3, langs: false },
  outro: { on: true, title: "THANKS FOR WATCHING", subtitle: "Like and subscribe for more", secs: 3, langs: false },
};
const DESIGN_SOFT = {
  ...structuredClone(DESIGN_POP),
  name: "Soft Sakura",
  soft: true,
  barColor: "#5cc98a",
  font: "Trebuchet MS",
  transition: "smooth",
  fade: 1,
};
const DESIGN_NEON = {
  ...structuredClone(DESIGN_POP),
  name: "Dark Neon",
  neon: true,
  barColor: "#ff2e4d",
  font: "Impact",
  transition: "smooth",
  fade: 1,
  intro: { on: true, title: "GUESS THE ANIME OPENING", subtitle: "Only the true fans know", secs: 4, langs: true },
};
const DESIGN_DEFAULT = DESIGN_POP;
// Ответ Claude или вставленный текст — недоверенные данные: берём только известные поля из разрешённых значений.
const asHex = (v, d) => (/^#[0-9a-f]{6}$/i.test(v) ? v : d);
const asPick = (v, list, d) => (list.includes(v) ? v : d);
const asText = (v, d, n = 60) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : d);
const asBool = (v, d) => (typeof v === "boolean" ? v : d);
function normalizeDesign(raw) {
  const r = raw && typeof raw === "object" ? raw : {}, D = DESIGN_DEFAULT;
  const g = r.guess ?? {}, rv = r.reveal ?? {}, vd = r.video ?? {}, secs = (x, d) => clamp(Math.round(Number(x)) || d, 1, 8);
  const card = (c, d) => ({ on: c?.on !== false, title: asText(c?.title, d.title), subtitle: asText(c?.subtitle, d.subtitle, 80), secs: secs(c?.secs, d.secs), langs: asBool(c?.langs, d.langs) });
  return {
    name: asText(r.name, D.name, 40),
    palette: Object.fromEntries(Object.entries(D.palette).map(([k, d]) => [k, asHex(r.palette?.[k], d)])),
    background: asPick(r.background, BACKGROUNDS, D.background),
    cycle: asBool(r.cycle, D.cycle),
    soft: asBool(r.soft, D.soft),
    neon: asBool(r.neon, D.neon),
    barColor: asHex(r.barColor, D.barColor),
    font: asPick(r.font, Object.keys(FONTS), D.font),
    guess: {
      title: asText(g.title, D.guess.title),
      picture: asPick(g.picture, PICTURES, D.guess.picture),
      timer: asPick(g.timer, TIMERS, D.guess.timer),
      timerLabel: asText(g.timerLabel, D.guess.timerLabel, 30),
      bar: asPick(g.bar, BARS, D.guess.bar),
      sides: asPick(g.sides, SIDES, D.guess.sides),
      titleStyle: asPick(g.titleStyle, ["outline", "plain"], D.guess.titleStyle),
    },
    reveal: { label: asText(rv.label, D.reveal.label, 24), frame: asPick(rv.frame, FRAMES, D.reveal.frame) },
    video: { frame: asPick(vd.frame, VIDEO_FRAMES, D.video.frame), label: asBool(vd.label, D.video.label) },
    transition: asPick(r.transition, TRANSITIONS, D.transition),
    fade: clamp(Math.round((Number(r.fade) || D.fade) * 10) / 10, 0.3, 2),
    intro: card(r.intro, D.intro),
    outro: card(r.outro, D.outro),
  };
}
const design = () => (state.design = normalizeDesign(state.design));
const lum = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
};
// Цвет текста по яркости фона: сверху и снизу кадра фон разный.
function inkOf(d) {
  const P = d.palette, onBg = lum(P.bg) > 0.55 ? P.text : P.light, onDark = lum(P.dark) > 0.55 ? P.text : P.light;
  if (d.background === "pop") return { top: "#ffffff", bottom: "#ffffff" };
  if (d.background === "solid") return { top: onBg, bottom: onBg };
  if (d.background === "stars") return { top: onDark, bottom: onDark };
  if (d.background === "sunset") return { top: P.text, bottom: P.light };
  return { top: onBg, bottom: onDark };
}
const popPair = (d, index) => {
  const list = d.neon ? NEON_COLORS : d.soft ? SOFT_COLORS : POP_COLORS;
  return d.cycle ? list[index % list.length] : [d.palette.bg, d.palette.mid];
};
// Цвет полосы времени: в Pop/Soft он задаётся отдельно (accent там белый), в остальных стилях это accent.
const barColorOf = (d) => (d.background === "pop" ? d.barColor : d.palette.accent);
// Тёмный неон: багровое затмение, шипы внизу, всплывающие угли и вспышки-росчерки.
function drawNeonArt(c, w, h, time) {
  const u = Math.min(w, h);
  c.save();
  const ex = w * 0.5, ey = h * 0.3, er = u * 0.26, pulse = 0.85 + 0.15 * Math.sin(time * 0.7);
  const glow = c.createRadialGradient(ex, ey, er * 0.9, ex, ey, er * 2.2);
  glow.addColorStop(0, "rgba(255,46,77," + (0.38 * pulse).toFixed(3) + ")");
  glow.addColorStop(1, "rgba(255,46,77,0)");
  c.fillStyle = glow;
  c.fillRect(0, 0, w, h);
  c.fillStyle = "#050205";
  c.beginPath();
  c.arc(ex, ey, er, 0, 7);
  c.fill();
  c.strokeStyle = "rgba(255,70,90," + (0.85 * pulse).toFixed(3) + ")";
  c.lineWidth = Math.max(3, u * 0.006);
  c.shadowColor = "#ff2e4d";
  c.shadowBlur = u * 0.03;
  c.beginPath();
  c.arc(ex, ey, er, 0, 7);
  c.stroke();
  c.shadowBlur = 0;
  // неоновые росчерки клинка, вспыхивают по очереди
  c.lineCap = "round";
  for (let k = 0; k < 3; k++) {
    const a = 0.5 + Math.sin(time * 0.4 + k * 2.1) * 0.5, y = h * (0.2 + k * 0.28), x = ((k * 0.43 + time * 0.006) % 1) * w;
    c.strokeStyle = "rgba(255,46,77," + (0.55 * a).toFixed(3) + ")";
    c.lineWidth = Math.max(2, u * 0.004);
    c.beginPath();
    c.moveTo(x - u * 0.2, y + u * 0.12);
    c.lineTo(x + u * 0.2, y - u * 0.12);
    c.stroke();
  }
  // шипы и зазубренный силуэт у нижнего края
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  // Шипы покачиваются и «дышат»: задний слой светлее и движется в другую сторону.
  let s2 = 3;
  const r2 = () => (s2 = (s2 * 16807) % 2147483647) / 2147483647;
  const heights = Array.from({ length: Math.ceil(w / (u * 0.045)) + 2 }, () => 0.02 + r2() * 0.07);
  for (const layer of [0, 1]) {
    c.fillStyle = layer ? "#12040a" : "#030103";
    c.strokeStyle = layer ? "rgba(255,46,77,0.35)" : "rgba(255,46,77,0.75)";
    c.lineWidth = Math.max(2, u * 0.0035);
    c.beginPath();
    c.moveTo(0, h);
    heights.forEach((hv, k) => {
      const x = k * u * 0.045 + Math.sin(time * 0.9 + k * 0.7 + layer * 2) * u * 0.006 * (layer ? -1 : 1);
      const grow = 1 + 0.22 * Math.sin(time * 1.3 + k * 0.9 + layer * 1.7);
      const tall = (k % 4 === 0 ? 2 : 1) * (layer ? 1.35 : 1);
      c.lineTo(x, h - u * hv * tall * grow);
    });
    c.lineTo(w, h);
    c.closePath();
    c.fill();
    c.stroke();
  }
  // угли поднимаются вверх и гаснут
  for (let i = 0; i < 28; i++) {
    const sp = 22 + rnd() * 40, x0 = rnd() * w, y0 = rnd() * h, r = u * (0.003 + rnd() * 0.005), ph = rnd() * 6;
    const y = h - ((y0 + time * sp * 0.3) % h), x = x0 + Math.sin(time * 0.3 + ph) * u * 0.02, life = y / h;
    c.fillStyle = "rgba(" + (255 - Math.round(rnd() * 60)) + ",120,40," + (0.25 + 0.7 * life).toFixed(3) + ")";
    c.beginPath();
    c.arc(x, y, r, 0, 7);
    c.fill();
  }
  c.restore();
}
// Японские мотивы мягкого стиля: солнце, облака, волны сэйгайха, лепестки сакуры.
function drawSoftArt(c, w, h, time) {
  const u = Math.min(w, h);
  c.save();
  c.fillStyle = "#ffffff59";
  c.beginPath();
  c.arc(w * 0.5, h * 0.3, u * 0.3, 0, 7);
  c.fill();
  c.fillStyle = "#ffffff73";
  for (const [k, y, sc] of [[0, 0.17, 1], [1, 0.52, 0.8], [2, 0.74, 0.9]]) {
    const x = ((k * 0.37 * w + time * 4 * sc) % (w * 1.5)) - w * 0.25, cw = u * 0.34 * sc, ch = cw * 0.22;
    roundRect(c, x, h * y, cw, ch, ch / 2);
    c.fill();
    c.beginPath();
    c.arc(x + cw * 0.3, h * y, ch * 0.9, 0, 7);
    c.arc(x + cw * 0.58, h * y - ch * 0.15, ch * 1.2, 0, 7);
    c.fill();
  }
  // сэйгайха: ряды полукруглых волн у нижнего края
  const R = u * 0.07;
  c.strokeStyle = "#ffffff80";
  c.lineWidth = Math.max(2, u * 0.0025);
  for (let row = 0; row < 3; row++) {
    // ряды плывут в разные стороны с периодом в одну волну, поэтому узор не рвётся
    const drift = (time * u * 0.01 * (row % 2 ? 1 : -1)) % (2 * R);
    for (let col = -2; col * 2 * R < w + 2 * R; col++) {
      const cx = col * 2 * R + (row % 2 ? R : 0) + drift, cy = h + R * 0.2 - row * R * 0.55 + Math.sin(time * 0.8 + row * 1.3) * R * 0.07;
      for (const k of [1, 0.72, 0.44]) {
        c.beginPath();
        c.arc(cx, cy, R * k, Math.PI, 0);
        c.stroke();
      }
    }
  }
  // лепестки сакуры медленно падают
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 16; i++) {
    const sp = 18 + rnd() * 22, x0 = rnd() * w, y0 = rnd() * h, sz = u * (0.012 + rnd() * 0.012), ph = rnd() * 6;
    const x = (x0 + time * sp * 0.15 + Math.sin(time * 0.3 + ph) * u * 0.02 + w) % w, y = (y0 + time * sp * 0.3) % h;
    c.save();
    c.translate(x, y);
    c.rotate(ph + time * 0.12);
    c.fillStyle = "#ffffffc8";
    c.beginPath();
    c.ellipse(0, 0, sz * 1.5, sz, 0, 0, 7);
    c.fill();
    c.fillStyle = "#f6a9c6aa";
    c.beginPath();
    c.ellipse(sz * 0.4, 0, sz * 0.9, sz * 0.55, 0, 0, 7);
    c.fill();
    c.restore();
  }
  c.restore();
}
function drawPop(c, w, h, pair, time, mode) {
  const soft = mode === "soft";
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, pair[0]);
  g.addColorStop(1, pair[1]);
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  // скоростные линии, медленно ползущие по диагонали
  c.save();
  c.translate(w / 2, h / 2);
  c.rotate(-0.45);
  const span = Math.hypot(w, h), step = span / 14, off = (time * 6) % step;
  c.fillStyle = soft ? "#ffffff0d" : mode === "neon" ? "#ff2e4d0e" : "#ffffff16";
  for (let k = -16; k < 16; k++) c.fillRect(k * step + off, -span, step * 0.33, span * 2);
  c.restore();
  if (soft) return drawSoftArt(c, w, h, time);
  if (mode === "neon") return drawNeonArt(c, w, h, time);
  // контурные фигуры: коробки, цилиндры, зигзаги
  let seed = 5;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  c.strokeStyle = "#ffffffb0";
  c.lineWidth = Math.max(2, w * 0.0026);
  c.lineJoin = "round";
  for (let i = 0; i < 10; i++) {
    const x = rnd() * w, y = rnd() * h, s = w * (0.022 + rnd() * 0.03), a = rnd() * 6 + time * 0.025 * (i % 2 ? 1 : -1);
    c.save();
    c.translate(x, y);
    c.rotate(a);
    if (i % 3 === 0) {
      c.strokeRect(-s, -s * 0.6, s * 2, s * 1.2);
      c.strokeRect(-s * 0.6, -s, s * 2, s * 1.2);
      c.beginPath();
      for (const [px, py] of [[-1, -0.6], [1, -0.6], [1, 0.6]]) {
        c.moveTo(px * s, py * s);
        c.lineTo(px * s + s * 0.4, py * s - s * 0.4);
      }
      c.stroke();
    } else if (i % 3 === 1) {
      c.beginPath();
      c.ellipse(0, -s * 0.8, s * 0.5, s * 0.2, 0, 0, 7);
      c.moveTo(-s * 0.5, -s * 0.8);
      c.lineTo(-s * 0.5, s * 0.8);
      c.moveTo(s * 0.5, -s * 0.8);
      c.lineTo(s * 0.5, s * 0.8);
      c.moveTo(-s * 0.5, s * 0.8);
      c.ellipse(0, s * 0.8, s * 0.5, s * 0.2, 0, Math.PI, 0, true);
      c.stroke();
    } else {
      c.beginPath();
      c.moveTo(-s * 1.4, 0);
      for (let j = 1; j <= 6; j++) c.lineTo(-s * 1.4 + (j * s * 2.8) / 6, j % 2 ? -s * 0.35 : s * 0.35);
      c.stroke();
    }
    c.restore();
  }
  drawHills(c, w, h, time);
}
// Мягкие холмы у нижнего края: два слоя качаются в противофазе.
function drawHills(c, w, h, time) {
  const u = Math.min(w, h);
  for (const [layer, base, amp, alpha] of [[0, 0.07, 0.022, "26"], [1, 0.04, 0.03, "3c"]]) {
    c.fillStyle = "#ffffff" + alpha;
    c.strokeStyle = "#ffffff90";
    c.lineWidth = Math.max(2, u * 0.0025);
    c.beginPath();
    c.moveTo(0, h);
    for (let x = 0; x <= w + 8; x += 8) {
      const y = h - u * base - u * amp * Math.sin(x / (u * 0.17) + time * 0.9 * (layer ? -1 : 1) + layer * 2) - u * amp * 0.5 * Math.sin(x / (u * 0.07) - time * 0.6 + layer);
      c.lineTo(x, y);
    }
    c.lineTo(w, h);
    c.closePath();
    c.fill();
    c.stroke();
  }
}
// Аура вокруг центрального круга: мягкое свечение, расходящиеся кольца и медленно вращающиеся лучи.
function drawAura(c, cx, cy, r, time, rgb) {
  c.save();
  const pulse = 0.8 + 0.2 * Math.sin(time * 1.8);
  const glow = c.createRadialGradient(cx, cy, r * 0.8, cx, cy, r * 2.3);
  glow.addColorStop(0, "rgba(" + rgb + "," + (0.42 * pulse).toFixed(3) + ")");
  glow.addColorStop(1, "rgba(" + rgb + ",0)");
  c.fillStyle = glow;
  c.beginPath();
  c.arc(cx, cy, r * 2.3, 0, 7);
  c.fill();
  c.translate(cx, cy);
  c.rotate(time * 0.18);
  c.fillStyle = "rgba(" + rgb + ",0.09)";
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    c.beginPath();
    c.moveTo(0, 0);
    c.arc(0, 0, r * 2.2, a, a + 0.15);
    c.closePath();
    c.fill();
  }
  c.rotate(-time * 0.18);
  for (let k = 0; k < 3; k++) {
    const ph = (time * 0.4 + k / 3) % 1;
    c.strokeStyle = "rgba(" + rgb + "," + (0.55 * Math.pow(1 - ph, 1.5)).toFixed(3) + ")";
    c.lineWidth = Math.max(2, r * 0.07 * (1 - ph));
    c.beginPath();
    c.arc(0, 0, r * (1.05 + ph * 0.95), 0, 7);
    c.stroke();
  }
  c.restore();
}
const auraColor = (d) => (d.neon ? "255,46,77" : d.soft ? "255,190,215" : "255,255,255");
function drawBackground(c, w, h, d, ctx = {}) {
  const P = d.palette;
  if (d.background === "pop") return drawPop(c, w, h, popPair(d, ctx.index ?? 0), ctx.time ?? 0, d.neon ? "neon" : d.soft ? "soft" : "");
  if (d.background === "sunset") return art(c, w, h, [P.bg, P.accent, P.mid, P.dark, P.text]);
  c.fillStyle = P.bg;
  c.fillRect(0, 0, w, h);
  if (d.background === "gradient" || d.background === "grid") {
    const g = c.createLinearGradient(0, 0, w * 0.2, h);
    g.addColorStop(0, P.bg);
    g.addColorStop(d.background === "grid" ? 0.5 : 0.55, d.background === "grid" ? P.bg : P.mid);
    g.addColorStop(1, P.dark);
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  }
  if (d.background === "grid") {
    c.strokeStyle = P.accent + "40";
    c.lineWidth = 2;
    for (let x = 0; x <= w; x += w / 12) {
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, h);
      c.stroke();
    }
    for (let y = 0; y <= h; y += w / 12) {
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(w, y);
      c.stroke();
    }
  }
  if (d.background === "stars") {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, P.dark);
    g.addColorStop(1, P.text);
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    let seed = 11;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 220; i++) {
      c.fillStyle = P.light + (rnd() > 0.7 ? "ff" : "88");
      c.beginPath();
      c.arc(rnd() * w, rnd() * h, 1 + rnd() * w * 0.0022, 0, 7);
      c.fill();
    }
  }
}
// Положение полосы времени. Используется и при рисовании, и при экспорте (плавную полосу рисует ffmpeg).
function barGeom(w, h, portrait) {
  const bh = Math.max(16, Math.round(h * 0.012));
  return { x: Math.round(w * 0.1), y: Math.round(h * (portrait ? 0.915 : 0.945)), w: Math.round(w * 0.8), h: bh };
}
const VIDEO_RADIUS = 28; // скругление видео внутри рамки; такая же маска режет кадр в ffmpeg
// Маска окна под видео: белое скруглённое окно на чёрном, края сглажены рисованием canvas.
function videoMask(win) {
  const m = document.createElement("canvas");
  m.width = win.w;
  m.height = win.h;
  const c = m.getContext("2d");
  c.fillStyle = "#000";
  c.fillRect(0, 0, win.w, win.h);
  c.fillStyle = "#fff";
  roundRect(c, 0, 0, win.w, win.h, VIDEO_RADIUS);
  c.fill();
  return m;
}
// Сцена ответа: заголовок, слева сверху обложка в рамке с подписью справа от неё, под ними плеер в рамке.
// Все числа окна чётные: так требует кодировщик.
function videoWin(w, h, portrait) {
  const even = (v) => Math.round(v / 2) * 2;
  let ww = portrait ? w * 0.92 : (h * 0.56 * 16) / 9, wh = (ww * 9) / 16;
  ww = even(ww);
  wh = even(wh);
  return { x: even((w - ww) / 2), y: even(h * (portrait ? 0.385 : 0.39)), w: ww, h: wh };
}
// Место под обложку: высота и левый верхний угол (картинка внутри рамки).
function coverBox(w, h, portrait) {
  const win = videoWin(w, h, portrait);
  return { x: win.x + 16, y: h * (portrait ? 0.135 : 0.15), h: h * (portrait ? 0.19 : 0.2) };
}
// Цвета рамок под фон: на тёмном неоне рамки тёмные с красным свечением, а не белые.
function frameTheme(d) {
  if (d.neon) return { fill: "#16060b", edge: "#ff2e4d", glow: "rgba(255,46,77,0.75)", inner: "#07020a", spark: "#ff5a73", tag: "#ff8a1f", name: "#ff9aa8", wipe: "#0b0206" };
  if (d.soft) return { fill: "#ffffff", edge: null, glow: "rgba(120,60,90,0.25)", inner: "#14101a", spark: "#ffffff", tag: "#ff8a1f", name: "#2a7bff", wipe: "#ffe6ef" };
  return { fill: "#ffffff", edge: null, glow: "rgba(0,0,0,0.30)", inner: "#101010", spark: "#ffffff", tag: "#ff8a1f", name: "#2a7bff", wipe: "#ffffff" };
}
function cardFrame(c, th, x, y, w, h, r) {
  c.save();
  c.shadowColor = th.glow;
  c.shadowBlur = th.edge ? 38 : 36;
  c.shadowOffsetY = th.edge ? 0 : 10;
  c.fillStyle = th.fill;
  roundRect(c, x, y, w, h, r);
  c.fill();
  if (th.edge) {
    c.shadowBlur = 22;
    c.strokeStyle = th.edge;
    c.lineWidth = 5;
    c.stroke();
  }
  c.restore();
}
// Шторка между сценами на прозрачном холсте: полосы наезжают по очереди, ведущая кромка подсвечена.
// p = 1 — экран закрыт полностью, p = 0 — шторки нет.
function drawWipe(c, w, h, p, d) {
  const th = frameTheme(d), bands = 8, bh = h / bands, slant = bh * 0.9, stag = 0.55;
  const edge = th.edge ?? (d.background === "pop" ? popPair(d, 1)[1] : d.palette.accent);
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.clearRect(0, 0, w, h);
  for (let i = 0; i < bands; i++) {
    const t = clamp((p - (i * stag) / bands) / (1 - stag), 0, 1), cov = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    if (cov <= 0) continue;
    const y0 = i * bh, y1 = y0 + bh + 1, x1 = cov * (w + 2 * slant) - slant;
    c.fillStyle = th.wipe;
    c.beginPath();
    c.moveTo(-slant, y0);
    c.lineTo(x1 + slant, y0);
    c.lineTo(x1, y1);
    c.lineTo(-slant, y1);
    c.closePath();
    c.fill();
    if (cov < 0.999) {
      c.fillStyle = edge;
      c.beginPath();
      c.moveTo(x1 + slant - 30, y0);
      c.lineTo(x1 + slant, y0);
      c.lineTo(x1, y1);
      c.lineTo(x1 - 30, y1);
      c.closePath();
      c.fill();
    }
  }
}
// Переход между угадыванием и ответом (xfade): под каждый стиль свой.
const xfadeOf = (d) => (!["wipe", "smooth"].includes(d.transition) ? "fade" : d.neon ? "radial" : d.soft ? "smoothleft" : d.background === "pop" ? "circleopen" : "fade");
const SAMPLE = { anime: "Frieren: Beyond Journey's End", ru: "Провожающая в последний путь Фрирен", title: "Yuusha", kind: "OP", version: "Opening 1" };
const coverCache = new Map();
function loadCover(id) {
  if (!coverCache.has(id))
    coverCache.set(id, api("cover-full", { id }).then((url) => url ? new Promise((ok) => {
      const im = new Image();
      im.onload = () => ok(im);
      im.onerror = () => ok(null);
      im.src = url;
    }) : null).catch(() => null));
  return coverCache.get(id);
}
function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
}
// Толстый курсивный текст с белым контуром, как в примерах.
function outlined(c, d, text, x, y, maxW, size, fill, stroke = "#ffffff") {
  const family = FONTS[d.font];
  for (; size > 12; size -= 2) {
    c.font = "italic 900 " + size + "px " + family;
    if (c.measureText(text).width <= maxW) break;
  }
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.lineJoin = "round";
  c.lineWidth = size * 0.2;
  c.strokeStyle = stroke;
  c.strokeText(text, x, y);
  c.fillStyle = fill;
  c.fillText(text, x, y);
}
function sparkle(c, x, y, r, color = "#ffffff") {
  c.fillStyle = color;
  c.beginPath();
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4 - Math.PI / 2, rr = k % 2 ? r * 0.22 : r;
    c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  c.closePath();
  c.fill();
}
function drawFlag(c, code, x, y, r) {
  c.save();
  c.beginPath();
  c.arc(x, y, r, 0, 7);
  c.clip();
  const band = (colors, vertical) => colors.forEach((col, i) => {
    c.fillStyle = col;
    if (vertical) c.fillRect(x - r + (i * 2 * r) / colors.length, y - r, (2 * r) / colors.length + 1, 2 * r);
    else c.fillRect(x - r, y - r + (i * 2 * r) / colors.length, 2 * r, (2 * r) / colors.length + 1);
  });
  if (code === "RU") band(["#ffffff", "#1c57a5", "#d52b1e"], false);
  else if (code === "IT") band(["#008c45", "#f4f5f0", "#cd212a"], true);
  else if (code === "DE") band(["#000000", "#dd0000", "#ffce00"], false);
  else if (code === "FR") band(["#0055a4", "#ffffff", "#ef4135"], true);
  else if (code === "PL") band(["#ffffff", "#dc143c"], false);
  else if (code === "ES") {
    band(["#aa151b", "#f1bf00", "#aa151b"], false);
  } else if (code === "BR") {
    c.fillStyle = "#009c3b";
    c.fillRect(x - r, y - r, 2 * r, 2 * r);
    c.fillStyle = "#ffdf00";
    c.beginPath();
    c.moveTo(x, y - r * 0.7);
    c.lineTo(x + r * 0.8, y);
    c.lineTo(x, y + r * 0.7);
    c.lineTo(x - r * 0.8, y);
    c.fill();
    c.fillStyle = "#002776";
    c.beginPath();
    c.arc(x, y, r * 0.38, 0, 7);
    c.fill();
  } else if (code === "JP") {
    c.fillStyle = "#ffffff";
    c.fillRect(x - r, y - r, 2 * r, 2 * r);
    c.fillStyle = "#bc002d";
    c.beginPath();
    c.arc(x, y, r * 0.5, 0, 7);
    c.fill();
  } else {
    c.fillStyle = "#012169";
    c.fillRect(x - r, y - r, 2 * r, 2 * r);
    c.fillStyle = "#ffffff";
    c.fillRect(x - r, y - r * 0.28, 2 * r, r * 0.56);
    c.fillRect(x - r * 0.28, y - r, r * 0.56, 2 * r);
    c.fillStyle = "#c8102e";
    c.fillRect(x - r, y - r * 0.14, 2 * r, r * 0.28);
    c.fillRect(x - r * 0.14, y - r, r * 0.28, 2 * r);
  }
  c.restore();
  c.strokeStyle = "#ffffff";
  c.lineWidth = Math.max(3, r * 0.12);
  c.beginPath();
  c.arc(x, y, r, 0, 7);
  c.stroke();
}
const LANGS = [
  ["EN", "GUESS THE ANIME OPENING IN {n} SECONDS"],
  ["ES", "ADIVINA EL OPENING DEL ANIME EN {n} SEGUNDOS"],
  ["DE", "ERRATE DIE ANIME-ERÖFFNUNG IN {n} SEKUNDEN"],
  ["FR", "DEVINEZ L'OPENING D'ANIME EN {n} SECONDES"],
  ["BR", "ADIVINHE A ABERTURA DO ANIME EM {n} SEGUNDOS"],
  ["RU", "УГАДАЙ ОПЕНИНГ АНИМЕ ЗА {n} СЕКУНД"],
  ["IT", "INDOVINA LA SIGLA DELL'ANIME IN {n} SECONDI"],
  ["PL", "ZGADNIJ OPENING ANIME W {n} SEKUND"],
  ["JP", "{n}秒でアニメのオープニングを当てよう"],
];
// Колонки-эквалайзеры по бокам. levels — уровни 0..1 по полосам спектра (из музыки раунда);
// без них колонки плавно колышутся сами.
const EQ_BANDS = 14, EQ_FPS = 30;
function drawSideEq(c, w, h, time, portrait, levels) {
  const n = portrait ? 26 : 22, top = h * 0.14, bottom = h * 0.84, step = (bottom - top) / n, th = Math.max(8, step * 0.42), maxLen = w * (portrait ? 0.07 : 0.05);
  c.fillStyle = "#ffffffe6";
  for (let k = 0; k < n; k++) {
    const lv = levels ? levels[Math.min(EQ_BANDS - 1, Math.floor(((n - 1 - k) / n) * EQ_BANDS))] : 0.35 + 0.3 * Math.sin(time * 1.3 + k * 0.5);
    const len = maxLen * (0.1 + 0.9 * lv);
    const y = top + k * step;
    roundRect(c, w * 0.025, y, len, th, th / 2);
    c.fill();
    roundRect(c, w * 0.975 - len, y, len, th, th / 2);
    c.fill();
  }
}
// Спектр песни раунда: декодируем кусок, считаем FFT, сглаживаем (быстро вверх, медленно вниз).
const eqCache = new Map(); // ключ → Promise, а после готовности ещё и данные в eqReady
const eqReady = new Map();
function fftMag(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [re[i], re[j]] = [re[j], re[i]], [im[i], im[j]] = [im[j], im[i]];
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k], vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}
const eqKey = (r) => r.id + ":" + guessStart(r) + ":" + r.guess;
function eqLevels(r) {
  const key = eqKey(r);
  if (!eqCache.has(key))
    eqCache.set(key, (async () => {
      const res = await fetch(clipURL({ id: r.id, offset: guessStart(r) }, r.guess));
      const ctx = new AudioContext();
      const buf = await ctx.decodeAudioData(await res.arrayBuffer());
      ctx.close();
      const ch = buf.getChannelData(0), sr = buf.sampleRate, N = 2048, frames = Math.ceil(r.guess * EQ_FPS) + 1;
      const edges = Array.from({ length: EQ_BANDS + 1 }, (_, i) => 50 * Math.pow(9000 / 50, i / EQ_BANDS)); // 50 Гц … 9 кГц
      const raw = [];
      for (let f = 0; f < frames; f++) {
        const start = Math.floor((f / EQ_FPS) * sr), re = new Float64Array(N), im = new Float64Array(N);
        for (let i = 0; i < N; i++) re[i] = (ch[start + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
        fftMag(re, im);
        raw.push(Array.from({ length: EQ_BANDS }, (_, b) => {
          const lo = Math.max(1, Math.floor((edges[b] * N) / sr)), hi = Math.max(lo + 1, Math.floor((edges[b + 1] * N) / sr));
          let sum = 0;
          for (let k = lo; k < hi; k++) sum += Math.hypot(re[k], im[k]);
          return Math.log10(1 + (sum / (hi - lo)) * 4);
        }));
      }
      // нормируем по каждой полосе (верхние частоты тише) и сглаживаем во времени
      const peak = Array.from({ length: EQ_BANDS }, (_, b) => Math.max(0.0001, [...raw.map((x) => x[b])].sort((p, q) => p - q)[Math.floor(frames * 0.95)] ?? 0.0001));
      const state = new Array(EQ_BANDS).fill(0), out = [];
      for (const x of raw) {
        out.push(Float32Array.from(state.map((v, b) => (state[b] = v + (clamp(x[b] / peak[b], 0, 1) - v) * (x[b] / peak[b] > v ? 0.55 : 0.12)))));
      }
      eqReady.set(key, out);
      return out;
    })().catch(() => null));
  return eqCache.get(key);
}
// Уровни в момент time секунд от начала угадывания; между кадрами спектра — линейная интерполяция.
function eqAt(r, time) {
  const data = eqReady.get(eqKey(r));
  if (!data) return null;
  const x = clamp(time * EQ_FPS, 0, data.length - 1), i = Math.floor(x), t = x - i, a = data[i], b = data[Math.min(data.length - 1, i + 1)];
  return Float32Array.from(a, (v, k) => v + (b[k] - v) * t);
}
// Надпись «OPENING 1 / название» и искры на прозрачном слое: ffmpeg кладёт его поверх видео.
function drawVideoLabel(c, d, q, win, w, h, portrait) {
  const tag = ((q.version || tagOf(q)) + "").toUpperCase();
  const spark = frameTheme(d).spark;
  sparkle(c, win.x + win.w * 0.03, win.y + win.h * 0.06, w * 0.018, spark);
  sparkle(c, win.x + win.w * 0.97, win.y + win.h * 0.94, w * 0.022, spark);
  if (true) return; // подпись теперь рядом с обложкой, в окне остаются только искры
  const x = win.x + win.w * 0.04;
  c.save();
  c.textAlign = "left";
  const draw = (text, y, size, fill) => {
    c.font = "italic 900 " + size + "px " + FONTS[d.font];
    while (c.measureText(text).width > win.w * 0.9 && size > 14) {
      size -= 2;
      c.font = "italic 900 " + size + "px " + FONTS[d.font];
    }
    c.textBaseline = "middle";
    c.lineJoin = "round";
    c.lineWidth = size * 0.22;
    c.strokeStyle = "#ffffff";
    c.strokeText(text, x, y);
    c.fillStyle = fill;
    c.fillText(text, x, y);
  };
  const base = win.y + win.h - (portrait ? 70 : 62);
  draw(tag, base - (portrait ? 56 : 50), portrait ? 46 : 42, "#ff8a1f");
  draw(q.anime.toUpperCase(), base, portrait ? 56 : 50, "#2a7bff");
  c.restore();
}
const easeOut = (x) => 1 - Math.pow(1 - x, 3);
const backOut = (x) => 1 + 2.7 * Math.pow(x - 1, 3) + 1.7 * Math.pow(x - 1, 2);
// Сколько секунд длится появление ответа (рамка, обложка, подписи); дальше кадр держится.
const revealAnim = (r) => clamp(r.reveal * 0.9, 0.8, 1.4);
const NEED_Q = ["guess", "answer", "reveal", "video", "vbg", "vlabel"];
function paintScene(canvas, index, scene) {
  if (["reveal", "video", "vbg"].includes(scene.type)) scene = { ...scene, type: "answer" }; // ответ и видео — одна сцена
  const s = state.applied, d = design(), q = scene.sample ?? state.plan[index];
  if (!s || (!q && NEED_Q.includes(scene.type))) return;
  const portrait = s.format === "short", w = portrait ? 1080 : 1920, h = portrait ? 1920 : 1080;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const c = canvas.getContext("2d"), P = d.palette, ink = inkOf(d), pop = d.background === "pop";
  const time = scene.time ?? 0, ci = scene.colorIndex ?? index, win = videoWin(w, h, portrait);
  window.designFont = FONTS[d.font];
  try {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.clearRect(0, 0, w, h);
    if (scene.type === "vlabel") return drawVideoLabel(c, d, q, win, w, h, portrait);
    drawBackground(c, w, h, d, { index: ci, time });
    c.textBaseline = "middle";
    if (!pop) {
      c.fillStyle = ink.top;
      c.font = "bold " + (portrait ? 33 : 27) + "px Consolas, monospace";
      c.textAlign = "left";
      c.fillText("FRAMEQUIZ  /  ANIME SONGS", w * 0.06, h * 0.065);
    }
    if (scene.type === "intro" || scene.type === "outro") {
      const t = d[scene.type];
      if (pop) {
        outlined(c, d, t.title, w * 0.5, h * (t.langs ? 0.1 : 0.4), w * 0.9, portrait ? 110 : 120, "#ffffff", "#00000040");
        if (t.langs) {
          const secs = scene.guessSecs ?? 10, rows = LANGS.length, top = h * (portrait ? 0.2 : 0.2), rowH = (h * (portrait ? 0.75 : 0.72)) / rows;
          const panelX = portrait ? w * 0.06 : w * 0.3, panelW = portrait ? w * 0.88 : w * 0.64;
          LANGS.forEach(([code, text], i) => {
            const y = top + i * rowH + rowH / 2, hh = rowH * 0.82;
            c.fillStyle = "#00000038";
            roundRect(c, panelX, y - hh / 2, panelW, hh, hh / 2);
            c.fill();
            drawFlag(c, code, panelX + hh / 2, y, hh * 0.46);
            c.font = "italic 900 " + hh * 0.46 + "px " + FONTS[d.font];
            c.fillStyle = "#ffffff";
            c.textAlign = "left";
            let line = text.replace("{n}", secs), size = hh * 0.46;
            while (c.measureText(line).width > panelW - hh * 1.3 && size > 10) {
              size -= 2;
              c.font = "italic 900 " + size + "px " + FONTS[d.font];
            }
            c.fillText(line, panelX + hh * 1.1, y);
          });
        } else outlined(c, d, t.subtitle, w * 0.5, h * 0.55, w * 0.84, portrait ? 60 : 56, "#ffffff", "#00000040");
        return;
      }
      fitted(c, t.title, w * 0.5, h * 0.4, w * 0.84, h * 0.3, portrait ? 130 : 120, 900, ink.top);
      fitted(c, t.subtitle, w * 0.5, h * (portrait ? 0.77 : 0.8), w * 0.78, h * 0.12, portrait ? 56 : 52, 600, ink.bottom);
      c.fillStyle = P.accent;
      roundRect(c, w * 0.38, h * 0.62, w * 0.24, Math.max(10, h * 0.008), 6);
      c.fill();
      return;
    }
    if (!pop) {
      c.textAlign = "right";
      c.fillStyle = ink.top;
      c.font = "bold " + (portrait ? 33 : 27) + "px Consolas, monospace";
      c.fillText("ROUND " + String(index + 1).padStart(2, "0") + " / " + String(scene.count ?? state.plan.length).padStart(2, "0"), w * 0.94, h * 0.065);
    }
    c.textAlign = "center";
    if (scene.type === "guess") {
      const g = d.guess, cx = w * 0.5, cy = h * (portrait ? 0.45 : 0.5), r = Math.min(w, h) * (portrait ? 0.3 : 0.27);
      const title = g.title.replace("{n}", String(index + 1));
      if (g.titleStyle === "outline") outlined(c, d, title, w * 0.5, h * (pop ? 0.1 : 0.17), w * 0.8, portrait ? 120 : 110, "#ffffff", pop ? "#00000040" : P.dark);
      else fitted(c, title, w * 0.5, h * 0.17, w * 0.86, h * 0.13, portrait ? 92 : 96, 850, ink.top);
      if (g.sides === "eq") drawSideEq(c, w, h, time, portrait, scene.levels);
      const frac = scene.frac ?? scene.left / scene.total, tick = Math.floor(time * 3);
      if (g.picture === "vinyl") {
        c.fillStyle = "#120d10";
        c.beginPath();
        c.arc(cx, cy, r, 0, 7);
        c.fill();
        c.strokeStyle = "#ffffff1c";
        c.lineWidth = 3;
        for (let k = 0.5; k < 0.95; k += 0.1) {
          c.beginPath();
          c.arc(cx, cy, r * k, 0, 7);
          c.stroke();
        }
        c.fillStyle = P.accent;
        c.beginPath();
        c.arc(cx, cy, r * 0.3, 0, 7);
        c.fill();
        c.fillStyle = P.light;
        c.font = "bold " + r * 0.3 + "px Arial, sans-serif";
        c.fillText("?", cx, cy + r * 0.02);
      } else if (g.picture === "frame") {
        const fw = r * 1.7, fh = r * 1.7;
        c.fillStyle = "#00000040";
        roundRect(c, cx - fw / 2, cy - fh / 2, fw, fh, 36);
        c.fill();
        c.strokeStyle = P.accent;
        c.lineWidth = 8;
        c.stroke();
        c.fillStyle = P.light;
        c.font = "bold " + r * 0.7 + "px Arial, sans-serif";
        c.fillText("?", cx, cy + r * 0.04);
      } else if (g.picture === "equalizer") {
        const n = 17, gap = r * 0.06, bw = (r * 1.9 - gap * (n - 1)) / n;
        for (let k = 0; k < n; k++) {
          const hh = r * (0.3 + 0.9 * Math.abs(Math.sin(k * 1.7 + tick * 2.3 + 1)));
          c.fillStyle = k % 2 ? P.accent : P.light;
          roundRect(c, cx - r * 0.95 + k * (bw + gap), cy - hh / 2, bw, hh, bw / 2);
          c.fill();
        }
      }
      const num = Math.max(1, scene.left ?? Math.ceil((1 - frac) * scene.total)), tY = h * (portrait ? 0.84 : 0.875);
      if (g.timer === "disc") {
        const R = Math.min(w, h) * (portrait ? 0.2 : 0.2), pair = popPair(d, ci), dcy = h * (portrait ? 0.45 : 0.5);
        drawAura(c, cx, dcy, R * 1.28, time, auraColor(d));
        c.lineCap = "round";
        c.lineWidth = R * 0.28;
        c.strokeStyle = "#ffffff55";
        c.beginPath();
        c.arc(cx, dcy, R * 1.28, 0, 7);
        c.stroke();
        c.strokeStyle = "#ffffff";
        c.beginPath();
        c.arc(cx, dcy, R * 1.28, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.002, frac));
        c.stroke();
        const grad = c.createLinearGradient(cx, dcy - R, cx, dcy + R);
        grad.addColorStop(0, pair[0]);
        grad.addColorStop(1, pair[1]);
        c.fillStyle = grad;
        c.shadowColor = "#0004";
        c.shadowBlur = R * 0.3;
        c.beginPath();
        c.arc(cx, dcy, R, 0, 7);
        c.fill();
        c.shadowBlur = 0;
        c.strokeStyle = "#ffffff80";
        c.lineWidth = R * 0.05;
        c.stroke();
        fitted(c, String(num), cx, dcy, R * 1.2, R * 1.2, Math.round(R * 1.15), 900, "#ffffff");
      } else if (g.timer !== "none") {
        c.fillStyle = ink.bottom;
        c.font = "bold " + (portrait ? 28 : 26) + "px Consolas, monospace";
        c.fillText(g.timerLabel, w * 0.5, h * (portrait ? 0.775 : 0.8));
      }
      if (g.timer === "number") fitted(c, String(num), w * 0.5, tY, w * 0.3, h * 0.1, portrait ? 150 : 130, 900, ink.bottom);
      if (g.timer === "ring") {
        const rr = h * 0.055;
        c.lineWidth = rr * 0.22;
        c.strokeStyle = "#ffffff30";
        c.beginPath();
        c.arc(w * 0.5, tY, rr, 0, 7);
        c.stroke();
        c.strokeStyle = P.accent;
        c.lineCap = "round";
        c.beginPath();
        c.arc(w * 0.5, tY, rr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.001, frac));
        c.stroke();
        fitted(c, String(num), w * 0.5, tY, rr * 1.3, rr * 1.3, Math.round(rr), 900, ink.bottom);
      }
      if (g.bar === "line") {
        const b = barGeom(w, h, portrait);
        c.fillStyle = "#ffffff30";
        roundRect(c, b.x, b.y, b.w, b.h, b.h / 2);
        c.fill();
        if (!scene.noBar) {
          c.fillStyle = barColorOf(d);
          roundRect(c, b.x, b.y, Math.max(b.h, b.w * frac), b.h, b.h / 2);
          c.fill();
        }
      }
      return;
    }
    // Ответ: заголовок, рамка плеера, обложка слева сверху над плеером, подписи справа от обложки.
    // appear (0..1) — ход появления; само видео кладёт ffmpeg в окно плеера.
    const th = frameTheme(d), cb = coverBox(w, h, portrait), A = scene.appear ?? 1;
    const seg = (a, b) => easeOut(clamp((A - a) / (b - a), 0, 1));
    c.save();
    c.globalAlpha = seg(0, 0.3);
    c.translate(0, -(1 - seg(0, 0.3)) * h * 0.03);
    const label = d.reveal.label;
    if (pop) outlined(c, d, label, w * 0.5, h * (portrait ? 0.075 : 0.08), w * 0.8, portrait ? 100 : 90, "#ffffff", "#00000040");
    else {
      c.fillStyle = P.accent;
      c.font = "bold " + (portrait ? 30 : 28) + "px Consolas, monospace";
      const lw = c.measureText(label).width + 50;
      c.fillRect((w - lw) / 2, h * 0.055, lw, 54);
      c.fillStyle = lum(P.accent) > 0.55 ? P.text : P.light;
      c.fillText(label, w * 0.5, h * 0.055 + 27);
    }
    c.restore();
    // рамка плеера: появляется с лёгким ростом; тёмное окно под видео
    {
      const fa = seg(0.05, 0.45), k = 0.96 + 0.04 * backOut(clamp((A - 0.05) / 0.4, 0, 1)), mx = win.x + win.w / 2, my = win.y + win.h / 2;
      c.save();
      c.globalAlpha = fa;
      c.translate(mx, my);
      c.scale(k, k);
      c.translate(-mx, -my);
      cardFrame(c, th, win.x - 16, win.y - 16, win.w + 32, win.h + 32, VIDEO_RADIUS + 16);
      c.fillStyle = th.inner;
      roundRect(c, win.x, win.y, win.w, win.h, VIDEO_RADIUS);
      c.fill();
      c.restore();
    }
    // обложка в рамке
    const ar = scene.img ? scene.img.width / scene.img.height : 0.7, ih = cb.h, iw = ih * ar, ix = cb.x, iy = cb.y;
    if (scene.img) {
      const fa = seg(0.2, 0.6), ca = seg(0.45, 0.85), grow = 0.8 + 0.2 * backOut(clamp((A - 0.2) / 0.5, 0, 1)), zoom = 0.1 * (1 - ca);
      const pic = () => c.drawImage(scene.img, ix - (iw * zoom) / 2, iy - (ih * zoom) / 2, iw * (1 + zoom), ih * (1 + zoom));
      c.save();
      c.translate(ix + iw / 2, iy + ih / 2);
      c.scale(grow, grow);
      c.translate(-(ix + iw / 2), -(iy + ih / 2));
      c.globalAlpha = fa;
      cardFrame(c, th, ix - 14, iy - 14, iw + 28, ih + 28, 26);
      c.save();
      c.globalAlpha = fa * ca;
      roundRect(c, ix, iy, iw, ih, 16);
      c.clip();
      pic();
      c.restore();
      c.globalAlpha = fa * ca;
      sparkle(c, ix - 6, iy + 8, w * 0.02, th.spark);
      sparkle(c, ix + iw + 8, iy + ih - 8, w * 0.024, th.spark);
      c.restore();
    }
    // подписи справа от обложки выезжают по очереди
    const tag = (q.version || tagOf(q)) + " · " + q.title, bx = ix + iw + 14 + w * 0.03, bw = w - bx - w * 0.05, bcx = bx + bw / 2, bcy = iy + ih / 2;
    const rise = (a, b) => {
      const k = seg(a, b);
      c.globalAlpha = k;
      c.translate((1 - k) * w * 0.05, 0);
    };
    c.save();
    if (pop) {
      rise(0.55, 0.85);
      outlined(c, d, tag.toUpperCase(), bcx, bcy - ih * 0.2, bw, portrait ? 50 : 44, th.tag);
      c.restore();
      c.save();
      rise(0.65, 0.95);
      outlined(c, d, q.anime.toUpperCase(), bcx, bcy + ih * 0.12, bw, portrait ? 60 : 54, th.name);
      if (q.ru) {
        c.restore();
        c.save();
        rise(0.75, 1);
        fitted(c, q.ru, bcx, bcy + ih * 0.38, bw, ih * 0.2, portrait ? 30 : 28, 700, ink.bottom);
      }
    } else {
      rise(0.55, 0.9);
      fitted(c, q.anime, bcx, bcy - ih * 0.12, bw, ih * 0.34, portrait ? 60 : 54, 850, ink.top);
      fitted(c, tagOf(q) + " · " + q.title, bcx, bcy + ih * 0.22, bw, ih * 0.22, portrait ? 38 : 34, 700, ink.top);
      if (q.ru) fitted(c, q.ru, bcx, bcy + ih * 0.42, bw, ih * 0.16, portrait ? 28 : 26, 600, ink.top + "bb");
    }
    c.restore();
  } finally {
    window.designFont = null;
  }
}

// ---- Раздел «Дизайн»: промт → шаблон ----
const DESIGN_HELP = `Ты помогаешь оформить видео-викторину «угадай аниме по опенингу». Нужно вернуть JSON шаблона сцен. Все поля необязательны, лишние поля игнорируются.
Схема:
{
 "name": "короткое имя стиля",
 "palette": {"bg":"#rrggbb","accent":"#rrggbb","mid":"#rrggbb","dark":"#rrggbb","text":"#rrggbb","light":"#rrggbb"},
 "background": "pop | sunset | gradient | stars | grid | solid",
 "cycle": true,
 "soft": false,
 "neon": false,
 "barColor": "#ffffff",
 "font": "Arial | Impact | Georgia | Trebuchet MS | Verdana | Consolas",
 "guess": {"title":"текст вопроса, {n} = номер раунда","picture":"vinyl | frame | equalizer | none","timer":"disc | number | ring | none","timerLabel":"подпись таймера","bar":"line | none","sides":"eq | none","titleStyle":"outline | plain"},
 "reveal": {"label":"подпись ответа","frame":"card | rounded | polaroid | circle"},
 "video": {"frame":"card | plain","label":true},
 "transition": "smooth | flash | none",
 "fade": 0.8,
 "intro": {"on":true,"title":"...","subtitle":"...","secs":3,"langs":true},
 "outro": {"on":true,"title":"...","subtitle":"...","secs":3,"langs":false}
}
Смысл: neon true — тёмный неоновый вариант pop (чёрно-багровый фон, затмение, шипы, летящие угли; текст светлый); soft true — мягкий пастельный вариант pop с японскими мотивами (солнце, облака, волны, лепестки сакуры); barColor — цвет полосы времени в стиле pop (например зелёный #5cc98a); background "pop" — яркий мультяшный фон с диагональными линиями и контурными фигурами; при "cycle":true цвет фона меняется от раунда к раунду, а palette почти не используется (accent оставь белым). Для остальных фонов: bg — светлая верхняя часть, dark — тёмная нижняя, accent — цвет полосы времени и подписей, mid — средний тон, text — тёмный цвет текста на светлом, light — светлый цвет текста на тёмном.
guess.timer "disc" — круглый диск с цифрой и белой дугой вокруг; guess.sides "eq" — живые колонки-эквалайзеры по бокам; guess.bar "line" — плавная полоса времени внизу. Экран угадывания: сверху вопрос, в центре место под картинку (picture) или диск таймера, снизу полоса. Затем экран ответа (reveal) с обложкой, потом видео: video.frame "card" — видео в белой скруглённой рамке с искрами, video.label — подпись «OPENING 1 / название» поверх видео. transition "smooth" — плавное затухание и появление между частями, fade — его длительность в секундах (0.3–2); transition "flash" — белая вспышка между раундами. intro.langs — плашка «угадай опенинг за N секунд» на девяти языках с флагами.
Обеспечь контраст текста с фоном. Тексты на экране — на английском (ролик англоязычный), если пользователь не просит иначе. Ответь только JSON без пояснений.`;
function designPrompt(wish) {
  return DESIGN_HELP + "\n\nТекущий шаблон:\n" + JSON.stringify(design()) + "\n\nПожелание пользователя: " + (wish || "сделай красиво");
}
function parseDesignReply(text) {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) throw Error("В ответе нет JSON.");
  try {
    return normalizeDesign(JSON.parse(text.slice(a, b + 1)));
  } catch {
    throw Error("Не удалось прочитать JSON из ответа.");
  }
}
async function askClaude(wish) {
  const key = localStorage.getItem("framequiz-claude-key");
  if (!key) throw Error("Вставьте ключ Claude API ниже или скопируйте промт и отправьте его Claude вручную.");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 2000, messages: [{ role: "user", content: designPrompt(wish) }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(data.error?.message || "Claude API вернул ошибку " + res.status);
  return data.content?.map((x) => x.text ?? "").join("") ?? "";
}
function renderDesign(only) {
  state.applied ??= { ...defaults, quiz: "music" };
  const sample = state.plan?.[0] ?? tracks[0] ?? SAMPLE, count = Math.max(1, state.plan?.length || tl.rounds.length || 5);
  const first = sample.id ? sample : null;
  const draw = (id, scene) => {
    const canvas = $(id);
    paintScene(canvas, 0, { sample: { ...SAMPLE, ...sample }, count, ...scene });
    if (scene.type === "reveal" && first)
      loadCover(first.id).then((img) => img && paintScene(canvas, 0, { sample: { ...SAMPLE, ...sample }, count, ...scene, img }));
  };
  const go = (id, scene) => (!only || only === id) && draw(id, scene);
  const total = 10, left = Math.max(1, Math.ceil((1 - $("designTime").value / 100) * total));
  const guessSecs = tl.rounds[0]?.guess ?? 10, t = ($("designTime").value / 100) * total;
  go("dpIntro", { type: "intro", colorIndex: 0, guessSecs, time: t });
  go("dpGuess", { type: "guess", left, total, frac: 1 - $("designTime").value / 100, colorIndex: 1, time: t });
  go("dpReveal", { type: "answer", colorIndex: 2, appear: designPlay.appear });
  go("dpOutro", { type: "outro", colorIndex: 4, guessSecs, time: t });
  if (only) return;
  $("designJson").textContent = JSON.stringify(design(), null, 1);
  $("designFormat").textContent = state.applied.format === "short" ? "Shorts 9:16" : "YouTube 16:9";
}
async function openDesign() {
  tracks = await api("tracks", {});
  $("claudeKey").value = localStorage.getItem("framequiz-claude-key") ? "••••••••" : "";
  renderDesign();
}
function setDesign(next, note) {
  state.design = next;
  save();
  tl.lastKey = "";
  renderDesign();
  $("designStatus").textContent = note;
}
// Живой просмотр экрана угадывания: ползунок едет сам, видно, как движутся таймер, полоса и фон.
function designPlay() {
  const btn = $("designPlay");
  if (designPlay.raf) {
    cancelAnimationFrame(designPlay.raf);
    designPlay.raf = 0;
    designPlay.appear = undefined;
    btn.textContent = "▶ Анимация";
    renderDesign();
    return;
  }
  btn.textContent = "Ⅱ Стоп";
  const t0 = performance.now(), total = 10;
  const step = (now) => {
    if ($("design").hidden) return designPlay();
    $("designTime").value = ((((now - t0) / 1000) % total) / total) * 100;
    designPlay.appear = clamp(((((now - t0) / 1000) % 3) / 1.4), 0, 1);
    renderDesign("dpGuess");
    renderDesign("dpReveal");
    designPlay.raf = requestAnimationFrame(step);
  };
  designPlay.raf = requestAnimationFrame(step);
}
function initDesign() {
  $("designTime").oninput = () => renderDesign();
  $("designPlay").onclick = designPlay;
  $("claudeKey").onchange = () => {
    const v = $("claudeKey").value.trim();
    if (v && !v.startsWith("•")) localStorage.setItem("framequiz-claude-key", v);
    if (!v) localStorage.removeItem("framequiz-claude-key");
    $("claudeKey").value = localStorage.getItem("framequiz-claude-key") ? "••••••••" : "";
  };
  button("designGen", async () => {
    $("designGen").disabled = true;
    $("designStatus").textContent = "Claude придумывает шаблон…";
    try {
      setDesign(parseDesignReply(await askClaude($("designPrompt").value.trim())), "Готово. Посмотрите сцены справа и уточните описание, если нужно.");
    } catch (e) {
      $("designStatus").textContent = e.message;
    } finally {
      $("designGen").disabled = false;
    }
  });
  button("designCopy", async () => {
    await navigator.clipboard.writeText(designPrompt($("designPrompt").value.trim()));
    $("designStatus").textContent = "Промт скопирован. Отправьте его Claude, а ответ вставьте в поле «Вставить ответ вручную».";
  });
  button("designApply", () => {
    setDesign(parseDesignReply($("designPaste").value), "Шаблон применён.");
    $("designPaste").value = "";
  });
  button("designPop", () => setDesign(structuredClone(DESIGN_POP), "Включён стиль Pop: яркий фон, диск-таймер, видео в рамке."));
  button("designSoft", () => setDesign(structuredClone(DESIGN_SOFT), "Включён стиль Soft: пастель, японские мотивы, зелёная полоса времени."));
  button("designNeon", () => setDesign(structuredClone(DESIGN_NEON), "Включён стиль Neon: тёмное фэнтези, багровое затмение, красная полоса времени."));
  button("designSolar", () => setDesign(structuredClone(DESIGN_SOLAR), "Включён стиль Solar."));
  document.querySelectorAll("[data-dfmt]").forEach((b) => {
    b.onclick = () => {
      state.applied ??= { ...defaults, quiz: "music" };
      state.applied.format = cfg.format = b.dataset.dfmt;
      save();
      renderDesign();
    };
  });
}

// ---- Таймлайн: итоговый редактор. Раунд = угадывание + ответ с обложкой + видео с пиком ----
const TEMPLATE = { guess: 10, reveal: 4, video: 12 };
const SEG_MIN = { guess: 3, reveal: 1, video: 2 }, SEG_MAX = { guess: 20, reveal: 10, video: 40 };
const CLS = { guess: "intro", reveal: "answer", video: "clip" };
const tl = { rounds: [], sel: 0, zoom: 10, head: 0, magnet: true, undo: [], redo: [], playing: false, lastKey: "", audio: null, audioKey: "" };
const rlen = (r) => r.guess + r.reveal + r.video;
const leadSecs = () => (design().intro.on ? design().intro.secs : 0);
const tailSecs = () => (design().outro.on ? design().outro.secs : 0);
const roundsTotal = () => tl.rounds.reduce((n, r) => n + rlen(r), 0);
const tlTotal = () => leadSecs() + roundsTotal() + tailSecs();
const trackOf = (r) => tracks.find((t) => t.id === r.id);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const trackSecs = (r) => Math.floor(trackOf(r).durationMs / 1000);
// Сколько секунд можно отдать части раунда: ограничено шаблоном, 60 с на раунд и длиной песни.
function limitFor(r, kind) {
  const others = rlen(r) - r[kind];
  return Math.max(SEG_MIN[kind], Math.min(SEG_MAX[kind], 60 - others, trackSecs(r) - r.offset - others));
}
// Shorts: весь ролик не длиннее минуты. Сжимаем части раундов пропорционально (пик песни остаётся на месте),
// а если даже минимумов не хватает — убираем лишние раунды с конца.
const SHORTS_MAX = 60;
function fitShorts() {
  if (state.applied?.format !== "short" || tlTotal() <= SHORTS_MAX) return;
  const before = tlTotal(), count = tl.rounds.length;
  commit();
  const budget = SHORTS_MAX - leadSecs() - tailSecs();
  const minLen = SEG_MIN.guess + SEG_MIN.reveal + SEG_MIN.video;
  tl.rounds = tl.rounds.slice(0, Math.max(1, Math.floor(budget / minLen)));
  const k = budget / roundsTotal();
  for (const r of tl.rounds) {
    const peak = peakStart(r);
    for (const kind of ["guess", "reveal", "video"]) r[kind] = Math.max(SEG_MIN[kind], Math.floor(r[kind] * k * 2) / 2);
    r.offset = clamp(peak - r.guess - r.reveal, 0, Math.max(0, trackSecs(r) - rlen(r)));
  }
  // Остаток из-за минимумов добираем с самых длинных частей.
  while (tlTotal() > SHORTS_MAX) {
    let best = null;
    for (const r of tl.rounds) for (const kind of ["guess", "reveal", "video"]) if (r[kind] - 0.5 >= SEG_MIN[kind] && (!best || r[kind] > best[0][best[1]])) best = [r, kind];
    if (!best) break;
    best[0][best[1]] -= 0.5;
  }
  state.timeline = tl.rounds;
  tl.sel = clamp(tl.sel, 0, tl.rounds.length - 1);
  tl.lastKey = "";
  toast("Shorts: " + Math.round(before) + " → " + Math.round(tlTotal()) + " с" + (tl.rounds.length < count ? ", убрано раундов: " + (count - tl.rounds.length) : ""));
}
function tlStarts() {
  let t = leadSecs();
  return tl.rounds.map((r) => {
    const s = t;
    t += rlen(r);
    return s;
  });
}
function syncPlan() {
  state.plan = tl.rounds.map((r) => ({ ...trackOf(r), offset: r.offset }));
  return state.plan;
}
function locate(time) {
  const lead = leadSecs(), end = lead + roundsTotal(), last = Math.max(0, tl.rounds.length - 1);
  if (time < lead) return { i: 0, section: "intro", rel: time };
  if (time >= end && tailSecs() > 0) return { i: last, section: "outro", rel: time - end };
  const starts = tlStarts();
  let i = starts.findLastIndex((s) => s <= time);
  if (i < 0) i = 0;
  const r = tl.rounds[i], rel = Math.min(time - starts[i], rlen(r) - 0.001);
  const section = rel < r.guess ? "guess" : rel < r.guess + r.reveal ? "reveal" : "video";
  return { i, section, rel };
}
function commit() {
  tl.undo.push(structuredClone(tl.rounds));
  if (tl.undo.length > 100) tl.undo.shift();
  tl.redo = [];
}
function uncommitIfUnchanged() {
  if (JSON.stringify(tl.rounds) === JSON.stringify(tl.undo.at(-1))) tl.undo.pop();
}
function tlSave() {
  state.timeline = tl.rounds;
  tl.sel = clamp(tl.sel, 0, Math.max(0, tl.rounds.length - 1));
  save();
  renderTimeline();
}
function place(node, left, width) {
  node.style.left = left + "px";
  node.style.width = Math.max(2, width) + "px";
}
function stageX(e) {
  return e.clientX - $("tlStage").getBoundingClientRect().left;
}
// Захват указателя на самой сцене: она не пересоздаётся при перерисовке клипов.
function dragger(e, onMove, onUp) {
  const stage = $("tlStage");
  stage.setPointerCapture(e.pointerId);
  const x0 = e.clientX;
  const move = (ev) => onMove(ev.clientX - x0);
  const up = (ev) => {
    stage.removeEventListener("pointermove", move);
    stage.removeEventListener("pointerup", up);
    stage.removeEventListener("pointercancel", up);
    onUp?.(ev.clientX - x0);
  };
  stage.addEventListener("pointermove", move);
  stage.addEventListener("pointerup", up);
  stage.addEventListener("pointercancel", up);
}
function seek(time) {
  tl.head = clamp(time, 0, tlTotal());
  if (tl.playing) {
    tl.h0 = tl.head;
    tl.t0 = performance.now();
    stopTlAudio();
  }
  updateHead(true);
}
function updateHead(force) {
  const head = $("tlHead");
  if (head) head.style.left = tl.head * tl.zoom + "px";
  $("tlTime").textContent = fmtTenths(tl.head) + " / " + fmt(Math.ceil(tlTotal()));
  $("tlWhere").textContent = whereLabel();
  drawPreview(force);
}
const fmtTenths = (t) => {
  const s = Math.floor(t * 10) / 10;
  return Math.floor(s / 60) + ":" + (s % 60).toFixed(1).padStart(4, "0");
};
// Где сейчас playhead: раунд, часть и точная секунда внутри неё.
function whereLabel() {
  if (!tl.rounds.length) return "";
  const { i, section, rel } = locate(tl.head), r = tl.rounds[i];
  const names = { intro: "Интро", outro: "Аутро", guess: "Угадывание", reveal: "Ответ", video: "Видео" };
  const local = { intro: rel, outro: rel, guess: rel, reveal: rel - r.guess, video: rel - r.guess - r.reveal }[section];
  const secs = { intro: leadSecs(), outro: tailSecs(), guess: r.guess, reveal: r.reveal, video: r.video }[section];
  const head = section === "intro" || section === "outro" ? "" : "Раунд " + (i + 1) + " · ";
  return head + names[section] + " " + Math.max(0, local).toFixed(1) + " / " + secs + " с";
}
function drawPreview(force) {
  if (!tl.rounds.length || !state.applied) return;
  const { i, section, rel } = locate(tl.head);
  const r = tl.rounds[i];
  const frac = section === "guess" ? clamp(1 - rel / r.guess, 0, 1) : 1;
  const isAnswer = section === "reveal" || section === "video", appear = isAnswer ? clamp((rel - r.guess - 0.3) / revealAnim(r), 0, 1) : undefined;
  const key = i + ":" + section + (section === "guess" ? ":" + Math.floor(rel * 24) : appear !== undefined && appear < 1 ? ":" + Math.floor(appear * 30) : "");
  if (section === "guess" && !eqReady.has(eqKey(r))) eqLevels(r).then(() => (tl.lastKey = ""));
  if (!force && key === tl.lastKey) return;
  tl.lastKey = key;
  syncPlan();
  const canvas = $("tlPreview");
  canvas.style.filter = section === "intro" || section === "outro" ? "none" : previewFilter(i, section);
  if (section === "intro" || section === "outro") return paintScene(canvas, i, { type: section, guessSecs: tl.rounds[0].guess, time: tl.head });
  if (section === "guess") return paintScene(canvas, i, { type: "guess", left: Math.max(1, Math.ceil(r.guess - rel)), total: r.guess, frac, time: rel, levels: eqAt(r, rel) });
  const scene = { type: isAnswer ? "answer" : section, appear, time: isAnswer ? rel : 0 };
  paintScene(canvas, i, scene);
  loadCover(r.id).then((img) => {
    if (img && tl.lastKey === key) paintScene(canvas, i, { ...scene, img });
  });
}
function renderStage() {
  const stage = $("tlStage"), z = tl.zoom, total = tlTotal(), starts = tlStarts(), lead = leadSecs(), tail = tailSecs();
  stage.style.width = total * z + 120 + "px";
  const ruler = el("div");
  ruler.className = "tl-ruler";
  const step = z >= 24 ? 1 : z >= 12 ? 2 : z >= 6 ? 5 : 10;
  for (let t = 0; t <= total + 10; t += step) {
    const tick = el("div", fmt(t));
    tick.className = "tl-tick";
    tick.style.left = t * z + "px";
    ruler.append(tick);
  }
  ruler.onpointerdown = (e) => {
    seek(stageX(e) / z);
    dragger(e, (dx) => seek((stageX(e) + dx) / z));
  };
  const nodes = [ruler];
  const cardBlock = (label, at, secs) => {
    const hdr = el("div", label);
    hdr.className = "tl-round card";
    place(hdr, at * z, secs * z);
    const seg = el("div", label + " · " + secs + " с");
    seg.className = "tl-seg card";
    seg.title = label + ". Настраивается во вкладке «Дизайн»";
    place(seg, at * z, secs * z);
    nodes.push(hdr, seg);
  };
  if (lead) cardBlock("Интро", 0, lead);
  tl.rounds.forEach((r, i) => {
    const t = trackOf(r), x = starts[i] * z, selected = i === tl.sel ? " sel" : "";
    const hdr = el("div", "Round " + (i + 1) + " · " + tagOf(t) + " · " + (t.ru || t.anime));
    hdr.className = "tl-round" + selected;
    place(hdr, x, rlen(r) * z);
    hdr.onpointerdown = (e) => roundDown(e, i, hdr);
    nodes.push(hdr);
    const parts = [
      ["guess", "Round " + (i + 1) + " · какое это аниме?", 0],
      ["reveal", "Ответ · " + t.anime, r.guess],
      ["video", "MP4 · пик · " + tagOf(t), r.guess + r.reveal],
    ];
    for (const [kind, label, off] of parts) {
      const seg = el("div", label);
      seg.title = label + " · " + r[kind] + " с";
      seg.className = "tl-seg " + CLS[kind] + selected;
      place(seg, x + off * z, r[kind] * z);
      seg.onpointerdown = (e) => segDown(e, i);
      seg.append(handle(i, kind));
      nodes.push(seg);
    }
    const aq = el("div", "Звук вопроса · с " + fmt(guessStart(r)));
    aq.title = "Звук экрана с таймером — другой момент песни. Потяните, чтобы сдвинуть";
    aq.className = "tl-seg audio q" + selected;
    place(aq, x, r.guess * z);
    aq.onpointerdown = (e) => slipGuess(e, i);
    nodes.push(aq);
    const au = el("div", "Звук ответа · пик с " + fmt(peakStart(r)));
    au.title = "Звук ответа — пиковый момент песни. Потяните, чтобы сдвинуть момент";
    au.className = "tl-seg audio" + selected;
    place(au, x + r.guess * z, (r.reveal + r.video) * z);
    au.onpointerdown = (e) => slipDown(e, i);
    nodes.push(au);
  });
  if (tail) cardBlock("Аутро", lead + roundsTotal(), tail);
  const head = el("div");
  head.className = "tl-head";
  head.id = "tlHead";
  nodes.push(head);
  stage.replaceChildren(...nodes);
  updateHead(false);
}
function handle(i, kind) {
  const h = el("i");
  h.className = "h r";
  h.onpointerdown = (e) => edgeDown(e, i, kind);
  return h;
}
function edgeDown(e, i, kind) {
  e.stopPropagation();
  e.preventDefault();
  tl.sel = i;
  commit();
  const start = { ...tl.rounds[i] };
  const edge = tlStarts()[i] + (kind === "guess" ? start.guess : kind === "reveal" ? start.guess + start.reveal : rlen(start));
  dragger(e, (dx) => {
    let d = Math.round(dx / tl.zoom);
    if (tl.magnet && Math.abs((tl.head - edge) * tl.zoom - dx) < 8) d = Math.round(tl.head - edge);
    const r = tl.rounds[i];
    r[kind] = clamp(start[kind] + d, SEG_MIN[kind], limitFor({ ...start }, kind));
    renderStage();
  }, () => {
    uncommitIfUnchanged();
    tlSave();
  });
}
function segDown(e, i) {
  e.preventDefault();
  tl.sel = i;
  renderTimeline();
}
function slipDown(e, i) {
  e.preventDefault();
  tl.sel = i;
  commit();
  const start = tl.rounds[i].offset, max = trackSecs(tl.rounds[i]) - rlen(tl.rounds[i]);
  dragger(e, (dx) => {
    tl.rounds[i].offset = clamp(start - Math.round(dx / tl.zoom), 0, max);
    renderStage();
  }, () => {
    uncommitIfUnchanged();
    tlSave();
  });
}
function slipGuess(e, i) {
  e.preventDefault();
  tl.sel = i;
  commit();
  const r = tl.rounds[i], start = guessStart(r);
  dragger(e, (dx) => {
    r.gOffset = clamp(start - Math.round(dx / tl.zoom), 0, Math.max(0, trackSecs(r) - r.guess - 1));
    renderStage();
  }, () => {
    uncommitIfUnchanged();
    tlSave();
  });
}
function roundDown(e, i, node) {
  e.preventDefault();
  tl.sel = i;
  const z = tl.zoom, starts = tlStarts(), w = rlen(tl.rounds[i]) * z;
  let moved = false;
  dragger(e, (dx) => {
    if (Math.abs(dx) > 4) moved = true;
    if (moved) node.style.transform = "translateX(" + dx + "px)";
  }, (dx) => {
    if (!moved) return renderTimeline();
    const center = starts[i] * z + dx + w / 2;
    const target = tl.rounds.filter((r, j) => j !== i && (starts[j] + rlen(r) / 2) * z < center).length;
    if (target === i) return renderTimeline();
    commit();
    const [item] = tl.rounds.splice(i, 1);
    tl.rounds.splice(target, 0, item);
    tl.sel = target;
    tlSave();
  });
}
// Начало видео (пик) = offset + guess + reveal. Ответ звучит с пика.
const peakStart = (r) => r.offset + r.guess + r.reveal;
// Звук вопроса — другой момент той же песни. Если не выбран вручную, берём кусок за 12 секунд до пика
// (узнаваемая часть до припева); если пик в самом начале, то кусок после него.
function guessStart(r) {
  const dur = trackSecs(r), max = Math.max(0, dur - r.guess - 1);
  if (Number.isFinite(r.gOffset)) return clamp(Math.round(r.gOffset), 0, max);
  const peak = peakStart(r), before = peak - r.guess - 12;
  return clamp(before >= 0 ? before : peak + r.reveal + r.video + 6, 0, max);
}
function setPeak(r, peak) {
  r.offset = clamp(peak - r.guess - r.reveal, 0, Math.max(0, trackSecs(r) - rlen(r)));
}
function renderInspector() {
  const box = $("tlInspector");
  box.replaceChildren();
  const r = tl.rounds[tl.sel];
  if (!r) {
    box.append(el("p", "Соберите раунды во вкладке «Раунды» и нажмите «К таймлайну»."));
    return;
  }
  const t = trackOf(r);
  const title = el("h3", "Round " + (tl.sel + 1) + " · " + (t.ru || t.anime));
  const chip = el("em", tagOf(t));
  chip.className = "chip " + (t.kind || "").toLowerCase();
  const sub = el("small");
  sub.append(chip, " " + t.title + " · " + t.anime + (t.version ? " · " + t.version : ""));
  box.append(title, sub);
  const grid = el("div");
  grid.className = "insp-grid";
  const field = (label, key, min, max) => {
    const wrap = el("div"), inp = el("input");
    inp.type = "number";
    inp.min = min;
    inp.step = 1;
    inp.value = r[key];
    inp.setAttribute("aria-label", label);
    inp.onchange = () => {
      commit();
      r[key] = clamp(Math.round(inp.valueAsNumber) || min, min, max());
      r.offset = clamp(r.offset, 0, Math.max(0, trackSecs(r) - rlen(r)));
      tlSave();
    };
    wrap.append(el("label", label), inp);
    grid.append(wrap);
  };
  field("Угадывание, с", "guess", SEG_MIN.guess, () => limitFor(r, "guess"));
  field("Ответ (обложка), с", "reveal", SEG_MIN.reveal, () => limitFor(r, "reveal"));
  field("Видео (пик), с", "video", SEG_MIN.video, () => limitFor(r, "video"));
  field("Начало песни, с", "offset", 0, () => Math.max(0, trackSecs(r) - rlen(r)));
  box.append(grid);
  const row = el("div");
  row.className = "round-opts";
  const pick = el("button", "Выбрать пик…");
  pick.onclick = run(() => openClip({ ...t, offset: peakStart(r) }, r.video, (o) => {
    commit();
    setPeak(r, o);
    tlSave();
  }));
  const gq = el("button", "♪ Звук вопроса…");
  gq.title = "Выбрать другой момент песни для экрана с таймером";
  gq.onclick = run(() => openClip({ ...t, offset: guessStart(r) }, r.guess, (o) => {
    commit();
    r.gOffset = o;
    tlSave();
  }));
  const peak = el("button", "★ Авто-пик");
  peak.onclick = run(async () => {
    const o = await api("peak", { id: r.id, seconds: r.video });
    commit();
    setPeak(r, o);
    tlSave();
  });
  const swap = el("select");
  swap.setAttribute("aria-label", "Заменить трек");
  swap.append(new Option("Заменить трек…", ""), ...tracks.filter((x) => x.id !== r.id).map((x) => new Option(tagOf(x) + " · " + (x.ru || x.anime) + " · " + x.title, x.id)));
  swap.onchange = () => {
    const n = tracks.find((x) => x.id === swap.value);
    if (!n) return;
    commit();
    delete r.gOffset;
    Object.assign(r, newRound(n, n.offset));
    tlSave();
  };
  row.append(pick, gq, peak, swap);
  box.append(row);
}
function renderTimeline() {
  const scroll = $("tlScroll").scrollLeft;
  renderStage();
  renderInspector();
  $("tlScroll").scrollLeft = scroll;
  $("tlZoom").value = tl.zoom;
  document.querySelectorAll("[data-fmt]").forEach((b) => b.classList.toggle("selected", b.dataset.fmt === (state.applied?.format ?? "short")));
}
async function openTimeline() {
  window.syncTransition?.();
  fillFxRounds();
  renderEffects();
  tracks = await api("tracks", {});
  const before = tl.rounds.length;
  tl.rounds = tl.rounds.filter((r) => r.guess && trackOf(r));
  if (tl.rounds.length !== before) {
    state.timeline = tl.rounds;
    save();
    toast("Из таймлайна убраны раунды старого формата или с удалёнными треками.");
  }
  fitShorts();
  save();
  tl.lastKey = "";
  renderTimeline();
}
const tlVolume = () => clamp(Number(state.tlVol ?? 0.35), 0, 1);
function stopTlAudio() {
  tl.audio?.pause();
  tl.audio = null;
  tl.audioKey = "";
}
function tlStop() {
  cancelAnimationFrame(tl.raf);
  tl.playing = false;
  stopTlAudio();
  $("tlPlay").textContent = "▶";
}
function tlTick(now) {
  if (!tl.playing) return;
  tl.head = tl.h0 + (now - tl.t0) / 1000;
  const total = tlTotal();
  if (tl.head >= total) {
    tl.head = total;
    tlStop();
    updateHead(true);
    return;
  }
  // Вопрос и ответ звучат из разных моментов одной песни; у интро и аутро звука нет.
  const { i, rel, section } = locate(tl.head);
  if (section === "intro" || section === "outro") stopTlAudio();
  else {
    const r = tl.rounds[i], q = section === "guess", from = q ? guessStart(r) : peakStart(r), key = i + ":" + (q ? "q" : "a") + ":" + from + ":" + rlen(r);
    if (tl.audioKey !== key) {
      stopTlAudio();
      const local = q ? rel : rel - r.guess, len = q ? r.guess : r.reveal + r.video, skip = Math.floor(local), left = len - skip;
      if (left >= 1) {
        tl.audio = new Audio(clipURL({ ...trackOf(r), offset: from + skip }, left));
        tl.audio.volume = tlVolume();
        tl.audioKey = key;
        tl.audio.play().catch(() => {});
      }
    }
  }
  const scroll = $("tlScroll"), x = tl.head * tl.zoom;
  if (x > scroll.scrollLeft + scroll.clientWidth - 40) scroll.scrollLeft = x - 40;
  updateHead(false);
  tl.raf = requestAnimationFrame(tlTick);
}
function tlPlay() {
  if (tl.playing) return tlStop();
  if (!tl.rounds.length) return;
  stop();
  if (tl.head >= tlTotal() - 0.05) tl.head = 0;
  Object.assign(tl, { playing: true, t0: performance.now(), h0: tl.head });
  $("tlPlay").textContent = "Ⅱ";
  tl.raf = requestAnimationFrame(tlTick);
}
function setZoom(z) {
  tl.zoom = clamp(Math.round(z), 3, 40);
  renderTimeline();
}
function undoRedo(from, to) {
  const snap = from.pop();
  if (!snap) return;
  to.push(structuredClone(tl.rounds));
  tl.rounds = snap;
  tlSave();
}
function dupRound() {
  if (!tl.rounds[tl.sel]) return;
  commit();
  tl.rounds.splice(tl.sel + 1, 0, { ...tl.rounds[tl.sel] });
  tl.sel++;
  tlSave();
}
function delRound() {
  if (!tl.rounds[tl.sel]) return;
  commit();
  tl.rounds.splice(tl.sel, 1); // дорожки последовательные, поэтому удаление сразу смыкает промежуток (ripple)
  tlSave();
}
// Кадры для экспорта. Угадывание: по кадру на каждую долю секунды (число, диск, эквалайзеры, фон),
// затем кадр с обложкой, а для стиля «card» ещё фон с рамкой под видео и прозрачная подпись.
// Полосу времени ffmpeg дорисовывает плавно сам, поэтому в кадрах она пустая.
async function timelineFrames(id, bar, canvas) {
  syncPlan();
  const d = design(), gfps = d.background === "pop" || d.guess.sides === "eq" ? 12 : 1, WIPE_N = 10, wiping = d.transition === "wipe";
  const frames = tl.rounds.reduce((n, r) => n + r.guess * gfps + Math.ceil((0.6 + revealAnim(r)) * gfps) + 2, 0) + (leadSecs() ? 1 : 0) + (tailSecs() ? 1 : 0) + (wiping ? WIPE_N : 0);
  let n = 0;
  const upload = async (type = "image/jpeg", source = canvas) => {
    const blob = await new Promise((ok) => source.toBlob(ok, type, 0.92));
    if (!blob) throw Error("Не удалось подготовить кадр.");
    await api("frame/" + id + "/" + n++, blob, true);
    bar.value = (0.3 * n) / frames; // кадры — первые 30%
  };
  const extra = {}, guessSecs = tl.rounds[0]?.guess ?? 10;
  const card = async (key) => {
    paintScene(canvas, 0, { type: key, guessSecs, time: 0 });
    extra[key] = { frame: n, secs: d[key].secs };
    await upload();
  };
  // Шторка: кадры закрывающего движения (p от 1 к 0), одни на все сцены; ffmpeg проигрывает их вперёд и назад.
  let wipe = null;
  if (wiping) {
    const wc = document.createElement("canvas");
    wc.width = canvas.width;
    wc.height = canvas.height;
    wipe = { first: n, count: WIPE_N };
    for (let k = 0; k < WIPE_N; k++) {
      drawWipe(wc.getContext("2d"), wc.width, wc.height, 1 - k / (WIPE_N - 1), d);
      await upload("image/png", wc);
    }
  }
  if (leadSecs()) await card("intro");
  const payload = [];
  for (const [i, r] of tl.rounds.entries()) {
    $("dText").textContent = "Подготовка кадров · раунд " + (i + 1) + " / " + tl.rounds.length;
    const frameQ = n;
    if (d.guess.sides === "eq") await eqLevels(r);
    for (let k = 0; k < r.guess * gfps; k++) {
      const time = k / gfps;
      paintScene(canvas, i, { type: "guess", left: Math.max(1, Math.ceil(r.guess - time)), total: r.guess, frac: 1 - time / r.guess, time, noBar: true, levels: eqAt(r, time) });
      await upload();
    }
    // Ответ — одна сцена: рамка плеера, обложка слева сверху и подписи появляются по очереди, затем кадр держится.
    // Видео в окно плеера кладёт ffmpeg, а здесь окно и подписи; плюс прозрачный слой искр и маска скруглённых углов.
    const cover = await loadCover(r.id), anim = revealAnim(r), cn = gfps > 1 ? Math.ceil((0.6 + anim) * gfps) : 1;
    const frameC = n;
    for (let k = 0; k < cn; k++) {
      paintScene(canvas, i, { type: "answer", img: cover, appear: cn > 1 ? clamp((k / gfps - 0.3) / anim, 0, 1) : 1, time: r.guess + k / gfps });
      await upload();
    }
    const round = { id: r.id, offset: r.offset, peak: peakStart(r), goff: guessStart(r), guess: r.guess, reveal: r.reveal, video: r.video, frameQ, frameC, cn, vin: 0.3 + anim * 0.55 };
    paintScene(canvas, i, { type: "vlabel" });
    round.frameL = n;
    await upload("image/png");
    round.frameM = n;
    await upload("image/png", videoMask(videoWin(canvas.width, canvas.height, canvas.height > canvas.width)));
    payload.push(round);
  }
  if (tailSecs()) await card("outro");
  const portrait = canvas.height > canvas.width;
  const out = { timeline: payload, width: canvas.width, height: canvas.height, total: tlTotal(), gfps, transition: d.transition, xtype: xfadeOf(d), fcolor: frameTheme(d).wipe, fade: d.fade, effects: effectsList(), ...extra };
  if (wipe) out.wipe = wipe;
  out.vwin = videoWin(canvas.width, canvas.height, portrait);
  if (d.guess.bar === "line") out.bar = { ...barGeom(canvas.width, canvas.height, portrait), color: barColorOf(d) };
  return out;
}
// ---- Эффекты: описание словами → список эффектов, которые ffmpeg накладывает на выбранные раунды и части ----
const FX = {
  bw: "Ч/Б", sepia: "Сепия", blur: "Размытие", vignette: "Виньетка", grain: "Зерно", bright: "Яркость", contrast: "Контраст",
  saturate: "Насыщенность", invert: "Негатив", chromatic: "Глитч RGB", warm: "Тёплый тон", cold: "Холодный тон",
};
const FX_PARTS = { all: "всё", guess: "угадывание", reveal: "ответ", video: "видео" };
const FX_WORDS = [
  ["bw", /ч\/?б|чёрно|черно|монохром|grayscale|black.?and.?white|\bbw\b|без цвет/i],
  ["sepia", /сепи|sepia|старин|винтаж|vintage|ретро/i],
  ["blur", /размыт|блюр|blur|расфокус/i],
  ["vignette", /виньет|vignette|тёмные края|темные края/i],
  ["grain", /зерн|шум|grain|плёнк|пленк|film/i],
  ["bright", /ярче|яркост|светлее|bright|осветли/i],
  ["bright-", /темнее|тёмнее|затемни|darker/i],
  ["contrast", /контраст|contrast/i],
  ["saturate", /насыщ|сочн|saturat|ярк\S* цвет/i],
  ["saturate-", /бледн|приглуш|desaturat|выцвет/i],
  ["invert", /инверс|негатив|invert/i],
  ["chromatic", /хромат|глитч|glitch|аберрац|rgb.?сдвиг/i],
  ["warm", /тепл|warm|закат|золот/i],
  ["cold", /холодн|cold|ночн|синий тон/i],
];
// Разбор описания без интернета: слова-эффекты, сила и, если названы, раунды и часть ролика.
function parseEffects(text) {
  const t = String(text || ""), strength = /слегка|чуть|немного|лёгк|легк|light|subtle/i.test(t) ? 0.3 : /сильн|очень|максим|жёстк|жестк|strong|heavy/i.test(t) ? 0.9 : 0.6;
  const rounds = [...t.matchAll(/раунд[а-яё]*\s*((?:\d+(?:\s*(?:,|и|and)\s*)?)+)/gi)].flatMap((m) => m[1].match(/\d+/g).map(Number));
  const part = /во?\s*вид|на\s*вид|video|клип/i.test(t) ? "video" : /угадыван|вопрос|таймер|guess/i.test(t) ? "guess" : /обложк|ответ|answer|cover/i.test(t) ? "reveal" : /везде|во всех|всё видео|все видео|everywhere/i.test(t) ? "all" : null;
  const out = [];
  for (const [key, re] of FX_WORDS) {
    if (!re.test(t)) continue;
    const neg = key.endsWith("-"), type = key.replace("-", "");
    out.push({ type, strength: neg ? -strength : strength, part, rounds });
  }
  return out;
}
// Всё, что пришло извне (ответ Claude, разбор текста, сохранённое), приводим к разрешённым значениям.
function normalizeEffects(list) {
  return (Array.isArray(list) ? list : []).slice(0, 40).flatMap((e) => {
    if (!e || !Object.hasOwn(FX, e.type)) return [];
    const st = Number(e.strength);
    return [{
      type: e.type,
      strength: clamp(Number.isFinite(st) ? st : 0.6, -1, 1),
      part: Object.hasOwn(FX_PARTS, e.part) ? e.part : "all",
      rounds: (Array.isArray(e.rounds) ? e.rounds : []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 60).slice(0, 60),
    }];
  });
}
const effectsList = () => (state.effects = normalizeEffects(state.effects));
const fxLabel = (e) =>
  FX[e.type] + (e.strength < 0 ? " −" : "") + " " + Math.round(Math.abs(e.strength) * 100) + "% · " + (e.rounds.length ? "раунд " + e.rounds.join(", ") : "все раунды") + " · " + FX_PARTS[e.part];
function renderEffects() {
  $("fxList").replaceChildren(...effectsList().map((e, i) => {
    const chip = el("button", fxLabel(e) + " ✕");
    chip.type = "button";
    chip.title = "Убрать эффект";
    chip.onclick = () => {
      state.effects = effectsList().filter((_, k) => k !== i);
      save();
      renderEffects();
    };
    return chip;
  }));
  tl.lastKey = "";
  drawPreview(true);
}
// В предпросмотре показываем те эффекты, что умеет CSS; виньетку, зерно и глитч видно только в экспорте.
function previewFilter(i, section) {
  const parts = [];
  for (const e of effectsList()) {
    if ((e.rounds.length && !e.rounds.includes(i + 1)) || (e.part !== "all" && e.part !== section)) continue;
    const a = Math.abs(e.strength), sg = e.strength < 0 ? -1 : 1;
    if (e.type === "bw") parts.push("grayscale(" + a + ")");
    else if (e.type === "sepia") parts.push("sepia(" + a + ")");
    else if (e.type === "blur") parts.push("blur(" + Math.round(a * 8) + "px)");
    else if (e.type === "bright") parts.push("brightness(" + (1 + sg * a * 0.5) + ")");
    else if (e.type === "contrast") parts.push("contrast(" + (1 + sg * a * 0.8) + ")");
    else if (e.type === "saturate") parts.push("saturate(" + (1 + sg * a * 1.5) + ")");
    else if (e.type === "invert") parts.push("invert(" + a + ")");
    else if (e.type === "warm") parts.push("sepia(" + a * 0.4 + ") saturate(" + (1 + a * 0.4) + ")");
    else if (e.type === "cold") parts.push("hue-rotate(" + Math.round(a * 25) + "deg) saturate(" + (1 - a * 0.2) + ")");
  }
  return parts.join(" ") || "none";
}
const FX_SYSTEM = `Ты помогаешь наложить видеоэффекты на аниме-викторину. Пользователь описывает эффект словами. Верни только JSON-массив без пояснений.
Элемент: {"type": один из ${Object.keys(FX).join(" | ")}, "strength": число от 0.1 до 1 (отрицательное для bright и saturate означает затемнить и обесцветить), "part": "all | guess | reveal | video", "rounds": [номера раундов с 1, пустой массив — все раунды]}.
guess — экран угадывания, reveal — обложка-ответ, video — клип с опенингом. Один запрос может дать несколько эффектов.`;
async function askEffects(text) {
  const key = localStorage.getItem("framequiz-claude-key");
  if (!key) return null;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 800, system: FX_SYSTEM, messages: [{ role: "user", content: text }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(data.error?.message || "Claude API: ошибка " + res.status);
  const raw = data.content?.map((x) => x.text ?? "").join("") ?? "";
  return JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1));
}
async function addEffects() {
  const text = $("fxPrompt").value.trim();
  if (!text) throw Error("Опишите эффект словами, например: «сепия и зерно на видео».");
  let found = null;
  try {
    found = await askEffects(text); // с ключом Claude понимает свободные формулировки
  } catch (e) {
    toast(e.message + " — разбираю текст сам.");
  }
  found = normalizeEffects(found ?? parseEffects(text));
  if (!found.length) throw Error("Не понял, какой эффект нужен. Доступно: " + Object.values(FX).join(", ").toLowerCase() + ".");
  const round = Number($("fxRound").value), part = $("fxPart").value;
  // Куда применять: что названо в описании, иначе — что выбрано в списках рядом.
  for (const e of found) {
    if (!e.rounds.length && round) e.rounds = [round];
    if (e.part === "all" && part !== "all") e.part = part;
  }
  state.effects = normalizeEffects([...effectsList(), ...found]);
  save();
  $("fxPrompt").value = "";
  renderEffects();
  toast("Добавлено эффектов: " + found.length);
}
function fillFxRounds() {
  const sel = $("fxRound"), cur = sel.value;
  sel.replaceChildren(new Option("все раунды", "0"), ...tl.rounds.map((_, i) => new Option("раунд " + (i + 1), String(i + 1))));
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : "0";
}
// Размер плеера, как во вьювере DaVinci: тянем нижнюю кромку, двойной клик возвращает исходный.
function initViewerResize() {
  const set = (h) => {
    state.tlPrevH = clamp(Math.round(h), 140, 760);
    document.documentElement.style.setProperty("--tl-prev-h", state.tlPrevH + "px");
  };
  set(state.tlPrevH ?? 240);
  const grip = $("tlResize");
  grip.onpointerdown = (ev) => {
    ev.preventDefault();
    grip.setPointerCapture(ev.pointerId);
    const y0 = ev.clientY, h0 = state.tlPrevH;
    grip.onpointermove = (m) => set(h0 + m.clientY - y0);
    grip.onpointerup = () => {
      grip.onpointermove = grip.onpointerup = null;
      save();
    };
  };
  grip.ondblclick = () => {
    set(240);
    save();
  };
  document.querySelectorAll("[data-prev]").forEach((b) => {
    b.onclick = () => {
      set(Number(b.dataset.prev));
      save();
    };
  });
}
function initTimeline() {
  tl.rounds = state.timeline ?? [];
  if (!state.smoothDefault) {
    state.smoothDefault = true;
    if (state.design?.transition === "wipe") state.design = { ...state.design, transition: "smooth" };
    save();
  }
  initViewerResize();
  button("fxAdd", addEffects);
  $("fxPrompt").onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("fxAdd").click();
    }
  };
  button("fxClear", () => {
    state.effects = [];
    save();
    renderEffects();
  });
  document.querySelectorAll("[data-fmt]").forEach((b) => {
    b.onclick = () => {
      state.applied ??= { ...defaults, quiz: "music" };
      state.applied.format = cfg.format = b.dataset.fmt;
      fitShorts();
      save();
      tl.lastKey = "";
      renderTimeline();
    };
  });
  button("tlDup", dupRound);
  button("tlDel", delRound);
  button("tlMagnet", () => {
    tl.magnet = !tl.magnet;
    $("tlMagnet").setAttribute("aria-pressed", tl.magnet);
  });
  button("tlUndo", () => undoRedo(tl.undo, tl.redo));
  button("tlRedo", () => undoRedo(tl.redo, tl.undo));
  button("tlZoomIn", () => setZoom(tl.zoom * 1.3));
  button("tlZoomOut", () => setZoom(tl.zoom / 1.3));
  button("tlFit", () => setZoom(($("tlScroll").clientWidth - 140) / Math.max(1, tlTotal())));
  $("tlZoom").oninput = () => setZoom(Number($("tlZoom").value));
  $("tlVol").value = Math.round(tlVolume() * 100);
  $("tlVol").oninput = () => {
    state.tlVol = $("tlVol").valueAsNumber / 100;
    if (tl.audio) tl.audio.volume = tlVolume(); // меняется на лету, пока играет
    save();
  };
  const syncTransition = () => {
    const d = design();
    $("tlTrans").value = d.transition;
    $("tlFade").value = Math.round(d.fade * 10);
    $("tlFadeVal").textContent = d.fade.toFixed(1) + " с";
    $("tlFade").disabled = d.transition !== "smooth";
  };
  $("tlTrans").onchange = () => {
    state.design = { ...design(), transition: $("tlTrans").value };
    save();
    syncTransition();
  };
  $("tlFade").oninput = () => {
    state.design = { ...design(), fade: $("tlFade").valueAsNumber / 10 };
    save();
    syncTransition();
  };
  syncTransition();
  window.syncTransition = syncTransition;
  button("tlPlay", tlPlay);
  button("tlExport", () => {
    if (!tl.rounds.length || !state.applied) throw Error("Сначала соберите раунды и нажмите «К таймлайну».");
    exportMode = "timeline";
    fitShorts();
    save();
    renderTimeline();
    return exportEpisode();
  });
  document.addEventListener("keydown", (e) => {
    if ($("timeline").hidden || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName) || document.querySelector("dialog[open]")) return;
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === "z") {
      e.preventDefault();
      undoRedo(e.shiftKey ? tl.redo : tl.undo, e.shiftKey ? tl.undo : tl.redo);
    } else if ((e.ctrlKey || e.metaKey) && key === "y") undoRedo(tl.redo, tl.undo);
    else if (e.ctrlKey || e.metaKey || e.altKey) return;
    else if (key === " ") { e.preventDefault(); tlPlay(); }
    else if (key === "d") dupRound();
    else if (key === "n") $("tlMagnet").click();
    else if (key === "delete" || key === "backspace") delRound();
    else if (key === "arrowleft") seek(tl.head - 1);
    else if (key === "arrowright") seek(tl.head + 1);
    else if (key === "+" || key === "=") setZoom(tl.zoom * 1.3);
    else if (key === "-") setZoom(tl.zoom / 1.3);
    else if (key === "z" && e.shiftKey) $("tlFit").click();
  });
}
