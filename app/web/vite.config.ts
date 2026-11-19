import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  // Relative asset and data paths: the same build works at the custom domain root and
  // at a GitHub Pages project path. Routing is hash-based, so every page is index.html.
  base: './',
  plugins: [react()],
  // MapLibre 6 loads its worker relative to its own module; pre-bundling breaks that URL.
  optimizeDeps: { exclude: ['maplibre-gl'] },
})
