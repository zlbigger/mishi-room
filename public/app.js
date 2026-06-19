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
  joinName: $("#join-name"),
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
  board: $("#board"),
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
  lastBoardPoint: { x: 0.5, y: 0.5 },
  imageCache: new Map(),
  cursors: new Map(),
  cursorSentAt: 0,
  drawFrame: null,
  timer: null
};

const ctx = els.board.getContext("2d");

function makePassword() {
  const words = ["moon", "paper", "mint", "river", "room", "warm", "quiet", "blue"];
  const word = words[Math.floor(Math.random() * words.length)];
  return `${word}-${Math.floor(1000 + Math.random() * 9000)}`;
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
  els.joinRoomId.textContent = `房间 ${roomId}`;
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
  if (tool === "image") {
    state.pendingImagePoint = { x: 0.5, y: 0.5 };
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

function toPoint(event) {
  const rect = els.board.getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
  return { x, y };
}

function rememberBoardPoint(point) {
  state.lastBoardPoint = point;
  return point;
}

function pastePoint() {
  return state.pendingImagePoint || state.lastBoardPoint || { x: 0.5, y: 0.5 };
}

function pointDistance(a, b) {
  const size = canvasSize();
  const dx = (a.x - b.x) * size.width;
  const dy = (a.y - b.y) * size.height;
  return Math.hypot(dx, dy);
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
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  for (const event of state.events) drawEvent(event);
  if (state.currentStroke) drawStroke(state.currentStroke);
}

function drawEvent(event) {
  if (event.type === "stroke") drawStroke(event);
  if (event.type === "text") drawText(event);
  if (event.type === "image") drawImage(event);
}

function drawStroke(stroke) {
  if (!stroke.points || stroke.points.length < 2) return;
  const { width, height } = canvasSize();
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = stroke.size || 5;
  ctx.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over";
  ctx.strokeStyle = stroke.color || "#252525";
  ctx.beginPath();
  stroke.points.forEach((point, index) => {
    const x = point.x * width;
    const y = point.y * height;
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
  const { width, height } = canvasSize();
  const x = item.x * width;
  const y = item.y * height;
  const fontSize = Math.max(16, Math.min(24, item.size || 20));
  ctx.save();
  ctx.font = `700 ${fontSize}px Inter, ui-sans-serif, system-ui, sans-serif`;
  ctx.textBaseline = "top";
  ctx.fillStyle = item.color || "#252525";
  const lines = wrapLines(item.text, Math.min(300, width - x - 18));
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
  const { width, height } = canvasSize();
  let image = state.imageCache.get(item.src);
  if (!image) {
    image = new Image();
    image.onload = scheduleDraw;
    image.src = item.src;
    state.imageCache.set(item.src, image);
  }
  if (!image.complete) return;
  const x = item.x * width;
  const y = item.y * height;
  const w = item.w * width;
  const h = item.h * height;
  ctx.save();
  ctx.fillStyle = "#fff";
  ctx.shadowColor = "rgba(0, 0, 0, 0.18)";
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 6;
  ctx.fillRect(x, y, w, h);
  ctx.shadowColor = "transparent";
  ctx.drawImage(image, x, y, w, h);
  ctx.restore();
}

function appendEvent(event) {
  if (state.events.some((item) => item.id === event.id)) return;
  state.events.push(event);
  scheduleDraw();
  if (event.type === "file") renderFiles();
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

  for (const type of ["stroke", "text", "image", "file"]) {
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
    await joinRoom(data.room.id, password, "你");
  } catch (error) {
    setError(els.createError, error.message);
  }
}

async function joinRoom(roomId, password, name) {
  try {
    const data = await api(`/api/rooms/${roomId}/join`, { password, name });
    state.roomId = roomId;
    state.password = password;
    state.token = data.token;
    state.self = data.self;
    state.room = data.room;
    state.events = data.events || [];
    els.activeTitle.textContent = data.room.title || "密室";
    updateShareFields();
    showRoom();
    connectEvents();
    renderFiles();
    updateTimer();
    clearInterval(state.timer);
    state.timer = setInterval(updateTimer, 1000);
    toast("已进入密室。");
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
    item.innerHTML = `<span class="presence-dot" style="--dot:${member.color}"></span><span></span>`;
    item.querySelector("span:last-child").textContent = member.id === state.self?.id ? `${member.name}（你）` : member.name;
    els.presenceList.append(item);
  }
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
  const { width, height } = canvasSize();
  let cursor = state.cursors.get(event.actor.id);
  if (!cursor) {
    cursor = document.createElement("div");
    cursor.className = "remote-cursor";
    cursor.innerHTML = `<span></span>`;
    els.cursorLayer.append(cursor);
    state.cursors.set(event.actor.id, cursor);
  }
  cursor.style.left = `${event.x * width}px`;
  cursor.style.top = `${event.y * height}px`;
  cursor.style.setProperty("--cursor-color", event.actor.color || "#2558ff");
  cursor.querySelector("span").textContent = event.actor.name || "对方";
  clearTimeout(cursor.hideTimer);
  cursor.hideTimer = setTimeout(() => cursor.remove(), 5000);
}

function openTextEditor(point) {
  state.currentTextPoint = point;
  const { width, height } = canvasSize();
  els.textEditor.style.left = `${Math.min(point.x * width, width - 272)}px`;
  els.textEditor.style.top = `${Math.min(point.y * height, height - 150)}px`;
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

async function addImageSource(src, name = "粘贴图片", point = { x: 0.5, y: 0.5 }) {
  if (!src) return;
  const image = new Image();
  image.onload = () => {
    const { width, height } = canvasSize();
    const maxWidth = Math.min(320, width * 0.42);
    const ratio = image.width ? image.height / image.width : 0.7;
    const displayWidth = maxWidth;
    const displayHeight = Math.min(height * 0.5, displayWidth * ratio);
    postEvent({
      type: "image",
      src,
      name,
      x: Math.min(0.92, Math.max(0.02, point.x - displayWidth / width / 2)),
      y: Math.min(0.88, Math.max(0.02, point.y - displayHeight / height / 2)),
      w: displayWidth / width,
      h: displayHeight / height
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
    x: point.x,
    y: point.y
  });
}

function handleDestroyed(data) {
  if (state.source) state.source.close();
  state.source = null;
  state.room = null;
  state.token = null;
  state.events = [];
  state.cursors.clear();
  els.cursorLayer.innerHTML = "";
  clearInterval(state.timer);
  window.history.pushState(null, "", "/");
  const reason = data?.reason === "expired" ? "房间已到期自动销毁。" : "房间已经销毁。";
  showLobby(reason);
}

function bindEvents() {
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
      await joinRoom(roomId, els.joinPassword.value.trim(), els.joinName.value.trim());
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
    const point = rememberBoardPoint(toPoint(event));
    sendCursor(point);
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
      tool: state.tool,
      color: state.color,
      size: state.tool === "eraser" ? state.size * 2.2 : state.size,
      points: [point]
    };
    scheduleDraw();
  });

  els.board.addEventListener("pointermove", (event) => {
    const point = rememberBoardPoint(toPoint(event));
    sendCursor(point);
    if (!state.currentStroke) return;
    const last = state.currentStroke.points[state.currentStroke.points.length - 1];
    if (pointDistance(point, last) > 2) {
      state.currentStroke.points.push(point);
      scheduleDraw();
    }
  });

  els.board.addEventListener("pointerup", (event) => {
    if (!state.currentStroke) return;
    els.board.releasePointerCapture(event.pointerId);
    const stroke = state.currentStroke;
    state.currentStroke = null;
    if (stroke.points.length > 1) postEvent(stroke);
    scheduleDraw();
  });

  els.board.addEventListener("pointercancel", () => {
    state.currentStroke = null;
    scheduleDraw();
  });

  els.textEditor.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = els.textArea.value.trim();
    if (text && state.currentTextPoint) {
      postEvent({
        type: "text",
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

  window.addEventListener("resize", resizeCanvas);
}

function init() {
  els.roomPassword.value = makePassword();
  bindEvents();
  resizeCanvas();
  const roomId = currentRoomIdFromPath();
  if (roomId) showJoin(roomId);
}

init();
