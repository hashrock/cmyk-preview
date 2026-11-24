import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages（/cmyk-preview/ 配下）でもローカルでも動くよう相対パスにする
  base: './',
  plugins: [react()],
})
