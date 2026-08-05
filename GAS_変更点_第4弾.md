# GAS（コード.gs）の変更点 — 第 4 弾

> **まだ適用していません。** 2026-08-04 のレビューで見つかった、当日に効く 6 件です。
> 上から順に貼れるよう、行がずれない形（関数まるごとの置換・末尾への追加）にしてあります。

反映後は必ず **デプロイを管理 → 対象デプロイの鉛筆アイコン → バージョン「新バージョン」→ デプロイ**。
「新しいデプロイ」を作ると URL が変わり、配布済みの QR が全部死にます。

適用したら `verifySetup()` を実行し、ログに `★` が無いことを確認してください。

---

## 一覧

| # | 内容 | 影響 |
|---|---|---|
| A | エラーを分類して `permanent` を返す | 設定ミスで全ゲストが 5 回ずつ再送するのを止める |
| B | `getAlbum` のフォールバックを 1 ページ目に限定し、結果をキャッシュする | ピーク時の自己増幅を止める |
| C | 二重登録の照合を `attempt` でゲートしない | リロードで同じ写真が 2 枚並ぶのを防ぐ |
| D | `UPLOAD_DEADLINE` の日付のみ指定を JST の終端に補完 | 挙式当日の朝 9 時に受付が閉まる事故を防ぐ |
| E | 動画のサイズ上限をフロントより低くする | 25MB の動画で詰まるのを防ぐ |
| F | ゴミ箱のファイルを読み出さない／MIME を許可リストに | 削除の意思を読み出しにも効かせる |

**フロント側（`index.html`）は A を受け取る側の実装が入っています。**
`callApi` が `json.permanent` を拾い、`processQueue` がその 1 枚だけリトライせず打ち切って
「この分は送信できないため送信待ちから外しました」と案内します。
A が未適用のうちは `permanent` が返らないので、従来どおり通常のリトライに落ちます。

B・C・D・F はサーバー側だけで完結します。**E はフロント側の変更が別途必要です**
（`CONFIG.VIDEO_MAX_BYTES` は 25MB のままなので、E だけ適用するとサーバーに届いてから
弾かれます。下の E の項を参照）。

---

## A. エラーを分類して `permanent` を返す

### 変更前（`handleUpload` の末尾、276 行付近）

```js
  } catch (error) {
    console.error('[upload]', error.stack || error.message);
    return { success: false, error: '写真を保存できませんでした。' };
  }
}
```

### 変更後

```js
  } catch (error) {
    console.error('[upload]', error.stack || error.message);

    /* 何度送っても直らないエラーは、そう伝えます。
       旧版はサイズ超過・形式不正・FOLDER_ID の誤り・Drive の容量切れ・
       一時的な 5xx を全部「写真を保存できませんでした。」に潰していたため、
       クライアントはリトライ可否を判断できず、MAX_RETRY まで 5 回送っていました。
       当日 FOLDER_ID に typo があると、全ゲストの全写真が 5 倍の負荷で再送されます。 */
    const permanent = /サイズが上限|形式が不正|画像データが空/.test(error.message);
    return {
      success: false,
      error: permanent ? error.message : '写真を保存できませんでした。',
      permanent: permanent
    };
  }
}
```

> フロント側は `callApi` が `json.permanent` を拾い、`processQueue` が即座に打ち切ります。
> A を適用しないうちは `permanent` が返らないだけで、従来どおり動きます（先に入れても壊れません）。

---

## B. `getAlbum` のフォールバックを 1 ページ目に限定し、キャッシュする

現状は 3 つが重なっています。

1. `listImagesViaDriveApp` は `pageSize` も `pageToken` も受け取らず、**500 件フルスキャン**する
2. `cache.put` は try の中、フォールバックは catch の中なので、**結果が 1 秒もキャッシュされない**
3. `getAlbumVersion()`（PropertiesService の読み）が内側 try/catch で守られておらず、
   Drive の失敗だけでなく Properties の短時間レート制限でもフォールバックへ落ちる

ピーク時に Drive REST が 429 を 1 回返すと、以後どのゲストの ↻ も 500 件走査になり、
同時実行スロットを食い合ってアップロードまで巻き添えになります。一度入ると自己増幅します。

### 変更前（`handleGetAlbum`、302〜347 行をまるごと置換）

### 変更後

```js
function handleGetAlbum(pageToken, pageSize) {
  try {
    const size = Math.min(
      Math.max(parseInt(pageSize, 10) || CONFIG.ALBUM_PAGE_SIZE, 1),
      CONFIG.ALBUM_PAGE_SIZE_MAX
    );

    /* CacheService のキーは 250 文字までです。Drive の pageToken は 400 文字を
       超えることがあり、そのまま繋ぐと get() が例外を投げます。
       トークンは短いダイジェストに畳んでから使います。 */
    const cache = CacheService.getScriptCache();

    /* バージョンの読み取り（PropertiesService）で失敗しても、REST 経路は捨てません。
       ここを外側 catch に落とすと、Properties の一時的なレート制限だけで
       500 件フルスキャンのフォールバックに切り替わってしまいます。 */
    let ver = '0';
    try {
      ver = getAlbumVersion();
    } catch (verError) {
      console.warn('[getAlbum] version read skipped:', verError.message);
    }
    const cacheKey = 'album_v' + ver + '_' + size + '_' + shortHash(pageToken);

    let cached = null;
    try {
      cached = cache.get(cacheKey);
    } catch (cacheError) {
      // キャッシュが読めないだけで、一覧の取得方法を変えてはいけません
      console.warn('[getAlbum] cache read skipped:', cacheError.message);
    }
    if (cached) return JSON.parse(cached);

    const result = listImagesViaRestApi(getTargetFolderId(), size, pageToken);

    try {
      cache.put(cacheKey, JSON.stringify(result), CONFIG.ALBUM_CACHE_SEC);
    } catch (cacheError) {
      // 100KB 超はキャッシュに入りません。無視して構いません
      console.warn('[getAlbum] cache skipped:', cacheError.message);
    }

    return result;
  } catch (error) {
    console.error('[getAlbum]', error.stack || error.message);

    /* REST が落ちた場合の保険。ただし全件スキャンは重く、同時実行スロットを
       長く握るため、1 ページ目だけに限定します。2 ページ目以降は素直に失敗を
       返してクライアントに再読み込みさせるほうが、全体としては速く復旧します。 */
    if (pageToken) {
      return { success: false, error: 'アルバムを読み込めませんでした。' };
    }

    try {
      const size = Math.min(
        Math.max(parseInt(pageSize, 10) || CONFIG.ALBUM_PAGE_SIZE, 1),
        CONFIG.ALBUM_PAGE_SIZE_MAX
      );
      const fallback = listImagesViaDriveApp(getTargetFolderId(), size);

      // フォールバックの結果もキャッシュします（旧版は catch 内なので効いていませんでした）
      try {
        const cache = CacheService.getScriptCache();
        let ver = '0';
        try { ver = getAlbumVersion(); } catch (verError) { /* 既定の 0 で続行 */ }
        cache.put('album_v' + ver + '_' + size + '_' + shortHash(pageToken),
          JSON.stringify(fallback), CONFIG.ALBUM_CACHE_SEC);
      } catch (cacheError) { /* 入らなくても構いません */ }

      return fallback;
    } catch (fallbackError) {
      console.error('[getAlbum:fallback]', fallbackError.message);
      return { success: false, error: 'アルバムを読み込めませんでした。' };
    }
  }
}
```

### あわせて `listImagesViaDriveApp` を差し替え（394〜419 行）

打ち切ったことをクライアントに伝えます。旧版は 500 件で打ち切っても `nextPageToken: null` を返すため、
601 枚目以降が「存在しない」扱いになり、下部バーも「全 500 枚」と断定していました。

```js
/**
 * REST が使えない環境向けのフォールバック。
 * 全件スキャンは重いので、渡された件数で打ち切ります。
 */
function listImagesViaDriveApp(folderId, limit) {
  const iterator = DriveApp.getFolderById(folderId).getFiles();
  const images = [];
  const hardLimit = Math.min(Math.max(parseInt(limit, 10) || CONFIG.ALBUM_PAGE_SIZE, 1), 200);

  while (iterator.hasNext() && images.length < hardLimit) {
    const file = iterator.next();
    const mime = file.getMimeType() || '';
    if (mime.indexOf('image/') !== 0 && mime.indexOf('video/') !== 0) continue;

    images.push({
      id: file.getId(),
      name: file.getName(),
      thumbnailUrl: thumbUrl(file.getId(), 400),
      highResUrl: thumbUrl(file.getId(), 1600),
      uploader: file.getDescription() || 'ゲスト',
      mimeType: mime,
      isVideo: mime.indexOf('video/') === 0,
      createdTime: file.getDateCreated().getTime(),
      capturedAt: file.getLastUpdated().getTime()
    });
  }

  images.sort(function (a, b) { return b.capturedAt - a.capturedAt; });

  /* degraded / truncated は「一部だけ返している」という申告です。
     クライアントが今は見ていなくても、返しておかないと後から判断できません。 */
  return {
    success: true,
    data: images,
    nextPageToken: null,
    truncated: iterator.hasNext(),
    degraded: true
  };
}
```

---

## C. 二重登録の照合を `attempt` でゲートしない

### 変更前（`handleUpload` 内、207〜220 行）

```js
    if (clientId) {
      const known = recallUpload(clientId);
      if (known) {
        return { success: true, data: { id: known.id, name: known.name, duplicate: true } };
      }
      // 再送のときだけ Drive も確認します（初回は無駄な往復を避ける）
      if (attempt > 0) {
        const found = findUploadByClientId(clientId);
        if (found) {
          rememberUpload(clientId, found);
          return { success: true, data: { id: found.id, name: found.name, duplicate: true } };
        }
      }
    }
```

### 変更後

```js
    if (clientId) {
      const known = recallUpload(clientId);
      if (known) {
        return { success: true, data: { id: known.id, name: known.name, duplicate: true } };
      }

      /* Drive の照合を attempt でゲートしてはいけません。
         attempt はクライアントの item.sendAttempts ですが、これを +1 して
         IndexedDB に書き戻すのは catch の中だけです。送信中にページが
         リロード・破棄されると catch は走らないので、attempt は 0 のまま残ります。
         一方 rememberUpload は createFile の後なので recallUpload も空振りし、
         結果として同じ写真がアルバムに 2 枚並びます（削除 API は無いので手作業）。
         弱い回線で 25 秒かかる写真を、待ちきれずリロードすると普通に起きます。

         照合のぶん UrlFetch が 1 枚あたり +1 回（200 枚で +200 回）増えますが、
         日次クォータには十分収まります。 */
      const found = findUploadByClientId(clientId);
      if (found) {
        rememberUpload(clientId, found);
        return { success: true, data: { id: found.id, name: found.name, duplicate: true } };
      }
    }
```

> `attempt` の変数自体は 194 行で読んだままにしておいて構いません（ログに使えます）。
> 未使用が気になる場合は 194 行の `const attempt = ...` を消してください。

### タブが 2 枚ある場合も塞ぐなら（任意・より確実）

`state.isQueueRunning` はページ単位のフラグなので、QR を 2 回読んでタブが 2 枚あると
同じ clientId のアップロードが真に並行します。クレーム区間だけを直列化すれば塞げます。
全体を直列化しないのでスループットは落ちません。

```js
    if (clientId) {
      const cache = CacheService.getScriptCache();
      const lock = LockService.getScriptLock();
      lock.waitLock(20000);
      try {
        const known = recallUpload(clientId);
        if (known) return { success: true, data: { id: known.id, name: known.name, duplicate: true } };

        if (cache.get('claim_' + clientId)) {
          // 別の実行が同じ写真を処理中。二重に作らせない
          return { success: false, error: '同じ写真を処理中です。', inflight: true };
        }

        const found = findUploadByClientId(clientId);
        if (found) {
          rememberUpload(clientId, found);
          return { success: true, data: { id: found.id, name: found.name, duplicate: true } };
        }

        cache.put('claim_' + clientId, '1', 300);
      } finally {
        lock.releaseLock();
      }
    }
```

---

## D. `UPLOAD_DEADLINE` の日付のみ指定を JST の終端に補完

ECMAScript 仕様では `'2026-09-05'` のような**日付のみの形式は UTC** として解釈されます
（日時形式ならローカル）。JST では **2026-09-05 09:00** です。
しかも `isFinite(t)` は true になるので、「読めない値は無期限に倒す」保護は一切効きません。

`setUploadDeadline('2026-09-05')` と書いた時点で、挙式当日の朝 9 時に受付が閉じます。
ゲストは表紙で「受付は終了しました」を見せられ、カメラボタンも押せなくなります。
復旧には GAS エディタを開く必要があり、披露宴の最中には現実的ではありません。

### 追加（ファイル末尾でよい）

```js
/**
 * 受付期限の文字列を正規化します。
 * 日付だけを書かれた場合、UTC 解釈で当日の朝 9 時（JST）に閉まってしまうため、
 * その日の終わり（JST）に補完します。
 */
function normalizeDeadlineText(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text + 'T23:59:59+09:00' : text;
}
```

### `getUploadDeadline` を差し替え（828〜835 行）

```js
function getUploadDeadline() {
  const raw = PropertiesService.getScriptProperties().getProperty('UPLOAD_DEADLINE');
  if (!raw || !raw.trim()) return null;
  const t = new Date(normalizeDeadlineText(raw)).getTime();
  /* 読めない値で受付を止めてしまう方が事故として重いので、
     判定できないときは「開いている」に倒します。 */
  return isFinite(t) ? t : null;
}
```

### `setUploadDeadline` を差し替え（866〜882 行）

```js
function setUploadDeadline(iso) {
  const props = PropertiesService.getScriptProperties();
  if (!iso || !String(iso).trim()) {
    props.deleteProperty('UPLOAD_DEADLINE');
    console.log('受付期限を解除しました（無期限）。');
    return;
  }

  const raw = String(iso).trim();
  const normalized = normalizeDeadlineText(raw);
  const t = new Date(normalized).getTime();
  if (!isFinite(t)) {
    console.log('★ 日時として読めません:', raw);
    console.log('  例: 2026-09-05T23:59:59+09:00');
    return;
  }

  if (normalized !== raw) {
    console.log('日付のみが指定されたため、その日の終わりに補完しました:', normalized);
  }

  props.setProperty('UPLOAD_DEADLINE', normalized);
  console.log('受付期限:', Utilities.formatDate(new Date(t), CONFIG.TZ, 'yyyy/MM/dd HH:mm:ss'));
  console.log('現在は', isUploadOpen() ? '受付中' : '受付終了', 'です。');
}
```

> 既に `UPLOAD_DEADLINE` に日付だけが入っている場合、`getUploadDeadline` 側の補完で
> その日の終わりとして解釈されるようになります（プロパティを直接編集された場合も救われます）。

---

## E. 動画のサイズ上限をフロントより低くする

現状 `MAX_UPLOAD_BYTES_VIDEO` は 30MB、フロントの `VIDEO_MAX_BYTES` は 25MB なので、
**サーバー側の上限は一度も発動しません。**

録画経路（15 秒 / 1.5Mbps ≒ 3MB）は安全ですが、「端末の写真をアップロード」で
既存動画を選ぶ経路が危険です。iPhone の 1080p は 1〜2 MB/秒なので 15〜25 秒で 25MB に届きます。
25MB は Base64 で 33.3M 文字になり、`postData.contents` → `JSON.parse` → 正規表現のコピー →
`base64Decode` で 25M 要素の `Byte[]` と、ピークで 150MB 級を踏みます。

### 変更前（31 行）

```js
  MAX_UPLOAD_BYTES_VIDEO: 30 * 1024 * 1024,
```

### 変更後

```js
  /* フロントの CONFIG.VIDEO_MAX_BYTES より必ず低くしておきます。
     サーバー側が先に弾かないと、通らない動画を MAX_RETRY 回ぶん送り続けます。 */
  MAX_UPLOAD_BYTES_VIDEO: 10 * 1024 * 1024,
```

**あわせてフロント側も下げてください**（サーバーだけ下げると、送ってから弾かれます）。
`index.html` の 2 箇所です。

```js
VIDEO_MAX_BYTES: 10 * 1024 * 1024,
```

> A を適用済みなら、サイズ超過は `permanent: true` で返るのでリトライされません。

---

## F. ゴミ箱のファイルを読み出さない／MIME を許可リストにする

### F-1. ゴミ箱（`getFileInTargetFolder`、160 行の while ループの直前に 1 行）

一覧側は `trashed = false` でゴミ箱を除外していますが、`getFileInTargetFolder` は
親フォルダと MIME しか見ていません。ゴミ箱のファイルも `getParents()` は元の親を返すため、
検証を通過して `getSingleBase64` で中身が取れます。

README の「削除は Drive のフォルダを直接開けばできる」という運用が、読み出し側に効いていません。

```js
  const folderId = getTargetFolderId();
  const file = DriveApp.getFileById(fileId);

  // 新郎新婦がゴミ箱に入れた写真は、読み出しでも拒否します
  if (file.isTrashed()) throw new Error('out_of_scope');

  const parents = file.getParents();
```

### F-2. MIME の許可リストとマジックバイト（`handleUpload`、246 行付近）

現状サブタイプは `[a-zA-Z0-9.+-]+` で何でも通り、中身のバイト列は検査されません。
`extensionFor` は未知の `image/*` を `.jpg` に落とすので、任意のバイナリが `.jpg` として
保存され、`getSingleBase64` でそのまま取り出せます。トークンを持つ第三者から見ると、
削除 API の無い汎用ストレージとして機能します。

#### 変更前

```js
    const bytes = Utilities.base64Decode(rawBase64);
    const blob = Utilities.newBlob(bytes, mimeType);
```

#### 変更後

```js
    /* MIME を許可リストにし、デコード後の先頭バイトで実体を確かめます。
       フロントは撮影分を JPEG に再エンコードしており、動画も MediaRecorder /
       ピッカー由来なので、これで実ゲストが弾かれることはありません。 */
    const ALLOWED_MIME = {
      'image/jpeg': [[0xFF, 0xD8, 0xFF]],
      'image/png':  [[0x89, 0x50, 0x4E, 0x47]],
      'image/webp': [[0x52, 0x49, 0x46, 0x46]],
      // heic / mp4 系は ftyp ボックスなので先頭数バイトでは判定できません。型名だけ絞ります
      'image/heic': null,
      'image/heif': null,
      'video/mp4': null,
      'video/quicktime': null,
      'video/webm': null
    };

    const baseMime = mimeType.split(';')[0].trim().toLowerCase();
    if (!(baseMime in ALLOWED_MIME)) throw new Error('画像の形式が不正です。');

    const bytes = Utilities.base64Decode(rawBase64);

    const signatures = ALLOWED_MIME[baseMime];
    if (signatures && !signatures.some(function (sig) {
          return sig.every(function (b, i) { return (bytes[i] & 0xFF) === b; });
        })) {
      throw new Error('画像の形式が不正です。');
    }

    const blob = Utilities.newBlob(bytes, baseMime);
```

> 最後の `newBlob` に渡すのを `mimeType` から `baseMime` に変えています。
> `video/mp4;codecs=avc1...` のようなパラメータ付きを Drive に渡さないためです。

---

## 反映後の確認

1. エディタから `verifySetup()` を実行し、ログに `★` が無いこと
2. **デプロイを管理 → 鉛筆 → 新バージョン → デプロイ**（URL は変わりません）
3. スマホで写真 2〜3 枚と動画 1 本を撮り、アルバムに撮影順で並ぶこと
4. 送信中にページをリロードし、**同じ写真が 2 枚並ばないこと**（C の確認）
5. `setUploadDeadline('2026-12-31')` を実行し、ログに
   「日付のみが指定されたため、その日の終わりに補完しました: 2026-12-31T23:59:59+09:00」
   と出ること。確認後 `setUploadDeadline('')` で解除（D の確認）
6. 10MB を超える動画を「端末の写真をアップロード」から選び、リトライを繰り返さず
   1 回で「動画が大きすぎます」相当に落ちること（A + E の確認）

## 今回入れていないもの

- **匿名 POST の流量制限**（合計バイト数のブレーカー、受付の「開始」側）。
  枚数無制限の方針は保ったままグローバル上限だけ入れる形になりますが、
  それより先に **式のためだけの Google アカウントを作ってそこでデプロイし直す**ほうが、
  コード変更ゼロで影響範囲をアカウントごと切り離せます。現在のデプロイ主体は業務用
  アカウントで、スコープは `auth/drive`（Drive 全体）です。
- `createFile` / `setDescription` / `PATCH` の 3 往復を REST の multipart create 1 往復に統合。
  1 リクエストの実行時間が縮み、同時実行スロットの取り合いが軽くなりますが、
  保存経路そのものを書き換えるので当日直前には勧めません。
- `stampDriveMetadata` の失敗時リトライ。失敗すると撮影順が「送信できた順」に戻り、
  `appProperties.cid` も付かないため C の照合が効きません（6 時間以内はキャッシュで拾えます）。
