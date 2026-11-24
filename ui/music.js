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
const inLibrary = (r) => tracks.some((t) => t.source === "anisongdb" && t.title === r.title && t.version === r.version && t.anime === r.anime && (!t.vintage || t.vintage === r.vintage));
async function pickAnime(a, card) {
  document.querySelectorAll(".anime-card.selected").forEach((c) => c.classList.remove("selected"));
  card.classList.add("selected");
  pickedAnime = a;
  $("songsTitle").textContent = a.russian || a.name;
  $("songList").replaceChildren();
  $("songStatus").textContent = "Ищу опенинги и эндинги…";
  const rows = await api("anime-songs", { name: a.name });
  songRows = rows.sort((x, y) => x.anime.localeCompare(y.anime) || vintageKey(x.vintage) - vintageKey(y.vintage) ||
    (x.kind === y.kind ? verNum(x.version) - verNum(y.version) : x.kind === "OP" ? -1 : 1));
  $("songStatus").textContent = songRows.length ? "" : "В AnisongDB нет видео опенингов и эндингов для этого аниме.";
  renderSongs();
}
function renderSongs() {
  const nodes = [];
  let last = null;
  songRows.forEach((r, i) => {
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
function renderBoard() {
  state.board = (state.board ?? []).map(boardEntry);
  const genres = [...new Set(tracks.flatMap((t) => t.genres || []))].sort();
  const select = $("boardGenre"), current = select.value;
  select.replaceChildren(new Option("Все жанры", ""), ...genres.map((g) => new Option(g, g)));
  select.value = genres.includes(current) ? current : "";
  select.onchange = renderBoard;
  const shown = tracks.filter((t) => !select.value || (t.genres || []).includes(select.value));
  $("boardCount").textContent = shown.length + " тр.";
  $("boardLib").replaceChildren(...shown.map((t) => {
    const card = trackCard(t);
    const add = el("button", "В раунд " + (activeRound + 1));
    add.className = "add-hover";
    add.onclick = () => assignRound(activeRound, t.id);
    card.append(add);
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
    const t = entry && tracks.find((x) => x.id === entry.id);
    plank.append(head);
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
      opts.append(pick);
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
const TRANSITIONS = ["flash", "none"];
// Цвета фона «Поп» по кругу: у каждого раунда свой (верх, низ).
const POP_COLORS = [
  ["#9ad8fb", "#4aa3de"], ["#ff8cc4", "#d63f93"], ["#a6f77a", "#4ec53a"], ["#b79bff", "#6a46e0"],
  ["#ffb27a", "#e0663a"], ["#e0f57a", "#a8c02e"], ["#86f2d6", "#32c29b"], ["#ec8bff", "#a83bd6"],
];
const DESIGN_POP = {
  name: "Pop",
  palette: { bg: "#9ad8fb", accent: "#ffffff", mid: "#4aa3de", dark: "#2d6fb0", text: "#1c3a63", light: "#ffffff" },
  background: "pop",
  cycle: true,
  font: "Impact",
  guess: { title: "QUESTION {n}", picture: "none", timer: "disc", timerLabel: "TIME TO ANSWER", bar: "line", sides: "eq", titleStyle: "outline" },
  reveal: { label: "ANSWER", frame: "card" },
  video: { frame: "card", label: true },
  transition: "flash",
  intro: { on: true, title: "GUESS THE ANIME OPENING", subtitle: "Name the anime from the opening", secs: 4, langs: true },
  outro: { on: true, title: "THANKS FOR WATCHING", subtitle: "Like and subscribe for more", secs: 3, langs: false },
};
const DESIGN_SOLAR = {
  name: "Solar",
  palette: { bg: "#f5dcaa", accent: "#e86739", mid: "#93402e", dark: "#512f31", text: "#2f2429", light: "#fff3db" },
  background: "sunset",
  cycle: false,
  font: "Arial",
  guess: { title: "WHAT ANIME IS THIS?", picture: "vinyl", timer: "number", timerLabel: "TIME TO ANSWER", bar: "line", sides: "none", titleStyle: "plain" },
  reveal: { label: "ANSWER", frame: "rounded" },
  video: { frame: "plain", label: false },
  transition: "none",
  intro: { on: true, title: "GUESS THE ANIME SONG", subtitle: "Name the anime from the opening", secs: 3, langs: false },
  outro: { on: true, title: "THANKS FOR WATCHING", subtitle: "Like and subscribe for more", secs: 3, langs: false },
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
const popPair = (d, index) => (d.cycle ? POP_COLORS[index % POP_COLORS.length] : [d.palette.bg, d.palette.mid]);
function drawPop(c, w, h, pair, time) {
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, pair[0]);
  g.addColorStop(1, pair[1]);
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  // скоростные линии, медленно ползущие по диагонали
  c.save();
  c.translate(w / 2, h / 2);
  c.rotate(-0.45);
  const span = Math.hypot(w, h), step = span / 14, off = (time * 36) % step;
  c.fillStyle = "#ffffff16";
  for (let k = -16; k < 16; k++) c.fillRect(k * step + off, -span, step * 0.33, span * 2);
  c.restore();
  // контурные фигуры: коробки, цилиндры, зигзаги
  let seed = 5;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  c.strokeStyle = "#ffffffb0";
  c.lineWidth = Math.max(2, w * 0.0026);
  c.lineJoin = "round";
  for (let i = 0; i < 10; i++) {
    const x = rnd() * w, y = rnd() * h, s = w * (0.022 + rnd() * 0.03), a = rnd() * 6 + time * 0.12 * (i % 2 ? 1 : -1);
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
}
function drawBackground(c, w, h, d, ctx = {}) {
  const P = d.palette;
  if (d.background === "pop") return drawPop(c, w, h, popPair(d, ctx.index ?? 0), ctx.time ?? 0);
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
// Окно под видео (16:9), все числа чётные: так требует кодировщик.
function videoWin(w, h, portrait) {
  const maxW = w * (portrait ? 0.92 : 0.94), maxH = h * (portrait ? 0.6 : 0.88);
  let ww = maxW, wh = (ww * 9) / 16;
  if (wh > maxH) {
    wh = maxH;
    ww = (wh * 16) / 9;
  }
  const even = (v) => Math.round(v / 2) * 2;
  ww = even(ww);
  wh = even(wh);
  return { x: even((w - ww) / 2), y: even(portrait ? (h - wh) / 2 - h * 0.04 : (h - wh) / 2), w: ww, h: wh };
}
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
function sparkle(c, x, y, r) {
  c.fillStyle = "#ffffff";
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
// Колонки-эквалайзеры по бокам: длины «пляшут» со временем.
function drawSideEq(c, w, h, time, portrait) {
  const n = portrait ? 26 : 22, top = h * 0.14, bottom = h * 0.84, step = (bottom - top) / n, th = Math.max(8, step * 0.42), maxLen = w * (portrait ? 0.07 : 0.05);
  c.fillStyle = "#ffffffe6";
  for (let k = 0; k < n; k++) {
    const len = maxLen * (0.15 + 0.85 * Math.abs(Math.sin(time * 5.2 + k * 0.8) * Math.cos(time * 2.1 + k * 0.37)));
    const y = top + k * step;
    roundRect(c, w * 0.025, y, len, th, th / 2);
    c.fill();
    roundRect(c, w * 0.975 - len, y, len, th, th / 2);
    c.fill();
  }
}
// Надпись «OPENING 1 / название» и искры на прозрачном слое: ffmpeg кладёт его поверх видео.
function drawVideoLabel(c, d, q, win, w, h, portrait) {
  const tag = ((q.version || tagOf(q)) + "").toUpperCase();
  sparkle(c, win.x + win.w * 0.03, win.y + win.h * 0.06, w * 0.018);
  sparkle(c, win.x + win.w * 0.97, win.y + win.h * 0.94, w * 0.022);
  if (!d.video.label) return;
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
const NEED_Q = ["guess", "reveal", "video", "vbg", "vlabel"];
function paintScene(canvas, index, scene) {
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
    c.clearRect(0, 0, w, h);
    if (scene.type === "vlabel") return drawVideoLabel(c, d, q, win, w, h, portrait);
    drawBackground(c, w, h, d, { index: ci, time });
    if (scene.type === "vbg" || (scene.type === "video" && d.video.frame === "card")) {
      c.fillStyle = "#ffffff";
      roundRect(c, win.x - 16, win.y - 16, win.w + 32, win.h + 32, 34);
      c.fill();
      c.fillStyle = "#101010";
      c.fillRect(win.x, win.y, win.w, win.h);
      if (scene.type === "video") drawVideoLabel(c, d, q, win, w, h, portrait);
      return;
    }
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
      if (g.sides === "eq") drawSideEq(c, w, h, time, portrait);
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
          c.fillStyle = P.accent;
          roundRect(c, b.x, b.y, Math.max(b.h, b.w * frac), b.h, b.h / 2);
          c.fill();
        }
      }
      return;
    }
    // reveal и video: обложка тайтла
    const label = scene.type === "video" ? "MP4 · PEAK MOMENT" : d.reveal.label;
    if (pop) outlined(c, d, label, w * 0.5, h * 0.1, w * 0.8, portrait ? 100 : 90, "#ffffff", "#00000040");
    else {
      c.fillStyle = P.accent;
      c.font = "bold " + (portrait ? 30 : 28) + "px Consolas, monospace";
      const lw = c.measureText(label).width + 50;
      c.fillRect((w - lw) / 2, h * 0.14, lw, 54);
      c.fillStyle = lum(P.accent) > 0.55 ? P.text : P.light;
      c.fillText(label, w * 0.5, h * 0.14 + 27);
    }
    if (scene.img) {
      const ih = h * (portrait ? 0.46 : 0.56), iw = (ih * scene.img.width) / scene.img.height, x = (w - iw) / 2, y = h * (portrait ? 0.2 : 0.22);
      c.save();
      if (d.reveal.frame === "card") {
        c.fillStyle = "#ffffff";
        roundRect(c, x - 16, y - 16, iw + 32, ih + 32, 34);
        c.fill();
        roundRect(c, x, y, iw, ih, 20);
        c.clip();
        c.drawImage(scene.img, x, y, iw, ih);
        c.restore();
        sparkle(c, x - 4, y + 10, w * 0.026);
        sparkle(c, x + iw + 6, y + ih - 10, w * 0.03);
        c.save();
      } else if (d.reveal.frame === "polaroid") {
        c.translate(w / 2, y + ih / 2);
        c.rotate(-0.04);
        c.translate(-w / 2, -(y + ih / 2));
        c.fillStyle = "#fffdf6";
        c.shadowColor = "#0008";
        c.shadowBlur = 30;
        c.fillRect(x - 24, y - 24, iw + 48, ih + 90);
        c.shadowBlur = 0;
        c.drawImage(scene.img, x, y, iw, ih);
      } else if (d.reveal.frame === "circle") {
        const rad = Math.min(iw, ih) / 2;
        c.beginPath();
        c.arc(w / 2, y + ih / 2, rad, 0, 7);
        c.clip();
        c.drawImage(scene.img, w / 2 - rad, y + ih / 2 - rad, rad * 2, rad * 2, w / 2 - rad, y + ih / 2 - rad, rad * 2, rad * 2);
      } else {
        roundRect(c, x, y, iw, ih, 24);
        c.clip();
        c.drawImage(scene.img, x, y, iw, ih);
      }
      c.restore();
    }
    const tag = (q.version || tagOf(q)) + " · " + q.title;
    if (pop) {
      outlined(c, d, tag.toUpperCase(), w * 0.5, h * (portrait ? 0.755 : 0.86), w * 0.86, portrait ? 52 : 46, "#ff8a1f");
      outlined(c, d, q.anime.toUpperCase(), w * 0.5, h * (portrait ? 0.83 : 0.94), w * 0.9, portrait ? 66 : 58, "#2a7bff");
      return;
    }
    fitted(c, q.anime, w * 0.5, h * (portrait ? 0.76 : 0.85), w * 0.86, h * 0.11, portrait ? 72 : 64, 850, ink.bottom);
    fitted(c, tagOf(q) + " · " + q.title, w * 0.5, h * (portrait ? 0.835 : 0.93), w * 0.86, h * 0.07, portrait ? 44 : 38, 700, ink.bottom);
    if (q.ru) fitted(c, q.ru, w * 0.5, h * (portrait ? 0.885 : 0.975), w * 0.8, h * 0.05, portrait ? 34 : 30, 600, ink.bottom + "bb");
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
 "font": "Arial | Impact | Georgia | Trebuchet MS | Verdana | Consolas",
 "guess": {"title":"текст вопроса, {n} = номер раунда","picture":"vinyl | frame | equalizer | none","timer":"disc | number | ring | none","timerLabel":"подпись таймера","bar":"line | none","sides":"eq | none","titleStyle":"outline | plain"},
 "reveal": {"label":"подпись ответа","frame":"card | rounded | polaroid | circle"},
 "video": {"frame":"card | plain","label":true},
 "transition": "flash | none",
 "intro": {"on":true,"title":"...","subtitle":"...","secs":3,"langs":true},
 "outro": {"on":true,"title":"...","subtitle":"...","secs":3,"langs":false}
}
Смысл: background "pop" — яркий мультяшный фон с диагональными линиями и контурными фигурами; при "cycle":true цвет фона меняется от раунда к раунду, а palette почти не используется (accent оставь белым). Для остальных фонов: bg — светлая верхняя часть, dark — тёмная нижняя, accent — цвет полосы времени и подписей, mid — средний тон, text — тёмный цвет текста на светлом, light — светлый цвет текста на тёмном.
guess.timer "disc" — круглый диск с цифрой и белой дугой вокруг; guess.sides "eq" — живые колонки-эквалайзеры по бокам; guess.bar "line" — плавная полоса времени внизу. Экран угадывания: сверху вопрос, в центре место под картинку (picture) или диск таймера, снизу полоса. Затем экран ответа (reveal) с обложкой, потом видео: video.frame "card" — видео в белой скруглённой рамке с искрами, video.label — подпись «OPENING 1 / название» поверх видео. transition "flash" — белая вспышка между раундами. intro.langs — плашка «угадай опенинг за N секунд» на девяти языках с флагами.
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
function renderDesign() {
  state.applied ??= { ...defaults, quiz: "music" };
  const sample = state.plan?.[0] ?? tracks[0] ?? SAMPLE, count = Math.max(1, state.plan?.length || tl.rounds.length || 5);
  const first = sample.id ? sample : null;
  const draw = (id, scene) => {
    const canvas = $(id);
    paintScene(canvas, 0, { sample: { ...SAMPLE, ...sample }, count, ...scene });
    if (scene.type === "reveal" && first)
      loadCover(first.id).then((img) => img && paintScene(canvas, 0, { sample: { ...SAMPLE, ...sample }, count, ...scene, img }));
  };
  const total = 10, left = Math.max(1, Math.ceil((1 - $("designTime").value / 100) * total));
  const guessSecs = tl.rounds[0]?.guess ?? 10, t = ($("designTime").value / 100) * total;
  draw("dpIntro", { type: "intro", colorIndex: 0, guessSecs, time: t });
  draw("dpGuess", { type: "guess", left, total, frac: 1 - $("designTime").value / 100, colorIndex: 1, time: t });
  draw("dpReveal", { type: "reveal", colorIndex: 2 });
  draw("dpVideo", { type: "video", colorIndex: 3 });
  draw("dpOutro", { type: "outro", colorIndex: 4, guessSecs, time: t });
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
function initDesign() {
  $("designTime").oninput = renderDesign;
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
  $("tlTime").textContent = fmt(Math.floor(tl.head)) + " / " + fmt(tlTotal());
  drawPreview(force);
}
function drawPreview(force) {
  if (!tl.rounds.length || !state.applied) return;
  const { i, section, rel } = locate(tl.head);
  const r = tl.rounds[i];
  const frac = section === "guess" ? clamp(1 - rel / r.guess, 0, 1) : 1;
  const key = i + ":" + section + (section === "guess" ? ":" + Math.floor(rel * 12) : "");
  if (!force && key === tl.lastKey) return;
  tl.lastKey = key;
  syncPlan();
  const canvas = $("tlPreview");
  if (section === "intro" || section === "outro") return paintScene(canvas, i, { type: section, guessSecs: tl.rounds[0].guess, time: tl.head });
  if (section === "guess") return paintScene(canvas, i, { type: "guess", left: Math.max(1, Math.ceil(r.guess - rel)), total: r.guess, frac, time: rel });
  paintScene(canvas, i, { type: section });
  loadCover(r.id).then((img) => {
    if (img && tl.lastKey === key) paintScene(canvas, i, { type: section, img });
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
    const au = el("div", tagOf(t) + " · " + t.title + " · с " + fmt(r.offset));
    au.title = "Звук песни. Потяните, чтобы сдвинуть момент в песне";
    au.className = "tl-seg audio" + selected;
    place(au, x, rlen(r) * z);
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
// Начало видео (пик) = offset + guess + reveal.
const peakStart = (r) => r.offset + r.guess + r.reveal;
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
    Object.assign(r, newRound(n, n.offset));
    tlSave();
  };
  row.append(pick, peak, swap);
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
  tracks = await api("tracks", {});
  const before = tl.rounds.length;
  tl.rounds = tl.rounds.filter((r) => r.guess && trackOf(r));
  if (tl.rounds.length !== before) {
    state.timeline = tl.rounds;
    save();
    toast("Из таймлайна убраны раунды старого формата или с удалёнными треками.");
  }
  tl.lastKey = "";
  renderTimeline();
}
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
  // Песня звучит непрерывно в течение всего раунда; у интро и аутро звука нет.
  const { i, rel, section } = locate(tl.head);
  if (section === "intro" || section === "outro") stopTlAudio();
  else {
    const r = tl.rounds[i], key = i + ":" + r.offset + ":" + rlen(r);
    if (tl.audioKey !== key) {
      stopTlAudio();
      const skip = Math.floor(rel), left = rlen(r) - skip;
      if (left >= 1) {
        tl.audio = new Audio(clipURL({ ...trackOf(r), offset: r.offset + skip }, left));
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
  const d = design(), gfps = d.background === "pop" || d.guess.sides === "eq" ? 4 : 1, framed = d.video.frame === "card";
  const frames = tl.rounds.reduce((n, r) => n + r.guess * gfps + 1 + (framed ? 2 : 0), 0) + (leadSecs() ? 1 : 0) + (tailSecs() ? 1 : 0);
  let n = 0;
  const upload = async (type = "image/jpeg") => {
    const blob = await new Promise((ok) => canvas.toBlob(ok, type, 0.92));
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
  if (leadSecs()) await card("intro");
  const payload = [];
  for (const [i, r] of tl.rounds.entries()) {
    $("dText").textContent = "Подготовка кадров · раунд " + (i + 1) + " / " + tl.rounds.length;
    const frameQ = n;
    for (let k = 0; k < r.guess * gfps; k++) {
      const time = k / gfps;
      paintScene(canvas, i, { type: "guess", left: Math.max(1, Math.ceil(r.guess - time)), total: r.guess, frac: 1 - time / r.guess, time, noBar: true });
      await upload();
    }
    paintScene(canvas, i, { type: "reveal", img: await loadCover(r.id) });
    const frameC = n;
    await upload();
    const round = { id: r.id, offset: r.offset, guess: r.guess, reveal: r.reveal, video: r.video, frameQ, frameC };
    if (framed) {
      paintScene(canvas, i, { type: "vbg" });
      round.frameV = n;
      await upload();
      paintScene(canvas, i, { type: "vlabel" });
      round.frameL = n;
      await upload("image/png");
    }
    payload.push(round);
  }
  if (tailSecs()) await card("outro");
  const portrait = canvas.height > canvas.width;
  const out = { timeline: payload, width: canvas.width, height: canvas.height, total: tlTotal(), gfps, flash: d.transition === "flash", ...extra };
  if (framed) out.vwin = videoWin(canvas.width, canvas.height, portrait);
  if (d.guess.bar === "line") out.bar = { ...barGeom(canvas.width, canvas.height, portrait), color: d.palette.accent };
  return out;
}
function initTimeline() {
  tl.rounds = state.timeline ?? [];
  document.querySelectorAll("[data-fmt]").forEach((b) => {
    b.onclick = () => {
      state.applied ??= { ...defaults, quiz: "music" };
      state.applied.format = cfg.format = b.dataset.fmt;
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
  button("tlPlay", tlPlay);
  button("tlExport", () => {
    if (!tl.rounds.length || !state.applied) throw Error("Сначала соберите раунды и нажмите «К таймлайну».");
    exportMode = "timeline";
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
