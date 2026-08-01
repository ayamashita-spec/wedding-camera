# Wedding Camera

結婚式のゲスト全員で撮る、デジタル使い捨てカメラ。
スマホのブラウザで開くだけで撮影でき、写真は共有アルバム（Google Drive）に集まります。

- フロント: 静的な PWA（`index.html` 1 枚 + Service Worker）。ビルド不要
- バックエンド: Google Apps Script（`/exec` の Web アプリ）
- 保存先: Google Drive のフォルダ

---

## 構成

| ファイル | 役割 |
|---|---|
| `index.html` | アプリ本体（HTML / CSS / JS すべて） |
| `sw.js` | Service Worker。回線が切れてもリロードで真っ白にならないように |
| `manifest.json` | ホーム画面に追加したときの見た目 |
| `config.js` | **コミットされません。** GAS の URL・トークン・Drive フォルダ |
| `config.sample.js` | `config.js` のひな形 |
| `GAS_変更点.md` | バックエンド（コード.gs）に当てるパッチ |

---

## ローカルで動かす

`file://` でも起動はしますが、**カメラと Service Worker は https か localhost でないと動きません。**
必ずローカルサーバー経由で開いてください。

```bash
cp config.sample.js config.js   # 値を埋める（Windows は copy）
npx serve .                     # または python -m http.server 8000
```

`http://localhost:3000`（serve の場合）を開きます。

---

## GitHub Pages への配信

### 初回だけ必要な設定

1. **Pages のソースを Actions にする**
   Settings → Pages → Build and deployment → Source を **GitHub Actions** に変更

2. **Secrets を 3 つ登録する**
   Settings → Secrets and variables → Actions → New repository secret

   | 名前 | 中身 |
   |---|---|
   | `WEDCAM_API_URL` | GAS の `/exec` URL |
   | `WEDCAM_API_TOKEN` | GAS の `generateApiToken()` が出した値 |
   | `WEDCAM_DRIVE_FOLDER_URL` | 共有アルバムの Drive フォルダ URL（任意） |

### 以降

`main` に push すれば自動で配信されます。
公開先は `https://<ユーザー名>.github.io/wedding-camera/` です。

> **リポジトリ名を変えると URL が変わり、配布済みの QR コードが全部死にます。**
> QR を作る前に名前を確定させてください。

---

## トークンの扱いについて

`API_TOKEN` は最終的にゲストのブラウザへ配られるため、**本質的な秘密にはできません。**
目的は「URL を拾った自動スキャンの流れ弾を弾く」ことだけです。

このリポジトリは公開ですが、`config.js` を `.gitignore` して Actions で生成することで、
**リポジトリのソースにも git 履歴にもトークンが残らない**ようにしています。
GitHub のコード検索やスキャン bot に拾われないための措置です。

実際の防御はサーバー側で行ってください。

- 保存先フォルダ所属チェック（`getFileInTargetFolder`。実装済み）
- 挙式日を過ぎたらアップロードを閉じるフラグ（未実装）

**1 日あたりのアップロード枚数に上限は設けていません**（方針として無制限）。
実質的な上限は Google 側のクォータ（GAS の 1 日あたり実行時間・UrlFetch 回数、
Drive の空き容量）で、これらはアプリ側からは変更できません。

トークンを変えるときは **GAS のスクリプトプロパティと GitHub Secrets の両方**を更新してください。

---

## バックエンド（GAS）

`GAS_変更点.md` のパッチを当ててください。撮影時刻順の並びと二重登録の防止は、
フロントとバックエンドが揃って初めて効きます（フロントだけ先に出しても壊れません）。

反映後は必ず **デプロイを管理 → 鉛筆アイコン → バージョン「新バージョン」→ デプロイ**。
「新しいデプロイ」を作ると URL が変わり、配布済みの QR が全部死にます。

---

## 新郎新婦向けの操作

### 写真を削除する（管理モード）

1. GAS エディタで **`generateAdminToken()`** を実行
2. 実行ログに出た `?admin=...` 付き URL を、**新郎新婦の端末だけ**で開く
3. アルバムで写真をタップすると **🗑 削除** が出ます（誤タップ防止に 2 段階）

トークンは端末に保存され、URL からは自動で消えます（そのまま共有するとゲストに渡ってしまうため）。
削除は **Drive のゴミ箱へ移動**するだけなので、30 日以内なら元に戻せます。
保存先フォルダ内のファイルしか消せないので、トークンが漏れても Drive 全体は無事です。

トークンを無効化したいときは、スクリプトプロパティの `ADMIN_TOKEN` を削除してください。
未設定の状態では削除機能そのものが無効になります。

### 写真の受付を締め切る

GAS エディタで実行します。

```
setUploadDeadline('2026-09-05T23:59:59+09:00')   期限を設定
setUploadDeadline('')                            解除（無期限）
```

期限を過ぎると、表紙に案内が出てカメラボタンが押せなくなり、サーバー側でも
アップロードを拒否します。**アルバムの閲覧と保存はそのまま使えます。**

案内文を変えたいときは、スクリプトプロパティ `UPLOAD_CLOSED_MESSAGE` に文章を入れてください。

> 受付を閉じた時点で未送信の写真が残っていた場合、ゲストは表紙の
> 「端末に保存する」で自分の端末に取り出せます。

---

## 当日の運用メモ

- 緊急修正を push した場合、HTML は network-first なのでゲストのリロードで反映されます
- 未送信の写真は端末の IndexedDB に残ります。ページを閉じても消えません
- 送れない写真は表紙画面の「端末に保存する」で取り出せます
