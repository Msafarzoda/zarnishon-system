import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        // System stacks render Tajik Cyrillic well on macOS, Windows and Android tablets.
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      colors: {
        ink: {
          DEFAULT: "#1a1d21",
          soft: "#4a5159",
          faint: "#8b949e",
        },
        paper: {
          DEFAULT: "#f7f6f3",
          card: "#ffffff",
          line: "#e3e1dc",
        },
        brand: {
          DEFAULT: "#1f5c3d", // cotton-field green
          dark: "#16452d",
          light: "#e8f1ec",
        },
        alarm: "#b3261e",
        warn: "#8a5a00",
      },
    },
  },
  plugins: [],
} satisfies Config;
