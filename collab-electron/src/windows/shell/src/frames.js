import { tiles } from "./canvas-state.js";
import { positionTile } from "./tile-renderer.js";

const GRID = 20;
const MIN_W = 120;
const MIN_H = 80;
const DEFAULT_COLOR = "#6b7280";

const snap = (v) => Math.round(v / GRID) * GRID;

/**
 * Frames are labeled rectangles drawn behind tiles. Membership is geometric:
 * when a frame is dragged, every tile whose center sits inside the frame rect
 * at drag start moves with it.
 *
 * @typedef {Object} Frame
 * @property {string} id
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {string} title
 * @property {string} color
 */
export function createFrameManager({
	frameLayer, viewportState, getTileDOMs, getAllWebviews, onSave,
}) {
	/** @type {Frame[]} */
	const frames = [];
	const frameDOMs = new Map();
	let idCounter = 0;
	const genId = () => `frame-${Date.now()}-${++idCounter}`;

	function positionFrame(el, f) {
		el.style.left = `${f.x * viewportState.zoom + viewportState.panX}px`;
		el.style.top = `${f.y * viewportState.zoom + viewportState.panY}px`;
		el.style.width = `${f.width}px`;
		el.style.height = `${f.height}px`;
		el.style.transform = `scale(${viewportState.zoom})`;
	}

	function repositionAllFrames() {
		for (const f of frames) {
			const el = frameDOMs.get(f.id);
			if (el) positionFrame(el, f);
		}
	}

	function containedTiles(f) {
		return tiles.filter((t) => {
			const cx = t.x + t.width / 2;
			const cy = t.y + t.height / 2;
			return cx >= f.x && cx <= f.x + f.width &&
				cy >= f.y && cy <= f.y + f.height;
		});
	}

	function repositionTiles(ts) {
		const doms = getTileDOMs();
		for (const t of ts) {
			const dom = doms.get(t.id);
			if (dom) {
				positionTile(
					dom.container, t,
					viewportState.panX, viewportState.panY, viewportState.zoom,
				);
			}
		}
	}

	function freezeWebviews() {
		const wvs = getAllWebviews();
		for (const w of wvs) w.webview.style.pointerEvents = "none";
		return () => { for (const w of wvs) w.webview.style.pointerEvents = ""; };
	}

	function attachDrag(handle, f, el) {
		handle.addEventListener("mousedown", (e) => {
			if (e.button !== 0) return;
			e.preventDefault();
			e.stopPropagation();
			const startMX = e.clientX;
			const startMY = e.clientY;
			const startFX = f.x;
			const startFY = f.y;
			const members = containedTiles(f).map((t) => ({ t, sx: t.x, sy: t.y }));
			const thaw = freezeWebviews();
			el.classList.add("frame-dragging");

			function onMove(ev) {
				const dx = (ev.clientX - startMX) / viewportState.zoom;
				const dy = (ev.clientY - startMY) / viewportState.zoom;
				f.x = startFX + dx;
				f.y = startFY + dy;
				for (const m of members) { m.t.x = m.sx + dx; m.t.y = m.sy + dy; }
				positionFrame(el, f);
				repositionTiles(members.map((m) => m.t));
			}
			function onUp() {
				document.removeEventListener("mousemove", onMove);
				document.removeEventListener("mouseup", onUp);
				thaw();
				el.classList.remove("frame-dragging");
				f.x = snap(f.x);
				f.y = snap(f.y);
				for (const m of members) { m.t.x = snap(m.t.x); m.t.y = snap(m.t.y); }
				positionFrame(el, f);
				repositionTiles(members.map((m) => m.t));
				onSave();
			}
			document.addEventListener("mousemove", onMove);
			document.addEventListener("mouseup", onUp);
		});
	}

	function attachResize(el, f) {
		for (const dir of ["n", "s", "e", "w", "nw", "ne", "sw", "se"]) {
			const h = document.createElement("div");
			const kind = dir.length === 1 ? "edge" : "corner";
			h.className = `tile-resize-handle ${kind}-${dir}`;
			h.addEventListener("mousedown", (e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				e.stopPropagation();
				const startMX = e.clientX;
				const startMY = e.clientY;
				const sx = f.x;
				const sy = f.y;
				const sw = f.width;
				const sh = f.height;
				const thaw = freezeWebviews();

				function onMove(ev) {
					const dx = (ev.clientX - startMX) / viewportState.zoom;
					const dy = (ev.clientY - startMY) / viewportState.zoom;
					if (dir.includes("e")) f.width = Math.max(MIN_W, sw + dx);
					if (dir.includes("s")) f.height = Math.max(MIN_H, sh + dy);
					if (dir.includes("w")) {
						const w = Math.max(MIN_W, sw - dx);
						f.x = sx + (sw - w);
						f.width = w;
					}
					if (dir.includes("n")) {
						const hh = Math.max(MIN_H, sh - dy);
						f.y = sy + (sh - hh);
						f.height = hh;
					}
					positionFrame(el, f);
				}
				function onUp() {
					document.removeEventListener("mousemove", onMove);
					document.removeEventListener("mouseup", onUp);
					thaw();
					f.x = snap(f.x);
					f.y = snap(f.y);
					f.width = snap(f.width);
					f.height = snap(f.height);
					positionFrame(el, f);
					onSave();
				}
				document.addEventListener("mousemove", onMove);
				document.addEventListener("mouseup", onUp);
			});
			el.appendChild(h);
		}
	}

	function startRename(titleEl, f) {
		const input = document.createElement("input");
		input.type = "text";
		input.className = "frame-rename-input";
		input.value = f.title;
		titleEl.replaceWith(input);
		input.focus();
		input.select();
		let done = false;
		function commit() {
			if (done) return;
			done = true;
			f.title = input.value.trim() || "Frame";
			titleEl.textContent = f.title;
			input.replaceWith(titleEl);
			onSave();
		}
		input.addEventListener("mousedown", (e) => e.stopPropagation());
		input.addEventListener("blur", commit);
		input.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Enter") { e.preventDefault(); commit(); }
			if (e.key === "Escape") {
				e.preventDefault();
				done = true;
				input.replaceWith(titleEl);
			}
		});
	}

	function buildDOM(f) {
		const el = document.createElement("div");
		el.className = "canvas-frame";
		el.dataset.frameId = f.id;
		el.style.setProperty("--frame-color", f.color);

		const bar = document.createElement("div");
		bar.className = "frame-title-bar";

		const title = document.createElement("span");
		title.className = "frame-title-text";
		title.textContent = f.title;
		title.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			startRename(title, f);
		});
		bar.appendChild(title);

		const colorBtn = document.createElement("button");
		colorBtn.className = "frame-color-btn";
		colorBtn.title = "Frame color";
		const colorInput = document.createElement("input");
		colorInput.type = "color";
		colorInput.value = f.color;
		colorInput.className = "frame-color-input";
		colorBtn.addEventListener("mousedown", (e) => e.stopPropagation());
		colorBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			colorInput.click();
		});
		colorInput.addEventListener("input", () => {
			f.color = colorInput.value;
			el.style.setProperty("--frame-color", f.color);
		});
		colorInput.addEventListener("change", () => onSave());

		const delBtn = document.createElement("button");
		delBtn.className = "frame-del-btn";
		delBtn.innerHTML = "&times;";
		delBtn.title = "Delete frame";
		delBtn.addEventListener("mousedown", (e) => e.stopPropagation());
		delBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			removeFrame(f.id);
			onSave();
		});

		bar.appendChild(colorBtn);
		bar.appendChild(colorInput);
		bar.appendChild(delBtn);
		el.appendChild(bar);

		attachDrag(bar, f, el);
		attachResize(el, f);

		frameLayer.appendChild(el);
		frameDOMs.set(f.id, el);
		positionFrame(el, f);
		return el;
	}

	function createFrame(x, y, opts = {}) {
		const f = {
			id: opts.id || genId(),
			x: snap(x),
			y: snap(y),
			width: opts.width || 400,
			height: opts.height || 300,
			title: opts.title || "Frame",
			color: opts.color || DEFAULT_COLOR,
		};
		frames.push(f);
		buildDOM(f);
		return f;
	}

	function removeFrame(id) {
		const i = frames.findIndex((f) => f.id === id);
		if (i !== -1) frames.splice(i, 1);
		const el = frameDOMs.get(id);
		if (el) el.remove();
		frameDOMs.delete(id);
	}

	function detachAllFrames() {
		for (const [, el] of frameDOMs) el.remove();
		frameDOMs.clear();
		frames.length = 0;
	}

	function restoreFrames(saved) {
		detachAllFrames();
		for (const s of saved) {
			createFrame(s.x, s.y, {
				id: s.id, width: s.width, height: s.height,
				title: s.title, color: s.color,
			});
		}
	}

	function getFramesForSave() {
		return frames.map((f) => ({
			id: f.id, x: f.x, y: f.y, width: f.width, height: f.height,
			title: f.title, color: f.color,
		}));
	}

	return {
		createFrame, removeFrame, restoreFrames, detachAllFrames,
		getFramesForSave, repositionAllFrames,
	};
}
