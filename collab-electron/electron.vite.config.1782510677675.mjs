// electron.vite.config.ts
import { execSync } from "child_process";
import { defineConfig } from "electron-vite";
import { resolve } from "path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
var __electron_vite_injected_dirname = "C:\\Users\\leone\\collab-public\\collab-electron";
var outDir = "out";
var gitCommitSha = execSync("git rev-parse HEAD", {
  encoding: "utf8"
}).trim();
var electron_vite_config_default = defineConfig({
  main: {
    define: {
      __GIT_COMMIT_SHA__: JSON.stringify(gitCommitSha)
    },
    resolve: {
      alias: {
        "@collab/shared": resolve(__electron_vite_injected_dirname, "packages/shared/src")
      }
    },
    build: {
      outDir: resolve(__electron_vite_injected_dirname, outDir, "main"),
      rollupOptions: {
        external: ["node-pty", "@parcel/watcher", "typescript", "sharp"],
        input: {
          index: resolve(__electron_vite_injected_dirname, "src/main/index.ts"),
          "pty-sidecar": resolve(__electron_vite_injected_dirname, "src/main/sidecar/entry.ts"),
          "watcher-worker": resolve(
            __electron_vite_injected_dirname,
            "src/main/watcher-worker.ts"
          ),
          "git-replay-worker": resolve(
            __electron_vite_injected_dirname,
            "src/main/git-replay-worker.ts"
          ),
          "image-worker": resolve(
            __electron_vite_injected_dirname,
            "src/main/image-worker.ts"
          )
        }
      }
    }
  },
  preload: {
    build: {
      outDir: resolve(__electron_vite_injected_dirname, outDir, "preload"),
      rollupOptions: {
        input: {
          universal: resolve(__electron_vite_injected_dirname, "src/preload/universal.ts"),
          shell: resolve(__electron_vite_injected_dirname, "src/preload/shell.ts"),
          "notification-overlay": resolve(
            __electron_vite_injected_dirname,
            "src/preload/notification-overlay.ts"
          )
        },
        output: {
          format: "cjs",
          entryFileNames: "[name].js"
        }
      }
    }
  },
  renderer: {
    root: resolve(__electron_vite_injected_dirname, "src/windows"),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@collab/shared": resolve(__electron_vite_injected_dirname, "packages/shared/src"),
        "@collab/theme": resolve(__electron_vite_injected_dirname, "packages/theme/src"),
        "@collab/components": resolve(
          __electron_vite_injected_dirname,
          "packages/components/src"
        )
      }
    },
    build: {
      outDir: resolve(__electron_vite_injected_dirname, outDir, "renderer"),
      rollupOptions: {
        input: {
          nav: resolve(__electron_vite_injected_dirname, "src/windows/nav/index.html"),
          viewer: resolve(__electron_vite_injected_dirname, "src/windows/viewer/index.html"),
          terminal: resolve(__electron_vite_injected_dirname, "src/windows/terminal/index.html"),
          settings: resolve(__electron_vite_injected_dirname, "src/windows/settings/index.html"),
          shell: resolve(__electron_vite_injected_dirname, "src/windows/shell/index.html"),
          "terminal-tile": resolve(
            __electron_vite_injected_dirname,
            "src/windows/terminal-tile/index.html"
          ),
          "graph-tile": resolve(
            __electron_vite_injected_dirname,
            "src/windows/graph-tile/index.html"
          ),
          "docker-tile": resolve(
            __electron_vite_injected_dirname,
            "src/windows/docker-tile/index.html"
          ),
          "tile-list": resolve(__electron_vite_injected_dirname, "src/windows/tile-list/index.html"),
          "agent-chat": resolve(
            __electron_vite_injected_dirname,
            "src/windows/agent-chat/index.html"
          ),
          "notification-overlay": resolve(
            __electron_vite_injected_dirname,
            "src/windows/notification-overlay/index.html"
          )
        }
      }
    }
  }
});
export {
  electron_vite_config_default as default
};
