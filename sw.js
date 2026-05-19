/* ═══════════════════════════════════════════════════════════
   STEREO LOGIC — Service Worker
   Strategy: Cache-first for app shell, network-first for
   external resources (fonts, CDN libs).
   Update: bump CACHE_VERSION to force a full refresh.
═══════════════════════════════════════════════════════════ */

const CACHE_VERSION = 'stereo-logic-v1';

// Files that form the installable app shell
const SHELL_FILES = [
    './',
    './index.html',
    './style.css',
    './script.js',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-512.png',
];

// ── INSTALL: pre-cache the app shell ──────────────────────
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_VERSION).then(cache => {
            // Use individual adds so one 404 doesn't block the rest
            return Promise.allSettled(
                SHELL_FILES.map(url => cache.add(url).catch(() => {}))
            );
        }).then(() => self.skipWaiting())
    );
});

// ── ACTIVATE: delete old cache versions ───────────────────
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys
                    .filter(key => key !== CACHE_VERSION)
                    .map(key => caches.delete(key))
            )
        ).then(() => self.clients.claim())
    );
});

// ── FETCH: cache-first for same-origin, network-first for CDN ──
self.addEventListener('fetch', event => {
    const req = event.request;
    const url = new URL(req.url);

    // Only handle GET requests
    if (req.method !== 'GET') return;

    // Skip chrome-extension and non-http(s) schemes
    if (!req.url.startsWith('http')) return;

    // Skip audio files — never cache them (too large, user-picked files)
    const audioExts = /\.(mp3|wav|flac|ogg|aac|m4a|opus|weba)$/i;
    if (audioExts.test(url.pathname)) return;

    // External resources (Google Fonts, CDN): network-first, fall to cache
    if (url.origin !== self.location.origin) {
        event.respondWith(
            fetch(req)
                .then(res => {
                    if (res && res.status === 200) {
                        const clone = res.clone();
                        caches.open(CACHE_VERSION).then(c => c.put(req, clone));
                    }
                    return res;
                })
                .catch(() => caches.match(req))
        );
        return;
    }

    // Same-origin app shell: cache-first, then network
    event.respondWith(
        caches.match(req).then(cached => {
            if (cached) return cached;
            return fetch(req).then(res => {
                if (res && res.status === 200) {
                    const clone = res.clone();
                    caches.open(CACHE_VERSION).then(c => c.put(req, clone));
                }
                return res;
            });
        })
    );
});

// ── MESSAGE: force update from client ─────────────────────
self.addEventListener('message', event => {
    if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
