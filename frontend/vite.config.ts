import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  server: {
    // Bind IPv4 + IPv6 so both http://127.0.0.1:5173 and http://localhost:5173 work.
    // Windows often leaves Vite on ::1 only, which makes 127.0.0.1 look "blank"/dead.
    host: true,
    port: 5173,
    strictPort: true,
  },
})
