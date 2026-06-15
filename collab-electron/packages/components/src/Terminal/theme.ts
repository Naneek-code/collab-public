import type { ITheme } from "@xterm/xterm";

export const darkTheme: ITheme = {
  background: "rgba(8, 8, 8, 0)",
  foreground: "#c1c1c1",
  cursor: "#c1c1c1",
  cursorAccent: "#000000",
  selectionBackground: "#264f78",
  black: "#757575",
  red: "#cc685c",
  green: "#76c266",
  yellow: "#cbca9b",
  blue: "#85aacb",
  magenta: "#cc72ca",
  cyan: "#74a7cb",
  white: "#c1c1c1",
  brightBlack: "#727272",
  brightRed: "#cc9d97",
  brightGreen: "#a3dd97",
  brightYellow: "#cbcaaa",
  brightBlue: "#9ab6cb",
  brightMagenta: "#cc8ecb",
  brightCyan: "#b7b8cb",
  brightWhite: "#f0f0f0",
};

export const lightTheme: ITheme = {
  background: "rgba(248, 248, 248, 0)",
  foreground: "#383a42",
  cursor: "#383a42",
  cursorAccent: "#ffffff",
  selectionBackground: "#add6ff",
  black: "#383a42",
  red: "#e45649",
  green: "#50a14f",
  yellow: "#c18401",
  blue: "#4078f2",
  magenta: "#a626a4",
  cyan: "#0184bc",
  white: "#fafafa",
  brightBlack: "#4f525e",
  brightRed: "#e06c75",
  brightGreen: "#98c379",
  brightYellow: "#e5c07b",
  brightBlue: "#61afef",
  brightMagenta: "#c678dd",
  brightCyan: "#56b6c2",
  brightWhite: "#ffffff",
};

export function getTheme(): ITheme {
  const prefersDark =
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  return prefersDark ? darkTheme : lightTheme;
}
