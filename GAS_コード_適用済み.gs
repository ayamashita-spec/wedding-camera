/**
 * @fileoverview Wedding Camera — バックエンド API (Google Apps Script)
 *
 * ■ 前提のデプロイ設定
 *   実行ユーザー          : 自分
 *   アクセスできるユーザー: 全員
 *
 * ■ 必須のスクリプトプロパティ（プロジェクトの設定 → スクリプト プロパティ）
 *   FOLDER_ID  : 写真の保存先 Drive フォルダ ID（必須）
 *   API_TOKEN  : フロントと共有する任意の文字列（任意・推奨）
 *   ALBUM_VER  : 自動管理。手で触らないこと
 *
 * ■ 重要：再デプロイの手順
 *   「新しいデプロイ」を作ると URL が変わり、配布済みの QR / HTML が全部死にます。
 *   必ず  デプロイを管理 → 対象デプロイの鉛筆アイコン → バージョン「新バージョン」→ デプロイ
 *   で同一 URL を維持してください。
 *
 * ■ appsscript.json に以下が含まれていることを確認してください
 *   "oauthScopes": [
 *     "https://www.googleapis.com/auth/drive",
 *     "https://www.googleapis.com/auth/script.external_request"
 *   ]
 */

'use strict';

const CONFIG = {
  /** アップロード 1 枚あたりの上限（デコード後バイト数） */
  MAX_UPLOAD_BYTES: 8 * 1024 * 1024,
  /* 動画 1 本あたりの上限。
     フロント（CONFIG.VIDEO_MAX_BYTES = 10MB）より少しだけ高くします。

     送信を止められるのはフロントだけです（サーバーは受け取ってからしか判定
     できないので、上限を低くしても通信量は減りません）。したがって
     「フロントを通ったものは必ずサーバーも通る」でなければならず、
     サーバー側はアプリを経由しない相手に対する最後の防波堤という位置づけです。

     同値（10MB ちょうど）にすると、256 行の approxBytes が Base64 長から
     3 の倍数へ切り上げる関係で、ちょうど 10485760 バイトの動画だけ
     フロントを通ってサーバーで弾かれます。2MB の余裕を持たせて避けます。 */
  MAX_UPLOAD_BYTES_VIDEO: 12 * 1024 * 1024,
  /** アルバム 1 ページの既定件数 / 上限 */
  ALBUM_PAGE_SIZE: 60,
  ALBUM_PAGE_SIZE_MAX: 100,
  /** アルバム一覧のキャッシュ秒数。ゲストの同時アクセスでクォータを焼かないための緩衝材 */
  ALBUM_CACHE_SEC: 20,
  /** 一括 Base64 取得の 1 リクエスト上限。GAS の 6 分制限とレスポンスサイズ対策 */
  BATCH_MAX: 5,
  /** 単一ファイルの Base64 化を許す上限。巨大ファイルでタイムアウトするのを防ぐ */
  MAX_READ_BYTES: 25 * 1024 * 1024,
  TZ: 'Asia/Tokyo'
};

/* ============================================================================
 * エントリポイント
 * ========================================================================== */

/**
 * GET は使いません。ブラウザで URL を直接開いた人に状況が伝わる文言を返します。
 */
function doGet() {
  return jsonResponse({
    success: false,
    error: 'この URL は API 専用です。アプリのページから開いてください。'
  });
}

/**
 * すべてのリクエストの入口。
 *
 * 注意: フロントは Content-Type を送りません（プリフライトを避けるため）。
 * そのため e.postData.type は text/plain になりますが、中身は JSON です。
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ success: false, error: 'リクエストが空です。' });
    }

    let payload;
    try {
      payload = JSON.parse(e.postData.contents);
    } catch (parseError) {
      return jsonResponse({ success: false, error: 'リクエストの形式が不正です。' });
    }

    assertToken(payload);

    switch (payload.action) {
      case 'getAlbum':
        return jsonResponse(handleGetAlbum(payload.pageToken, payload.pageSize));
      case 'upload':
        return jsonResponse(handleUpload(payload.base64Data, payload.userName, {
          clientId: payload.clientId,
          capturedAt: payload.capturedAt,
          attempt: payload.attempt
        }));
      case 'getBatchBase64':
        return jsonResponse(handleGetBatchBase64(payload.fileIds));
      case 'getSingleBase64':
        return jsonResponse(handleGetSingleBase64(payload.fileId));
      case 'getStatus':
        return jsonResponse(handleGetStatus());
      case 'ping':
        return jsonResponse({ success: true, data: 'ok' });
      default:
        return jsonResponse({ success: false, error: '不明なリクエストです。' });
    }
  } catch (error) {
    // 詳細はログだけに残す。クライアントに内部構造を渡さない
    console.error('[doPost]', error.stack || error.message);
    const isAuth = error.message === 'unauthorized';
    return jsonResponse({
      success: false,
      error: isAuth ? '利用が許可されていません。' : 'サーバー側で問題が発生しました。'
    });
  }
}

/* ============================================================================
 * 認可・設定
 * ========================================================================== */

/**
 * 共有トークンを検証します。
 *
 * トークンはフロントの JS に平文で載るため、本質的な認証ではありません。
 * 目的は「URL を拾った自動スキャンの流れ弾を弾く」ことだけです。
 * API_TOKEN 未設定なら検証をスキップします（後から有効化できます）。
 */
function assertToken(payload) {
  const expected = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  if (!expected) return;
  if (!payload || payload.token !== expected) throw new Error('unauthorized');
}

/**
 * 保存先フォルダ ID を取得します。
 */
function getTargetFolderId() {
  const folderId = PropertiesService.getScriptProperties().getProperty('FOLDER_ID');
  if (!folderId || !folderId.trim()) {
    throw new Error('スクリプトプロパティ FOLDER_ID が未設定です。');
  }
  return folderId.trim();
}

/* ============================================================================
 * ファイルアクセス（ここが最重要のセキュリティ境界）
 * ========================================================================== */

/**
 * 指定 ID のファイルを、保存先フォルダ直下にあることを確認したうえで返します。
 *
 * この検証がないと、この Web アプリはオーナーの Drive 全体を
 * 誰でも読み出せる公開プロキシになります（fileId は任意に指定できるため）。
 * 絶対に外さないこと。
 *
 * @param {string} fileId
 * @return {DriveApp.File}
 */
function getFileInTargetFolder(fileId) {
  if (!fileId || typeof fileId !== 'string' || !/^[A-Za-z0-9_-]{10,}$/.test(fileId)) {
    throw new Error('invalid_file_id');
  }

  const folderId = getTargetFolderId();
  const file = DriveApp.getFileById(fileId);

  /* ゴミ箱に入れた写真は読み出しでも拒否します。
     一覧側のクエリは trashed = false で除外していますが、ここは親フォルダと MIME
     しか見ていませんでした。ゴミ箱のファイルも getParents() は元の親を返すため、
     新郎新婦が消したつもりの写真が getSingleBase64 でまだ取得できていました。 */
  if (file.isTrashed()) throw new Error('out_of_scope');

  const parents = file.getParents();
  while (parents.hasNext()) {
    if (parents.next().getId() === folderId) {
      const mime = file.getMimeType() || '';
      if (mime.indexOf('image/') !== 0 && mime.indexOf('video/') !== 0) {
        throw new Error('not_a_media_file');
      }
      return file;
    }
  }
  throw new Error('out_of_scope');
}

/* ============================================================================
 * アップロード
 * ========================================================================== */

/**
 * 画像を 1 枚保存します。
 *
 * Advanced Drive Service (Drive.Files.insert) は v2 固有の記法で、
 * v3 移行で動かなくなります。ここでは意図的にバージョン非依存の
 * DriveApp を使っています。差は数百 ms で、当日壊れるリスクに見合いません。
 *
 * @param {string} base64Data data URL でも生の Base64 でも受け付けます
 * @param {string} userName
 */
function handleUpload(base64Data, userName, meta) {
  try {
    if (!base64Data || typeof base64Data !== 'string') throw new Error('画像データが空です。');

    const options = meta || {};
    const clientId = normalizeClientId(options.clientId);
    const capturedAt = normalizeCapturedAt(options.capturedAt);
    const attempt = parseInt(options.attempt, 10) || 0;

    /* 式後のアップロード停止。スクリプトプロパティ UPLOAD_DEADLINE に
       日時を入れると、それ以降は受け付けません（未設定なら無期限）。
       設定は setUploadDeadline() から行ってください。 */
    if (!isUploadOpen()) {
      return { success: false, error: uploadClosedMessage(), closed: true };
    }

    /* --- 二重登録の防止 ---------------------------------------------------
       アップロードが 45 秒でタイムアウトしても、サーバー側は保存を完了して
       いることがあります。クライアントは失敗と判断して再送するため、同じ写真が
       2 枚並びます。clientId は再送でも同じ値なので、これで突き合わせます。 */
    if (clientId) {
      const known = recallUpload(clientId);
      if (known) {
        return { success: true, data: { id: known.id, name: known.name, duplicate: true } };
      }

      /* Drive の照合を attempt でゲートしてはいけません。
         attempt はクライアントの item.sendAttempts ですが、これを +1 して
         IndexedDB に書き戻すのは catch の中だけです。送信中にページが
         リロード・破棄されると catch は走らないので attempt は 0 のまま残ります。
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

    let mimeType = 'image/jpeg';
    let rawBase64 = base64Data;

    /* MIME にパラメータが付く場合があります（MediaRecorder は必ず
       video/mp4;codecs=avc1... の形で返します）。type と ;base64, の間の
       パラメータを読み飛ばさないと、録画した動画が全て弾かれます。
       捕捉するのは種類だけなので、Drive には素の MIME が渡ります。 */
    const matches = base64Data.match(
      /^data:((?:image|video)\/[a-zA-Z0-9.+-]+)(?:;[^;]+)*;base64,([\s\S]+)$/);
    if (matches) {
      mimeType = matches[1];
      rawBase64 = matches[2];
    } else if (!/^[A-Za-z0-9+/=\s]+$/.test(base64Data)) {
      throw new Error('画像の形式が不正です。');
    }

    // デコード前におおよそのサイズで弾く（Base64 は元データの約 4/3）
    const approxBytes = rawBase64.length * 0.75;
    const isVideo = mimeType.indexOf('video/') === 0;
    const sizeLimit = isVideo ? CONFIG.MAX_UPLOAD_BYTES_VIDEO : CONFIG.MAX_UPLOAD_BYTES;
    if (approxBytes > sizeLimit) {
      // 上限を文言に入れます。この文言は permanent と判定され、再送されません
      throw new Error(isVideo
        ? '動画が大きすぎます（上限 ' + Math.round(sizeLimit / 1048576) + 'MB）。'
        : '画像のサイズが上限を超えています。');
    }

    /* MIME を許可リストにし、デコード後の先頭バイトで実体を確かめます。
       旧版はサブタイプを [a-zA-Z0-9.+-]+ で何でも通し、中身を検査していなかったため、
       任意のバイナリが .jpg として保存され、getSingleBase64 でそのまま取り出せました
       （削除 API が無いので、実質「消せない汎用ストレージ」になっていました）。
       フロントは撮影分を JPEG に再エンコードし、動画も MediaRecorder / ピッカー由来
       なので、これで実ゲストが弾かれることはありません。 */
    const ALLOWED_MIME = {
      'image/jpeg': [[0xFF, 0xD8, 0xFF]],
      'image/png':  [[0x89, 0x50, 0x4E, 0x47]],
      'image/webp': [[0x52, 0x49, 0x46, 0x46]],
      // heic / mp4 系は ftyp ボックスなので先頭数バイトでは判定できません。型名だけ絞ります
      'image/heic': null,
      'image/heif': null,
      /* 動画は「端末から選ぶ」経路で file.type がそのまま届きます。iPhone は
         video/quicktime、Android は video/mp4 が大半ですが、「ファイル」アプリや
         PC 由来の .m4v / .3gp / .avi / .mkv も実在します。ここを 3 種だけに絞ると、
         以前は保存できていた動画が拒否されるうえ、permanent 判定で再送もされません。 */
      'video/mp4': null,
      'video/quicktime': null,
      'video/webm': null,
      'video/3gpp': null,
      'video/3gpp2': null,
      'video/x-m4v': null,
      'video/x-msvideo': null,
      'video/x-matroska': null,
      'video/mpeg': null
    };

    const baseMime = mimeType.split(';')[0].trim().toLowerCase();
    if (!(baseMime in ALLOWED_MIME)) {
      // 動画に「画像の形式が不正です」と出すと、ゲストは何を直せばいいか分かりません
      throw new Error(baseMime.indexOf('video/') === 0
        ? '動画の形式に対応していません。'
        : '画像の形式が不正です。');
    }

    const bytes = Utilities.base64Decode(rawBase64);

    const signatures = ALLOWED_MIME[baseMime];
    if (signatures && !signatures.some(function (sig) {
          return sig.every(function (b, i) { return (bytes[i] & 0xFF) === b; });
        })) {
      throw new Error('画像の形式が不正です。');
    }

    // パラメータ付き（video/mp4;codecs=...）を Drive に渡さないよう素の MIME にします
    const blob = Utilities.newBlob(bytes, baseMime);

    // 撮影時刻で名前を作ります。送信が遅れても名前が撮影順に並びます
    const stampSource = capturedAt ? new Date(capturedAt) : new Date();
    const timeStamp = Utilities.formatDate(stampSource, CONFIG.TZ, 'yyyyMMdd_HHmmss_SSS');
    const suffix = clientId ? clientId.slice(0, 6) : Math.random().toString(36).slice(2, 6);
    const fileName = 'wedding_' + timeStamp + '_' + suffix + extensionFor(mimeType);

    const safeUserName = sanitizeUserName(userName);

    const folder = DriveApp.getFolderById(getTargetFolderId());
    const file = folder.createFile(blob.setName(fileName));
    file.setDescription(safeUserName);

    /* 撮影時刻を modifiedTime に、clientId を appProperties に残します。
       一覧は modifiedTime 降順で並べるため、これで撮った順になります。
       setDescription も modifiedTime を動かすので、必ず最後に実行します。 */
    /* 目印は「ファイルを作った直後」に置きます。
       stampDriveMetadata は REST 呼び出しで数百 ms かかるため、その後に
       登録していると、その隙に届いた再送が重複を作ります（実際に発生）。 */
    if (clientId) rememberUpload(clientId, { id: file.getId(), name: fileName });

    stampDriveMetadata(file.getId(), capturedAt, clientId);

    bumpAlbumVersion(); // 一覧キャッシュを無効化して、撮った写真がすぐ見えるように

    return { success: true, data: { id: file.getId(), name: fileName } };
  } catch (error) {
    console.error('[upload]', error.stack || error.message);

    /* 何度送っても直らないエラーは、そう伝えます。
       旧版は全部「写真を保存できませんでした。」に潰していたため、クライアントは
       リトライ可否を判断できず、MAX_RETRY まで 5 回送っていました。
       フロント側は json.permanent を見て、その 1 枚だけ即座に打ち切ります。

       ここで permanent にするのは「そのデータが原因で、何度送っても通らないもの」
       だけです。FOLDER_ID の誤りや Drive の容量切れ、PropertiesService の
       レート制限は**意図的に含めていません**。それらを恒久扱いにすると、
       幹事が式中に設定を直しても、撮り溜めた写真が二度と送れなくなります。
       設定ミスはデプロイ前に verifySetup() で潰してください。 */
    const permanent = /サイズが上限|形式が不正|形式に対応していません|画像データが空|大きすぎます/
      .test(error.message);
    return {
      success: false,
      error: permanent ? error.message : '写真を保存できませんでした。',
      permanent: permanent
    };
  }
}

/**
 * 投稿者名を無害化します。長さを切り、改行と制御文字を落とします。
 */
function sanitizeUserName(userName) {
  if (!userName || typeof userName !== 'string') return 'ゲスト';
  const cleaned = userName.replace(/[\r\n\t\u0000-\u001F\u007F]/g, ' ').trim();
  if (!cleaned) return 'ゲスト';
  return cleaned.length > 30 ? cleaned.slice(0, 30) : cleaned;
}

/* ============================================================================
 * アルバム一覧
 * ========================================================================== */

/**
 * 撮影日時の新しい順にページングして返します。
 *
 * 旧実装は folder.getFiles() を 100 件で打ち切ってから並べ替えていました。
 * イテレーションの順序は保証されないため、101 枚目以降がある状況では
 * 「さっき撮った写真が出てこない」という現象が起きます。
 * サーバー側で並べ替えたうえでページングするのが正解です。
 */
function handleGetAlbum(pageToken, pageSize) {
  try {
    const size = Math.min(
      Math.max(parseInt(pageSize, 10) || CONFIG.ALBUM_PAGE_SIZE, 1),
      CONFIG.ALBUM_PAGE_SIZE_MAX
    );

    /* CacheService のキーは 250 文字までです。Drive の pageToken は 400 文字を
       超えることがあり、そのまま繋ぐと get() が例外を投げます。以前はそれが
       外側の catch に落ちて DriveApp のフォールバック（全件・ページングなし）へ
       切り替わり、2 ページ目に 1 ページ目と同じ写真が丸ごと混ざっていました。
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
       返してクライアントに読み直させるほうが、全体としては速く復旧します。

       旧版は pageSize も pageToken も無視して 500 件走査したうえ、結果を
       キャッシュしていなかった（cache.put が try の中、ここは catch の中）ため、
       ピーク時に Drive が 1 回 429 を返すと、以後どのゲストの再読み込みも
       500 件走査になって自己増幅していました。 */
    if (pageToken) {
      return { success: false, error: 'アルバムを読み込めませんでした。' };
    }

    // 直前に誰かが同じフォールバックを踏んでいれば、その結果を使い回します
    try {
      const hit = CacheService.getScriptCache().get(fallbackCacheKey());
      if (hit) return JSON.parse(hit);
    } catch (cacheError) { /* 読めなければ普通に走査します */ }

    try {
      /* 走査件数は pageSize に連動させません。フロントは 1 ページ 30 件で要求して
         きますが、DriveApp のイテレータ順は保証されないため、30 件だけ取ると
         「任意の 30 枚」になり、さっき撮った写真が入っている保証がありません。
         ページングもできない経路なので、多めに取って新しい順に並べます
         （旧版の 500 件よりは軽く、同時実行スロットを長く握らない範囲）。 */
      const fallback = listImagesViaDriveApp(getTargetFolderId(), 200);

      /* フォールバックの結果は「専用のキー」に置きます。正常系と同じキーに書くと、
         1 回きりの REST 失敗で作った劣化レスポンスが、REST が復活したあとも
         ALBUM_CACHE_SEC のあいだ全ゲストに配られてしまいます。
         キーを分ければ、再利用するのは同じくフォールバックに落ちた要求だけです。 */
      try {
        CacheService.getScriptCache().put(
          fallbackCacheKey(), JSON.stringify(fallback), CONFIG.ALBUM_CACHE_SEC
        );
      } catch (cacheError) { /* 100KB 超は入りません。無視して構いません */ }

      return fallback;
    } catch (fallbackError) {
      console.error('[getAlbum:fallback]', fallbackError.message);
      return { success: false, error: 'アルバムを読み込めませんでした。' };
    }
  }
}

/**
 * フォールバック結果専用のキャッシュキー。
 * 正常系（album_v…）とは必ず別にします。同じキーに書くと、劣化レスポンスが
 * 復活後も全ゲストに配られてしまうためです。
 */
function fallbackCacheKey() {
  let ver = '0';
  try { ver = getAlbumVersion(); } catch (error) { /* 既定の 0 で続行 */ }
  return 'albumfb_v' + ver;
}

/**
 * Drive REST v3 を UrlFetchApp で直接叩きます。
 * Advanced Drive Service の v2/v3 差異に巻き込まれないための選択です。
 */
function listImagesViaRestApi(folderId, pageSize, pageToken) {
  const q = "'" + folderId + "' in parents and trashed = false"
    + " and (mimeType contains 'image/' or mimeType contains 'video/')";

  const params = [
    'q=' + encodeURIComponent(q),
    'orderBy=' + encodeURIComponent('modifiedTime desc'),
    'pageSize=' + pageSize,
    'fields=' + encodeURIComponent('nextPageToken,files(id,name,description,createdTime,modifiedTime,size,mimeType)'),
    'supportsAllDrives=true',
    'includeItemsFromAllDrives=true'
  ];
  if (pageToken) params.push('pageToken=' + encodeURIComponent(pageToken));

  const response = UrlFetchApp.fetch(
    'https://www.googleapis.com/drive/v3/files?' + params.join('&'),
    {
      method: 'get',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    }
  );

  const code = response.getResponseCode();
  if (code !== 200) {
    throw new Error('Drive API ' + code + ': ' + response.getContentText().slice(0, 300));
  }

  const body = JSON.parse(response.getContentText());
  const files = body.files || [];

  return {
    success: true,
    data: files.map(toClientImage),
    nextPageToken: body.nextPageToken || null
  };
}

/**
 * REST が使えない環境向けのフォールバック。
 * 全件スキャンは重いので、渡された件数で打ち切ります。
 *
 * @param {string} folderId
 * @param {number} [limit] 取得件数の上限（既定は 1 ページぶん、最大 200）
 */
function listImagesViaDriveApp(folderId, limit) {
  const iterator = DriveApp.getFolderById(folderId).getFiles();
  const images = [];
  const HARD_LIMIT = Math.min(
    Math.max(parseInt(limit, 10) || CONFIG.ALBUM_PAGE_SIZE, 1),
    200
  );

  while (iterator.hasNext() && images.length < HARD_LIMIT) {
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

  /* truncated / degraded は「一部だけ返している」という申告です。
     フロント側はこれを見て「いま一部の写真だけを表示しています」と案内し、
     枚数表示に「以上」を付けます。 */
  return {
    success: true,
    data: images,
    nextPageToken: null,
    truncated: iterator.hasNext(),
    degraded: true
  };
}

/**
 * REST のレスポンスをクライアント向けの形に整えます。
 */
function toClientImage(file) {
  const mime = file.mimeType || '';
  return {
    id: file.id,
    name: file.name,
    mimeType: mime,
    isVideo: mime.indexOf('video/') === 0,
    thumbnailUrl: thumbUrl(file.id, 400),
    highResUrl: thumbUrl(file.id, 1600),
    uploader: file.description || 'ゲスト',
    createdTime: new Date(file.createdTime).getTime(),
    // 撮影時刻。stampDriveMetadata が焼いた modifiedTime を使います
    capturedAt: new Date(file.modifiedTime || file.createdTime).getTime()
  };
}

/**
 * サムネイル URL。
 *
 * 注意: この URL が表示されるには、保存先フォルダが
 * 「リンクを知っている全員 / 閲覧者」で共有されている必要があります。
 * 共有していない場合、グリッドが全部グレーのプレースホルダになります。
 */
function thumbUrl(fileId, width) {
  return 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w' + width;
}

/**
 * アップロードのたびに一覧キャッシュの世代を進めます。
 */
function getAlbumVersion() {
  return PropertiesService.getScriptProperties().getProperty('ALBUM_VER') || '0';
}

function bumpAlbumVersion() {
  try {
    const props = PropertiesService.getScriptProperties();
    const next = (parseInt(props.getProperty('ALBUM_VER'), 10) || 0) + 1;
    props.setProperty('ALBUM_VER', String(next));
  } catch (error) {
    console.warn('[bumpAlbumVersion]', error.message);
  }
}

/* ============================================================================
 * ダウンロード用 Base64
 * ========================================================================== */

/**
 * 複数枚をまとめて Base64 で返します。
 *
 * 旧実装は個々の失敗を catch(e){} で捨てたうえで success:true を返しており、
 * クライアントは欠損に気づけませんでした。失敗した ID を明示して返します。
 */
function handleGetBatchBase64(fileIds) {
  try {
    if (!Array.isArray(fileIds) || fileIds.length === 0) {
      return { success: false, error: '対象が指定されていません。' };
    }
    if (fileIds.length > CONFIG.BATCH_MAX) {
      return { success: false, error: '一度に取得できるのは ' + CONFIG.BATCH_MAX + ' 枚までです。' };
    }

    const data = {};
    const errors = [];

    fileIds.forEach(function (id) {
      try {
        data[id] = readAsBase64(id);
      } catch (error) {
        console.warn('[getBatchBase64] skipped', id, error.message);
        errors.push(id);
      }
    });

    return { success: true, data: data, errors: errors };
  } catch (error) {
    console.error('[getBatchBase64]', error.stack || error.message);
    return { success: false, error: '画像を取得できませんでした。' };
  }
}

/**
 * 1 枚を Base64 で返します。
 */
function handleGetSingleBase64(fileId) {
  try {
    return { success: true, data: readAsBase64(fileId) };
  } catch (error) {
    console.error('[getSingleBase64]', error.stack || error.message);
    return { success: false, error: '画像を取得できませんでした。' };
  }
}

/**
 * フォルダ所属を検証したうえで Base64 化します。
 */
function readAsBase64(fileId) {
  const file = getFileInTargetFolder(fileId);
  if (file.getSize() > CONFIG.MAX_READ_BYTES) throw new Error('too_large');
  return Utilities.base64Encode(file.getBlob().getBytes());
}

/* ============================================================================
 * ユーティリティ
 * ========================================================================== */

function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ============================================================================
 * セットアップ支援（エディタから手動で実行してください）
 * ========================================================================== */

/**
 * 設定が正しいかを一度で確認します。
 * デプロイ前にエディタから実行し、ログを確認してください。
 */
function verifySetup() {
  const props = PropertiesService.getScriptProperties();
  const folderId = props.getProperty('FOLDER_ID');
  const token = props.getProperty('API_TOKEN');

  console.log('===== 設定の確認 =====');
  console.log('FOLDER_ID  :', folderId || '★未設定★');
  console.log('API_TOKEN  :', token ? '設定済み' : '未設定（推奨: 設定する）');

  if (!folderId) {
    console.log('→ FOLDER_ID を設定してから再実行してください。');
    return;
  }

  let folder;
  try {
    folder = DriveApp.getFolderById(folderId.trim());
    console.log('フォルダ名 :', folder.getName());
  } catch (error) {
    console.log('★フォルダを開けません:', error.message);
    console.log('→ FOLDER_ID が間違っているか、このアカウントに権限がありません。');
    return;
  }

  /* --- 共有設定 ---------------------------------------------------------
     getSharingAccess() は、共有ドライブ配下や Workspace の
     「対象ユーザー」ポリシー下では
       Exception: The file or folder has invalid access settings.
     を投げます。旧来の Access / Permission の enum で表現できない
     共有状態があるためで、フォルダが壊れているわけではありません。
     判定できなくても止めず、下の実測チェックで結論を出します。 */
  try {
    const access = folder.getSharingAccess();
    console.log('共有設定   :', access, '/', folder.getSharingPermission());
    if (access === DriveApp.Access.PRIVATE) {
      console.log('  ⚠ 非公開です。アルバムのサムネイルが表示されません。');
      console.log('    「リンクを知っている全員 / 閲覧者」に変更してください。');
    }
  } catch (error) {
    console.log('共有設定   : この API では判定できませんでした（問題ではありません）');
    console.log('             共有ドライブ配下、または組織の共有ポリシー下でよく起きます。');
    console.log('             実際に公開されているかは下の「サムネイル」で判定します。');
  }

  /* --- 一覧取得 --------------------------------------------------------- */
  console.log('===== 動作の確認 =====');
  const album = handleGetAlbum(null, 5);
  if (album.success) {
    console.log('一覧取得   : 成功（' + album.data.length + ' 件）');
  } else {
    console.log('一覧取得   : ★失敗:', album.error);
    console.log('             appsscript.json の oauthScopes を確認してください。');
  }

  /* --- 匿名でサムネイルが読めるか（ここが本当に効く確認） ---------------- */
  if (album.success && album.data.length > 0) {
    const probe = probePublicThumbnail(album.data[0].id);
    if (probe.ok) {
      console.log('サムネイル : 公開OK（ゲストの端末から表示できます）');
    } else {
      console.log('サムネイル : ★公開されていません（HTTP ' + probe.code + ' / ' + probe.type + '）');
      console.log('             Drive でフォルダを右クリック → 共有 →');
      console.log('             「リンクを知っている全員」／「閲覧者」に変更してください。');
      console.log('             ※ 追加直後の写真はサムネイル生成待ちで失敗することがあります。');
    }
  } else if (album.success) {
    console.log('サムネイル : 写真が 0 枚のため未検証。');
  }

  /* --- 書き込みの往復テスト -------------------------------------------- */
  const write = testWriteRoundTrip();
  console.log('書き込み   :', write.message);

  console.log('===== 完了 =====');
  console.log('★ の付いた行がなければ設定は完了です。デプロイに進んでください。');
}

/**
 * サムネイル URL を「認証なし」で取得し、ゲストの端末から見えるかを実測します。
 * UrlFetchApp は Authorization ヘッダーを付けないため、匿名アクセスと同じ条件になります。
 */
function probePublicThumbnail(fileId) {
  try {
    const response = UrlFetchApp.fetch(thumbUrl(fileId, 200), {
      muteHttpExceptions: true,
      followRedirects: true
    });
    const code = response.getResponseCode();
    const headers = response.getAllHeaders();
    const type = String(headers['Content-Type'] || headers['content-type'] || '');
    return { ok: code === 200 && type.indexOf('image') === 0, code: code, type: type || '不明' };
  } catch (error) {
    return { ok: false, code: 0, type: error.message };
  }
}

/**
 * 書き込みテスト専用の 1×1 PNG。
 * 1 行に収めているのは、行分割で 1 文字でも欠けると壊れるためです。
 */
const TEST_IMAGE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP49eMrAAXXAuhZo/fVAAAAAElFTkSuQmCC';

/**
 * 実際に 1 枚アップロードして取得できるかを確認し、最後にゴミ箱へ入れます。
 * あわせて「保存先フォルダの外にある画像は拒否されるか」も実測します。
 * 権限やフォルダ指定の間違いを、当日ではなく今のうちに露出させるためのテストです。
 */
function testWriteRoundTrip() {
  let insideId = null;
  let outsideFile = null;

  try {
    /* --- 1. 保存先フォルダに書けるか / 読めるか --- */
    const uploaded = handleUpload(TEST_IMAGE_DATA_URL, '__setup_test__');
    if (!uploaded.success) return { ok: false, message: '★失敗（書き込み）: ' + uploaded.error };

    insideId = uploaded.data.id;

    const read = handleGetSingleBase64(insideId);
    if (!read.success) return { ok: false, message: '★失敗（読み出し）: ' + read.error };

    /* --- 2. フォルダ外の画像がきちんと拒否されるか ---
       これが通ってしまうと、この Web アプリはオーナーの Drive 全体を
       誰でも読み出せる公開プロキシになります。
       mime チェックではなく親フォルダチェックで弾かれることを確かめるため、
       あえて正しい画像ファイルを使います。 */
    const bytes = Utilities.base64Decode(TEST_IMAGE_DATA_URL.split(',')[1]);
    outsideFile = DriveApp.getRootFolder()
      .createFile(Utilities.newBlob(bytes, 'image/png', '__setup_test_outside__.png'));

    const outsider = handleGetSingleBase64(outsideFile.getId());

    if (outsider.success) {
      return {
        ok: false,
        message: '★★ 重大: フォルダ外の画像が読み出せました。getFileInTargetFolder が効いていません。'
      };
    }

    return { ok: true, message: '成功（書き込み・読み出しOK / フォルダ外の拒否もOK）' };
  } catch (error) {
    return { ok: false, message: '★失敗: ' + error.message };
  } finally {
    // テスト用ファイルは必ず片付けます
    if (insideId) {
      try {
        DriveApp.getFileById(insideId).setTrashed(true);
        bumpAlbumVersion();
      } catch (error) {
        console.log('  （テスト用ファイルを削除できませんでした。Drive のゴミ箱を確認してください）');
      }
    }
    if (outsideFile) {
      try {
        outsideFile.setTrashed(true);
      } catch (error) {
        console.log('  （マイドライブ直下の __setup_test_outside__.png を手動で削除してください）');
      }
    }
  }
}

/**
 * API_TOKEN をランダム生成して設定します。
 * 実行後、ログに出た値をフロントの CONFIG.API_TOKEN に貼ってください。
 */
function generateApiToken() {
  const token = Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('API_TOKEN', token);
  console.log('API_TOKEN を設定しました。フロントに貼る値:');
  console.log(token);
}

/* ==========================================================================
 * 撮影時刻・二重登録防止のためのヘルパー
 * ======================================================================== */

/** CacheService の上限は 6 時間。披露宴 1 日ぶんには十分です */
const UPLOAD_CACHE_SEC = 21600;

/** clientId は英数字 8〜64 文字だけ許します（Drive のクエリに直接埋めるため） */
function normalizeClientId(value) {
  if (!value || typeof value !== 'string') return '';
  return /^[A-Za-z0-9]{8,64}$/.test(value) ? value : '';
}

/** 端末の時計が狂っている場合に備え、未来 1 日超・過去 1 年超は捨てます */
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
 * modifiedTime（撮影時刻）と appProperties.cid を書き込みます。
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

/** 再送時に、同じ clientId の写真がすでに保存されていないか確認します */
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

/* \u003d\u003d\u003d 受付期間・管理者操作 \u003d\u003d\u003d */

const UPLOAD_CLOSED_DEFAULT = '写真の受付は終了しました。たくさんの思い出をありがとうございました。';

/**
 * 受付期限の文字列を正規化します。
 *
 * ECMAScript の仕様では '2026-09-05' のような日付のみの形式は **UTC** として
 * 解釈されます（日時形式ならローカル）。JST では 2026-09-05 09:00 になり、
 * 挙式当日の朝 9 時に受付が閉まります。しかも isFinite は true なので
 * 「読めない値は無期限に倒す」保護も効きません。その日の終わりに補完します。
 */
function normalizeDeadlineText(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text + 'T23:59:59+09:00' : text;
}

/** UPLOAD_DEADLINE を読みます。壊れた値なら null（＝無期限）に倒します */
function getUploadDeadline() {
  const raw = PropertiesService.getScriptProperties().getProperty('UPLOAD_DEADLINE');
  if (!raw || !raw.trim()) return null;
  // プロパティを直接編集された場合も救えるよう、読み取り側でも補完します
  const t = new Date(normalizeDeadlineText(raw)).getTime();
  /* 読めない値で受付を止めてしまう方が事故として重いので、
     判定できないときは「開いている」に倒します。 */
  return isFinite(t) ? t : null;
}

function isUploadOpen() {
  const deadline = getUploadDeadline();
  return deadline === null || Date.now() <= deadline;
}

function uploadClosedMessage() {
  const raw = PropertiesService.getScriptProperties().getProperty('UPLOAD_CLOSED_MESSAGE');
  return (raw && raw.trim()) ? raw.trim() : UPLOAD_CLOSED_DEFAULT;
}

/** フロントが起動時に受付状況を知るための軽い問い合わせ */
function handleGetStatus() {
  try {
    const open = isUploadOpen();
    return { success: true, data: { uploadOpen: open, closedMessage: open ? '' : uploadClosedMessage() } };
  } catch (error) {
    console.error('[getStatus]', error.stack || error.message);
    return { success: true, data: { uploadOpen: true, closedMessage: '' } };
  }
}




/**
 * 写真の受付を締め切る日時を設定します。
 *   setUploadDeadline('2026-09-05T23:59:59+09:00')  期限を設定
 *   setUploadDeadline('')                            解除（無期限）
 */
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

/** MIME から保存時の拡張子を決めます。Drive 上で種類が一目で分かるように */
function extensionFor(mimeType) {
  const map = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
    'image/heic': '.heic', 'image/heif': '.heif',
    'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm'
  };
  const base = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (map[base]) return map[base];
  return base.indexOf('video/') === 0 ? '.mp4' : '.jpg';
}

/**
 * 長い pageToken を、キャッシュキーに使える短い文字列へ畳みます。
 * CacheService のキー上限 250 文字を超えさせないための措置です。
 */
function shortHash(value) {
  if (!value) return 'first';
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(value));
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += ('0' + (bytes[i] & 0xFF).toString(16)).slice(-2);
  }
  return out;
}
