# GAS（コード.gs）の変更点

> **【適用済み】2026-08-01 にこの内容を反映し、バージョン 37 としてデプロイ済みです。**
> 公開サイトから `getAlbum` が `capturedAt` を返し、撮影時刻の降順に並ぶことを確認しました。
> **もう一度適用する必要はありません。** 以下は変更内容の記録として残しています。

クライアント側（`index.html`）は修正済みです。撮影時刻順の並びと二重登録の防止は
**サーバー側の対応が揃って初めて効きます**。以下を `コード.gs` に反映してください。

行番号は変更前のファイルのものです。上から順に適用すると行がずれるので、
**下（⑤）から上（①）へ逆順に作業する**のがおすすめです。

反映後は必ず **デプロイを管理 → 対象デプロイの鉛筆アイコン → バージョン「新バージョン」→ デプロイ**
で更新してください。「新しいデプロイ」を作ると URL が変わり、配布済みの QR が全部死にます。

---

## ① `doPost` の upload 分岐（80〜81 行目）

### 変更前

```js
      case 'upload':
        return jsonResponse(handleUpload(payload.base64Data, payload.userName));
```

### 変更後

```js
      case 'upload':
        return jsonResponse(handleUpload(payload.base64Data, payload.userName, {
          clientId: payload.clientId,
          capturedAt: payload.capturedAt,
          attempt: payload.attempt
        }));
```

---

## ② `handleUpload` を差し替え（177〜218 行目をすべて置換）

第 3 引数はオプションなので、`testWriteRoundTrip()` からの
`handleUpload(TEST_IMAGE_DATA_URL, '__setup_test__')` はそのまま動きます。

```js
/**
 * 画像を 1 枚保存します。
 *
 * Advanced Drive Service (Drive.Files.insert) は v2 固有の記法で、
 * v3 移行で動かなくなります。ここでは意図的にバージョン非依存の
 * DriveApp を使っています。差は数百 ms で、当日壊れるリスクに見合いません。
 *
 * @param {string} base64Data data URL でも生の Base64 でも受け付けます
 * @param {string} userName
 * @param {{clientId?: string, capturedAt?: number, attempt?: number}=} meta
 */
function handleUpload(base64Data, userName, meta) {
  try {
    if (!base64Data || typeof base64Data !== 'string') throw new Error('画像データが空です。');

    const options = meta || {};
    const clientId = normalizeClientId(options.clientId);
    const capturedAt = normalizeCapturedAt(options.capturedAt);
    const attempt = parseInt(options.attempt, 10) || 0;

    /* --- 二重登録の防止 ---------------------------------------------------
       アップロードが 45 秒でタイムアウトしても、サーバー側は保存を完了して
       いることがあります。クライアントは失敗と判断して再送するため、同じ写真が
       2 枚並びます。会場の細い回線ではかなりの確率で起きます。
       clientId は同じ写真なら再送でも同じ値なので、これで突き合わせます。 */
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

    let mimeType = 'image/jpeg';
    let rawBase64 = base64Data;

    const matches = base64Data.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (matches) {
      mimeType = matches[1];
      rawBase64 = matches[2];
    } else if (!/^[A-Za-z0-9+/=\s]+$/.test(base64Data)) {
      throw new Error('画像の形式が不正です。');
    }

    // デコード前におおよそのサイズで弾く（Base64 は元データの約 4/3）
    const approxBytes = rawBase64.length * 0.75;
    if (approxBytes > CONFIG.MAX_UPLOAD_BYTES) {
      throw new Error('画像のサイズが上限を超えています。');
    }

    const bytes = Utilities.base64Decode(rawBase64);
    const blob = Utilities.newBlob(bytes, mimeType);

    /* ファイル名は「撮影時刻」で作ります。圏外で撮って後から送っても、
       名前が撮影順に並びます（旧版は送信できた時刻で付けていました）。 */
    const stampSource = capturedAt ? new Date(capturedAt) : new Date();
    const timeStamp = Utilities.formatDate(stampSource, CONFIG.TZ, 'yyyyMMdd_HHmmss_SSS');
    const suffix = clientId ? clientId.slice(0, 6) : Math.random().toString(36).slice(2, 6);
    const fileName = 'wedding_' + timeStamp + '_' + suffix + '.jpg';

    const safeUserName = sanitizeUserName(userName);

    const folder = DriveApp.getFolderById(getTargetFolderId());
    const file = folder.createFile(blob.setName(fileName));
    file.setDescription(safeUserName);

    /* 撮影時刻を modifiedTime に焼き、clientId を appProperties に残します。
       一覧は modifiedTime 降順で並べるので、これで「撮った順」になります。
       setDescription も modifiedTime を動かすため、必ずこの順で最後に実行します。
       失敗しても保存自体は成功なので、例外は飲み込みます。 */
    stampDriveMetadata(file.getId(), capturedAt, clientId);

    if (clientId) rememberUpload(clientId, { id: file.getId(), name: fileName });

    bumpAlbumVersion(); // 一覧キャッシュを無効化して、撮った写真がすぐ見えるように

    return { success: true, data: { id: file.getId(), name: fileName } };
  } catch (error) {
    console.error('[upload]', error.stack || error.message);
    return { success: false, error: '写真を保存できませんでした。' };
  }
}
```

---

## ③ 新しいヘルパー群を追加（`sanitizeUserName` の直後／228 行目のあとに貼る）

```js
/** CacheService の上限は 6 時間。披露宴 1 日ぶんには十分です */
const UPLOAD_CACHE_SEC = 21600;

/**
 * clientId は英数字 8〜64 文字だけ許します。
 * Drive の検索クエリにそのまま埋めるため、記号は一切通しません。
 */
function normalizeClientId(value) {
  if (!value || typeof value !== 'string') return '';
  return /^[A-Za-z0-9]{8,64}$/.test(value) ? value : '';
}

/**
 * 撮影時刻。端末の時計が狂っている場合に備え、
 * 未来 1 日以上・過去 1 年以上は捨てて 0（＝サーバー時刻を使う）にします。
 */
function normalizeCapturedAt(value) {
  const ms = Number(value);
  if (!isFinite(ms) || ms <= 0) return 0;
  const now = Date.now();
  if (ms > now + 24 * 3600 * 1000) return 0;
  if (ms < now - 365 * 24 * 3600 * 1000) return 0;
  return Math.floor(ms);
}

function rememberUpload(clientId, info) {
  try {
    CacheService.getScriptCache().put(
      'up_' + clientId,
      JSON.stringify({ id: info.id, name: info.name }),
      UPLOAD_CACHE_SEC
    );
  } catch (error) {
    console.warn('[rememberUpload]', error.message);
  }
}

function recallUpload(clientId) {
  try {
    const raw = CacheService.getScriptCache().get('up_' + clientId);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
}

/**
 * modifiedTime（撮影時刻）と appProperties.cid（clientId）を書き込みます。
 * DriveApp では appProperties を扱えないため REST v3 を直接叩きます。
 */
function stampDriveMetadata(fileId, capturedAt, clientId) {
  const body = {};
  if (capturedAt) body.modifiedTime = new Date(capturedAt).toISOString();
  if (clientId) body.appProperties = { cid: clientId };
  if (!body.modifiedTime && !body.appProperties) return;

  try {
    const response = UrlFetchApp.fetch(
      'https://www.googleapis.com/drive/v3/files/' + fileId + '?supportsAllDrives=true&fields=id',
      {
        method: 'patch',
        contentType: 'application/json',
        payload: JSON.stringify(body),
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
        muteHttpExceptions: true
      }
    );
    const code = response.getResponseCode();
    if (code !== 200) {
      console.warn('[stampDriveMetadata] HTTP ' + code, response.getContentText().slice(0, 200));
    }
  } catch (error) {
    console.warn('[stampDriveMetadata]', error.message);
  }
}

/**
 * 再送時に、同じ clientId の写真がすでに保存されていないか確認します。
 * 前回の応答がタイムアウトしただけで、実際は保存できていた場合の受け皿です。
 */
function findUploadByClientId(clientId) {
  try {
    const q = "'" + getTargetFolderId() + "' in parents and trashed = false"
      + " and appProperties has { key='cid' and value='" + clientId + "' }";

    const params = [
      'q=' + encodeURIComponent(q),
      'pageSize=1',
      'fields=' + encodeURIComponent('files(id,name)'),
      'supportsAllDrives=true',
      'includeItemsFromAllDrives=true'
    ];

    const response = UrlFetchApp.fetch(
      'https://www.googleapis.com/drive/v3/files?' + params.join('&'),
      {
        method: 'get',
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
        muteHttpExceptions: true
      }
    );

    if (response.getResponseCode() !== 200) return null;
    const files = JSON.parse(response.getContentText()).files || [];
    return files.length > 0 ? { id: files[0].id, name: files[0].name } : null;
  } catch (error) {
    console.warn('[findUploadByClientId]', error.message);
    return null;
  }
}
```

---

## ④ `listImagesViaRestApi` の並び順とフィールド（286 行目・288 行目）

### 変更前

```js
    'orderBy=' + encodeURIComponent('createdTime desc'),
    'pageSize=' + pageSize,
    'fields=' + encodeURIComponent('nextPageToken,files(id,name,description,createdTime,size)'),
```

### 変更後

```js
    // 撮影時刻を焼いた modifiedTime で並べます。createdTime は「送信できた時刻」です
    'orderBy=' + encodeURIComponent('modifiedTime desc'),
    'pageSize=' + pageSize,
    'fields=' + encodeURIComponent('nextPageToken,files(id,name,description,createdTime,modifiedTime,size)'),
```

---

## ⑤ 撮影時刻をクライアントに返す（`toClientImage` 348〜357 行目 と `listImagesViaDriveApp` 331〜341 行目）

### `toClientImage`（348〜357 行目を置換）

```js
function toClientImage(file) {
  return {
    id: file.id,
    name: file.name,
    thumbnailUrl: thumbUrl(file.id, 400),
    highResUrl: thumbUrl(file.id, 1600),
    uploader: file.description || 'ゲスト',
    createdTime: new Date(file.createdTime).getTime(),
    // 撮影時刻。stampDriveMetadata が焼いた modifiedTime を使います
    capturedAt: new Date(file.modifiedTime || file.createdTime).getTime()
  };
}
```

### `listImagesViaDriveApp` の push とソート（331〜341 行目を置換）

```js
    images.push({
      id: file.getId(),
      name: file.getName(),
      thumbnailUrl: thumbUrl(file.getId(), 400),
      highResUrl: thumbUrl(file.getId(), 1600),
      uploader: file.getDescription() || 'ゲスト',
      createdTime: file.getDateCreated().getTime(),
      capturedAt: file.getLastUpdated().getTime()
    });
  }

  images.sort(function (a, b) { return b.capturedAt - a.capturedAt; });
```

---

## 反映後の確認

1. エディタから `verifySetup()` を実行し、ログに `★` が無いことを確認。
2. **デプロイを管理 → 鉛筆 → 新バージョン → デプロイ**（URL は変わりません）。
3. スマホで 2〜3 枚撮り、アルバムに撮影順で並ぶか確認。
4. 機内モードで 2 枚撮る → 機内モードを解除 → 自動で送信され、
   撮影時刻の位置に入るか確認（末尾ではなく撮った時刻の場所）。

## 既知の注意点

- **既存の写真**は `modifiedTime` ＝ アップロード時刻のままです。順序は従来どおりで、
  壊れはしません。本番前にテスト写真を消すなら、消してから始めるのが一番きれいです。
- Drive 上で写真を**リネーム・編集すると `modifiedTime` が変わり、一覧の先頭に飛びます**。
  閲覧だけなら影響ありません。
- `stampDriveMetadata` が失敗した写真は `appProperties` が付かないため、
  再送時の Drive 照合が効きません（6 時間以内ならキャッシュ側で拾えます）。
- 二重登録の判定は `CacheService`（6 時間）と `appProperties` の二段構えです。
  同じ写真を 6 時間以上あとに手動再送した場合のみ、まれに重複しえます。

## 意図的に入れていないもの

- **1 日あたりのアップロード上限 — 実装しない方針です（2026-08-01 決定）。**
  枚数は無制限です。ゲストが撮りたいだけ撮れることを優先します。
  なお Google 側のクォータ（GAS の 1 日あたり実行時間・UrlFetch 回数、Drive の容量）は
  こちらでは外せません。実質的な上限はそちらになります。

## 第2弾（適用済み・バージョン 38 / 2026-08-01）

受付期間と削除機能を追加しました。**こちらも適用済みです。**

追加した関数: `getUploadDeadline` / `isUploadOpen` / `uploadClosedMessage` /
`handleGetStatus` / `assertAdmin` / `handleDeletePhoto` / `generateAdminToken` /
`setUploadDeadline`

追加したアクション: `getStatus`（受付状況の問い合わせ）/ `deletePhoto`（管理者のみ）

新しいスクリプトプロパティ（すべて任意）

| 名前 | 用途 |
|---|---|
| `UPLOAD_DEADLINE` | 受付終了日時。未設定なら無期限。`setUploadDeadline()` から設定 |
| `UPLOAD_CLOSED_MESSAGE` | 受付終了時の案内文。未設定なら既定文 |
| `ADMIN_TOKEN` | 削除機能の鍵。`generateAdminToken()` で生成。未設定なら削除機能は無効 |

設計上の判断

- 受付判定が壊れた値だった場合は **「受付中」に倒します**。
  誤設定で受付が止まる方が、事故として重いためです。
- 削除は `setTrashed(true)`（ゴミ箱へ移動）です。完全削除はしません。
- 削除前に `getFileInTargetFolder()` を通すので、`ADMIN_TOKEN` が漏れても
  保存先フォルダの外にあるファイルは消せません。

## 未着手（別途ご相談ください）

- ゲストが自分の写真だけを消せる仕組み（誰の写真かを認証できないため保留）
