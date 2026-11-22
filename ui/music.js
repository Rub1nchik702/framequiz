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
async function reloadTracks() {
  tracks = await api("tracks", {});
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
}
let selectedTrack = null;
function selectTrack(track, origin) {
  selectedTrack = track ? {track, origin} : null;
  const active = !!track;
  $("trackFile").value = "";
  $("trackFile").required = !active;
  $("trackFile").hidden = document.querySelector('label[for="trackFile"]').hidden = active;
  $("clearPick").hidden = $("selectedSource").hidden = !active;
  $("animeName").readOnly = $("trackTitle").readOnly = active;
  $("trackKind").disabled = $("trackLevel").disabled = active;
  $("animeName").value = track?.anime || "";
  $("trackTitle").value = track?.title || "";
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
    $("downloadMusic").disabled = true;
    try {
      for (const [kind, quota] of groups) {
        for (const [level, count] of Object.entries(quota)) {
          if (!count) continue;
          status.textContent = "Загрузка " + kind + " · " + levels[level] + "…";
          try {
            const picked = await api("download-tracks", {kind, quota:{easy:0, medium:0, hard:0, [level]:count}});
            reused += picked.filter(t => before.has(t.id)).length;
          } catch (e) { messages.push(e.message); }
        }
      }
      await reloadTracks();
      status.textContent = ["Добавлено: " + tracks.filter(t => !before.has(t.id)).length, "уже в фонотеке: " + reused, ...messages].join(" · ");
    } finally { $("downloadMusic").disabled = false; }
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
  for (let k of ["emptyImport", "goTracks"])
    button(k, () => document.querySelector('[data-tab="tracks"]').click());
  button("composeMusic", () => {
    document.querySelector('[data-tab="studio"]').click();
    switchQuiz(true);
  });
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
      } catch(e) { $("importStatus").textContent = e.message; }
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
    };
    $("importTrack").disabled = true;
    $("importStatus").textContent = "Подготовка аудио…";
    try {
      await uploadTrack(f, meta);
      $("trackFile").value = $("trackTitle").value = "";
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


