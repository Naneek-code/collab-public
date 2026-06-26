import { createRoot } from "react-dom/client";
import { initDarkMode } from "@collab/shared/dark-mode";
import App from "./App";
import "@collab/shared/styles/Theme.css";
import "./styles/App.css";

initDarkMode();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<App />);
}
