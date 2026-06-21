const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const els = {
  lobby: $("#lobby"),
  room: $("#room"),
  createForm: $("#create-form"),
  joinForm: $("#join-form"),
  createError: $("#create-error"),
  joinError: $("#join-error"),
  roomTitle: $("#room-title"),
  roomPassword: $("#room-password"),
  randomPassword: $("#random-password"),
  joinRoomId: $("#join-room-id"),
  joinPassword: $("#join-password"),
  activeTitle: $("#active-title"),
  expiresIn: $("#expires-in"),
  shareLink: $("#share-link"),
  sharePassword: $("#share-password"),
  shareButton: $("#share-button"),
  copyInvite: $("#copy-invite"),
  destroyButton: $("#destroy-button"),
  destroyDialog: $("#destroy-dialog"),
  confirmDestroy: $("#confirm-destroy"),
  canvasWrap: $("#canvas-wrap"),
  excalidrawBoard: $("#excalidraw-board"),
  board: $("#board"),
  zoomLevel: $("#zoom-level"),
  zoomOut: $("#zoom-out"),
  zoomIn: $("#zoom-in"),
  zoomReset: $("#zoom-reset"),
  zoomFit: $("#zoom-fit"),
  selectionHint: $("#selection-hint"),
  cursorLayer: $("#cursor-layer"),
  textEditor: $("#text-editor"),
  textArea: $("#text-editor textarea"),
  textCancel: $("#text-cancel"),
  dropHint: $("#drop-hint"),
  imageInput: $("#image-input"),
  fileInput: $("#file-input"),
  sideFileInput: $("#side-file-input"),
  brushSize: $("#brush-size"),
  presenceCount: $("#presence-count"),
  presenceList: $("#presence-list"),
  identityCards: $$(".identity-card"),
  identityNames: $$(".identity-name"),
  fileCount: $("#file-count"),
  fileList: $("#file-list"),
  toast: $("#toast")
};

const state = {
  roomId: null,
  room: null,
  token: null,
  self: null,
  password: "",
  source: null,
  tool: "pen",
  color: "#2558ff",
  size: 5,
  events: [],
  currentStroke: null,
  currentTextPoint: null,
  pendingImagePoint: null,
  lastBoardPoint: { x: 0, y: 0 },
  viewport: { x: 0, y: 0, scale: 1 },
  panInteraction: null,
  imageInteraction: null,
  selectedImageId: null,
  isSpacePanning: false,
  imageCache: new Map(),
  cursors: new Map(),
  cursorSentAt: 0,
  drawFrame: null,
  timer: null
};

const ctx = els.board.getContext("2d");
const handwritingFont =
  '"Hannotate SC", "HanziPen SC", "Kaiti SC", STKaiti, KaiTi, "Comic Sans MS", "Bradley Hand", cursive';
const modePresets = {
  intimate: {
    title: "今晚的双人密室",
    passwordHint: "moon-2941"
  },
  stranger: {
    title: "三分钟破冰密室",
    passwordHint: "hello-2049"
  },
  work: {
    title: "临时协作密室",
    passwordHint: "sync-1024"
  }
};
const excalidrawState = {
  api: null,
  applyingRemoteScene: false,
  postTimer: null,
  lastPostedHash: "",
  latestSceneAt: 0,
  files: {}
};

function makePassword() {
  const words = ["moon", "paper", "mint", "river", "room", "warm", "quiet", "blue"];
  const word = words[Math.floor(Math.random() * words.length)];
  return `${word}-${Math.floor(1000 + Math.random() * 9000)}`;
}

function applyModePreset(mode) {
  const preset = modePresets[mode];
  if (!preset) return;
  if (!els.roomTitle.value || Object.values(modePresets).some((item) => item.title === els.roomTitle.value)) {
    els.roomTitle.value = preset.title;
  }
  if (!els.roomPassword.value || Object.values(modePresets).some((item) => item.passwordHint === els.roomPassword.value)) {
    els.roomPassword.value = preset.passwordHint;
  }
}

function setError(target, message = "") {
  target.textContent = message;
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.remove("show"), 2200);
}

async function api(path, payload) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || "请求失败，请稍后再试。");
  }
  return data;
}

function currentRoomIdFromPath() {
  const match = window.location.pathname.match(/^\/r\/([^/]+)$/);
  return match ? match[1] : null;
}

function showJoin(roomId) {
  els.createForm.classList.add("hidden");
  els.joinForm.classList.remove("hidden");
  els.joinRoomId.textContent = `房间 ${roomId} 正在等你，口令对了就入室。`;
  els.joinPassword.focus();
}

function showLobby(message = "") {
  els.room.classList.add("hidden");
  els.lobby.classList.remove("hidden");
  els.createForm.classList.remove("hidden");
  els.joinForm.classList.add("hidden");
  if (message) toast(message);
}

function showRoom() {
  els.lobby.classList.add("hidden");
  els.room.classList.remove("hidden");
  mountExcalidrawBoard();
  resizeCanvas();
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(ms) {
  if (ms <= 0) return "00:00";
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}天 ${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  if (hours > 0) return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function updateTimer() {
  if (!state.room) return;
  const remaining = state.room.expiresAt - Date.now();
  els.expiresIn.textContent = formatDuration(remaining);
  if (remaining <= 0) {
    handleDestroyed({ reason: "expired" });
  }
}

function updateShareFields() {
  const url = `${window.location.origin}/r/${state.roomId}`;
  els.shareLink.value = url;
  els.sharePassword.value = state.password;
}

async function copyInvite() {
  const text = `密室：${els.shareLink.value}\n口令：${state.password}`;
  try {
    await navigator.clipboard.writeText(text);
    toast("邀请信息已复制。");
  } catch {
    els.shareLink.select();
    toast("已选中链接，可以手动复制。");
  }
}

function setTool(tool) {
  state.tool = tool;
  $$(".tool-button[data-tool]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tool === tool);
  });
  els.canvasWrap.dataset.tool = tool;
  if (tool !== "move") {
    state.selectedImageId = null;
    updateSelectionHint();
    scheduleDraw();
  }
  if (tool === "image") {
    state.pendingImagePoint = pastePoint();
    els.imageInput.click();
  }
}

function setColor(color) {
  state.color = color;
  $$(".swatch").forEach((button) => {
    button.classList.toggle("active", button.dataset.color === color);
  });
}

function resizeCanvas() {
  const rect = els.canvasWrap.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  els.board.width = Math.max(1, Math.floor(rect.width * ratio));
  els.board.height = Math.max(1, Math.floor(rect.height * ratio));
  els.board.style.width = `${rect.width}px`;
  els.board.style.height = `${rect.height}px`;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  scheduleDraw();
}

function canvasSize() {
  return {
    width: els.board.clientWidth || els.canvasWrap.clientWidth,
    height: els.board.clientHeight || els.canvasWrap.clientHeight
  };
}

function toScreenPoint(event) {
  const rect = els.board.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
}

function screenToWorld(screen) {
  const { width, height } = canvasSize();
  return {
    x: (screen.x - width / 2 - state.viewport.x) / state.viewport.scale,
    y: (screen.y - height / 2 - state.viewport.y) / state.viewport.scale
  };
}

function worldToScreen(point) {
  const { width, height } = canvasSize();
  return {
    x: point.x * state.viewport.scale + width / 2 + state.viewport.x,
    y: point.y * state.viewport.scale + height / 2 + state.viewport.y
  };
}

function toPoint(event) {
  return screenToWorld(toScreenPoint(event));
}

function rememberBoardPoint(point) {
  state.lastBoardPoint = point;
  return point;
}

function pastePoint() {
  return state.pendingImagePoint || state.lastBoardPoint || { x: 0, y: 0 };
}

function pointDistance(a, b) {
  const dx = (a.x - b.x) * state.viewport.scale;
  const dy = (a.y - b.y) * state.viewport.scale;
  return Math.hypot(dx, dy);
}

function clampScale(value) {
  return Math.min(8, Math.max(0.12, value));
}

function zoomAt(screen, nextScale) {
  const scale = clampScale(nextScale);
  const world = screenToWorld(screen);
  const { width, height } = canvasSize();
  state.viewport.scale = scale;
  state.viewport.x = screen.x - width / 2 - world.x * scale;
  state.viewport.y = screen.y - height / 2 - world.y * scale;
  updateZoomHud();
  scheduleDraw();
}

function zoomFromCenter(factor) {
  const { width, height } = canvasSize();
  zoomAt({ x: width / 2, y: height / 2 }, state.viewport.scale * factor);
}

function resetViewport() {
  state.viewport = { x: 0, y: 0, scale: 1 };
  updateZoomHud();
  scheduleDraw();
}

function includeBounds(bounds, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return bounds;
  return {
    minX: Math.min(bounds.minX, x),
    minY: Math.min(bounds.minY, y),
    maxX: Math.max(bounds.maxX, x),
    maxY: Math.max(bounds.maxY, y)
  };
}

function pointToWorld(point, item) {
  return item?.space === "world" ? point : screenToWorld(legacyPointToScreen(point));
}

function textBounds(item) {
  const origin = pointToWorld(item, item);
  const size = item.space === "world" ? item.size || 20 : 20 / state.viewport.scale;
  const lines = String(item.text || "").split("\n").slice(0, 8);
  const longestLine = Math.max(4, ...lines.map((line) => line.length));
  return {
    minX: origin.x - 10,
    minY: origin.y - 10,
    maxX: origin.x + Math.min(360, longestLine * size * 0.72) + 20,
    maxY: origin.y + Math.max(1, lines.length) * size * 1.36 + 20
  };
}

function contentBounds() {
  let bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const event of state.events) {
    if (event.type === "stroke") {
      for (const point of event.points || []) {
        const world = pointToWorld(point, event);
        bounds = includeBounds(bounds, world.x, world.y);
      }
    }
    if (event.type === "text") {
      const box = textBounds(event);
      bounds = includeBounds(bounds, box.minX, box.minY);
      bounds = includeBounds(bounds, box.maxX, box.maxY);
    }
    if (event.type === "image") {
      if (event.space === "world") {
        bounds = includeBounds(bounds, event.x, event.y);
        bounds = includeBounds(bounds, event.x + event.w, event.y + event.h);
      } else {
        const { width, height } = canvasSize();
        const topLeft = screenToWorld({ x: event.x * width, y: event.y * height });
        const bottomRight = screenToWorld({ x: (event.x + event.w) * width, y: (event.y + event.h) * height });
        bounds = includeBounds(bounds, topLeft.x, topLeft.y);
        bounds = includeBounds(bounds, bottomRight.x, bottomRight.y);
      }
    }
  }
  return Number.isFinite(bounds.minX) ? bounds : null;
}

function fitToContent() {
  const bounds = contentBounds();
  if (!bounds) {
    resetViewport();
    return;
  }
  const { width, height } = canvasSize();
  const padding = Math.min(140, Math.max(56, Math.min(width, height) * 0.16));
  const contentWidth = Math.max(1, bounds.maxX - bounds.minX);
  const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
  const availableWidth = Math.max(120, width - padding * 2);
  const availableHeight = Math.max(120, height - padding * 2);
  const scale = clampScale(Math.min(2.4, availableWidth / contentWidth, availableHeight / contentHeight));
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  state.viewport.scale = scale;
  state.viewport.x = -centerX * scale;
  state.viewport.y = -centerY * scale;
  updateZoomHud();
  scheduleDraw();
}

function panBy(dx, dy) {
  state.viewport.x += dx;
  state.viewport.y += dy;
  scheduleDraw();
}

function updateZoomHud() {
  els.zoomLevel.textContent = `${Math.round(state.viewport.scale * 100)}%`;
}

function latestSceneEvent() {
  return state.events
    .filter((event) => event.type === "scene")
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .at(-1) || null;
}

function scenePayloadFrom(event) {
  if (!event) return null;
  const source = event.payload && typeof event.payload === "object" ? event.payload : event;
  return {
    elements: Array.isArray(source.elements) ? source.elements : [],
    appState: source.appState && typeof source.appState === "object" ? source.appState : {},
    files: source.files && typeof source.files === "object" ? source.files : {}
  };
}

function mergeSceneFiles(files = {}) {
  if (!files || typeof files !== "object") return excalidrawState.files;
  for (const [id, file] of Object.entries(files)) {
    if (file && typeof file === "object") {
      excalidrawState.files[id] = file;
    }
  }
  return excalidrawState.files;
}

function applyRemoteScene(event) {
  if (!excalidrawState.api || !event || (event.createdAt || 0) < excalidrawState.latestSceneAt) return;
  const scene = scenePayloadFrom(event);
  if (!scene) return;
  excalidrawState.latestSceneAt = event.createdAt || Date.now();
  excalidrawState.applyingRemoteScene = true;
  const files = mergeSceneFiles(scene.files);
  excalidrawState.lastPostedHash = sceneHash(scene.elements, files);
  if (Object.keys(files).length && typeof excalidrawState.api.addFiles === "function") {
    excalidrawState.api.addFiles(Object.values(files));
  }
  excalidrawState.api.updateScene({
    elements: scene.elements,
    appState: {
      viewBackgroundColor: "#fffdf7",
      ...scene.appState
    },
    files
  });
  setTimeout(() => {
    excalidrawState.applyingRemoteScene = false;
  }, 160);
}

function sceneHash(elements, files) {
  return JSON.stringify({
    elements: elements.map((element) => [element.id, element.version, element.versionNonce, element.updated]),
    files: Object.entries(files || {})
      .map(([id, file]) => [id, file?.id, file?.mimeType, file?.created, file?.dataURL?.length])
      .sort((a, b) => a[0].localeCompare(b[0]))
  });
}

function scheduleScenePost(elements, appState, files) {
  if (!state.roomId || !state.token || excalidrawState.applyingRemoteScene) return;
  const mergedFiles = mergeSceneFiles(files);
  const hash = sceneHash(elements, mergedFiles);
  if (hash === excalidrawState.lastPostedHash) return;
  excalidrawState.lastPostedHash = hash;
  clearTimeout(excalidrawState.postTimer);
  excalidrawState.postTimer = setTimeout(() => {
    postEvent({
      type: "scene",
      elements,
      appState: {
        viewBackgroundColor: appState.viewBackgroundColor || "#fffdf7"
      },
      files: mergedFiles
    });
  }, 450);
}

async function mountExcalidrawBoard() {
  if (!els.excalidrawBoard || excalidrawState.api) return;
  try {
    const [{ default: React }, { createRoot }, excalidraw] = await Promise.all([
      import("https://esm.sh/react@18.3.1"),
      import("https://esm.sh/react-dom@18.3.1/client"),
      import("https://esm.sh/@excalidraw/excalidraw@0.18.1?external=react,react-dom")
    ]);
    const root = createRoot(els.excalidrawBoard);
    root.render(
      React.createElement(excalidraw.Excalidraw, {
        excalidrawAPI: (api) => {
          excalidrawState.api = api;
          applyRemoteScene(latestSceneEvent());
        },
        initialData: {
          appState: {
            viewBackgroundColor: "#fffdf7"
          }
        },
        langCode: "zh-CN",
        name: "密室白板",
        onChange: (elements, appState, files) => scheduleScenePost(elements, appState, files),
        UIOptions: {
          canvasActions: {
            export: false,
            loadScene: false,
            saveAsImage: true,
            saveToActiveFile: false,
            toggleTheme: false
          }
        }
      })
    );
  } catch (error) {
    console.error(error);
    els.excalidrawBoard.innerHTML = '<div class="board-loading">白板加载失败，请刷新重试</div>';
    toast("白板加载失败，请刷新重试。");
  }
}

function scheduleDraw() {
  if (state.drawFrame) return;
  state.drawFrame = requestAnimationFrame(() => {
    state.drawFrame = null;
    drawBoard();
  });
}

function drawBoard() {
  const { width, height } = canvasSize();
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fffdf7";
  ctx.fillRect(0, 0, width, height);
  drawGrid();
  for (const event of state.events) drawEvent(event);
  if (state.currentStroke) drawStroke(state.currentStroke);
  drawSelectedImage();
}

function drawEvent(event) {
  if (event.type === "stroke") drawStroke(event);
  if (event.type === "text") drawText(event);
  if (event.type === "image") drawImage(event);
}

function drawGrid() {
  const { width, height } = canvasSize();
  const grid = 80;
  const topLeft = screenToWorld({ x: 0, y: 0 });
  const bottomRight = screenToWorld({ x: width, y: height });
  const startX = Math.floor(topLeft.x / grid) * grid;
  const endX = Math.ceil(bottomRight.x / grid) * grid;
  const startY = Math.floor(topLeft.y / grid) * grid;
  const endY = Math.ceil(bottomRight.y / grid) * grid;

  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(23, 23, 23, 0.08)";
  for (let x = startX; x <= endX; x += grid) {
    const screen = worldToScreen({ x, y: 0 });
    ctx.beginPath();
    ctx.moveTo(screen.x, 0);
    ctx.lineTo(screen.x, height);
    ctx.stroke();
  }
  for (let y = startY; y <= endY; y += grid) {
    const screen = worldToScreen({ x: 0, y });
    ctx.beginPath();
    ctx.moveTo(0, screen.y);
    ctx.lineTo(width, screen.y);
    ctx.stroke();
  }

  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(37, 88, 255, 0.18)";
  const origin = worldToScreen({ x: 0, y: 0 });
  ctx.beginPath();
  ctx.moveTo(origin.x, 0);
  ctx.lineTo(origin.x, height);
  ctx.moveTo(0, origin.y);
  ctx.lineTo(width, origin.y);
  ctx.stroke();
  ctx.restore();
}

function legacyPointToScreen(point) {
  const { width, height } = canvasSize();
  return { x: point.x * width, y: point.y * height };
}

function pointToScreen(point, item) {
  return item?.space === "world" ? worldToScreen(point) : legacyPointToScreen(point);
}

function drawStroke(stroke) {
  if (!stroke.points || stroke.points.length < 2) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(1, (stroke.size || 5) * (stroke.space === "world" ? state.viewport.scale : 1));
  ctx.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over";
  ctx.strokeStyle = stroke.color || "#252525";
  ctx.beginPath();
  stroke.points.forEach((point, index) => {
    const screen = pointToScreen(point, stroke);
    const x = screen.x;
    const y = screen.y;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.restore();
}

function wrapLines(text, maxWidth) {
  const lines = [];
  const source = String(text || "").split("\n");
  for (const paragraph of source) {
    let line = "";
    for (const char of paragraph) {
      const test = line + char;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = char;
      } else {
        line = test;
      }
    }
    lines.push(line);
  }
  return lines.slice(0, 8);
}

function drawText(item) {
  const { width } = canvasSize();
  const screen = item.space === "world" ? worldToScreen(item) : legacyPointToScreen(item);
  const x = screen.x;
  const y = screen.y;
  const fontSize = Math.max(10, Math.min(48, (item.size || 20) * (item.space === "world" ? state.viewport.scale : 1)));
  ctx.save();
  ctx.font = `700 ${fontSize}px ${handwritingFont}`;
  ctx.textBaseline = "top";
  ctx.fillStyle = item.color || "#252525";
  const lines = wrapLines(item.text, Math.max(80, Math.min(300, width - x - 18)));
  const pad = 10;
  const lineHeight = fontSize * 1.36;
  const boxWidth = Math.min(320, Math.max(...lines.map((line) => ctx.measureText(line).width), 80) + pad * 2);
  const boxHeight = lines.length * lineHeight + pad * 2;
  ctx.fillStyle = "rgba(244, 214, 109, 0.86)";
  ctx.fillRect(x - pad, y - pad, boxWidth, boxHeight);
  ctx.fillStyle = item.color || "#252525";
  lines.forEach((line, index) => ctx.fillText(line, x, y + index * lineHeight));
  ctx.restore();
}

function drawImage(item) {
  if (!item.src) return;
  let image = state.imageCache.get(item.src);
  if (!image) {
    image = new Image();
    image.onload = scheduleDraw;
    image.src = item.src;
    state.imageCache.set(item.src, image);
  }
  if (!image.complete) return;
  const rect = imageRectScreen(item);
  ctx.save();
  ctx.fillStyle = "#fff";
  ctx.shadowColor = "rgba(0, 0, 0, 0.18)";
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 6;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.shadowColor = "transparent";
  ctx.drawImage(image, rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
}

function imageRectScreen(item) {
  if (item.space === "world") {
    const screen = worldToScreen({ x: item.x, y: item.y });
    return {
      x: screen.x,
      y: screen.y,
      w: item.w * state.viewport.scale,
      h: item.h * state.viewport.scale
    };
  }
  const { width, height } = canvasSize();
  return {
    x: item.x * width,
    y: item.y * height,
    w: item.w * width,
    h: item.h * height
  };
}

function drawSelectedImage() {
  const item = selectedImage();
  if (!item) return;
  const rect = imageRectScreen(item);
  const handle = 14;
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#2558ff";
  ctx.setLineDash([8, 5]);
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  ctx.setLineDash([]);
  ctx.fillStyle = "#ffd84d";
  ctx.strokeStyle = "#171717";
  ctx.lineWidth = 2;
  ctx.fillRect(rect.x + rect.w - handle / 2, rect.y + rect.h - handle / 2, handle, handle);
  ctx.strokeRect(rect.x + rect.w - handle / 2, rect.y + rect.h - handle / 2, handle, handle);
  ctx.restore();
}

function appendEvent(event) {
  if (event.type === "scene") {
    state.events = state.events.filter((item) => item.type !== "scene");
    state.events.push(event);
    applyRemoteScene(event);
    return;
  }
  if (event.type === "image-update") {
    applyImageUpdate(event);
    return;
  }
  if (state.events.some((item) => item.id === event.id)) return;
  state.events.push(event);
  scheduleDraw();
  if (event.type === "file") renderFiles();
}

function selectedImage() {
  return state.events.find((item) => item.type === "image" && item.id === state.selectedImageId) || null;
}

function updateSelectionHint() {
  const image = selectedImage();
  if (!image) {
    els.selectionHint.classList.add("hidden");
    return;
  }
  els.selectionHint.textContent = image.name ? `贴图已选中 · ${image.name}` : "贴图已选中";
  els.selectionHint.classList.remove("hidden");
}

function imageEventsTopFirst() {
  return state.events.filter((event) => event.type === "image").slice().reverse();
}

function hitImageAt(screen) {
  const handleSize = 18;
  for (const image of imageEventsTopFirst()) {
    const rect = imageRectScreen(image);
    const inHandle =
      screen.x >= rect.x + rect.w - handleSize &&
      screen.x <= rect.x + rect.w + handleSize &&
      screen.y >= rect.y + rect.h - handleSize &&
      screen.y <= rect.y + rect.h + handleSize;
    if (inHandle) return { image, mode: "resize" };

    const inBody =
      screen.x >= rect.x &&
      screen.x <= rect.x + rect.w &&
      screen.y >= rect.y &&
      screen.y <= rect.y + rect.h;
    if (inBody) return { image, mode: "move" };
  }
  return null;
}

function updateBoardHover(screen) {
  const hit = state.tool === "move" && !state.panInteraction && !state.imageInteraction ? hitImageAt(screen) : null;
  els.canvasWrap.classList.toggle("can-grab-image", hit?.mode === "move");
  els.canvasWrap.classList.toggle("can-resize-image", hit?.mode === "resize");
}

function clearBoardHover() {
  els.canvasWrap.classList.remove("can-grab-image", "can-resize-image");
}

function applyImageUpdate(event) {
  const target = state.events.find((item) => item.type === "image" && item.id === event.id);
  if (!target) return;
  for (const key of ["x", "y", "w", "h"]) {
    if (Number.isFinite(Number(event[key]))) target[key] = Number(event[key]);
  }
  target.updatedAt = event.createdAt || Date.now();
  target.updatedBy = event.actor;
  scheduleDraw();
}

async function syncImageUpdate(image) {
  if (!image || image.space !== "world") return;
  await postEvent({
    type: "image-update",
    id: image.id,
    x: image.x,
    y: image.y,
    w: image.w,
    h: image.h
  });
}

async function postEvent(event) {
  if (!state.roomId || !state.token) return;
  try {
    await api(`/api/rooms/${state.roomId}/events`, {
      token: state.token,
      event
    });
  } catch (error) {
    toast(error.message);
  }
}

function connectEvents() {
  if (state.source) state.source.close();
  const source = new EventSource(`/api/rooms/${state.roomId}/events?token=${encodeURIComponent(state.token)}`);
  state.source = source;

  source.addEventListener("hello", (event) => {
    const data = JSON.parse(event.data);
    state.room = data.room;
    state.events = data.events || [];
    renderFiles();
    scheduleDraw();
  });

  for (const type of ["stroke", "text", "image", "image-update", "file", "scene"]) {
    source.addEventListener(type, (event) => appendEvent(JSON.parse(event.data)));
  }

  source.addEventListener("cursor", (event) => renderCursor(JSON.parse(event.data)));

  source.addEventListener("presence", (event) => renderPresence(JSON.parse(event.data).members || []));

  source.addEventListener("destroyed", (event) => {
    handleDestroyed(JSON.parse(event.data));
  });

  source.onerror = () => {
    if (state.room && Date.now() < state.room.expiresAt) {
      toast("连接有点不稳，正在自动重连。");
    }
  };
}

async function createRoom(form) {
  const formData = new FormData(form);
  const password = String(formData.get("password") || "").trim();
  if (password.length < 4) {
    setError(els.createError, "口令至少需要 4 个字符。");
    return;
  }
  setError(els.createError);
  try {
    const data = await api("/api/rooms", {
      title: formData.get("title"),
      password,
      mode: formData.get("mode"),
      ttlMinutes: Number(formData.get("ttl"))
    });
    window.history.pushState(null, "", `/r/${data.room.id}`);
    await joinRoom(data.room.id, password);
  } catch (error) {
    setError(els.createError, error.message);
  }
}

async function joinRoom(roomId, password) {
  try {
    const data = await api(`/api/rooms/${roomId}/join`, { password });
    state.roomId = roomId;
    state.password = password;
    state.token = data.token;
    state.self = data.self;
    state.room = data.room;
    state.events = data.events || [];
    state.selectedImageId = null;
    applyRemoteScene(latestSceneEvent());
    els.activeTitle.textContent = data.room.title || "密室";
    updateShareFields();
    showRoom();
    connectEvents();
    renderFiles();
    renderIdentity();
    updateSelectionHint();
    updateTimer();
    clearInterval(state.timer);
    state.timer = setInterval(updateTimer, 1000);
    toast(`你的临时代号：${data.self.name}`);
  } catch (error) {
    throw error;
  }
}

function renderPresence(members) {
  els.presenceCount.textContent = `${members.length} 在线`;
  els.presenceList.innerHTML = "";
  for (const member of members) {
    const item = document.createElement("div");
    item.className = "presence-item";
    item.classList.toggle("is-self", member.id === state.self?.id);
    item.innerHTML = `<span class="presence-dot" style="--dot:${member.color}"></span><span></span>`;
    item.querySelector("span:last-child").textContent = member.id === state.self?.id ? `${member.name}（你）` : member.name;
    els.presenceList.append(item);
  }
}

function renderIdentity() {
  if (!state.self?.name) {
    els.identityCards.forEach((card) => card.classList.add("hidden"));
    return;
  }
  els.identityNames.forEach((name) => {
    name.textContent = state.self.name;
  });
  els.identityCards.forEach((card) => card.classList.remove("hidden"));
}

function renderFiles() {
  const files = state.events.filter((event) => event.type === "file");
  els.fileCount.textContent = `${files.length} 个`;
  if (!files.length) {
    els.fileList.className = "file-list empty-state";
    els.fileList.innerHTML = `<p>还没有附件。</p><label class="secondary-action compact">选择文件<input id="empty-file-input" type="file" multiple /></label>`;
    $("#empty-file-input")?.addEventListener("change", (event) => addAttachmentFiles([...event.target.files]));
    return;
  }
  els.fileList.className = "file-list";
  els.fileList.innerHTML = "";
  for (const file of files.slice().reverse()) {
    const item = document.createElement("div");
    item.className = "file-item";
    const link = document.createElement("a");
    link.href = file.dataUrl;
    link.download = file.name || "attachment";
    link.textContent = file.name || "未命名文件";
    const meta = document.createElement("div");
    meta.className = "file-meta";
    meta.textContent = `${formatBytes(file.size || 0)} · ${file.actor?.name || "访客"}`;
    item.append(link, meta);
    els.fileList.append(item);
  }
}

function renderCursor(event) {
  if (!event.actor || event.actor.id === state.self?.id) return;
  let cursor = state.cursors.get(event.actor.id);
  if (!cursor) {
    cursor = document.createElement("div");
    cursor.className = "remote-cursor";
    cursor.innerHTML = `<span></span>`;
    els.cursorLayer.append(cursor);
    state.cursors.set(event.actor.id, cursor);
  }
  const screen = event.space === "world" ? worldToScreen(event) : legacyPointToScreen(event);
  cursor.style.left = `${screen.x}px`;
  cursor.style.top = `${screen.y}px`;
  cursor.style.setProperty("--cursor-color", event.actor.color || "#2558ff");
  cursor.querySelector("span").textContent = event.actor.name || "对方";
  clearTimeout(cursor.hideTimer);
  cursor.hideTimer = setTimeout(() => {
    cursor.remove();
    state.cursors.delete(event.actor.id);
  }, 5000);
}

function openTextEditor(point) {
  state.currentTextPoint = point;
  const { width, height } = canvasSize();
  const screen = worldToScreen(point);
  els.textEditor.style.left = `${Math.min(Math.max(12, screen.x), width - 282)}px`;
  els.textEditor.style.top = `${Math.min(Math.max(12, screen.y), height - 160)}px`;
  els.textArea.value = "";
  els.textEditor.classList.remove("hidden");
  els.textArea.focus();
}

function closeTextEditor() {
  state.currentTextPoint = null;
  els.textEditor.classList.add("hidden");
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("文件读取失败。"));
    reader.readAsDataURL(file);
  });
}

async function addImageFile(file, point = { x: 0.5, y: 0.5 }) {
  if (!file || !file.type.startsWith("image/")) return;
  if (file.size > 6 * 1024 * 1024) {
    toast("图片超过 6MB，先压小一点再贴。");
    return;
  }
  const src = await readFileAsDataUrl(file);
  await addImageSource(src, file.name || "粘贴图片", point);
}

async function addImageSource(src, name = "粘贴图片", point = { x: 0, y: 0 }) {
  if (!src) return;
  const image = new Image();
  image.onload = () => {
    const { width, height } = canvasSize();
    const maxWidth = Math.min(320, width * 0.42);
    const ratio = image.width ? image.height / image.width : 0.7;
    const displayWidth = maxWidth;
    const displayHeight = Math.min(height * 0.5, displayWidth * ratio);
    const worldWidth = displayWidth / state.viewport.scale;
    const worldHeight = displayHeight / state.viewport.scale;
    postEvent({
      type: "image",
      space: "world",
      src,
      name,
      x: point.x - worldWidth / 2,
      y: point.y - worldHeight / 2,
      w: worldWidth,
      h: worldHeight
    });
  };
  image.onerror = () => {
    toast("这张图片暂时贴不上，可以先保存图片后再粘贴或拖入。");
  };
  image.src = src;
}

function firstImageSrcFromHtml(html) {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.querySelector("img")?.getAttribute("src") || "";
}

function looksLikeImageUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "data:" && url.pathname.startsWith("image/")
    ) || (
      ["http:", "https:"].includes(url.protocol) &&
      /\.(apng|avif|gif|jpe?g|png|svg|webp)$/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

async function imageFileFromClipboard(clipboardData) {
  const files = [...(clipboardData.files || [])];
  const fileImage = files.find((file) => file.type.startsWith("image/"));
  if (fileImage) return fileImage;

  const items = [...(clipboardData.items || [])];
  const imageItem = items.find((item) => item.kind === "file" && item.type.startsWith("image/"));
  return imageItem?.getAsFile() || null;
}

async function addAttachmentFiles(files) {
  for (const file of files) {
    if (file.size > 6 * 1024 * 1024) {
      toast(`${file.name} 超过 6MB，已跳过。`);
      continue;
    }
    const dataUrl = await readFileAsDataUrl(file);
    await postEvent({
      type: "file",
      name: file.name,
      size: file.size,
      mime: file.type || "application/octet-stream",
      dataUrl
    });
  }
}

function sendCursor(point) {
  const now = Date.now();
  if (now - state.cursorSentAt < 120) return;
  state.cursorSentAt = now;
  postEvent({
    type: "cursor",
    space: "world",
    x: point.x,
    y: point.y
  });
}

function handleDestroyed(data) {
  if (state.source) state.source.close();
  state.source = null;
  state.room = null;
  state.token = null;
  state.self = null;
  state.events = [];
  state.selectedImageId = null;
  excalidrawState.latestSceneAt = 0;
  excalidrawState.lastPostedHash = "";
  if (excalidrawState.api) {
    excalidrawState.api.updateScene({
      elements: [],
      appState: {
        viewBackgroundColor: "#fffdf7"
      }
    });
  }
  state.cursors.clear();
  renderIdentity();
  updateSelectionHint();
  els.cursorLayer.innerHTML = "";
  clearInterval(state.timer);
  window.history.pushState(null, "", "/");
  const reason = data?.reason === "expired" ? "房间已到期自动销毁。" : "房间已经销毁。";
  showLobby(reason);
}

function beginPan(event, screen) {
  event.preventDefault();
  state.panInteraction = {
    pointerId: event.pointerId,
    last: screen
  };
  els.canvasWrap.classList.add("is-panning");
  els.board.setPointerCapture(event.pointerId);
}

function beginImageInteraction(event, hit, screen, world) {
  event.preventDefault();
  const image = hit.image;
  if (image.space !== "world") return;
  state.selectedImageId = image.id;
  updateSelectionHint();
  state.imageInteraction = {
    pointerId: event.pointerId,
    mode: hit.mode,
    startWorld: world,
    original: {
      x: image.x,
      y: image.y,
      w: image.w,
      h: image.h
    }
  };
  els.canvasWrap.classList.toggle("is-moving-image", hit.mode === "move");
  els.canvasWrap.classList.toggle("is-resizing-image", hit.mode === "resize");
  els.board.setPointerCapture(event.pointerId);
  scheduleDraw();
}

function updateImageInteraction(world) {
  const interaction = state.imageInteraction;
  if (!interaction) return;
  const image = selectedImage();
  if (!image) return;
  const dx = world.x - interaction.startWorld.x;
  const dy = world.y - interaction.startWorld.y;

  if (interaction.mode === "move") {
    image.x = interaction.original.x + dx;
    image.y = interaction.original.y + dy;
  } else {
    const minSize = 48 / state.viewport.scale;
    const nextW = Math.max(minSize, interaction.original.w + dx);
    const nextH = Math.max(minSize, interaction.original.h + dy);
    const ratio = interaction.original.h / interaction.original.w || 1;
    const scale = Math.max(nextW / interaction.original.w, nextH / interaction.original.h);
    image.w = Math.max(minSize, interaction.original.w * scale);
    image.h = Math.max(minSize, interaction.original.w * scale * ratio);
  }
  scheduleDraw();
}

async function finishImageInteraction(event) {
  const interaction = state.imageInteraction;
  if (!interaction) return;
  if (event.pointerId === interaction.pointerId && els.board.hasPointerCapture(event.pointerId)) {
    els.board.releasePointerCapture(event.pointerId);
  }
  state.imageInteraction = null;
  els.canvasWrap.classList.remove("is-moving-image", "is-resizing-image");
  await syncImageUpdate(selectedImage());
}

function finishPan(event) {
  if (!state.panInteraction) return;
  if (event.pointerId === state.panInteraction.pointerId && els.board.hasPointerCapture(event.pointerId)) {
    els.board.releasePointerCapture(event.pointerId);
  }
  state.panInteraction = null;
  els.canvasWrap.classList.remove("is-panning");
}

function isTypingTarget(target = document.activeElement) {
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName) || target?.isContentEditable;
}

function handleBoardShortcut(event) {
  const key = event.key.toLowerCase();
  if (key === "escape" && !els.textEditor.classList.contains("hidden")) {
    closeTextEditor();
    event.preventDefault();
    return;
  }
  if (!state.roomId || isTypingTarget()) return;
  if (event.code === "Space") {
    event.preventDefault();
    state.isSpacePanning = true;
    els.canvasWrap.dataset.tool = "move";
    return;
  }
  if (key === "escape") {
    closeTextEditor();
    state.selectedImageId = null;
    updateSelectionHint();
    scheduleDraw();
    return;
  }
  if (key === "v") setTool("move");
  else if (key === "p") setTool("pen");
  else if (key === "e") setTool("eraser");
  else if (key === "t") setTool("text");
  else if (key === "+" || key === "=") zoomFromCenter(1.25);
  else if (key === "-" || key === "_") zoomFromCenter(0.8);
  else if (key === "0") resetViewport();
  else if (key === "f") fitToContent();
  else return;
  event.preventDefault();
}

function bindEvents() {
  $$('input[name="mode"]').forEach((input) => {
    input.addEventListener("change", () => applyModePreset(input.value));
  });

  els.randomPassword.addEventListener("click", () => {
    els.roomPassword.value = makePassword();
  });

  els.createForm.addEventListener("submit", (event) => {
    event.preventDefault();
    createRoom(event.currentTarget);
  });

  els.joinForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const roomId = currentRoomIdFromPath();
    if (!roomId) return;
    setError(els.joinError);
    try {
      await joinRoom(roomId, els.joinPassword.value.trim());
    } catch (error) {
      setError(els.joinError, error.message);
    }
  });

  $$(".tool-button[data-tool]").forEach((button) => {
    button.addEventListener("click", () => setTool(button.dataset.tool));
  });

  $$(".swatch").forEach((button) => {
    button.addEventListener("click", () => setColor(button.dataset.color));
  });

  els.brushSize.addEventListener("input", () => {
    state.size = Number(els.brushSize.value);
  });

  els.zoomOut.addEventListener("click", () => zoomFromCenter(0.8));
  els.zoomIn.addEventListener("click", () => zoomFromCenter(1.25));
  els.zoomReset.addEventListener("click", resetViewport);
  els.zoomFit.addEventListener("click", fitToContent);

  els.copyInvite.addEventListener("click", copyInvite);
  els.shareButton.addEventListener("click", copyInvite);

  els.destroyButton.addEventListener("click", () => {
    if (typeof els.destroyDialog.showModal === "function") els.destroyDialog.showModal();
  });

  els.confirmDestroy.addEventListener("click", async () => {
    els.destroyDialog.close();
    try {
      await api(`/api/rooms/${state.roomId}/destroy`, { token: state.token });
    } catch (error) {
      toast(error.message);
    }
  });

  els.board.addEventListener("pointerdown", (event) => {
    const screen = toScreenPoint(event);
    const point = rememberBoardPoint(screenToWorld(screen));
    sendCursor(point);

    if (state.isSpacePanning || state.tool === "move") {
      const hit = state.tool === "move" ? hitImageAt(screen) : null;
      if (hit) beginImageInteraction(event, hit, screen, point);
      else {
        state.selectedImageId = null;
        updateSelectionHint();
        scheduleDraw();
        beginPan(event, screen);
      }
      return;
    }

    if (state.tool === "text") {
      openTextEditor(point);
      return;
    }
    if (state.tool === "image") {
      state.pendingImagePoint = point;
      els.imageInput.click();
      return;
    }
    event.preventDefault();
    els.board.setPointerCapture(event.pointerId);
    state.currentStroke = {
      type: "stroke",
      space: "world",
      tool: state.tool,
      color: state.color,
      size: state.tool === "eraser" ? state.size * 2.2 : state.size,
      points: [point]
    };
    scheduleDraw();
  });

  els.board.addEventListener("pointermove", (event) => {
    const screen = toScreenPoint(event);
    const point = rememberBoardPoint(screenToWorld(screen));
    sendCursor(point);

    updateBoardHover(screen);

    if (state.panInteraction) {
      panBy(screen.x - state.panInteraction.last.x, screen.y - state.panInteraction.last.y);
      state.panInteraction.last = screen;
      return;
    }

    if (state.imageInteraction) {
      updateImageInteraction(point);
      return;
    }

    if (!state.currentStroke) return;
    const last = state.currentStroke.points[state.currentStroke.points.length - 1];
    if (pointDistance(point, last) > 2) {
      state.currentStroke.points.push(point);
      scheduleDraw();
    }
  });

  els.board.addEventListener("pointerup", (event) => {
    if (state.imageInteraction) {
      finishImageInteraction(event);
      return;
    }
    if (state.panInteraction) {
      finishPan(event);
      return;
    }
    if (!state.currentStroke) return;
    els.board.releasePointerCapture(event.pointerId);
    const stroke = state.currentStroke;
    state.currentStroke = null;
    if (stroke.points.length > 1) postEvent(stroke);
    scheduleDraw();
  });

  els.board.addEventListener("pointercancel", (event) => {
    if (state.imageInteraction) finishImageInteraction(event);
    if (state.panInteraction) finishPan(event);
    state.currentStroke = null;
    clearBoardHover();
    scheduleDraw();
  });

  els.board.addEventListener("pointerleave", clearBoardHover);

  els.canvasWrap.addEventListener("wheel", (event) => {
    if (!state.roomId) return;
    event.preventDefault();
    const screen = toScreenPoint(event);
    const factor = Math.exp(-event.deltaY * 0.0014);
    zoomAt(screen, state.viewport.scale * factor);
  }, { passive: false });

  els.textEditor.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = els.textArea.value.trim();
    if (text && state.currentTextPoint) {
      postEvent({
        type: "text",
        space: "world",
        text,
        color: state.color,
        size: 20,
        x: state.currentTextPoint.x,
        y: state.currentTextPoint.y
      });
    }
    closeTextEditor();
  });

  els.textCancel.addEventListener("click", closeTextEditor);

  els.imageInput.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (file) await addImageFile(file, state.pendingImagePoint || { x: 0.5, y: 0.5 });
    state.pendingImagePoint = null;
    event.target.value = "";
  });

  els.fileInput.addEventListener("change", async (event) => {
    await addAttachmentFiles([...event.target.files]);
    event.target.value = "";
  });

  els.sideFileInput.addEventListener("change", async (event) => {
    await addAttachmentFiles([...event.target.files]);
    event.target.value = "";
  });

  els.canvasWrap.addEventListener("dragover", (event) => {
    event.preventDefault();
    els.dropHint.classList.remove("hidden");
  });

  els.canvasWrap.addEventListener("dragleave", () => {
    els.dropHint.classList.add("hidden");
  });

  els.canvasWrap.addEventListener("drop", async (event) => {
    event.preventDefault();
    els.dropHint.classList.add("hidden");
    const files = [...event.dataTransfer.files];
    const point = rememberBoardPoint(toPoint(event));
    const images = files.filter((file) => file.type.startsWith("image/"));
    const others = files.filter((file) => !file.type.startsWith("image/"));
    for (const image of images) await addImageFile(image, point);
    if (others.length) await addAttachmentFiles(others);
  });

  window.addEventListener("paste", async (event) => {
    if (!state.roomId) return;
    const point = pastePoint();
    const image = await imageFileFromClipboard(event.clipboardData);
    if (image) {
      event.preventDefault();
      await addImageFile(image, point);
      toast("图片已贴到白板。");
      return;
    }

    const htmlImageSrc = firstImageSrcFromHtml(event.clipboardData.getData("text/html"));
    if (htmlImageSrc) {
      event.preventDefault();
      await addImageSource(htmlImageSrc, "复制的网页图片", point);
      toast("图片已贴到白板。");
      return;
    }

    const text = event.clipboardData.getData("text/plain").trim();
    if (looksLikeImageUrl(text)) {
      event.preventDefault();
      await addImageSource(text, "复制的图片链接", point);
      toast("图片已贴到白板。");
      return;
    }

    if (text && state.tool === "text") {
      event.preventDefault();
      openTextEditor(point);
      els.textArea.value = text.slice(0, 180);
    }
  });

  window.addEventListener("keydown", handleBoardShortcut);

  window.addEventListener("keyup", (event) => {
    if (event.code === "Space") {
      state.isSpacePanning = false;
      els.canvasWrap.dataset.tool = state.tool;
    }
  });

  window.addEventListener("resize", resizeCanvas);
}

function init() {
  applyModePreset(document.querySelector('input[name="mode"]:checked')?.value || "intimate");
  bindEvents();
  updateZoomHud();
  els.canvasWrap.dataset.tool = state.tool;
  resizeCanvas();
  const roomId = currentRoomIdFromPath();
  if (roomId) showJoin(roomId);
}

init();
