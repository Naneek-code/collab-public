import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { getTheme } from "./theme";
import { ClaudePrompt } from "./ClaudePrompt";
import { loadHackFont } from "./fontutil";
import { createTempImageFromBlob } from "./clipboard-util";
import "@xterm/xterm/css/xterm.css";
import "./TerminalTab.css";

// Matches VS Code's TerminalDataBufferer throttle interval.
// Coalesces rapid PTY data events into a single term.write()
// call, preventing partial-render artifacts from the renderer
// processing many small sequential writes.
const DATA_BUFFER_FLUSH_MS = 5;
const IS_MAC = window.api.getPlatform() === "darwin";

interface TerminalTabProps {
	sessionId: string;
	visible: boolean;
	restored?: boolean;
	scrollbackData?: string | null;
	mode?: "tmux" | "sidecar" | undefined;
}

function TerminalTab({
	sessionId,
	visible,
	restored,
	scrollbackData,
	mode,
}: TerminalTabProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const fitRef = useRef<FitAddon | null>(null);
	const [termInstance, setTermInstance] = useState<Terminal | null>(null);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		let cancelled = false;
		let disposeTerminal: (() => void) | undefined;

		const prefersDark = window.matchMedia(
			"(prefers-color-scheme: dark)",
		).matches;

		loadHackFont().then(() => {
		if (cancelled) return;

		const term = new Terminal({
			theme: getTheme(),
			fontFamily: "Hack, monospace",
			fontSize: 12,
			fontWeight: "normal",
			fontWeightBold: "bold",
			drawBoldTextInBrightColors: false,
			cursorBlink: true,
			scrollback: 200000,
			allowProposedApi: true,
			allowTransparency: prefersDark,
			macOptionIsMeta: false,
			overviewRuler: { width: 8 },
		});

		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(container);
		fitRef.current = fit;
		setTermInstance(term);

		const unicode11 = new Unicode11Addon();
		term.loadAddon(unicode11);
		term.unicode.activeVersion = "11";

		// WebGL renderer: double-buffered canvas avoids the
		// partial-paint artifacts the DOM renderer can show
		// during rapid sequential writes. Falls back to DOM
		// if the GPU context can't be acquired.
		try {
			const webgl = new WebglAddon();
			webgl.onContextLoss(() => webgl.dispose());
			term.loadAddon(webgl);
		} catch {
			// DOM renderer fallback — no action needed
		}

		// Delay initial fit: the webview may not have its final
		// dimensions when the page first loads. Double-rAF ensures
		// the layout pass has finished before we measure.
		requestAnimationFrame(() => {
			requestAnimationFrame(() => fit.fit());
		});

		// Auto-focus xterm when the webview already has focus (e.g.
		// tile created via Cmd+N or double-click where focusCanvasTile
		// ran before xterm mounted).
		if (document.hasFocus()) {
			term.focus();
		}

		// Restore focus to whichever surface the user last had focused —
		// the floating Claude prompt or the terminal — when the webview
		// window regains focus (e.g. returning from another app that
		// re-pastes via a synthetic Ctrl+V). Defaults to the terminal.
		let lastFocusedSurface: "terminal" | "editor" = "terminal";
		// Each tile is a separate webview. Only the active one may write the
		// shared clipboard, otherwise a backgrounded tile whose PTY output
		// reflows its xterm selection would clobber what another tile copied.
		let active = document.hasFocus();
		const onFocusIn = (ev: FocusEvent) => {
			active = true;
			const target = ev.target as HTMLElement | null;
			if (!target) return;
			if (target.closest(".claude-prompt-editor")) {
				lastFocusedSurface = "editor";
			} else if (target.closest(".xterm")) {
				lastFocusedSurface = "terminal";
			}
		};
		const onWindowFocus = () => {
			active = true;
			if (lastFocusedSurface === "editor") {
				const editor = container.parentElement?.querySelector(
					".claude-prompt-editor",
				) as HTMLElement | null;
				if (editor) {
					editor.focus();
					return;
				}
			}
			term.focus();
		};
		document.addEventListener("focusin", onFocusIn, true);
		window.addEventListener("focus", onWindowFocus);

		if (!restored) {
			term.write(
				`\x1b[38;2;100;100;100mStarting...\x1b[0m`,
			);
		}

		if (restored && scrollbackData) {
			term.write(scrollbackData);
		}

		// Shift+Enter: inject a CSI u escape sequence directly into the
		// tmux pane (via send-keys -l) so TUI apps like Claude Code can
		// detect the shift modifier. The normal ptyWrite path goes through
		// tmux's input parser which strips modifier info in legacy mode.
		// Block both keydown AND keypress to prevent xterm from also
		// sending \r through the normal onData path.
		// Route clipboard writes through the main process. navigator.clipboard
		// rejects with "Document is not focused" when the host webview does not
		// hold DOM focus (the canvas or another tile owns it), which silently
		// dropped copies inside embedded tiles.
		const copySelectionToClipboard = () => {
			const selection = term.getSelection();
			if (!selection) return false;
			window.api.clipboardWriteText(selection);
			return true;
		};

		term.attachCustomKeyEventHandler((e) => {
			if (e.key === "Enter" && e.shiftKey) {
				if (e.type === "keydown") {
					window.api.ptySendRawKeys(sessionId, "\x1b[13;2u");
				}
				return false;
			}
			// Option key on macOS: with macOptionIsMeta disabled (so
			// macOS composes special characters like —), we manually
			// send ESC+key for the readline/shell bindings we need.
			if (IS_MAC && e.type === "keydown" && e.altKey && !e.metaKey && !e.ctrlKey) {
				if (e.key === "ArrowLeft") {
					window.api.ptyWrite(sessionId, "\x1bb");
					return false;
				}
				if (e.key === "ArrowRight") {
					window.api.ptyWrite(sessionId, "\x1bf");
					return false;
				}
				if (e.key === "b") {
					window.api.ptyWrite(sessionId, "\x1bb");
					return false;
				}
				if (e.key === "f") {
					window.api.ptyWrite(sessionId, "\x1bf");
					return false;
				}
				if (e.key === "d") {
					window.api.ptyWrite(sessionId, "\x1bd");
					return false;
				}
				if (e.key === "Backspace") {
					window.api.ptyWrite(sessionId, "\x1b\x7f");
					return false;
				}
				if (e.key === ".") {
					window.api.ptyWrite(sessionId, "\x1b.");
					return false;
				}
			}
			// Command+Arrow on macOS: jump to start/end of line, matching
			// the system terminal. ESC has no metaKey, so send the
			// readline beginning/end-of-line controls (Ctrl-A / Ctrl-E).
			if (IS_MAC && e.type === "keydown" && e.metaKey && !e.altKey && !e.ctrlKey) {
				if (e.key === "ArrowLeft") {
					window.api.ptyWrite(sessionId, "\x01");
					return false;
				}
				if (e.key === "ArrowRight") {
					window.api.ptyWrite(sessionId, "\x05");
					return false;
				}
			}
			const primaryModifier = IS_MAC ? e.metaKey : e.ctrlKey;
			if (e.type === "keydown" && primaryModifier) {
				const key = e.key.toLowerCase();
				if (key === "c" && copySelectionToClipboard()) {
					return false;
				}
				// Paste: let the native paste event fire so handlePaste can
				// process both text and images. Returning false stops xterm
				// from sending the keystroke through onData.
				if (key === "v") {
					return false;
				}
				if (!IS_MAC && e.shiftKey) {
					if (key === "c" && copySelectionToClipboard()) {
						return false;
					}
					if (key === "v") {
						return false;
					}
				}
			}
			if (e.type === "keydown" && e.shiftKey && e.key === "Insert") {
				return false;
			}
			if (e.type === "keydown" && e.metaKey) {
				if (e.key === "t" || (e.key >= "1" && e.key <= "9")) {
					return false;
				}
			}
			return true;
		});

		// OSC 7: shell reports current working directory
		// Format: file://hostname/path or file:///path
		term.parser.registerOscHandler(7, (data) => {
			try {
				const url = new URL(data);
				if (url.protocol === "file:") {
					let cwd = decodeURIComponent(url.pathname);
					// Windows drive paths arrive as "/C:/Users/x"; strip the
					// leading slash and restore native separators so the value
					// matches the host-format cwd used elsewhere.
					if (/^\/[A-Za-z]:/.test(cwd)) {
						cwd = cwd.slice(1).replace(/\//g, "\\");
					}
					if (cwd) window.api.notifyCwdChanged(sessionId, cwd);
				}
			} catch {
				// Malformed URL — ignore
			}
			return true;
		});

		term.onData((data: string) => {
			window.api.ptyWrite(sessionId, data);
		});

		let dataBuffer: Uint8Array[] = [];
		let flushTimer: number | undefined;
		let firstData = true;

		const flushData = () => {
			if (dataBuffer.length === 0) {
				flushTimer = undefined;
				return;
			}
			const chunks = dataBuffer;
			dataBuffer = [];
			flushTimer = undefined;
			if (firstData) {
				firstData = false;
				if (restored && mode !== "sidecar") {
					term.write("\x1b[2J\x1b[H");
				} else if (!restored) {
					term.reset();
				}
			}
			for (const chunk of chunks) {
				term.write(chunk);
			}
		};

		const handleData = (payload: {
			sessionId: string;
			data: Uint8Array;
		}) => {
			if (payload.sessionId !== sessionId) return;
			dataBuffer.push(payload.data);
			if (flushTimer === undefined) {
				flushTimer = window.setTimeout(
					flushData,
					DATA_BUFFER_FLUSH_MS,
				);
			}
		};
		window.api.onPtyData(sessionId, handleData);

		term.onResize(({ cols, rows }) => {
			window.api.ptyResize(sessionId, cols, rows);
		});

		const handleCopy = (event: ClipboardEvent) => {
			const selection = term.getSelection();
			if (!selection) return;
			event.clipboardData?.setData("text/plain", selection);
			event.preventDefault();
			event.stopImmediatePropagation();
		};

		const handlePaste = (event: ClipboardEvent) => {
			const dt = event.clipboardData;
			if (!dt) return;

			// clipboardData is only valid during the synchronous part of the
			// handler, so read everything before any await.
			const text = dt.getData("text/plain");
			const imageFiles: File[] = [];
			for (const item of Array.from(dt.items)) {
				if (item.kind === "file" && item.type.startsWith("image/")) {
					const file = item.getAsFile();
					if (file) imageFiles.push(file);
				}
			}

			// Take over the paste entirely so xterm's own paste handler
			// doesn't also write the text and double it.
			event.preventDefault();
			event.stopImmediatePropagation();

			if (imageFiles.length === 0) {
				if (text) window.api.ptyWrite(sessionId, text);
				return;
			}

			// Persist each image to a temp file and feed its path to the PTY
			// inside bracketed-paste markers, so Claude Code recognizes it as
			// a pasted image path and attaches it instead of inserting literal
			// text.
			void (async () => {
				for (const file of imageFiles) {
					try {
						const path = await createTempImageFromBlob(file);
						await window.api.ptyWrite(
							sessionId,
							"\x1b[200~" + path + " \x1b[201~",
						);
					} catch {
						// Unsupported or oversized image — skip it.
					}
				}
				if (text) window.api.ptyWrite(sessionId, text);
			})();
		};

		const handleDragOver = (event: DragEvent) => {
			event.preventDefault();
			if (event.dataTransfer) {
				event.dataTransfer.dropEffect = "copy";
			}
		};

		const handleDrop = async (event: DragEvent) => {
			event.preventDefault();
			event.stopPropagation();
			if (!event.dataTransfer?.files?.length) return;

			// Extract paths synchronously before any await
			const rawPaths: string[] = [];
			for (let i = 0; i < event.dataTransfer.files.length; i++) {
				const file = event.dataTransfer.files[i];
				if (!file) continue;
				try {
					const p = window.api.getPathForFile(file);
					if (p) rawPaths.push(p);
				} catch { /* skip non-file items */ }
			}
			if (rawPaths.length === 0) return;

			// Filter out directories
			const checks = rawPaths.map(async (p) => {
				const isDir = await window.api.isDirectory(p);
				return isDir ? null : p;
			});
			const paths = (await Promise.all(checks)).filter(
				(p): p is string => p !== null,
			);
			if (paths.length === 0) return;

			const escaped = paths.map(
				(p) => "'" + p.replace(/'/g, "'\\''") + "'",
			);
			try {
				await window.api.ptyWrite(sessionId, escaped.join(" "));
			} catch { /* PTY may have exited */ }
			term.focus();
		};

		// Copy-on-select: a finished selection lands in the clipboard without
		// Ctrl+C. clipboardWriteText goes through the main process, so this
		// works even when the embedded webview never holds DOM focus.
		const selectionDisposable = term.onSelectionChange(() => {
			if (active) copySelectionToClipboard();
		});

		// Ctrl/Cmd+C copies the terminal selection even when keyboard focus is
		// on the floating Claude prompt editor (or anywhere in the guest), not
		// just xterm. A live DOM text selection (e.g. inside the editor) takes
		// precedence so the native copy of that text still works.
		const onCopyKey = (e: KeyboardEvent) => {
			if (!active) return;
			const mod = IS_MAC ? e.metaKey : e.ctrlKey;
			if (!mod || e.key.toLowerCase() !== "c") return;
			if (window.getSelection()?.toString()) return;
			if (copySelectionToClipboard()) {
				e.preventDefault();
				e.stopImmediatePropagation();
			}
		};
		document.addEventListener("keydown", onCopyKey, true);

		container.addEventListener("copy", handleCopy, true);
		container.addEventListener("paste", handlePaste, true);
		container.addEventListener("dragover", handleDragOver);
		container.addEventListener("drop", handleDrop);

		const offShellBlur = window.api.onShellBlur(() => {
			active = false;
			term.blur();
			const activeEl = document.activeElement as HTMLElement | null;
			activeEl?.blur();
		});

		// Debounce resize via rAF to coalesce rapid events
		let rafId = 0;
		const resizeObserver = new ResizeObserver((entries) => {
			const { width, height } = entries[0].contentRect;
			if (width > 0 && height > 0) {
				cancelAnimationFrame(rafId);
				rafId = requestAnimationFrame(() => fit.fit());
			}
		});
		resizeObserver.observe(containerRef.current);

		const mediaQuery = window.matchMedia(
			"(prefers-color-scheme: dark)",
		);
		const onThemeChange = (e: MediaQueryListEvent) => {
			term.options.allowTransparency = e.matches;
			term.options.theme = getTheme();
		};
		mediaQuery.addEventListener("change", onThemeChange);

		disposeTerminal = () => {
			if (flushTimer !== undefined) {
				clearTimeout(flushTimer);
				flushData();
			}
			cancelAnimationFrame(rafId);
			document.removeEventListener("focusin", onFocusIn, true);
			window.removeEventListener("focus", onWindowFocus);
			mediaQuery.removeEventListener("change", onThemeChange);
			resizeObserver.disconnect();
			container.removeEventListener("copy", handleCopy, true);
			container.removeEventListener("paste", handlePaste, true);
			container.removeEventListener("dragover", handleDragOver);
			container.removeEventListener("drop", handleDrop);
			document.removeEventListener("keydown", onCopyKey, true);
			selectionDisposable.dispose();
			window.api.offPtyData(sessionId, handleData);
			offShellBlur();
			setTermInstance(null);
			term.dispose();
			fitRef.current = null;
		};
		}); // end loadHackFont().then()

		return () => {
			cancelled = true;
			disposeTerminal?.();
		};
	}, [sessionId]);

	useEffect(() => {
		if (visible && fitRef.current) {
			requestAnimationFrame(() => fitRef.current?.fit());
		}
	}, [visible]);

	return (
		<div
			className="terminal-tab-host"
			style={{ display: visible ? "flex" : "none" }}
		>
			<div ref={containerRef} className="terminal-tab" />
			{termInstance && (
				<ClaudePrompt sessionId={sessionId} term={termInstance} />
			)}
		</div>
	);
}

export default TerminalTab;
