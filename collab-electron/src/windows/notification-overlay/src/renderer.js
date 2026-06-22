const MAX_TOASTS = 20;
const PAD = 14;
const GAP = 10;
const PEEK_OFFSET = 12;
const PEEK_SCALE = 0.05;
const MAX_PEEK = 3;

const soundCache = {};

function playNotifSound(type) {
	const file = type === "finished" ? "notif-finished.wav" : "notif-attention.wav";
	const volume = type === "finished" ? 0.2 : 0.7;
	if (!soundCache[type]) {
		soundCache[type] = new Audio(file);
	}
	const audio = soundCache[type];
	audio.volume = volume;
	audio.currentTime = 0;
	audio.play().catch(() => {});
}

const container = document.getElementById("toast-container");
const toasts = new Map();

let isDark = false;
let expanded = false;

function applyTheme(dark) {
	isDark = dark;
	document.documentElement.classList.toggle("dark", dark);
}

function reportSize(height) {
	const empty = toasts.size === 0;
	window.notifApi.resize({
		height: empty ? 0 : Math.max(Math.ceil(height), 56),
		empty,
	});
}

// All cards are absolutely positioned from the bottom. Collapsed = a deck with
// the newest card in front and older ones peeking behind it. Expanded (hover) =
// the full list fanned out upward. layout() also reports the content height so
// the window resizes to wrap exactly what's visible.
function layout() {
	const items = [...toasts.values()];
	const n = items.length;
	if (n === 0) {
		reportSize(0);
		return;
	}

	if (expanded) {
		let offset = PAD;
		for (let i = n - 1; i >= 0; i--) {
			const el = items[i];
			el.style.bottom = `${offset}px`;
			el.style.transform = "translateY(0) scale(1)";
			el.style.opacity = "1";
			el.style.zIndex = String(i + 1);
			el.style.pointerEvents = "auto";
			offset += el.offsetHeight + GAP;
		}
		reportSize(offset - GAP + PAD);
	} else {
		const front = items[n - 1];
		for (let i = 0; i < n; i++) {
			const el = items[i];
			const depth = Math.min(n - 1 - i, MAX_PEEK + 1);
			el.style.bottom = `${PAD}px`;
			el.style.transform =
				`translateY(${-depth * PEEK_OFFSET}px) scale(${1 - depth * PEEK_SCALE})`;
			el.style.opacity = depth > MAX_PEEK ? "0" : "1";
			el.style.zIndex = String(n - depth);
			el.style.pointerEvents = depth === 0 ? "auto" : "none";
		}
		const peek = Math.min(n - 1, MAX_PEEK) * PEEK_OFFSET;
		reportSize(PAD + front.offsetHeight + peek + PAD);
	}
}

container.addEventListener("mouseenter", () => {
	expanded = true;
	layout();
});
container.addEventListener("mouseleave", () => {
	expanded = false;
	layout();
});

function dismissToast(id) {
	const el = toasts.get(id);
	if (!el) return;
	toasts.delete(id);
	el.style.pointerEvents = "none";
	el.style.opacity = "0";
	el.style.transform = `${el.style.transform} translateX(40px)`;
	const done = () => {
		el.remove();
		layout();
	};
	el.addEventListener("transitionend", done, { once: true });
	setTimeout(done, 320);
	layout();
}

function buildToast({ id, title, body, tileId, cwd }) {
	const el = document.createElement("div");
	el.className = "toast-item";
	el.dataset.id = id;
	if (tileId) el.dataset.tileId = tileId;
	if (cwd) el.dataset.cwd = cwd;

	const iconEl = document.createElement("div");
	iconEl.className = "toast-icon";
	iconEl.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/><path d="M8 12l3 3 5-6"/></svg>`;

	const appLabel = document.createElement("span");
	appLabel.className = "toast-app";
	appLabel.textContent = "Collaborator";

	const closeBtn = document.createElement("button");
	closeBtn.className = "toast-close";
	closeBtn.textContent = "×";
	closeBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		dismissToast(id);
	});

	const headerRow = document.createElement("div");
	headerRow.className = "toast-header";
	headerRow.appendChild(iconEl);
	headerRow.appendChild(appLabel);
	headerRow.appendChild(closeBtn);

	const titleEl = document.createElement("div");
	titleEl.className = "toast-title";
	titleEl.textContent = title || "Notification";

	el.appendChild(headerRow);
	el.appendChild(titleEl);
	if (body) {
		const bodyEl = document.createElement("div");
		bodyEl.className = "toast-body";
		bodyEl.textContent = body;
		el.appendChild(bodyEl);
	}

	el.style.cursor = (tileId || cwd) ? "pointer" : "default";
	el.addEventListener("click", (e) => {
		if (e.target.closest(".toast-close")) return;
		window.notifApi.notificationClicked({ tileId, cwd });
		dismissToast(id);
	});

	return el;
}

function showToast(data) {
	if (toasts.has(data.id)) return;

	while (toasts.size >= MAX_TOASTS) {
		const oldest = toasts.keys().next().value;
		const el = toasts.get(oldest);
		toasts.delete(oldest);
		if (el) el.remove();
	}

	const el = buildToast(data);
	el.style.opacity = "0";
	el.style.transform = "translateX(40px)";
	container.appendChild(el);
	toasts.set(data.id, el);

	if (data.sound) playNotifSound(data.sound);

	requestAnimationFrame(layout);
}

window.notifApi.onNotification(showToast);
function normCwd(c) {
	return c ? c.replace(/\\/g, "/").toLowerCase() : "";
}
window.notifApi.onDismiss(({ tileId, cwd }) => {
	const target = normCwd(cwd);
	for (const [id, el] of toasts) {
		const tileMatch = tileId && el.dataset.tileId === tileId;
		const cwdMatch = target && normCwd(el.dataset.cwd) === target;
		if (tileMatch || cwdMatch) dismissToast(id);
	}
});
window.notifApi.onTheme(applyTheme);

const style = document.createElement("style");
style.textContent = `
:root {
	--bg: rgb(252, 252, 252);
	--fg: rgb(22, 22, 22);
	--fg-secondary: rgb(96, 96, 96);
	--border: rgba(0, 0, 0, 0.08);
	--accent: rgb(0, 103, 192);
	--radius: 8px;
	--shadow: 0 2px 6px rgba(0, 0, 0, 0.08), 0 8px 24px rgba(0, 0, 0, 0.12);
	--font-sans: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
	--font-mono: 'Cascadia Code', 'Consolas', monospace;
}

.dark {
	--bg: rgb(44, 44, 44);
	--fg: rgb(245, 245, 245);
	--fg-secondary: rgb(170, 170, 170);
	--border: rgba(255, 255, 255, 0.08);
	--accent: rgb(96, 205, 255);
	--shadow: 0 2px 6px rgba(0, 0, 0, 0.3), 0 8px 24px rgba(0, 0, 0, 0.4);
}

* { margin: 0; padding: 0; box-sizing: border-box; }

html, body {
	width: 100%;
	height: 100%;
	background: transparent !important;
	overflow: hidden;
	font-family: var(--font-sans);
	-webkit-font-smoothing: antialiased;
}

#toast-container {
	position: fixed;
	inset: 0;
}

.toast-item {
	position: absolute;
	right: ${PAD}px;
	width: calc(100% - ${PAD * 2}px);
	padding: 14px 16px 13px;
	background: var(--bg);
	border: 1px solid var(--border);
	border-radius: var(--radius);
	box-shadow: var(--shadow);
	color: var(--fg);
	transform-origin: bottom center;
	transition:
		transform 0.26s cubic-bezier(0.16, 1, 0.3, 1),
		bottom 0.26s cubic-bezier(0.16, 1, 0.3, 1),
		opacity 0.2s ease;
	will-change: transform, bottom, opacity;
}

.toast-header {
	display: flex;
	align-items: center;
	gap: 8px;
	margin-bottom: 8px;
}

.toast-icon {
	width: 16px;
	height: 16px;
	color: var(--accent);
	flex-shrink: 0;
	display: flex;
	align-items: center;
}

.toast-icon svg { width: 16px; height: 16px; }

.toast-app {
	font-size: 12px;
	color: var(--fg-secondary);
	flex: 1;
	font-weight: 400;
}

.toast-title {
	font-weight: 600;
	font-size: 14px;
	line-height: 1.3;
	color: var(--fg);
	margin-bottom: 4px;
	word-wrap: break-word;
}

.toast-body {
	font-size: 13px;
	line-height: 1.4;
	color: var(--fg-secondary);
	word-wrap: break-word;
}

.toast-close {
	background: none;
	border: none;
	color: var(--fg-secondary);
	cursor: pointer;
	font-size: 18px;
	line-height: 1;
	padding: 2px 4px;
	border-radius: 4px;
	margin-left: auto;
	flex-shrink: 0;
	transition: background 0.1s ease, color 0.1s ease;
}

.toast-close:hover {
	color: var(--fg);
	background: rgba(128, 128, 128, 0.15);
}
`;
document.head.appendChild(style);
