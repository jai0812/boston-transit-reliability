import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  // MapLibre 6 loads its worker relative to its own module; pre-bundling breaks that URL.
  optimizeDeps: { exclude: ['maplibre-gl'] },
})
