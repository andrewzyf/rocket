import { defineConfig } from 'vite'

export default defineConfig({
  base: '/rocket/',
  // ... leave other existing settings intact
})
  server: { host: '0.0.0.0', port: 5173 },
  build: { target: 'es2022', sourcemap: true },
});

