import { snapToGrid } from "./canvas-state.js";
import { computeDragSnap, collectGluedChain } from "./magnetic.js";

const SNAP_PX = 8;

const MIN_SIZES = {
  term: { width: 200, height: 120 },
  note: { width: 200, height: 120 },
  code: { width: 200, height: 120 },
  image: { width: 80, height: 80 },
  graph: { width: 300, height: 250 },
};

const CLICK_THRESHOLD = 3;

/**
 * Attach drag behavior to a tile's title bar.
 * Supports single-tile drag, group drag (when tile is in a
 * multi-tile selection), and Shift+click toggling.
 *
 * @param {HTMLElement} titleBar
 * @param {import('./canvas-state.js').Tile} tile
 * @param {object} opts
 * @param {object} opts.viewport - { panX, panY, zoom } (read live)
 * @param {() => void} opts.onUpdate
 * @param {(ws: Array<{webview: HTMLElement}>) => void} opts.disablePointerEvents
 * @param {(ws: Array<{webview: HTMLElement}>) => void} opts.enablePointerEvents
 * @param {() => Array<{webview: HTMLElement}>} opts.getAllWebviews
 * @param {() => null | Array<{tile: object, container: HTMLElement, startX: number, startY: number}>} opts.getGroupDragContext
 * @param {(tileId: string) => void} opts.onShiftClick
 * @param {() => boolean} [opts.isSpaceHeld] - when true, suppress drag (canvas is panning)
 * @param {HTMLElement} [opts.contentOverlay] - secondary drag surface over tile content
 */
export function attachDrag(titleBar, tile, {
  viewport,
  onUpdate,
  disablePointerEvents,
  enablePointerEvents,
  getAllWebviews,
  getGroupDragContext,
  onShiftClick,
  onFocus,
  isSpaceHeld,
  contentOverlay,
}) {
  function startDrag(e, { deferFocus = false } = {}) {
    if (e.button !== 0) return;
    if (isSpaceHeld?.()) return;
    e.preventDefault();
    if (!deferFocus && onFocus) onFocus(tile.id, e);

    const startMX = e.clientX;
    const startMY = e.clientY;
    const startTX = tile.x;
    const startTY = tile.y;
    const startPanX = viewport.panX;
    const startPanY = viewport.panY;
    const shiftHeld = e.shiftKey;

    const groupCtx = getGroupDragContext();
    const isGroupDrag = groupCtx !== null && groupCtx.length > 1;

    const webviews = getAllWebviews();
    disablePointerEvents(webviews);

    const container = titleBar.closest(".canvas-tile");
    container.classList.add("tile-dragging");
    if (isGroupDrag) {
      for (const entry of groupCtx) {
        entry.container.classList.add("tile-dragging");
      }
    }

    let moved = false;
    let lastMX = startMX;
    let lastMY = startMY;

    function applyDrag(mx, my) {
      const panDX = viewport.panX - startPanX;
      const panDY = viewport.panY - startPanY;
      const dx = (mx - startMX - panDX) / viewport.zoom;
      const dy = (my - startMY - panDY) / viewport.zoom;

      if (isGroupDrag) {
        for (const entry of groupCtx) {
          entry.tile.x = entry.startX + dx;
          entry.tile.y = entry.startY + dy;
          if (entry.tile.pinned) {
            const canvasEl = document.getElementById("canvas");
            if (canvasEl) {
              const vw = canvasEl.clientWidth;
              const vh = canvasEl.clientHeight;
              const tZoom = viewport.zoom;
              const sWidth = entry.tile.width * tZoom;
              const sHeight = entry.tile.height * tZoom;
              entry.tile.pinnedX = Math.max(0, Math.min(vw - sWidth, entry.tile.x * tZoom + viewport.panX));
              entry.tile.pinnedY = Math.max(0, Math.min(vh - sHeight, entry.tile.y * tZoom + viewport.panY));
              entry.tile.x = (entry.tile.pinnedX - viewport.panX) / tZoom;
              entry.tile.y = (entry.tile.pinnedY - viewport.panY) / tZoom;
            } else {
              entry.tile.pinnedX = entry.tile.x * viewport.zoom + viewport.panX;
              entry.tile.pinnedY = entry.tile.y * viewport.zoom + viewport.panY;
            }
          }
        }
      } else {
        tile.x = startTX + dx;
        tile.y = startTY + dy;
        const snap = computeDragSnap(tile, SNAP_PX / viewport.zoom);
        if (snap.x !== null) tile.x = snap.x;
        if (snap.y !== null) tile.y = snap.y;
        if (tile.pinned) {
          const canvasEl = document.getElementById("canvas");
          if (canvasEl) {
            const vw = canvasEl.clientWidth;
            const vh = canvasEl.clientHeight;
            const tZoom = viewport.zoom;
            const sWidth = tile.width * tZoom;
            const sHeight = tile.height * tZoom;
            tile.pinnedX = Math.max(0, Math.min(vw - sWidth, tile.x * tZoom + viewport.panX));
            tile.pinnedY = Math.max(0, Math.min(vh - sHeight, tile.y * tZoom + viewport.panY));
            tile.x = (tile.pinnedX - viewport.panX) / tZoom;
            tile.y = (tile.pinnedY - viewport.panY) / tZoom;
          } else {
            tile.pinnedX = tile.x * viewport.zoom + viewport.panX;
            tile.pinnedY = tile.y * viewport.zoom + viewport.panY;
          }
        }
      }
      onUpdate();
    }

    function onMove(e) {
      lastMX = e.clientX;
      lastMY = e.clientY;
      const dist = Math.hypot(lastMX - startMX, lastMY - startMY);
      if (dist >= CLICK_THRESHOLD) moved = true;
      applyDrag(lastMX, lastMY);
    }

    function onWheel() {
      applyDrag(lastMX, lastMY);
    }

    function onUp(e) {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("wheel", onWheel);
      enablePointerEvents(webviews);

      if (shiftHeld && !moved) {
        container.classList.remove("tile-dragging");
        if (isGroupDrag) {
          for (const entry of groupCtx) {
            entry.container.classList.remove("tile-dragging");
          }
        }
        onShiftClick(tile.id);
        return;
      }

      if (deferFocus && !moved && onFocus) {
        onFocus(tile.id, e);
      }

      container.classList.remove("tile-dragging");
      if (isGroupDrag) {
        for (const entry of groupCtx) {
          entry.container.classList.remove("tile-dragging");
          snapToGrid(entry.tile);
        }
      } else {
        snapToGrid(tile);
      }
      onUpdate();
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("wheel", onWheel, { passive: true });
  }

  titleBar.addEventListener("mousedown", (e) => startDrag(e));

  if (contentOverlay) {
    contentOverlay.addEventListener("mousedown", (e) => {
      startDrag(e, { deferFocus: true });
    });
  }
}

/**
 * Attach marquee (rubber-band) selection to the canvas element.
 *
 * @param {HTMLElement} canvasEl
 * @param {object} opts
 * @param {object} opts.viewport - { panX, panY, zoom } (read live)
 * @param {() => Array<import('./canvas-state.js').Tile>} opts.tiles
 * @param {(ids: Set<string>) => void} opts.onSelectionChange
 * @param {() => boolean} opts.isShiftHeld
 * @param {() => boolean} opts.isSpaceHeld
 * @param {() => Array<{webview: HTMLElement}>} opts.getAllWebviews
 */
export function attachMarquee(canvasEl, {
  viewport,
  tiles,
  onSelectionChange,
  isShiftHeld,
  isSpaceHeld,
  getAllWebviews,
}) {
  const tileLayer = canvasEl.querySelector("#tile-layer");
  const gridCanvas = canvasEl.querySelector("#grid-canvas");

  canvasEl.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    // Ignore if Space is held (pan gesture)
    if (isSpaceHeld()) return;
    // Only trigger on clicks directly on the canvas background
    if (
      e.target !== canvasEl &&
      e.target !== tileLayer &&
      e.target !== gridCanvas
    ) return;

    e.preventDefault();
    if (document.activeElement) document.activeElement.blur();

    const webviews = getAllWebviews();
    for (const w of webviews) w.webview.style.pointerEvents = "none";

    const startSX = e.clientX;
    const startSY = e.clientY;

    const marquee = document.createElement("div");
    marquee.className = "selection-marquee";
    marquee.style.position = "fixed";
    marquee.style.left = `${startSX}px`;
    marquee.style.top = `${startSY}px`;
    marquee.style.width = "0px";
    marquee.style.height = "0px";
    document.body.appendChild(marquee);

    let moved = false;

    function onMove(e) {
      const curSX = e.clientX;
      const curSY = e.clientY;
      const dist = Math.hypot(curSX - startSX, curSY - startSY);
      if (dist >= CLICK_THRESHOLD) moved = true;

      const left = Math.min(startSX, curSX);
      const top = Math.min(startSY, curSY);
      const width = Math.abs(curSX - startSX);
      const height = Math.abs(curSY - startSY);

      marquee.style.left = `${left}px`;
      marquee.style.top = `${top}px`;
      marquee.style.width = `${width}px`;
      marquee.style.height = `${height}px`;
    }

    function onUp(e) {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      marquee.remove();
      for (const w of webviews) w.webview.style.pointerEvents = "";

      if (!moved) {
        // Click on empty canvas — clear selection
        onSelectionChange(new Set());
        return;
      }

      // Compute marquee rect in canvas coordinates
      const curSX = e.clientX;
      const curSY = e.clientY;
      const mLeft = Math.min(startSX, curSX);
      const mTop = Math.min(startSY, curSY);
      const mRight = Math.max(startSX, curSX);
      const mBottom = Math.max(startSY, curSY);

      // Convert viewport-relative pointer coords into canvas coords.
      const viewerRect = canvasEl.getBoundingClientRect();
      const toCanvas = (sx, sy) => ({
        x: (sx - viewerRect.left - viewport.panX) / viewport.zoom,
        y: (sy - viewerRect.top - viewport.panY) / viewport.zoom,
      });

      const cTL = toCanvas(mLeft, mTop);
      const cBR = toCanvas(mRight, mBottom);

      // AABB hit-test against all tiles
      const hitIds = new Set();
      for (const t of tiles()) {
        const tRight = t.x + t.width;
        const tBottom = t.y + t.height;
        if (
          t.x < cBR.x &&
          tRight > cTL.x &&
          t.y < cBR.y &&
          tBottom > cTL.y
        ) {
          hitIds.add(t.id);
        }
      }

      if (isShiftHeld()) {
        // Additive — merge with existing selection handled by caller
        // Pass the new hits; caller unions with current selection
        onSelectionChange(hitIds);
      } else {
        onSelectionChange(hitIds);
      }
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

/**
 * Creates resize handle elements and attaches resize behavior.
 * @param {HTMLElement} container
 * @param {import('./canvas-state.js').Tile} tile
 * @param {object} viewport
 * @param {() => void} onUpdate
 * @param {() => Array<{webview: HTMLElement}>} getAllWebviews
 */
export function attachResize(
  container, tile, viewport, onUpdate, getAllWebviews, onFocus,
  onResizeEnd, getFrameForTile,
) {
  const edges = ["n", "s", "e", "w"];
  const corners = ["nw", "ne", "sw", "se"];

  for (const dir of [...edges, ...corners]) {
    const handle = document.createElement("div");
    const kind = dir.length === 1 ? "edge" : "corner";
    handle.className = `tile-resize-handle ${kind}-${dir}`;

    handle.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      const startMX = e.clientX;
      const startMY = e.clientY;
      const startPanX = viewport.panX;
      const startPanY = viewport.panY;
      const startX = tile.x;
      const startY = tile.y;
      const startW = tile.width;
      const startH = tile.height;
      const min = MIN_SIZES[tile.type] || MIN_SIZES.term;

      const chains = {
        e: dir.includes("e") ? collectGluedChain(tile, "e") : [],
        w: dir.includes("w") ? collectGluedChain(tile, "w") : [],
        s: dir.includes("s") ? collectGluedChain(tile, "s") : [],
        n: dir.includes("n") ? collectGluedChain(tile, "n") : [],
      };
      const chainStart = new Map();
      for (const side of ["e", "w", "s", "n"]) {
        for (const o of chains[side]) {
          if (!chainStart.has(o.id)) {
            chainStart.set(o.id, {
              x: o.x, y: o.y, width: o.width, height: o.height,
            });
          }
        }
      }

      const frame = getFrameForTile ? getFrameForTile(tile) : null;

      const webviews = getAllWebviews();
      for (const wv of webviews) {
        wv.webview.style.pointerEvents = "none";
      }

      function pushChainsFree() {
        const eDelta = tile.x + tile.width - (startX + startW);
        const wDelta = tile.x - startX;
        const sDelta = tile.y + tile.height - (startY + startH);
        const nDelta = tile.y - startY;
        for (const o of chains.e) o.x = chainStart.get(o.id).x + eDelta;
        for (const o of chains.w) o.x = chainStart.get(o.id).x + wDelta;
        for (const o of chains.s) o.y = chainStart.get(o.id).y + sDelta;
        for (const o of chains.n) o.y = chainStart.get(o.id).y + nDelta;
      }

      // Lay a glued chain out within the frame wall: keep tiles flush and at
      // their original size while there is room, compress them toward their
      // minimum once the chain reaches the frame edge.
      function layoutBounded(chain, P, S, frameLo, frameHi, aFixedFar) {
        const minTile = (MIN_SIZES[tile.type] || MIN_SIZES.term)[S];
        const minOf = (o) => (MIN_SIZES[o.type] || MIN_SIZES.term)[S];
        const startSize = (o) => chainStart.get(o.id)[S];
        const toHi = aFixedFar === undefined;
        const ordered = [...chain].sort((a, b) =>
          toHi
            ? chainStart.get(a.id)[P] - chainStart.get(b.id)[P]
            : chainStart.get(b.id)[P] - chainStart.get(a.id)[P]);
        const chainMin = ordered.reduce((s, o) => s + minOf(o), 0);

        let cursor;
        let avail;
        if (toHi) {
          const maxFar = frameHi - chainMin;
          if (tile[P] + tile[S] > maxFar) {
            tile[S] = Math.max(minTile, maxFar - tile[P]);
          }
          cursor = tile[P] + tile[S];
          avail = frameHi - cursor;
        } else {
          const minNear = frameLo + chainMin;
          if (tile[P] < minNear) {
            tile[P] = minNear;
            tile[S] = Math.max(minTile, aFixedFar - tile[P]);
          }
          cursor = tile[P];
          avail = cursor - frameLo;
        }

        const need = ordered.reduce((s, o) => s + startSize(o), 0);
        const extra = Math.max(0, avail - chainMin);
        const flexTotal = ordered.reduce(
          (s, o) => s + Math.max(0, startSize(o) - minOf(o)), 0) || 1;
        for (const o of ordered) {
          const size = need <= avail
            ? startSize(o)
            : minOf(o) + extra * (Math.max(0, startSize(o) - minOf(o)) / flexTotal);
          if (toHi) {
            o[P] = cursor;
            o[S] = size;
            cursor += size;
          } else {
            o[P] = cursor - size;
            o[S] = size;
            cursor = o[P];
          }
        }
      }

      function pushChainsInFrame() {
        if (dir.includes("e")) {
          layoutBounded(chains.e, "x", "width", frame.x, frame.x + frame.width);
        }
        if (dir.includes("w")) {
          layoutBounded(
            chains.w, "x", "width", frame.x, frame.x + frame.width,
            startX + startW);
        }
        if (dir.includes("s")) {
          layoutBounded(chains.s, "y", "height", frame.y, frame.y + frame.height);
        }
        if (dir.includes("n")) {
          layoutBounded(
            chains.n, "y", "height", frame.y, frame.y + frame.height,
            startY + startH);
        }
      }

      function pushChains() {
        if (frame) pushChainsInFrame();
        else pushChainsFree();
      }

      function onMove(e) {
        const panDX = viewport.panX - startPanX;
        const panDY = viewport.panY - startPanY;
        const dx = (e.clientX - startMX - panDX) / viewport.zoom;
        const dy = (e.clientY - startMY - panDY) / viewport.zoom;
        const symmetric = e.altKey;
        const m = symmetric ? 2 : 1;
        const cx = startX + startW / 2;
        const cy = startY + startH / 2;

        if (dir.includes("e")) {
          tile.width = Math.max(min.width, startW + dx * m);
          if (symmetric) tile.x = cx - tile.width / 2;
        }
        if (dir.includes("w")) {
          const newW = Math.max(min.width, startW - dx * m);
          tile.x = symmetric
            ? cx - newW / 2
            : startX + (startW - newW);
          tile.width = newW;
        }
        if (dir.includes("s")) {
          tile.height = Math.max(min.height, startH + dy * m);
          if (symmetric) tile.y = cy - tile.height / 2;
        }
        if (dir.includes("n")) {
          const newH = Math.max(min.height, startH - dy * m);
          tile.y = symmetric
            ? cy - newH / 2
            : startY + (startH - newH);
          tile.height = newH;
        }

        pushChains();
        if (tile.pinned) {
          tile.pinnedX = tile.x * viewport.zoom + viewport.panX;
          tile.pinnedY = tile.y * viewport.zoom + viewport.panY;
        }
        onUpdate();
      }

      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        for (const wv of webviews) {
          wv.webview.style.pointerEvents = "";
        }
        snapToGrid(tile);
        if (tile.pinned) {
          tile.pinnedX = tile.x * viewport.zoom + viewport.panX;
          tile.pinnedY = tile.y * viewport.zoom + viewport.panY;
        }
        for (const side of ["e", "w", "s", "n"]) {
          for (const o of chains[side]) snapToGrid(o);
        }
        onUpdate();
        if (onResizeEnd) onResizeEnd(tile);
        if (onFocus) onFocus();
      }

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    container.appendChild(handle);
  }
}
