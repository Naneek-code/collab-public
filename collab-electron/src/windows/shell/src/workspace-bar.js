/**
 * Titlebar workspace/tab bar. Two independent axes:
 *   - Tabs: the strip of canvases inside the active workspace ([T1][T2][+]).
 *   - Workspaces: saved, named containers, chosen from the popover.
 *
 * All canvas teardown/restore lives in the host (renderer); this module only
 * renders state and reads/writes workspace metadata, delegating canvas swaps
 * through the provided callbacks.
 */

const PALETTE = [
	"#6ea8fe", "#75d0a0", "#e6a957", "#d98abf",
	"#7fd1d6", "#d97c7c", "#b39ddb", "#c0c97f",
];

export function createWorkspaceBar({
	wsButton, popover, tabStrip,
	onSwitchWorkspace, onSwitchTab, onNewTab, onCloseTab,
	onNewWorkspace, onDeleteWorkspace,
}) {
	let workspaces = [];
	let activeWorkspaceId = null;
	let tabs = [];
	let activeTabId = null;
	let renamingTab = null;
	let popoverOpen = false;

	function activeWorkspace() {
		return workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
	}

	async function refresh() {
		const list = await window.shellApi.workspaceMgrList();
		workspaces = list.workspaces;
		activeWorkspaceId = list.activeId;
		if (activeWorkspaceId) {
			const t = await window.shellApi.tabGet(activeWorkspaceId);
			tabs = t.tabs;
			activeTabId = t.activeTabId;
		} else {
			tabs = [];
			activeTabId = null;
		}
		renderWsButton();
		renderTabs();
		if (popoverOpen) renderPopover();
	}

	// ── Workspace button + popover ──

	function renderWsButton() {
		const ws = activeWorkspace();
		wsButton.innerHTML = "";
		const dot = document.createElement("span");
		dot.className = "workspace-dot";
		dot.style.background = ws?.color ?? "var(--muted)";
		wsButton.appendChild(dot);
	}

	function openPopover() {
		popoverOpen = true;
		renderPopover();
		popover.classList.remove("hidden");
		setTimeout(() => {
			document.addEventListener("pointerdown", onOutside, true);
			document.addEventListener("keydown", onEsc, true);
		}, 0);
	}

	function closePopover() {
		popoverOpen = false;
		popover.classList.add("hidden");
		document.removeEventListener("pointerdown", onOutside, true);
		document.removeEventListener("keydown", onEsc, true);
	}

	function onOutside(e) {
		if (!popover.contains(e.target) && !wsButton.contains(e.target)) {
			closePopover();
		}
	}

	function onEsc(e) {
		if (e.key === "Escape") closePopover();
	}

	function renderPopover() {
		popover.innerHTML = "";

		const header = document.createElement("div");
		header.className = "workspace-popover-header";
		header.textContent = "Switch workspace";
		popover.appendChild(header);

		for (const ws of workspaces) {
			const row = document.createElement("button");
			row.type = "button";
			row.className = "workspace-row";
			if (ws.id === activeWorkspaceId) row.classList.add("active");

			const dot = document.createElement("span");
			dot.className = "workspace-dot";
			dot.style.background = ws.color;
			row.appendChild(dot);

			const name = document.createElement("span");
			name.className = "workspace-row-name";
			name.textContent = ws.name;
			row.appendChild(name);

			if (ws.id === activeWorkspaceId) {
				const check = document.createElement("span");
				check.className = "workspace-row-check";
				check.textContent = "✓";
				row.appendChild(check);
			}

			row.addEventListener("click", async () => {
				if (ws.id !== activeWorkspaceId) {
					await onSwitchWorkspace(ws.id);
					await refresh();
				}
				closePopover();
			});
			row.addEventListener("contextmenu", (e) => {
				e.preventDefault();
				showWorkspaceMenu(ws);
			});
			popover.appendChild(row);
		}

		const add = document.createElement("button");
		add.type = "button";
		add.className = "workspace-row workspace-row-add";
		add.textContent = "+ Create new workspace";
		add.addEventListener("click", async () => {
			closePopover();
			await onNewWorkspace();
			await refresh();
		});
		popover.appendChild(add);
	}

	async function showWorkspaceMenu(ws) {
		const items = [
			{ id: "rename", label: "Rename" },
			{ id: "separator", label: "" },
			...PALETTE.map((c, i) => ({
				id: `color:${c}`,
				label: `Color ${i + 1}`,
			})),
			{ id: "separator", label: "" },
			{
				id: "delete",
				label: "Delete workspace",
				enabled: workspaces.length > 1,
			},
		];
		const choice = await window.shellApi.showContextMenu(items);
		if (!choice) return;
		if (choice === "rename") {
			const next = await promptName(ws.name);
			if (next) await window.shellApi.workspaceMgrRename(ws.id, next);
			await refresh();
		} else if (choice === "delete") {
			const ok = await window.shellApi.showConfirmDialog({
				message: `Delete "${ws.name}"?`,
				detail: "All its tabs and running terminals are removed.",
				buttons: ["Cancel", "Delete"],
			});
			if (ok !== 1) return;
			await onDeleteWorkspace(ws.id, ws.id === activeWorkspaceId);
			await refresh();
		} else if (choice.startsWith("color:")) {
			await window.shellApi.workspaceMgrSetColor(
				ws.id, choice.slice("color:".length),
			);
			await refresh();
		}
	}

	// Minimal inline prompt via a transient input inside the popover row.
	function promptName(current) {
		return new Promise((resolve) => {
			const value = window.prompt("Workspace name", current);
			resolve(value && value.trim() ? value.trim() : null);
		});
	}

	// ── Tab strip ──

	function renderTabs() {
		tabStrip.innerHTML = "";

		for (const tab of tabs) {
			const el = document.createElement("div");
			el.className = "tab";
			if (tab.id === activeTabId) el.classList.add("active");

			if (renamingTab === tab.id) {
				const input = document.createElement("input");
				input.type = "text";
				input.className = "tab-rename";
				input.value = tab.name;
				el.appendChild(input);
				queueMicrotask(() => {
					input.focus();
					input.select();
				});
				const commit = async (save) => {
					if (renamingTab !== tab.id) return;
					renamingTab = null;
					if (save && input.value.trim()) {
						await window.shellApi.tabRename(
							activeWorkspaceId, tab.id, input.value.trim(),
						);
					}
					await refresh();
				};
				input.addEventListener("keydown", (e) => {
					e.stopPropagation();
					if (e.key === "Enter") commit(true);
					else if (e.key === "Escape") commit(false);
				});
				input.addEventListener("blur", () => commit(true));
			} else {
				const label = document.createElement("span");
				label.className = "tab-label";
				label.textContent = tab.name;
				el.appendChild(label);

				const close = document.createElement("button");
				close.type = "button";
				close.className = "tab-close";
				close.setAttribute("aria-label", "Close tab");
				close.textContent = "×";
				if (tabs.length <= 1) close.disabled = true;
				close.addEventListener("click", async (e) => {
					e.stopPropagation();
					await onCloseTab(tab.id, tab.id === activeTabId);
					await refresh();
				});
				el.appendChild(close);

				el.addEventListener("click", async () => {
					if (tab.id !== activeTabId) {
						await onSwitchTab(tab.id);
						await refresh();
					}
				});
				el.addEventListener("dblclick", () => {
					renamingTab = tab.id;
					renderTabs();
				});
			}

			tabStrip.appendChild(el);
		}

		const add = document.createElement("button");
		add.type = "button";
		add.className = "tab-add";
		add.setAttribute("aria-label", "New tab");
		add.textContent = "+";
		add.addEventListener("click", async () => {
			await onNewTab();
			await refresh();
		});
		tabStrip.appendChild(add);
	}

	wsButton.addEventListener("click", () => {
		if (popoverOpen) closePopover();
		else openPopover();
	});

	return { refresh };
}
