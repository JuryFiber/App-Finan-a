// Service worker: deixa o app abrir rápido e instalável. Dados sempre vêm do Supabase (não são cacheados).
const CACHE = 'financas-v15';
const SHELL = ['./', './index.html', './styles.css', './app.js', './config.js', './manifest.webmanifest', './icon.svg', './icon-maskable.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Rede primeiro (pega atualizações), cache como reserva quando estiver offline
  e.respondWith(
    // cache: 'no-cache' obriga a conferir com o servidor se há versão nova (ignora os 10 min de cache do GitHub Pages)
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) { // só guarda respostas boas (um erro 404/500 não pode virar a cópia offline)
          const copy = res.clone();
          e.waitUntil(caches.open(CACHE).then((c) => c.put(e.request, copy)));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')))
  );
});
