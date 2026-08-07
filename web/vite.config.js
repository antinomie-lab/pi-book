import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  base: "/pi/",
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // chapters live in the repo's agent/ folder, one level up
      "@book": fileURLToPath(new URL("../agent", import.meta.url)),
    },
  },
  server: {
    fs: { allow: [".."] },
  },
});
