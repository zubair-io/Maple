"use strict";
const data = JSON.parse(document.getElementById("gallery-data").textContent);
const keys = ["before", "after", "reference"];
const labels = { before: "Before", after: "After", reference: "Embedded JPEG" };
const stage = document.getElementById("stage"),
  scene = document.getElementById("scene");
const select = document.getElementById("fixture"),
  filmstrip = document.getElementById("filmstrip");
const pictures = Object.fromEntries(
  keys.map((key) => [key, document.getElementById(key)]),
);
let index = 0,
  active = "after",
  comparison = "before",
  scale = 1,
  panX = 0,
  panY = 0,
  fitMode = true;
let token = 0,
  loaded = {},
  failed = {},
  decoders = [],
  pointer = null;
function row() {
  return data.cases[index];
}
function dimensions() {
  return row().images.after.size;
}
function fitScale() {
  const [w, h] = dimensions();
  return Math.min((stage.clientWidth - 24) / w, (stage.clientHeight - 24) / h);
}
function position() {
  const [w, h] = dimensions(),
    vw = stage.clientWidth,
    vh = stage.clientHeight;
  panX = Math.max(
    -Math.max(0, (w * scale - vw) / 2),
    Math.min(Math.max(0, (w * scale - vw) / 2), panX),
  );
  panY = Math.max(
    -Math.max(0, (h * scale - vh) / 2),
    Math.min(Math.max(0, (h * scale - vh) / 2), panY),
  );
  Object.assign(scene.style, {
    width: `${w * scale}px`,
    height: `${h * scale}px`,
    left: `${vw / 2 + panX - (w * scale) / 2}px`,
    top: `${vh / 2 + panY - (h * scale) / 2}px`,
  });
  document.getElementById("zoom").textContent =
    `${(scale * 100).toFixed(scale < 0.1 ? 1 : 0)}%`;
  document.getElementById("fit").setAttribute("aria-pressed", String(fitMode));
  document
    .getElementById("native")
    .setAttribute(
      "aria-pressed",
      String(!fitMode && Math.abs(scale - 1) < 1e-6),
    );
}
function fit() {
  fitMode = true;
  scale = Math.max(0.001, fitScale());
  panX = panY = 0;
  position();
}
function zoomTo(next, x = stage.clientWidth / 2, y = stage.clientHeight / 2) {
  const old = scale;
  scale = Math.max(Math.max(0.001, fitScale() / 4), Math.min(8, next));
  panX =
    x -
    stage.clientWidth / 2 -
    ((x - stage.clientWidth / 2 - panX) * scale) / old;
  panY =
    y -
    stage.clientHeight / 2 -
    ((y - stage.clientHeight / 2 - panY) * scale) / old;
  fitMode = false;
  position();
}
function updateStatus() {
  const image = row().images[active],
    status = document.getElementById("load");
  const size = `${image.size[0]} × ${image.size[1]}`;
  status.className = failed[active] ? "error" : "";
  status.textContent = failed[active]
    ? `${labels[active]}: original could not load; showing preview. Use “Open original file”.`
    : loaded[active]
      ? `${labels[active]} · original ${size}${active === "reference" ? " · scaled to the same scene size as Auto" : ""}`
      : `${labels[active]} · preview while original ${size} loads…`;
  document.getElementById("original").href = image.original;
}
function show(key) {
  active = key;
  if (key !== "after") comparison = key;
  for (const k of keys) pictures[k].classList.toggle("active", k === key);
  for (const button of document.querySelectorAll("[data-view]"))
    button.setAttribute("aria-pressed", String(button.dataset.view === key));
  document.getElementById("badge").textContent = labels[key];
  document.getElementById("badge").style.borderColor =
    key === "after" ? "#e2bc69" : key === "reference" ? "#8eca9a" : "#9bacbf";
  updateStatus();
}
function swap() {
  show(active === "after" ? comparison : "after");
}
function choose(next) {
  index = (next + data.cases.length) % data.cases.length;
  token++;
  const request = token;
  loaded = {};
  failed = {};
  for (const image of decoders) {
    image.onload = null;
    image.onerror = null;
    image.src = "";
  }
  decoders = [];
  for (const key of keys) {
    pictures[key].src = row().images[key].preview;
    const image = new Image();
    decoders.push(image);
    image.onload = async () => {
      try {
        await image.decode();
      } catch {
        /* An already decoded image can still be displayed. */
      }
      if (request !== token) return;
      loaded[key] = true;
      pictures[key].src = image.src;
      if (active === key) updateStatus();
    };
    image.onerror = () => {
      if (request !== token) return;
      failed[key] = true;
      if (active === key) updateStatus();
    };
    image.src = row().images[key].original;
  }
  select.value = String(index);
  document.getElementById("result").textContent =
    `${row().name} · ${row().status.toUpperCase()}`;
  document.getElementById("result").className =
    row().status === "passed" ? "pass" : "fail";
  for (const button of filmstrip.children)
    button.setAttribute(
      "aria-current",
      String(Number(button.dataset.index) === index),
    );
  filmstrip.children[index].scrollIntoView({
    block: "nearest",
    inline: "nearest",
  });
  history.replaceState(null, "", `#${row().name}`);
  fit();
  show(active);
}
for (const [i, item] of data.cases.entries()) {
  const option = document.createElement("option");
  option.value = String(i);
  option.textContent = `${item.name} · ${item.status}`;
  select.append(option);
  const button = document.createElement("button");
  button.dataset.index = String(i);
  button.title = `${item.name}: ${item.status}`;
  const thumb = document.createElement("img");
  thumb.src = item.images.after.preview;
  thumb.alt = "";
  thumb.loading = "lazy";
  const label = document.createElement("span");
  label.textContent = item.name;
  button.append(thumb, label);
  button.onclick = () => choose(i);
  filmstrip.append(button);
}
document.getElementById("checkpoint").textContent = data.notice;
select.onchange = () => choose(Number(select.value));
document.getElementById("previous").onclick = () => choose(index - 1);
document.getElementById("next").onclick = () => choose(index + 1);
for (const button of document.querySelectorAll("[data-view]"))
  button.onclick = () => show(button.dataset.view);
document.getElementById("swap").onclick = swap;
document.getElementById("fit").onclick = fit;
document.getElementById("native").onclick = () => zoomTo(1);
document.getElementById("minus").onclick = () => zoomTo(scale / 1.4);
document.getElementById("plus").onclick = () => zoomTo(scale * 1.4);
document.getElementById("fullscreen").onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    document.getElementById("load").textContent =
      "Full screen is unavailable in this browser; 100% zoom still works.";
  }
};
stage.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const rect = stage.getBoundingClientRect();
    zoomTo(
      scale * Math.exp(-event.deltaY * 0.002),
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
  },
  { passive: false },
);
stage.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  stage.focus({ preventScroll: true });
  pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
  stage.setPointerCapture(event.pointerId);
  stage.classList.add("dragging");
});
stage.addEventListener("pointermove", (event) => {
  if (!pointer || event.pointerId !== pointer.id) return;
  panX += event.clientX - pointer.x;
  panY += event.clientY - pointer.y;
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  position();
});
function release() {
  pointer = null;
  stage.classList.remove("dragging");
}
stage.addEventListener("pointerup", release);
stage.addEventListener("pointercancel", release);
stage.addEventListener("lostpointercapture", release);
stage.addEventListener("dblclick", (event) => {
  const rect = stage.getBoundingClientRect();
  if (!fitMode && Math.abs(scale - 1) < 1e-6) fit();
  else zoomTo(1, event.clientX - rect.left, event.clientY - rect.top);
});
document.addEventListener("keydown", (event) => {
  if (
    event.target.matches("input,select,textarea") ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey
  )
    return;
  if (["1", "2", "3"].includes(event.key)) {
    event.preventDefault();
    show(keys[Number(event.key) - 1]);
  } else if (event.code === "Space") {
    event.preventDefault();
    swap();
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    choose(index + 1);
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    choose(index - 1);
  } else if (event.key.toLowerCase() === "f") {
    event.preventDefault();
    fit();
  } else if (event.key === "0") {
    event.preventDefault();
    zoomTo(1);
  } else if (event.key === "+" || event.key === "=") {
    event.preventDefault();
    zoomTo(scale * 1.4);
  } else if (event.key === "-") {
    event.preventDefault();
    zoomTo(scale / 1.4);
  }
});
new ResizeObserver(() => {
  if (fitMode) fit();
  else position();
}).observe(stage);
const requested = decodeURIComponent(location.hash.slice(1));
choose(
  Math.max(
    0,
    data.cases.findIndex((item) => item.name === requested),
  ),
);
