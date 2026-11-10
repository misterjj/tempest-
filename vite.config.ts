import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // En dev, Owlbear charge le manifest depuis un autre domaine.
  // Port fixe, distinct des fiches (5173) et de Spellcast FX (5174), pour les lancer ensemble.
  server: { cors: true, port: 5175, strictPort: true },
  build: {
    rollupOptions: {
      input: { guide: resolve("index.html"), guideFr: resolve("fr/index.html"), background: resolve("background.html"), panel: resolve("panel.html"), palette: resolve("palette.html"), fluidPalette: resolve("fluid-palette.html") },
    },
  },
});
