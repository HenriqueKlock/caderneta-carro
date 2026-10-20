import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// O GitHub Pages serve o app em /caderneta-carro/
const base = process.env.BASE_PATH ?? '/caderneta-carro/';
const build = new Date().toISOString().slice(0, 16).replace('T', ' ');

export default defineConfig({
  base,
  define: { __BUILD__: JSON.stringify(build) },
  plugins: [
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'Caderneta do Carro',
        short_name: 'Caderneta',
        description: 'Abastecimentos, consumo e manutenção do carro, funcionando sem internet.',
        lang: 'pt-BR',
        start_url: base,
        scope: base,
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#14202B',
        theme_color: '#14202B',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: base + 'index.html',
        cleanupOutdatedCaches: true,
        // Lista de postos (atualizada toda semana): abre na hora com a cópia do celular e atualiza por trás
        runtimeCaching: [
          {
            urlPattern: ({ url }) => /\/dados\/postos-[A-Z-]+\.json$/.test(url.pathname),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'postos', expiration: { maxEntries: 4 } },
          },
        ],
      },
    }),
  ],
});
