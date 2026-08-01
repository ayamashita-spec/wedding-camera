/**
 * Wedding Camera — Service Worker
 *
 * 目的はひとつだけです。会場の回線が切れた瞬間にリロードしても
 * 真っ白にならないようにすること。
 *
 * ■ 絶対にキャッシュしないもの
 *   - GAS の API（script.google.com / script.googleusercontent.com）
 *   - Drive のサムネイル（drive.google.com）
 *   古い応答を返すと「撮ったのに出てこない」「保存できたか分からない」の原因になります。
 *
 * ■ HTML は network-first
 *   当日の緊急修正が反映されないと困るため、通信があれば必ず新しい方を使います。
 */

const CACHE_NAME = 'wedcam-shell-v3';

/**
 * opaque レスポンスでもキャッシュを許すホスト。
 *
 * fonts.googleapis.com の CSS は <link> 経由なので no-cors 扱いになり、
 * response.ok が false・status 0 の opaque レスポンスで返ってきます。
 * 旧条件（response.ok || type === 'cors'）では弾かれていたため、
 * フォント本体（CORS なのでキャッシュ済み）だけがあって @font-face 定義が無い、
 * という状態になり、オフラインではフォントが当たっていませんでした。
 *
 * opaque は中身も status も見えないため、エラー応答を焼き付けてしまう危険が
 * あります。だからフォントの 2 ホストだけに限定します。
 */
const OPAQUE_OK_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

const SHELL_ASSETS = [
  './',
  './index.html',
  './config.js',
  './manifest.json',
  './assets/cover.jpg',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // 1 つ欠けても install 全体を失敗させないよう個別に追加します
      .then((cache) => Promise.all(
        SHELL_ASSETS.map((url) => cache.add(url).catch(() => {}))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

/** キャッシュしてはいけないホスト */
const BYPASS_HOSTS = [
  'script.google.com',
  'script.googleusercontent.com',
  'drive.google.com',
  'www.googleapis.com'
];

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (error) { return; }

  if (BYPASS_HOSTS.indexOf(url.hostname) !== -1) return; // ネットワークにそのまま通す

  const isDocument = request.mode === 'navigate' ||
    (request.headers.get('accept') || '').indexOf('text/html') !== -1;

  /* config.js は GAS の URL とトークンを持ちます。古い値を返すと
     「撮れるのに保存できない」という一番わかりにくい壊れ方をするため、
     HTML と同じく network-first にします（cache-first にしてはいけません）。 */
  const isConfig = url.origin === self.location.origin &&
    url.pathname.replace(/\/+$/, '').endsWith('/config.js');

  if (isDocument || isConfig) {
    // network-first：新しい方を優先し、落ちていたらキャッシュで表示
    const cacheKey = isDocument ? './index.html' : request;
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(cacheKey, copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match(cacheKey).then((cached) => cached || Response.error()))
    );
    return;
  }

  // それ以外（フォント・アイコン・背景画像など）は cache-first
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request).then((response) => {
        const isOpaqueFont = response.type === 'opaque' &&
          OPAQUE_OK_HOSTS.indexOf(url.hostname) !== -1;
        const cacheable = response.ok || isOpaqueFont;

        if (cacheable) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      }).catch(() =>
        // オフラインで未キャッシュのものを掴むと未処理の reject になります
        caches.match(request).then((fallback) => fallback || Response.error())
      );
    })
  );
});