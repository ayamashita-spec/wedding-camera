/**
 * config.js のひな形。これはリポジトリにコミットされます（値は空）。
 *
 * ■ ローカルで動かすとき
 *   このファイルを config.js という名前でコピーし、値を埋めてください。
 *   config.js は .gitignore 済みなのでコミットされません。
 *
 * ■ 本番（GitHub Pages）
 *   .github/workflows/deploy.yml が GitHub Secrets から config.js を
 *   生成して配信します。リポジトリに実際の値を書く必要はありません。
 *
 *   必要な Secrets:
 *     WEDCAM_API_URL          GAS の /exec URL
 *     WEDCAM_API_TOKEN        GAS の generateApiToken() が出した値
 *     WEDCAM_DRIVE_FOLDER_URL 共有アルバムの Drive フォルダ URL（任意）
 *
 * 注意: これらは最終的にゲストのブラウザに配られるため、本質的な秘密には
 * できません。トークンは「URL を拾った自動スキャンの流れ弾を弾く」ためのもので、
 * 実際の防御は GAS 側の 1 日上限・フォルダ所属チェックで行います。
 */
window.WEDCAM_CONFIG = {
  API_URL: '',
  API_TOKEN: '',
  DRIVE_FOLDER_URL: ''
};
