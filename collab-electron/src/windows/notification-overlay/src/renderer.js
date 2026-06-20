const DISMISS_MS = 8000;
const MAX_TOASTS = 3;

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

function applyTheme(dark) {
	isDark = dark;
	document.documentElement.classList.toggle("dark", dark);
}

function reportSize() {
	const empty = toasts.size === 0;
	const height = empty
		? 0
		: Math.ceil(container.getBoundingClientRect().height);
	window.notifApi.resize({ height, empty });
}

const resizeObserver = new ResizeObserver(() => reportSize());
resizeObserver.observe(container);

function dismissToast(id) {
	const el = toasts.get(id);
	if (!el) return;
	el.classList.add("toast-exit");
	el.addEventListener("animationend", () => {
		el.remove();
		toasts.delete(id);
		reportSize();
	}, { once: true });
}

function showToast({ id, title, body, tileId, cwd, sound }) {
	if (toasts.has(id)) {
		dismissToast(id);
	}

	while (toasts.size >= MAX_TOASTS) {
		const oldest = toasts.keys().next().value;
		dismissToast(oldest);
	}

	const el = document.createElement("div");
	el.className = "toast-item";
	el.dataset.id = id;
	if (tileId) el.dataset.tileId = tileId;
	if (cwd) el.dataset.cwd = cwd;

	const titleEl = document.createElement("div");
	titleEl.className = "toast-title";
	titleEl.textContent = title || "Notification";

	const bodyEl = document.createElement("div");
	bodyEl.className = "toast-body";
	bodyEl.textContent = body || "";

	const closeBtn = document.createElement("button");
	closeBtn.className = "toast-close";
	closeBtn.textContent = "×";
	closeBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		dismissToast(id);
	});

	const headerRow = document.createElement("div");
	headerRow.className = "toast-header";

	const iconEl = document.createElement("div");
	iconEl.className = "toast-icon";
	iconEl.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/><path d="M8 12l3 3 5-6"/></svg>`;

	const appLabel = document.createElement("span");
	appLabel.className = "toast-app";
	appLabel.textContent = "Collaborator";

	headerRow.appendChild(iconEl);
	headerRow.appendChild(appLabel);
	headerRow.appendChild(closeBtn);

	el.appendChild(headerRow);
	el.appendChild(titleEl);
	if (body) el.appendChild(bodyEl);

	el.style.cursor = (tileId || cwd) ? "pointer" : "default";
	el.addEventListener("click", () => {
		window.notifApi.notificationClicked({ tileId, cwd });
		dismissToast(id);
	});

	container.appendChild(el);
	requestAnimationFrame(() => el.classList.add("toast-enter"));
	// Fallback: if rAF is throttled, force the toast visible anyway.
	setTimeout(() => el.classList.add("toast-enter"), 50);

	if (sound) playNotifSound(sound);

	toasts.set(id, el);
	reportSize();

	setTimeout(() => {
		if (toasts.has(id)) dismissToast(id);
	}, DISMISS_MS);
}

window.notifApi.onNotification(showToast);
window.notifApi.onDismiss(({ tileId }) => {
	for (const [id, el] of toasts) {
		if (el.dataset.tileId === tileId) dismissToast(id);
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
	bottom: 0;
	right: 0;
	width: 100%;
	display: flex;
	flex-direction: column-reverse;
	gap: 8px;
	padding: 12px;
}

.toast-item {
	width: 100%;
	padding: 16px 18px 14px;
	background: var(--bg);
	border: 1px solid var(--border);
	border-radius: var(--radius);
	box-shadow: var(--shadow);
	color: var(--fg);
	position: relative;
	opacity: 0;
	transform: translateX(40px);
	transition: opacity 0.25s ease, transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

.toast-item.toast-enter {
	opacity: 1;
	transform: translateX(0);
}

.toast-item.toast-exit {
	animation: toast-out 0.2s ease forwards;
}

.toast-header {
	display: flex;
	align-items: center;
	gap: 8px;
	margin-bottom: 10px;
}

.toast-icon {
	width: 16px;
	height: 16px;
	color: var(--accent);
	flex-shrink: 0;
	display: flex;
	align-items: center;
}

.toast-icon svg {
	width: 16px;
	height: 16px;
}

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

@keyframes toast-out {
	from { opacity: 1; transform: translateX(0); }
	to   { opacity: 0; transform: translateX(40px); }
}
`;
document.head.appendChild(style);
