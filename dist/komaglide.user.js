// ==UserScript==
// @name         KomaGlide
// @namespace    https://komaglide.local/
// @version      0.7.13
// @updateURL    https://raw.githubusercontent.com/st9240202/KomaGlide/main/dist/komaglide.user.js
// @downloadURL  https://raw.githubusercontent.com/st9240202/KomaGlide/main/dist/komaglide.user.js
// @description  在漫畫分頁閱讀、保存圖片，並從腳本選單開啟本站書庫。
// @description:en Read and save comic pages, and open your site library from the script menu.
// @description:ja 漫画ページを読みながら画像を保存し、スクリプトメニューからサイトの本棚を開けます。
// @description:zh-CN 在漫画页面阅读、保存图片，并从脚本菜单打开本站书库。
// @match        http://*/*
// @match        https://*/*
// @noframes
// @run-at       document-start
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM_addValueChangeListener
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      imgs.xkcd.com
// @connect      img7.8comic.com
// @connect      img9.8comic.com
// @connect      hath.network
// @connect      hamreus.com
// @connect      nhentai.net
// ==/UserScript==

// 開發用範本。安裝到腳本管理器時請選 dist/komaglide.user.js。
(() => {
  'use strict';

  const PREFIX = 'kg1.';
  const SHELF_HASH = '#komaglide/';
  const IMAGE_LIMIT = 32 * 1024 * 1024;
  const MIME = /^image\/(?:jpeg|png|apng|webp|gif|avif|bmp|x-icon)$/i;
  const read = key => GM.getValue(key, null);
  const write = (key, value) => GM.setValue(key, value);

  function webUrl(value, base = document.baseURI) {
    if (!value) return null;
    try {
      const url = new URL(value, base);
      return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url : null;
    } catch {
      return null;
    }
  }

  const localeNames = { 'zh-Hant': '繁體中文', en: 'English', ja: '日本語', 'zh-Hans': '简体中文' };
let locale = 'zh-Hant';

function setLocale(value) {
  locale = typeof value === 'string' && Object.hasOwn(localeNames, value) ? value : 'zh-Hant';
}

const translations = {
  // Traditional Chinese is the default. Columns follow the order in localeNames.
  language: ['語言', 'Language', '言語', '语言'],
  languageSaveFailed: ['無法儲存語言設定，請再試一次。', 'Could not save the language preference. Try again.', '言語設定を保存できませんでした。もう一度お試しください。', '无法保存语言设置，请重试。'],
  library: ['書庫', 'Library', '本棚', '书库'],
  siteLibrary: ['本站書庫', 'Site Library', 'このサイトの本棚', '本站书库'],
  offlineLibrary: ['離線書庫', 'Offline Library', 'オフライン本棚', '离线书库'],
  siteLibraryHome: ['KomaGlide 本站書庫首頁', 'KomaGlide Site Library home', 'KomaGlide このサイトの本棚のトップ', 'KomaGlide 本站书库首页'],
  offlineLibraryHome: ['KomaGlide 離線書庫首頁', 'KomaGlide Offline Library home', 'KomaGlide オフライン本棚のトップ', 'KomaGlide 离线书库首页'],
  preparingLibrary: ['準備離線書庫中', 'Preparing Offline Library', 'オフライン本棚を準備中', '正在准备离线书库'],
  offlineReady: ['可離線開啟', 'Available offline', 'オフラインで利用可能', '可离线打开'],
  offlineReading: ['離線閱讀中', 'Reading offline', 'オフラインで閲覧中', '正在离线阅读'],
  offlineUnavailable: ['離線介面尚未就緒', 'Offline interface is not ready', 'オフライン画面の準備ができていません', '离线界面尚未就绪'],
  appearance: ['外觀', 'Appearance', '外観', '外观'],
  systemTheme: ['跟隨系統', 'System', 'システムに合わせる', '跟随系统'],
  lightTheme: ['淺色', 'Light', 'ライト', '浅色'],
  darkTheme: ['深色', 'Dark', 'ダーク', '深色'],
  storageSettings: ['容量設定', 'Storage Settings', '容量設定', '容量设置'],
  libraryFilters: ['書庫篩選', 'Library filters', '本棚の絞り込み', '书库筛选'],
  allWorks: ['全部作品', 'All Works', 'すべての作品', '全部作品'],
  favorites: ['收藏', 'Favorites', 'お気に入り', '收藏'],
  exportMode: ['匯出模式', 'Export Mode', 'エクスポート', '导出模式'],
  exportSelectAll: ['全選', 'Select All', 'すべて選択', '全选'],
  exportClear: ['清除選取', 'Clear Selection', '選択を解除', '清除选择'],
  exportPrepare: ['準備 ZIP', 'Prepare ZIP', 'ZIP を作成', '准备 ZIP'],
  exportDownload: ['下載 ZIP', 'Download ZIP', 'ZIP をダウンロード', '下载 ZIP'],
  exportSelected: ['已選 {count} 話，共 {pages} 頁', 'Selected chapters: {count} · Saved pages: {pages}', '{count} 話を選択・保存済み {pages} ページ', '已选 {count} 话，共 {pages} 页'],
  exportSavedOnly: ['ZIP 只包含已儲存的頁面。', 'The ZIP includes only saved pages.', 'ZIP には保存済みのページのみが含まれます。', 'ZIP 仅包含已保存的页面。'],
  exportReading: ['正在讀取已儲存的頁面…', 'Reading saved pages…', '保存済みのページを読み込み中…', '正在读取已保存的页面…'],
  exportPackaging: ['正在打包 {done}／{total} 頁…', 'Packing pages {done}/{total}…', 'ZIP を作成中（{done}/{total} ページ）…', '正在打包 {done}／{total} 页…'],
  exportReady: ['ZIP 已準備好。', 'The ZIP is ready.', 'ZIP をダウンロードできます。', 'ZIP 已准备好。'],
  exportFailed: ['無法準備 ZIP，請重試。', 'Could not prepare the ZIP. Try again.', 'ZIP を作成できませんでした。もう一度お試しください。', '无法准备 ZIP，请重试。'],
  exportTooLarge: ['選取的漫畫超出單一 ZIP 的容量或檔案數上限，請減少勾選後分批下載。', 'The selection exceeds the size or file count limit for one ZIP. Select fewer chapters and download in batches.', '選択した漫画が ZIP 1 個の容量またはファイル数の上限を超えています。選択する話を減らして、分けてダウンロードしてください。', '所选漫画超出单个 ZIP 的容量或文件数上限，请减少勾选后分批下载。'],
  exportChapterMissing: ['部分選取的章節已無法讀取，請確認選取後重試。', 'Some selected chapters are no longer available. Check your selection and try again.', '選択した話の一部を読み込めません。選択内容を確認してもう一度お試しください。', '部分所选章节已无法读取，请确认选择后重试。'],
  backToLibrary: ['返回書庫', 'Back to Library', '本棚に戻る', '返回书库'],
  storageLimit: ['書庫容量上限（MiB）', 'Library storage limit (MiB)', '本棚の容量上限（MiB）', '书库容量上限（MiB）'],
  saveLimit: ['儲存上限', 'Save Limit', '上限を保存', '保存上限'],
  limitHint: ['收藏和一般快取共用容量。調低上限時，書庫會從最久沒讀、尚未收藏的一話開始，整話移除。', 'Favorites and cached pages share this storage. Lowering the limit removes whole chapters, starting with the least recently read chapter that isn’t a favorite.', 'お気に入りとキャッシュは容量を共有します。上限を下げると、お気に入りに入っていない話のうち、最後に読んだ時期が古いものから話単位で削除されます。', '收藏和普通缓存共用容量。调低上限时，书库会从最久未读、尚未收藏的一话开始，整话移除。'],
  storageProtection: ['瀏覽器儲存保護', 'Browser Storage Protection', 'ブラウザーのストレージ保護', '浏览器存储保护'],
  storageProtectionHint: ['空間不足時，瀏覽器可能清除未受保護的網站資料。', 'The browser may clear unprotected site data when storage runs low.', '空き容量が少なくなると、ブラウザーが保護されていないサイトデータを削除する場合があります。', '空间不足时，浏览器可能清除未受保护的网站数据。'],
  requestPersistence: ['申請持久儲存', 'Request Persistent Storage', '永続ストレージをリクエスト', '申请持久存储'],
  chapterNavigation: ['話數導覽', 'Chapter navigation', '話の移動', '章节导航'],
  thumbnails: ['小圖選頁', 'Page Thumbnails', 'サムネイルでページ選択', '缩略图选页'],
  thumbnailSize: ['縮圖大小', 'Thumbnail Size', 'サムネイルのサイズ', '缩略图大小'],
  small: ['小', 'Small', '小', '小'],
  medium: ['中', 'Medium', '中', '中'],
  large: ['大', 'Large', '大', '大'],
  close: ['關閉', 'Close', '閉じる', '关闭'],
  closeThumbnails: ['關閉小圖', 'Close page thumbnails', 'サムネイルを閉じる', '关闭缩略图'],
  previousBatch: ['上一組', 'Previous Set', '前の組', '上一组'],
  nextBatch: ['下一組', 'Next Set', '次の組', '下一组'],
  noPreview: ['無預覽', 'No preview', 'プレビューなし', '无预览'],
  pageCount: ['{count} 頁', '{count} pages', '{count} ページ', '{count} 页'],
  pageCountOne: ['{count} 頁', '{count} page', '{count} ページ', '{count} 页'],
  pageRange: ['{start}–{end} / {total} 頁', '{start}–{end} of {total} pages', '{start}–{end} / {total} ページ', '{start}–{end} / {total} 页'],
  pageNumber: ['第 {page} 頁', 'Page {page}', '{page} ページ', '第 {page} 页'],
  readerSettings: ['閱讀設定', 'Reading Settings', '閲覧設定', '阅读设置'],
  settings: ['設定', 'Settings', '設定', '设置'],
  pageNavigation: ['頁面導覽', 'Page Navigation', 'ページ移動', '页面导航'],
  navigation: ['導覽', 'Navigate', '移動', '导航'],
  readingMode: ['閱讀模式', 'Reading Mode', '閲覧モード', '阅读模式'],
  verticalScroll: ['直向捲動', 'Vertical Scroll', '縦スクロール', '纵向滚动'],
  singlePage: ['單頁', 'Single Page', '単ページ', '单页'],
  doublePage: ['雙頁', 'Double Page', '見開き', '双页'],
  bufferMode: ['緩衝模式', 'Preload Mode', '先読みモード', '缓冲模式'],
  bufferChapter: ['停留時緩衝整話', 'Preload chapter when idle', '操作を止めると全ページを先読み', '停留时预载整话'],
  bufferAhead: ['只預載後面 3 頁', 'Preload next 3 pages', '次の3ページだけ先読み', '只预载后面 3 页'],
  parallelPreload: ['並行預載數', 'Parallel Preloads', '同時先読み数', '并行预载数'],
  pageDirection: ['翻頁方向', 'Reading Direction', 'ページをめくる方向', '翻页方向'],
  rtl: ['從右到左', 'Right to Left', '右から左', '从右到左'],
  ltr: ['從左到右', 'Left to Right', '左から右', '从左到右'],
  tapToTurn: ['點按翻頁', 'Tap to Turn Pages', 'タップでページをめくる', '点击翻页'],
  previousPage: ['上一頁', 'Previous Page', '前のページ', '上一页'],
  nextPage: ['下一頁', 'Next Page', '次のページ', '下一页'],
  tapRtl: ['點畫面左側前進，右側返回', 'Tap left to advance and right to go back', '画面左側をタップで次へ、右側で前へ', '点击屏幕左侧前进，右侧返回'],
  tapLtr: ['點畫面右側前進，左側返回', 'Tap right to advance and left to go back', '画面右側をタップで次へ、左側で前へ', '点击屏幕右侧前进，左侧返回'],
  previousChapter: ['上一話', 'Previous Chapter', '前の話', '上一话'],
  nextChapter: ['下一話', 'Next Chapter', '次の話', '下一话'],
  continuePage: ['接上下一頁', 'Continue to Next Page', '次のページを表示', '接上下一页'],
  continueChapter: ['接上下一話', 'Continue to Next Chapter', '次の話を表示', '接上下一话'],
  connecting: ['正在接續…', 'Loading next section…', '続きのページを読み込み中…', '正在接续…'],
  autoContinue: ['自動接下一話', 'Continue Automatically', '自動で次の話へ', '自动接下一话'],
  closeReader: ['關閉閱讀器', 'Close Reader', 'リーダーを閉じる', '关闭阅读器'],
  openSiteLibrary: ['開啟本站書庫', 'Open Site Library', 'このサイトの本棚を開く', '打开本站书库'],
  openKomaGlideLibrary: ['開啟 KomaGlide 書庫', 'Open KomaGlide Library', 'KomaGlide の本棚を開く', '打开 KomaGlide 书库'],
  verticalReader: ['直向閱讀器', 'Vertical Reader', '縦読みリーダー', '纵向阅读器'],
  retry: ['重試', 'Retry', '再試行', '重试'],
  retryPages: ['重試缺頁', 'Retry Missing Pages', '未取得のページを再試行', '重试缺页'],
  waitingForPage: ['等候原站載入第 {page} 頁…', 'Waiting for the site to load page {page}…', 'サイトが {page} ページを読み込むのを待っています…', '等待原网站加载第 {page} 页…'],
  sitePageFailed: ['原站未能載入第 {page} 頁。', 'The site could not load page {page}.', 'サイトが {page} ページを読み込めませんでした。', '原网站未能加载第 {page} 页。'],
  pageNotSavedOnSite: ['第 {page} 頁尚未儲存，請在原站載入此頁。', 'Page {page} is not saved. Load it on the original site.', '{page} ページは未保存です。元のサイトで開いてください。', '第 {page} 页尚未保存，请在原网站加载此页。'],
  bufferProgress: ['已保存 {count}／{total} 頁', 'Pages saved: {count}/{total}', '保存済み {count}／{total} ページ', '已保存 {count}／{total} 页'],
  bufferProgressMissing: ['已保存 {count}／{total} 頁 · 有缺頁，見閱讀設定', 'Pages saved: {count}/{total} · See Reading Settings for missing pages', '保存済み {count}／{total} ページ · 未取得のページは閲覧設定を確認', '已保存 {count}／{total} 页 · 有缺页，请查看阅读设置'],
  bufferProgressFailed: ['無法讀取緩衝進度', 'Could not read preload progress', '先読みの進行状況を取得できません', '无法读取缓冲进度'],
  bufferMissing: ['緩衝缺 {count} 頁（第 {page} 頁：{reason}）', 'Pages missing: {count} (page {page}: {reason})', '未取得 {count} ページ（{page} ページ：{reason}）', '缓冲缺 {count} 页（第 {page} 页：{reason}）'],
  onlineDisplay: ['線上顯示 · {reason}', 'Showing online · {reason}', 'オンラインで表示 · {reason}', '在线显示 · {reason}'],
  imageDisplayFailed: ['圖檔無法顯示', 'Image could not be displayed', '画像を表示できません', '无法显示图片'],
  savingPaused: ['保存暫停', 'Saving paused', '保存を一時停止', '保存暂停'],
  savedPages: ['已保存 {count} 頁', 'Pages saved: {count}', '保存済み {count} ページ', '已保存 {count} 页'],
  savedPagesOfTotal: ['已保存 {count} 頁 / 共 {total} 頁', 'Pages saved: {count}/{total}', '保存済み {count}／{total} ページ', '已保存 {count} 页 / 共 {total} 页'],
  savedCountFailed: ['無法讀取保存頁數', 'Could not read the saved page count', '保存済みのページ数を取得できません', '无法读取已保存页数'],
  savingPage: ['正在保存第 {page} 頁', 'Saving page {page}', '{page} ページを保存中', '正在保存第 {page} 页'],
  persistenceGranted: ['瀏覽器已授予持久儲存。', 'The browser granted persistent storage.', 'ブラウザーが永続ストレージを許可しました。', '浏览器已授予持久存储。'],
  persistenceNotGranted: ['本站目前尚未獲得持久儲存保護。', 'This site does not have persistent storage protection.', 'このサイトのデータは永続ストレージで保護されていません。', '本站目前尚未获得持久存储保护。'],
  persistenceDenied: ['瀏覽器未核准這次持久儲存申請。', 'The browser declined the persistent storage request.', 'ブラウザーが永続ストレージのリクエストを拒否しました。', '浏览器未批准此次持久存储申请。'],
  persistenceCheckUnsupported: ['目前的瀏覽器環境未提供持久儲存查詢功能。', 'This browser cannot check persistent storage status.', 'このブラウザーでは永続ストレージの状態を確認できません。', '当前浏览器不支持查询持久存储状态。'],
  persistenceRequestUnsupported: ['目前的瀏覽器環境未提供持久儲存申請功能。', 'This browser cannot request persistent storage.', 'このブラウザーでは永続ストレージをリクエストできません。', '当前浏览器不支持申请持久存储。'],
  persistenceCheckFailed: ['瀏覽器查詢持久儲存時發生錯誤。', 'Could not check persistent storage status.', '永続ストレージの状態を確認できませんでした。', '查询持久存储状态时发生错误。'],
  persistenceRequestFailed: ['瀏覽器申請持久儲存時發生錯誤。', 'Could not request persistent storage.', '永続ストレージをリクエストできませんでした。', '申请持久存储时发生错误。'],
  returnedFalse: ['{api} 回傳 false', '{api} returned false', '{api} が false を返しました', '{api} 返回 false'],
  checkingPersistence: ['正在查詢本站的持久儲存狀態。', 'Checking persistent storage for this site…', 'このサイトの永続ストレージの状態を確認中…', '正在查询本站的持久存储状态。'],
  requestingPersistence: ['正在向瀏覽器申請持久儲存。', 'Requesting persistent storage…', '永続ストレージをリクエスト中…', '正在向浏览器申请持久存储。'],
  savedKnownTotal: ['已存 {count} / {total} 頁', 'Pages saved: {count}/{total}', '保存済み {count}／{total} ページ', '已存 {count} / {total} 页'],
  savedUnknownTotal: ['已存 {count} 頁 · 總頁數未知', 'Pages saved: {count} · Total unknown', '保存済み {count} ページ · 総ページ数不明', '已存 {count} 页 · 总页数未知'],
  favoriteWork: ['收藏作品', 'Favorite Work', '作品をお気に入りに追加', '收藏作品'],
  favoritedWork: ['已收藏作品', 'Work Favorited', '作品はお気に入りに登録済み', '已收藏作品'],
  favoriteChapter: ['收藏單話', 'Favorite Chapter', 'この話をお気に入りに追加', '收藏单话'],
  favoritedChapter: ['已收藏單話', 'Chapter Favorited', 'この話はお気に入りに登録済み', '已收藏单话'],
  removedFavorite: ['已取消收藏。', 'Removed from favorites.', 'お気に入りから削除しました。', '已取消收藏。'],
  addedFavorite: ['已收藏。', 'Added to favorites.', 'お気に入りに追加しました。', '已收藏。'],
  storageDiagnostics: ['查看儲存診斷', 'View Storage Diagnostics', 'ストレージの詳細を見る', '查看存储诊断'],
  ungrouped: ['尚未歸入作品', 'Unassigned Chapters', '作品未分類', '尚未归入作品'],
  chapterCount: ['{count} 話', '{count} chapters', '{count} 話', '{count} 话'],
  chapterCountOne: ['{count} 話', '{count} chapter', '{count} 話', '{count} 话'],
  noFavorites: ['還沒有收藏', 'No Favorites Yet', 'お気に入りはまだありません', '还没有收藏'],
  noComics: ['書架上還沒有漫畫', 'Your Library Is Empty', '本棚に漫画がありません', '书架上还没有漫画'],
  favoritesHint: ['在全部作品中收藏作品或單話，即可在這裡找到。', 'Favorite a work or chapter in All Works to find it here.', '「すべての作品」で作品や話をお気に入りに追加すると、ここに表示されます。', '在全部作品中收藏作品或单话，即可在这里找到。'],
  emptyShelfHint: ['安裝 KomaGlide 腳本後，到支援的漫畫頁閱讀。已儲存的頁面會自動出現在這裡。', 'Install KomaGlide and read a chapter on a supported site. Saved pages will appear here.', 'KomaGlide をインストールして対応サイトで漫画を読むと、保存したページがここに表示されます。', '安装 KomaGlide 脚本后，到支持的漫画页阅读。已保存的页面会自动出现在这里。'],
  pageRemoved: ['此頁已從書庫移除。', 'This page was removed from the library.', 'このページは本棚から削除されました。', '此页已从书库移除。'],
  decodeFailed: ['第 {page} 頁的圖片無法解碼。', 'The image for page {page} could not be decoded.', '{page} ページの画像を読み取れませんでした。', '第 {page} 页的图片无法解码。'],
  missingPages: ['第 {range} 頁尚未儲存', 'Not saved: {range}', '{range} ページは未保存です', '第 {range} 页尚未保存'],
  loadingChapter: ['載入這一話中', 'Loading Chapter', '話を読み込み中', '正在加载这一话'],
  invalidChapterUrl: ['這個閱讀網址不完整，請返回書庫重新選話。', 'This reading link is incomplete. Go back to the library and select a chapter.', '閲覧リンクが不完全です。本棚に戻って話を選び直してください。', '此阅读链接不完整，请返回书库重新选择章节。'],
  chapterNotFound: ['書庫裡找不到這一話，請返回書庫選擇其他話。', 'This chapter is missing. Go back to the library and pick another chapter.', 'この話は本棚にありません。本棚に戻って別の話を選んでください。', '书库里找不到这一话，请返回书库选择其他章节。'],
  chapterOpenFailed: ['無法開啟這一話', 'Could Not Open Chapter', 'この話を開けません', '无法打开这一话'],
  storageUsage: ['已使用 {used}，目前上限 {limit}。', '{used} used out of {limit}.', '{used} 使用中。上限は {limit} です。', '已使用 {used}，当前上限 {limit}。'],
  storageLimitSaved: ['已更新書庫容量上限。', 'Library storage limit updated.', '本棚の容量上限を更新しました。', '已更新书库容量上限。'],
  newPagesSaved: ['這一話有新儲存的頁面。', 'New pages were saved for this chapter.', 'この話に新しく保存されたページがあります。', '这一话有新保存的页面。'],
  refreshPages: ['更新頁面', 'Refresh Pages', 'ページを更新', '更新页面'],
  quotaExceeded: ['瀏覽器儲存空間不足，請釋放空間後再試。', 'Browser storage is full. Free up space and try again.', 'ブラウザーの保存領域が不足しています。空き容量を確保して再試行してください。', '浏览器存储空间不足，请释放空间后再试。'],
  libraryAccessFailed: ['無法存取本站書庫。', 'Could not access the site library.', 'このサイトの本棚にアクセスできません。', '无法访问本站书库。'],
  offlineAccessFailed: ['無法存取本機書庫，請再試一次。', 'Could not access the local library. Try again.', 'ローカルの本棚にアクセスできません。再試行してください。', '无法访问本地书库，请重试。'],
  writeAborted: ['書庫寫入已中斷，請重試。', 'The library write was interrupted. Try again.', '本棚への保存が中断されました。再試行してください。', '书库写入已中断，请重试。'],
  incompletePage: ['頁面識別資料不完整，無法存取漫畫頁。', 'The page could not be identified in the library.', 'ページの識別情報が不足しているため、本棚からアクセスできません。', '页面识别信息不完整，无法访问漫画页。'],
  insufficientStorage: ['容量不足。請調高書庫上限或解除收藏，再重新儲存。', 'The library is full. Raise the storage limit or remove some favorites, then try again.', '本棚の空き容量がありません。容量上限を上げるか、お気に入りを解除して再試行してください。', '容量不足。请调高书库上限或取消部分收藏后重试。'],
  emptyImage: ['圖片沒有內容，請重新載入這一頁。', 'The image is empty. Reload this page.', '画像が空です。このページを読み込み直してください。', '图片没有内容，请重新加载这一页。'],
  chapterTooLarge: ['這一話的圖片超過書庫上限。請調高上限後重試。', 'This chapter exceeds the library storage limit. Raise the limit and try again.', 'この話の画像は本棚の容量上限を超えています。上限を上げて再試行してください。', '这一话的图片超过书库上限。请调高上限后重试。'],
  invalidLimit: ['請輸入有效的容量上限。', 'Enter a valid storage limit.', '有効な容量上限を入力してください。', '请输入有效的容量上限。'],
  noWork: ['尚未確認這一話所屬的作品。', 'The work this chapter belongs to is unknown.', 'この話がどの作品に属するか確認できません。', '尚未确认这一话所属的作品。'],
  chapterRemoved: ['書庫已移除這一話，請重新開啟書架。', 'This chapter was removed. Reopen the library.', 'この話は本棚から削除されました。本棚を開き直してください。', '书库已移除这一话，请重新打开书库。'],
  offlineRequiresSecure: ['請從 HTTPS 或 localhost 開啟書庫，才能準備離線介面。', 'Open the library over HTTPS or localhost to set up offline access.', 'オフラインで利用できるようにするには、HTTPS または localhost から本棚を開いてください。', '请通过 HTTPS 或 localhost 打开书库，以准备离线界面。'],
  offlineSetupFailed: ['書庫未能安裝離線介面，請連線後重新整理。', 'Could not set up offline access. Connect to the internet and reload.', 'オフラインで利用する準備ができませんでした。インターネットに接続して再読み込みしてください。', '书库未能安装离线界面，请联网后刷新。'],
  offlineInstallFailed: ['離線介面安裝失敗，請連線後重新整理。', 'Offline setup failed. Connect to the internet and reload.', 'オフラインで利用するための設定に失敗しました。インターネットに接続して再読み込みしてください。', '离线界面安装失败，请联网后刷新。'],
  galleryFailed: ['無法讀取圖庫目錄', 'Could not load the gallery index', 'ギャラリーの目次を読み込めません', '无法读取图库目录'],
  unsupportedImage: ['圖檔格式不支援', 'Unsupported image format', '対応していない画像形式です', '不支持此图片格式'],
  imageReadFailed: ['無法讀取漫畫圖檔', 'Could not load the comic image', '漫画画像を読み込めません', '无法读取漫画图片'],
  imageHttpStatus: ['圖站回應 HTTP {status}', 'Image host returned HTTP {status}', '画像サーバーが HTTP {status} を返しました', '图片服务器返回 HTTP {status}'],
  onlineOnly: ['此圖片限線上閱讀', 'This image is available online only', 'この画像はオンラインでのみ閲覧できます', '此图片仅限在线阅读'],
  imageHttpFailed: ['讀取圖檔失敗（HTTP {status}）', 'Could not load the image (HTTP {status})', '画像を読み込めませんでした（HTTP {status}）', '读取图片失败（HTTP {status}）'],
  imageTooLarge: ['單頁超過 32 MiB', 'This page exceeds 32 MiB', 'ページの画像が 32 MiB を超えています', '单页超过 32 MiB'],
  blankImage: ['圖檔為空', 'The image is empty', '画像ファイルが空です', '图片文件为空'],
  nextPageNotHtml: ['下一頁沒有傳回章節網頁', 'The next page did not return chapter HTML', '次のページから話の HTML が取得できませんでした', '下一页未返回章节网页'],
  chapterHtmlTooLarge: ['章節網頁過大', 'The chapter HTML is too large', '話の HTML が大きすぎます', '章节网页过大'],
  nextChapterUnrecognized: ['無法辨識接續章節', 'Could not identify the next chapter', '次の話を識別できません', '无法识别后续章节'],
  siteImageTimeout: ['原站載圖逾時', 'The site timed out loading the image', 'サイトでの画像読み込みがタイムアウトしました', '原网站加载图片超时'],
  imageNotAvailable: ['原站尚未提供圖檔', 'The site has not provided the image yet', 'サイトから画像をまだ取得できません', '原网站尚未提供图片'],
};

const locales = Object.keys(localeNames);

function t(key, values) {
  const message = translations[key][locales.indexOf(locale)];
  return values ? message.replace(/\{(\w+)\}/g, (_, name) => values[name]) : message;
}

const languageKey = 'kg1.language';

function localizeDocument() {
  document.documentElement.lang = locale;
  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of document.querySelectorAll('[data-i18n-label]')) {
    node.setAttribute('aria-label', t(node.dataset.i18nLabel));
  }
}

  const DB_NAME = 'komaglide-library-v1';
const MiB = 1024 ** 2;
const DEFAULT_LIMIT = 1024 * MiB;
const stores = ['pages', 'chapters', 'favoriteWorks', 'settings'];
let opening;
let useImageBytes = false;

function database() {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      for (const store of stores) req.result.createObjectStore(store);
    };
    req.onerror = () => {
      opening = undefined;
      reject(req.error);
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => {
        req.result.close();
        opening = undefined;
      };
      resolve(req.result);
    };
  });
  return opening;
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function transaction(names, mode, run) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, mode);
    const tables = Object.fromEntries(names.map(name => [name, tx.objectStore(name)]));
    let result;
    let failure;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(failure || tx.error || new Error(t('writeAborted')));
    Promise.resolve().then(() => run(tables)).then(value => {
      result = value;
    }, error => {
      failure = error;
      try { tx.abort(); } catch { reject(error); }
    });
  });
}

async function readState(settings) {
  return await request(settings.get('storage')) || { used: 0, limit: DEFAULT_LIMIT, clock: 0 };
}

function touch(state, chapter) {
  state.clock = Math.max(Date.now(), state.clock + 1);
  chapter.lastRead = state.clock;
}

function identity(page) {
  if (!page || typeof page.site !== 'string' || !page.site || typeof page.chapterId !== 'string' || !page.chapterId ||
      (page.workId != null && typeof page.workId !== 'string') ||
      !Number.isSafeInteger(page.index) || page.index < 1) {
    throw new Error(t('incompletePage'));
  }
  return [page.site, page.workId || '', page.chapterId];
}

function indices(key) {
  return IDBKeyRange.bound([...key, 1], [...key, Number.MAX_SAFE_INTEGER]);
}

// Select the complete set of victims before deleting anything. The read-write
// transaction serializes selection, byte accounting and the actual Blob write.
async function makeRoom(tables, state, required, skipKey) {
  if (required <= 0) return;
  const [chapters, favorites] = await Promise.all([
    request(tables.chapters.getAll()), request(tables.favoriteWorks.getAllKeys())
  ]);
  const protectedWorks = new Set(favorites.map(key => JSON.stringify(key)));
  const candidates = chapters.filter(chapter =>
    !chapter.favorite && !(chapter.workKnown && protectedWorks.has(JSON.stringify(chapter.key.slice(0, 2)))) &&
    (!skipKey || indexedDB.cmp(chapter.key, skipKey) !== 0)
  ).sort((a, b) => a.lastRead - b.lastRead);
  let bytes = 0;
  let count = 0;
  while (count < candidates.length && bytes < required) bytes += candidates[count++].bytes;
  if (bytes < required) throw new Error(t('insufficientStorage'));
  for (const { key } of candidates.slice(0, count)) {
    tables.chapters.delete(key);
    tables.pages.delete(indices(key));
  }
  state.used -= bytes;
}

function title(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

async function putPage(page, blob) {
  const key = identity(page);
  if (!(blob instanceof Blob) || !blob.size) throw new Error(t('emptyImage'));
  let blobRejected = false;
  function save(image) {
    return transaction(stores, 'readwrite', async tables => {
      const pageKey = [...key, page.index];
      const [state, previous, present] = await Promise.all([
        readState(tables.settings), request(tables.chapters.get(key)), request(tables.pages.getKey(pageKey))
      ]);
      const chapter = previous || { key, favorite: false, count: 0, bytes: 0, total: null };
      if (!present) {
        if (blob.size + chapter.bytes > state.limit) {
          throw new Error(t('chapterTooLarge'));
        }
        await makeRoom(tables, state, state.used + blob.size - state.limit, key);
        try {
          await request(tables.pages.add({ ...image, imageUrl: title(page.imageUrl, '') }, pageKey));
        } catch (error) {
          blobRejected = !!image.blob && (error.name === 'UnknownError' || error.name === 'DataCloneError');
          throw error;
        }
        state.used += blob.size;
        chapter.bytes += blob.size;
        chapter.count++;
      }
      chapter.workTitle = title(page.workTitle, chapter.workTitle || key[1]);
      chapter.chapterTitle = title(page.chapterTitle, chapter.chapterTitle || key[2]);
      if (typeof page.chapterSubtitle === 'string') chapter.chapterSubtitle = page.chapterSubtitle;
      chapter.chapterUrl = title(page.chapterUrl, chapter.chapterUrl || '');
      chapter.workKnown = !!key[1] && (page.workKnown ?? chapter.workKnown ?? true);
      chapter.lastIndex = Math.max(chapter.lastIndex || 0, page.index);
      if (Number.isSafeInteger(page.total) && page.total >= chapter.lastIndex) {
        chapter.total = Math.max(chapter.total || 0, page.total);
      }
      if (chapter.total && chapter.lastIndex > chapter.total) chapter.total = null;
      if (Number.isFinite(page.chapterOrder)) chapter.order = page.chapterOrder;
      touch(state, chapter);
      tables.chapters.put(chapter, key);
      tables.settings.put(state, 'storage');
    });
  }

  if (!useImageBytes) {
    try { return await save({ blob }); }
    catch (error) { if (!blobRejected) throw error; }
  }
  // Some WebKit contexts cannot persist Blob records. Convert outside the
  // transaction, after a rejected write and its evictions have rolled back.
  const bytes = await blob.arrayBuffer();
  await save({ bytes, mime: blob.type });
  useImageBytes = true;
}

// Keep saved pages readable when the browser can no longer commit recency data.
async function chapterRead(key, read) {
  async function run(tables) {
    const chapter = await request(tables.chapters.get(key));
    if (!chapter) return null;
    const result = await read(tables.pages, chapter);
    if (result && tables.settings) {
      const state = await readState(tables.settings);
      touch(state, chapter);
      tables.chapters.put(chapter, key);
      tables.settings.put(state, 'storage');
    }
    return result;
  }
  try {
    return await transaction(['pages', 'chapters', 'settings'], 'readwrite', run);
  } catch (error) {
    if (error.name !== 'QuotaExceededError') throw error;
    return transaction(['pages', 'chapters'], 'readonly', run);
  }
}

async function lookupPage(page, includeBlob) {
  const key = identity(page);
  const pageKey = [...key, page.index];
  const data = await chapterRead(key, pages => request(includeBlob ? pages.get(pageKey) : pages.getKey(pageKey)));
  if (!includeBlob) return { exists: !!data };
  return { exists: !!data, blob: data ? storedImage(data) : null };
}

function storedImage(data) {
  return data.blob || new Blob([data.bytes], { type: data.mime });
}

async function readExportChapters(keys, validate, signal) {
  return transaction(['chapters', 'pages'], 'readonly', async tables => {
    const chapters = await Promise.all(keys.map(key => request(tables.chapters.get(key))));
    signal.throwIfAborted();
    if (chapters.some(chapter => !chapter?.count)) throw new Error(t('exportChapterMissing'));
    validate(chapters);
    const result = [];
    for (const chapter of chapters) {
      signal.throwIfAborted();
      const pages = await new Promise((resolve, reject) => {
        const images = [];
        const scan = tables.pages.openCursor(indices(chapter.key));
        scan.onerror = () => reject(scan.error);
        scan.onsuccess = () => {
          const cursor = scan.result;
          if (signal.aborted) return reject(signal.reason);
          if (!cursor) return resolve(images);
          try {
            const blob = storedImage(cursor.value);
            if (!blob.size) throw new Error(t('exportChapterMissing'));
            images.push({ index: cursor.key[3], blob });
            cursor.continue();
          } catch (error) {
            reject(error);
          }
        };
      });
      if (pages.length !== chapter.count) throw new Error(t('exportChapterMissing'));
      result.push({ chapter, pages });
    }
    return result;
  });
}

async function shelf() {
  return transaction(['chapters', 'favoriteWorks', 'settings'], 'readonly', async tables => ({
    chapters: await request(tables.chapters.getAll()),
    favorites: await request(tables.favoriteWorks.getAllKeys()),
    state: await readState(tables.settings)
  }));
}

async function savedPageCount(key) {
  const chapter = await transaction(['chapters'], 'readonly', tables => request(tables.chapters.get(key)));
  return chapter?.count || 0;
}

async function readChapterSubtitle(key) {
  const chapter = await transaction(['chapters'], 'readonly', tables => request(tables.chapters.get(key)));
  return chapter?.chapterSubtitle;
}

async function setChapterSubtitle(key, subtitle) {
  return transaction(['chapters'], 'readwrite', async ({chapters}) => {
    const chapter = await request(chapters.get(key));
    if (!chapter || chapter.chapterSubtitle === subtitle) return false;
    chapter.chapterSubtitle = subtitle;
    await request(chapters.put(chapter, key));
    return true;
  });
}

async function readChapter(key) {
  return chapterRead(key, async (pages, chapter) => {
    const keys = await request(pages.getAllKeys(indices(key)));
    return { chapter, indices: keys.map(pageKey => pageKey[3]) };
  });
}

async function readerBlob(key, index) {
  const [site, workId, chapterId] = key;
  const result = await lookupPage({ site, workId, chapterId, index }, true);
  return result.blob;
}

async function setLimit(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error(t('invalidLimit'));
  return transaction(stores, 'readwrite', async tables => {
    const state = await readState(tables.settings);
    await makeRoom(tables, state, state.used - bytes);
    state.limit = bytes;
    tables.settings.put(state, 'storage');
  });
}

async function setFavorite(key, enabled) {
  return transaction(['chapters', 'favoriteWorks'], 'readwrite', async tables => {
    if (key.length === 2) {
      if (!key[1]) throw new Error(t('noWork'));
      if (enabled) tables.favoriteWorks.put(true, key);
      else tables.favoriteWorks.delete(key);
      return;
    }
    const chapter = await request(tables.chapters.get(key));
    if (!chapter) throw new Error(t('chapterRemoved'));
    chapter.favorite = enabled;
    tables.chapters.put(chapter, key);
  });
}

  let shelfEvents;

function getShelfEvents() {
  if (shelfEvents) return shelfEvents;
  const changes = new EventTarget();
  let channel;
  try {
    channel = new BroadcastChannel('komaglide-site-shelf-v1');
  } catch { /* A shelf opened later still reads the saved pages directly. */ }
  const dispatch = detail => changes.dispatchEvent(new CustomEvent('change', {detail}));
  if (channel) channel.onmessage = ({data}) => {
    if (typeof data?.kind === 'string') dispatch(data);
  };
  shelfEvents = {
    changes,
    announce(detail) {
      dispatch(detail);
      channel?.postMessage(detail);
    },
    messageFor(error) {
      return error?.name === 'QuotaExceededError'
        ? t('quotaExceeded')
        : error?.message || t('libraryAccessFailed');
    }
  };
  return shelfEvents;
}

function notifyPageSaved({site, workId, chapterId}) {
  getShelfEvents().announce({kind: 'saved', site, workId, chapterId});
}

  // ZIP32 reserves the maximum field values as ZIP64 markers.
const zipEntryLimit = 0xfffe;
const zipSizeLimit = 0xfffffffe;
const zipExtensions = {
  jpeg: 'jpg', png: 'png', apng: 'apng', webp: 'webp', gif: 'gif',
  avif: 'avif', bmp: 'bmp', 'x-icon': 'ico', 'vnd.microsoft.icon': 'ico',
};

function validateComicZip(chapters) {
  let entries = 0;
  let bytes = 22;
  for (const chapter of chapters) {
    entries += chapter.count;
    bytes += chapter.bytes + chapter.count * 76;
  }
  if (entries > zipEntryLimit || bytes > zipSizeLimit) throw new Error(t('exportTooLarge'));
}

function zipTitle(title) {
  const safe = title.normalize('NFC')
    .replace(/[<>:"/\\|?*\p{Cc}\p{Bidi_Control}]/gu, '_')
    .trim();
  return Array.from(safe).slice(0, 28).join('').replace(/[. ]+$/u, '') || '_';
}

function zipEntries(chapters) {
  const groups = new Map();
  for (const { chapter, pages } of chapters) {
    const key = JSON.stringify(chapter.workKnown ? chapter.key.slice(0, 2) : chapter.key);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ chapter, pages });
  }
  const entries = [];
  const encoder = new TextEncoder();
  const number = (index, width) => String(index).padStart(width, '0');
  let groupIndex = 0;
  for (const group of groups.values()) {
    const first = group[0].chapter;
    const groupNumber = number(++groupIndex, String(groups.size).length);
    const folder = groupNumber + ' - ' + zipTitle(first.workKnown ? first.workTitle : first.chapterTitle);
    for (const [index, { chapter, pages }] of group.entries()) {
      const path = chapter.workKnown
        ? folder + '/' + number(index + 1, String(group.length).length) + ' - ' + zipTitle(chapter.chapterTitle)
        : folder;
      const width = Math.max(3, String(pages.at(-1).index).length);
      for (const page of pages) {
        const subtype = /^image\/([a-z0-9.-]+)$/i.exec(page.blob.type)?.[1].toLowerCase();
        const extension = Object.hasOwn(zipExtensions, subtype) ? zipExtensions[subtype] : 'bin';
        const name = encoder.encode(path + '/' + number(page.index, width) + '.' + extension);
        entries.push({ name, blob: page.blob });
      }
    }
  }
  return entries;
}

const zipCrcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return value;
});

async function zipCrc(blob, signal, yieldIfNeeded) {
  const chunkSize = 1024 ** 2;
  let crc = 0xffffffff;
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    signal.throwIfAborted();
    const bytes = new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer());
    for (const byte of bytes) crc = (crc >>> 8) ^ zipCrcTable[(crc ^ byte) & 0xff];
    const pause = yieldIfNeeded();
    if (pause) await pause;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipHeaders(name, size, crc, offset) {
  // APPNOTE 4.3.7 and 4.3.12. Method 0 stores the original image bytes.
  const local = new Uint8Array(30 + name.length);
  const file = new DataView(local.buffer);
  file.setUint32(0, 0x04034b50, true);
  file.setUint16(4, 10, true);
  file.setUint16(6, 1 << 11, true); // UTF-8 names.
  file.setUint16(12, 0x21, true); // DOS date 1980-01-01.
  file.setUint32(14, crc, true);
  file.setUint32(18, size, true);
  file.setUint32(22, size, true);
  file.setUint16(26, name.length, true);
  local.set(name, 30);

  const central = new Uint8Array(46 + name.length);
  const directory = new DataView(central.buffer);
  directory.setUint32(0, 0x02014b50, true);
  directory.setUint16(4, 20, true);
  central.set(local.subarray(4, 30), 6);
  directory.setUint32(42, offset, true);
  central.set(name, 46);
  return { local, central };
}

async function makeComicZip(chapters, { signal, progress }) {
  validateComicZip(chapters.map(({ chapter }) => chapter));
  const entries = zipEntries(chapters);
  const bytes = entries.reduce((sum, { name, blob }) => sum + 76 + 2 * name.length + blob.size, 22);
  if (entries.length > zipEntryLimit || bytes > zipSizeLimit) throw new Error(t('exportTooLarge'));
  const files = [];
  const directory = [];
  let offset = 0;
  let directorySize = 0;
  let lastYield = performance.now();
  function yieldIfNeeded() {
    if (performance.now() - lastYield < 32) return;
    return new Promise(resolve => setTimeout(() => {
      lastYield = performance.now();
      resolve();
    }, 0));
  }
  progress(0, entries.length);
  for (const [index, { name, blob }] of entries.entries()) {
    const crc = await zipCrc(blob, signal, yieldIfNeeded);
    signal.throwIfAborted();
    const { local, central } = zipHeaders(name, blob.size, crc, offset);
    files.push(local, blob);
    directory.push(central);
    offset += local.length + blob.size;
    directorySize += central.length;
    if (index % 16 === 0 || index + 1 === entries.length) progress(index + 1, entries.length);
  }

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);
  return new Blob([...files, ...directory, end.buffer], { type: 'application/zip' });
}

  
function mountShelf(routePrefix, { announce, changes, messageFor, saveLanguage }) {
  localizeDocument();
  const $ = id => document.getElementById(id);
  const languagePicker = $('library-language');
  for (const [value, label] of Object.entries(localeNames)) {
    const option = new Option(label, value);
    option.lang = value;
    languagePicker.add(option);
  }
  languagePicker.value = locale;
  languagePicker.addEventListener('change', async () => {
    languagePicker.disabled = true;
    try {
      await saveLanguage(languagePicker.value);
      location.reload();
    } catch {
      languagePicker.value = locale;
      languagePicker.disabled = false;
      notify(t('languageSaveFailed'));
    }
  });
  for (const link of document.querySelectorAll('a[href^="#"]')) {
    link.hash = routePrefix + link.hash.slice(1);
  }
  const collator = new Intl.Collator(locale, { numeric: true });
  let version = 0;
  let refreshTimer;
  let disposePages = () => {};
  let pageAtViewport = () => 1;
  let activeKey;
  let retentionCheck = 0;
  let pendingRetentionRequest;
  const selectedChapters = new Set();
  let exportRows = [];
  let exportJob;
  let zipClickedAt = 0;
  const MiB = 1024 ** 2;
  const preferencesKey = 'komaglide.reader.preferences.v1';

  function readPreferences() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(preferencesKey)); } catch { /* Storage may be unavailable. */ }
    return {
      mode: ['single', 'double'].includes(saved?.mode) ? saved.mode : 'scroll',
      theme: ['light', 'dark'].includes(saved?.theme) ? saved.theme : 'system',
      direction: saved?.direction === 'ltr' ? 'ltr' : 'rtl',
      tapToTurn: saved?.tapToTurn !== false,
      thumbnailSize: ['small', 'large'].includes(saved?.thumbnailSize) ? saved.thumbnailSize : 'medium',
    };
  }

  let libraryPreferences = readPreferences();
  let updateReaderPreferences;
  const themePicker = $('library-theme');
  const themeColor = document.querySelector('meta[name="theme-color"]');
  const setLibraryTheme = watchReaderTheme(theme => {
    const root = document.documentElement;
    if (root.dataset.readerTheme === theme) return;
    root.dataset.readerTheme = theme;
    themeColor.content = getComputedStyle(root).getPropertyValue('--paper').trim();
  });

  function applyLibraryPreferences(next) {
    libraryPreferences = next;
    themePicker.value = next.theme;
    setLibraryTheme(next.theme);
    updateReaderPreferences?.(next);
  }

  function changePreference(field, value) {
    const next = { ...libraryPreferences, [field]: value };
    applyLibraryPreferences(next);
    try { localStorage.setItem(preferencesKey, JSON.stringify(next)); } catch { /* Keep the choice for this tab. */ }
  }

  applyLibraryPreferences(libraryPreferences);
  themePicker.addEventListener('change', () => changePreference('theme', themePicker.value));
  window.addEventListener('storage', event => {
    if (event.key === preferencesKey || event.key === null) applyLibraryPreferences(readPreferences());
  });

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function notify(text = '', tone = '') {
    const notice = $('notice');
    notice.dataset.tone = tone;
    notice.textContent = text;
    notice.hidden = !text;
    return notice;
  }

  async function readStorageProtection(method) {
    try {
      const storage = navigator.storage;
      if (typeof storage?.[method] !== 'function') return {state: 'unsupported'};
      return {state: await storage[method]() ? 'granted' : 'not-granted'};
    } catch (error) {
      return {state: 'error', detail: [error?.name, error?.message].filter(Boolean).join(' · ') || String(error)};
    }
  }

  function storageProtectionMessage({state}, isRequest) {
    if (state === 'granted') return t('persistenceGranted');
    if (state === 'not-granted') return t(isRequest ? 'persistenceDenied' : 'persistenceNotGranted');
    if (state === 'unsupported') return t(isRequest ? 'persistenceRequestUnsupported' : 'persistenceCheckUnsupported');
    return t(isRequest ? 'persistenceRequestFailed' : 'persistenceCheckFailed');
  }

  function showStorageDiagnostic(element, result, isRequest, api) {
    element.textContent = storageProtectionMessage(result, isRequest);
    if (result.state === 'granted') return;
    const detail = result.state === 'not-granted' ? t('returnedFalse', {api}) : [api, result.detail].filter(Boolean).join(' · ');
    element.append(el('span', detail, 'notice-detail'));
  }

  async function checkStorageProtection() {
    const check = ++retentionCheck;
    const status = $('retention');
    status.textContent = t('checkingPersistence');
    const result = await readStorageProtection('persisted');
    if (check === retentionCheck) showStorageDiagnostic(status, result, false, 'navigator.storage.persisted()');
  }

  function requestStorageProtection() {
    if (pendingRetentionRequest) return pendingRetentionRequest;
    // Start during the click so browser policies that require a gesture can apply.
    const pending = pendingRetentionRequest = readStorageProtection('persist');
    const button = $('request-retention');
    const status = $('retention-result');
    button.disabled = true;
    status.textContent = t('requestingPersistence');
    void pending.then(result => {
      pendingRetentionRequest = null;
      showStorageDiagnostic(status, result, true, 'navigator.storage.persist()');
      button.disabled = false;
      if (!$('storage').hidden) void checkStorageProtection();
    });
    return pending;
  }

  function size(bytes) {
    if (bytes >= 1024 * MiB) return (bytes / (1024 * MiB)).toLocaleString(locale, { maximumFractionDigits: 2 }) + ' GiB';
    if (bytes >= MiB) return (bytes / MiB).toLocaleString(locale, { maximumFractionDigits: 1 }) + ' MiB';
    if (bytes >= 1024) return Math.ceil(bytes / 1024) + ' KiB';
    return bytes + ' B';
  }

  function chapterHref(key) {
    return routePrefix + 'read/' + key.map(encodeURIComponent).join('/');
  }

  function japaneseSubtitle(chapter, tag, className) {
    const subtitle = el(tag, chapter.chapterSubtitle, className);
    subtitle.lang = 'ja';
    return subtitle;
  }

  function chapterLink(chapter, label = chapter.chapterTitle) {
    const link = el('a', label, 'chapter-link');
    link.href = chapterHref(chapter.key);
    return link;
  }

  function shelfChapterLink(chapter, checkboxId) {
    const link = checkboxId ? el('label', chapter.chapterTitle, 'chapter-link') : chapterLink(chapter);
    if (checkboxId) link.htmlFor = checkboxId;
    // Only separate an explicit chapter number from a named title. Keep the
    // original wording and separator for copying and assistive technology.
    const parts = /^(第\s*[0-9０-９〇零一二三四五六七八九十百千萬兩]+(?:[.．][0-9０-９]+)?\s*[話集章回卷冊]|(?:chapter|episode)\s+\d+(?:\.\d+)?)([：:]\s*|\s+)(\S[\s\S]*)$/iu.exec(chapter.chapterTitle);
    if (parts) {
      const [, number, separator, title] = parts;
      const punctuation = separator.trimEnd();
      const heading = el('span', null, 'chapter-heading');
      const ordinal = el('span', number + punctuation, 'chapter-ordinal');
      ordinal.append(el('span', separator.slice(punctuation.length), 'chapter-separator'));
      heading.append(ordinal, el('span', title));
      link.replaceChildren(heading);
    }
    if (chapter.chapterSubtitle) link.append(japaneseSubtitle(chapter, 'span', 'chapter-subtitle'));
    return link;
  }

  function chaptersInOrder(a, b) {
    if (Number.isFinite(a.order) && Number.isFinite(b.order) && a.order !== b.order) return a.order - b.order;
    return collator.compare(a.chapterTitle, b.chapterTitle) || collator.compare(a.key[2], b.key[2]);
  }

  function countText(chapter) {
    return t(chapter.total ? 'savedKnownTotal' : 'savedUnknownTotal', {count: chapter.count, total: chapter.total});
  }

  function favoriteButton(key, enabled) {
    const label = key.length === 3
      ? t(enabled ? 'favoritedChapter' : 'favoriteChapter')
      : t(enabled ? 'favoritedWork' : 'favoriteWork');
    const button = el('button', label, 'favorite');
    button.type = 'button';
    button.id = 'kg-favorite-' + key.map(encodeURIComponent).join('/');
    button.setAttribute('aria-pressed', String(enabled));
    if (key.length === 3) {
      const ns = 'http://www.w3.org/2000/svg';
      const icon = document.createElementNS(ns, 'svg');
      icon.setAttribute('aria-hidden', 'true');
      icon.setAttribute('viewBox', '0 0 24 24');
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', 'M6.25 4.75a1 1 0 0 1 1-1h9.5a1 1 0 0 1 1 1v15.5L12 16.3l-5.75 3.95z');
      icon.append(path);
      button.replaceChildren(icon);
      button.setAttribute('aria-label', label);
      button.title = label;
    }
    button.onclick = async () => {
      if (button.getAttribute('aria-disabled') === 'true') return;
      button.setAttribute('aria-disabled', 'true');
      const route = location.hash;
      const retention = enabled ? null : requestStorageProtection();
      try {
        await setFavorite(key, !enabled);
        announce({ kind: 'favorite' });
        if (location.hash !== route) return;
        const notice = notify(enabled ? t('removedFavorite') : t('addedFavorite'), 'success');
        if (retention) {
          const detail = el('span', '', 'notice-detail');
          notice.append(detail);
          void retention.then(result => {
            if (result.state === 'granted') return;
            const link = el('a', t('storageDiagnostics'));
            link.href = routePrefix + 'storage';
            detail.append(storageProtectionMessage(result, true), ' ', link);
          });
        }
      } catch (error) {
        notify(messageFor(error));
      } finally {
        button.removeAttribute('aria-disabled');
      }
    };
    return button;
  }

  function exportStatus(text = '', error = false) {
    const status = $('export-status');
    status.toggleAttribute('data-error', error);
    status.textContent = text;
    status.hidden = !text;
  }

  function clearPreparedZip() {
    exportJob?.abort();
    exportJob = undefined;
    const download = $('export-download');
    const url = download.getAttribute('href');
    if (url) {
      const delay = zipClickedAt ? 60_000 - (Date.now() - zipClickedAt) : 0;
      if (delay > 0) setTimeout(() => URL.revokeObjectURL(url), delay);
      else URL.revokeObjectURL(url);
      download.removeAttribute('href');
      download.removeAttribute('download');
    }
    download.hidden = true;
    $('export-prepare').hidden = false;
    zipClickedAt = 0;
    exportStatus();
  }

  function updateExportControls() {
    let pages = 0;
    for (const { checkbox, chapter } of exportRows) {
      checkbox.checked = selectedChapters.has(checkbox.id);
      checkbox.disabled = !!exportJob;
      if (checkbox.checked) pages += chapter.count;
    }
    const all = $('export-select-all');
    all.textContent = t(exportRows.length && selectedChapters.size === exportRows.length ? 'exportClear' : 'exportSelectAll');
    all.disabled = !!exportJob || !exportRows.length;
    $('export-prepare').disabled = !!exportJob || !selectedChapters.size;
    const summary = t('exportSelected', {count: selectedChapters.size.toLocaleString(locale), pages: pages.toLocaleString(locale)});
    if ($('export-selection').textContent !== summary) $('export-selection').textContent = summary;
  }

  function exportCheckbox(chapter, checkbox) {
    const target = el('label', null, 'export-check');
    target.append(checkbox);
    exportRows.push({ chapter, checkbox });
    checkbox.onchange = () => {
      clearPreparedZip();
      if (checkbox.checked) selectedChapters.add(checkbox.id);
      else selectedChapters.delete(checkbox.id);
      updateExportControls();
    };
    return target;
  }

  $('export-select-all').onclick = () => {
    clearPreparedZip();
    const clear = selectedChapters.size === exportRows.length;
    selectedChapters.clear();
    if (!clear) for (const { checkbox } of exportRows) selectedChapters.add(checkbox.id);
    updateExportControls();
  };
  $('export-download').onclick = () => { zipClickedAt = Date.now(); };
  $('export-prepare').onclick = async () => {
    if (exportJob || !selectedChapters.size) return;
    const prepare = $('export-prepare');
    const keys = exportRows.filter(({ checkbox }) => selectedChapters.has(checkbox.id)).map(({ chapter }) => chapter.key);
    clearPreparedZip();
    const job = exportJob = new AbortController();
    const { signal } = job;
    updateExportControls();
    exportStatus(t('exportReading'));
    try {
      const chapters = await readExportChapters(keys, validateComicZip, signal);
      const blob = await makeComicZip(chapters, { signal, progress: (done, total) => {
        if (!signal.aborted) exportStatus(t('exportPackaging', {done, total}));
      }});
      if (signal.aborted) return;
      const download = $('export-download');
      const host = location.hostname.replace(/[^a-z0-9.-]/gi, '_');
      download.href = URL.createObjectURL(blob);
      download.download = 'KomaGlide-' + host + '-' + new Date().toISOString().slice(0, 10) + '.zip';
      download.hidden = false;
      if (document.activeElement === document.body || document.activeElement === prepare) download.focus({preventScroll: true});
      prepare.hidden = true;
      exportStatus(t('exportReady'));
    } catch (error) {
      if (signal.aborted) return;
      const known = ['exportChapterMissing', 'exportTooLarge'].map(key => t(key));
      exportStatus(known.includes(error?.message) ? error.message : t('exportFailed'), true);
    } finally {
      if (exportJob === job) {
        exportJob = undefined;
        updateExportControls();
      }
    }
  };

  function showBooks(data, starred, exporting) {
    const protectedWorks = new Set(data.favorites.map(key => JSON.stringify(key)));
    const groups = new Map();
    for (const chapter of data.chapters) {
      const workKey = chapter.key.slice(0, 2);
      const workStar = chapter.workKnown && protectedWorks.has(JSON.stringify(workKey));
      if (starred && !workStar && !chapter.favorite) continue;
      const id = JSON.stringify(chapter.workKnown ? workKey : chapter.key);
      if (!groups.has(id)) groups.set(id, { chapters: [], workKey, workStar, recent: chapter });
      const group = groups.get(id);
      group.chapters.push(chapter);
      if (chapter.lastRead > group.recent.lastRead) group.recent = chapter;
    }
    exportRows = [];
    const frag = document.createDocumentFragment();
    for (const group of [...groups.values()].sort((a, b) => b.recent.lastRead - a.recent.lastRead)) {
      const { recent, workKey, workStar } = group;
      const article = el('article', null, 'work');
      const head = el('div', null, 'work-head');
      const names = el('div');
      const count = group.chapters.length;
      names.append(el('h2', recent.workKnown ? recent.workTitle : t('ungrouped')),
        el('span', recent.key[0] + ' · ' + t(count === 1 ? 'chapterCountOne' : 'chapterCount', {count}), 'source'));
      head.append(names);
      if (!exporting && recent.workKnown) head.append(favoriteButton(workKey, workStar));
      article.append(head);
      for (const chapter of group.chapters.sort(chaptersInOrder)) {
        const row = el('div', null, 'chapter-row');
        const action = exporting ? el('input') : favoriteButton(chapter.key, chapter.favorite);
        if (exporting) {
          action.type = 'checkbox';
          action.id = 'kg-export-' + chapter.key.map(encodeURIComponent).join('/');
        }
        const link = shelfChapterLink(chapter, exporting ? action.id : null);
        link.id = 'title-' + action.id;
        action.setAttribute(exporting ? 'aria-labelledby' : 'aria-describedby', link.id);
        row.append(link, el('span', countText(chapter), 'count'), exporting ? exportCheckbox(chapter, action) : action);
        article.append(row);
      }
      frag.append(article);
    }
    if (!groups.size) {
      const empty = el('div', null, 'empty');
      empty.append(el('h2', starred ? t('noFavorites') : t('noComics')),
        el('p', starred ? t('favoritesHint') :
          t('emptyShelfHint')));
      frag.append(empty);
    }
    const books = $('books');
    const focusedId = books.contains(document.activeElement) && document.activeElement.id;
    books.replaceChildren(frag);
    if (exporting) {
      const visible = new Set(exportRows.map(({ checkbox }) => checkbox.id));
      const previousCount = selectedChapters.size;
      for (const id of selectedChapters) if (!visible.has(id)) selectedChapters.delete(id);
      if (selectedChapters.size !== previousCount) {
        clearPreparedZip();
        exportStatus(t('exportChapterMissing'), true);
      }
      updateExportControls();
    }
    if (focusedId) {
      const nextFocus = $(focusedId) || $(exporting ? 'export-tab' : starred ? 'star-tab' : 'all-tab');
      nextFocus.focus({ preventScroll: true });
    }
  }

  function addPages(key, chapter, indices, initialPage) {
    const list = $('pages');
    const toolbar = $('reader-tools');
    const saved = new Set(indices);
    const total = Math.max(chapter.total || 0, indices.at(-1) || 1);
    let current = Math.max(1, Math.min(initialPage, total));
    let preferences = libraryPreferences;
    let scrollAnchor;
    const pending = new Map();
    const urls = new Map();
    function release(slot) {
      pending.delete(slot);
      if (urls.has(slot)) URL.revokeObjectURL(urls.get(slot));
      urls.delete(slot);
      slot.replaceChildren();
    }
    async function load(slot) {
      const token = Symbol();
      pending.set(slot, token);
      try {
        const index = Number(slot.dataset.index);
        const blob = await readerBlob(key, index);
        if (pending.get(slot) !== token) return;
        if (!blob) throw new Error(t('pageRemoved'));
        const img = el('img');
        const url = URL.createObjectURL(blob);
        urls.set(slot, url);
        img.dataset.index = String(index);
        img.alt = t('pageNumber', {page: index});
        img.onload = () => {
          if (img.naturalWidth && img.naturalHeight) slot.style.aspectRatio = img.naturalWidth + ' / ' + img.naturalHeight;
        };
        img.onerror = () => {
          if (pending.get(slot) === token) slot.replaceChildren(el('p', t('decodeFailed', {page: index}), 'gap'));
        };
        img.src = url;
        slot.replaceChildren(img);
      } catch (error) {
        if (pending.get(slot) === token) slot.replaceChildren(el('p', messageFor(error), 'gap'));
      }
    }
    const observer = new IntersectionObserver(entries => {
      for (const { target, isIntersecting } of entries) {
        if (isIntersecting && !pending.has(target) && list.contains(target)) load(target);
        if (!isIntersecting) release(target);
      }
    }, { rootMargin: '1400px 0px' });
    function gap(first, last) {
      if (first > last) return;
      const range = first === last ? String(first) : first + '–' + last;
      const missing = el('p', t('missingPages', {range}), 'gap');
      missing.dataset.first = first;
      missing.dataset.last = last;
      list.append(missing);
    }
    function figureAt(index) {
      const figure = el('figure');
      figure.dataset.first = index;
      const slot = el('div', null, 'page-slot');
      slot.dataset.index = String(index);
      figure.append(el('figcaption', t('pageNumber', {page: index})), slot);
      list.append(figure);
      observer.observe(slot);
    }
    function clear() {
      observer.disconnect();
      observer.takeRecords();
      for (const slot of pending.keys()) release(slot);
      list.replaceChildren();
    }
    function alignToPage() {
      const row = [...list.children].find(node => Number(node.dataset.first) <= current &&
        Number(node.dataset.last || node.dataset.first) >= current);
      if (!row) return;
      window.scrollBy(0, row.getBoundingClientRect().top);
      scrollAnchor = { page: current, y: window.scrollY };
    }
    pageAtViewport = () => {
      if (preferences.mode !== 'scroll') return current;
      // A short final page may share the viewport with its predecessor after a jump.
      if (scrollAnchor?.y === window.scrollY) return scrollAnchor.page;
      scrollAnchor = undefined;
      const row = [...list.children].find(node => node.getBoundingClientRect().bottom > 1);
      return row ? Number(row.dataset.first) : total;
    };
    function draw(align = false) {
      clear();
      scrollAnchor = undefined;
      $('reader').dataset.mode = preferences.mode;
      document.documentElement.classList.toggle('paged-reader', preferences.mode !== 'scroll');
      if (preferences.mode === 'scroll') {
        let next = 1;
        for (const index of indices) {
          gap(next, index - 1);
          figureAt(index);
          next = index + 1;
        }
        gap(next, total);
      } else {
        const first = preferences.mode === 'double' ? current - ((current - 1) % 2) : current;
        const last = preferences.mode === 'double' ? Math.min(first + 1, total) : first;
        for (let index = first; index <= last; index++) {
          if (saved.has(index)) figureAt(index);
          else gap(index, index);
        }
        if (align) window.scrollTo(0, 0);
      }
      controls.update({ ...preferences, current, total });
      if (align && preferences.mode === 'scroll') alignToPage();
    }
    function applyPreferences(next) {
      const modeChanged = next.mode !== preferences.mode;
      if (modeChanged) current = pageAtViewport();
      preferences = next;
      list.dir = next.mode === 'double' ? next.direction : 'ltr';
      if (modeChanged) draw(true);
      else controls.update({ ...preferences, current, total });
    }
    const controls = mountReaderControls(toolbar, {
      ...preferences, keyTarget: document, tapTarget: list,
      settingsExtras: [$('chapter-head'), $('reader-return')],
      navigationExtras: $('reader-end').childElementCount ? [$('reader-end')] : [],
      onMode: mode => changePreference('mode', mode),
      onTheme: theme => changePreference('theme', theme),
      onDirection: direction => changePreference('direction', direction),
      onTapToTurn: enabled => changePreference('tapToTurn', enabled),
      onThumbnailSize: size => changePreference('thumbnailSize', size),
      getCurrentPage: () => pageAtViewport(),
      getThumbnail: async (index, size) => saved.has(index) ? makeReaderThumbnail(await readerBlob(key, index), size) : null,
      onPick: page => {
        current = page;
        if (preferences.mode === 'scroll') {
          alignToPage();
          controls.update({ current });
        } else draw();
      },
      onTurn: page => { current = page; draw(); },
    });
    updateReaderPreferences = applyPreferences;
    list.dir = preferences.mode === 'double' ? preferences.direction : 'ltr';
    document.documentElement.classList.add('reading-chapter');
    draw(initialPage > 1);
    disposePages = () => {
      disposePages = () => {};
      updateReaderPreferences = undefined;
      controls.destroy();
      clear();
      delete $('reader').dataset.mode;
      document.documentElement.classList.remove('reading-chapter', 'paged-reader');
      pageAtViewport = () => 1;
    };
  }

  function chapterNeighbors(chapter, chapters) {
    const related = chapters.filter(c => c.workKnown && chapter.workKnown &&
      c.key[0] === chapter.key[0] && c.key[1] === chapter.key[1]).sort(chaptersInOrder);
    const i = related.findIndex(c => c.key[2] === chapter.key[2]);
    const links = [];
    if (i > 0) links.push(chapterLink(related[i - 1], t('previousChapter') + ' · ' + related[i - 1].chapterTitle));
    if (i >= 0 && related[i + 1]) links.push(chapterLink(related[i + 1], t('nextChapter') + ' · ' + related[i + 1].chapterTitle));
    return links;
  }

  async function render(reset = false) {
    const token = ++version;
    const hash = location.hash.slice(routePrefix.length);
    const reading = hash.startsWith('read/');
    const storage = hash === 'storage';
    const starred = hash === 'favorites';
    const exporting = hash === 'export';
    if (reset) {
      notify();
      disposePages();
      if (exporting !== !$('export-tools').hidden) $('books').replaceChildren();
      clearPreparedZip();
      selectedChapters.clear();
      exportRows = [];
      updateExportControls();
      activeKey = undefined;
      window.scrollTo(0, 0);
    }
    $('shelf').hidden = reading || storage;
    $('reader').hidden = !reading;
    $('storage').hidden = !storage;
    $('export-tools').hidden = !exporting;
    themePicker.parentElement.hidden = reading;
    if (reading && reset) {
      $('chapter-head').replaceChildren(el('h1', t('loadingChapter')));
      $('reader-end').replaceChildren();
    }
    try {
      if (reading) {
        const key = hash.slice(5).split('/').map(decodeURIComponent);
        if (key.length !== 3) throw new Error(t('invalidChapterUrl'));
        const result = await readChapter(key);
        if (version !== token) return;
        if (!result) throw new Error(t('chapterNotFound'));
        const { chapter, indices } = result;
        const data = await shelf();
        if (version !== token) return;
        const current = reset ? 1 : pageAtViewport();
        disposePages();
        activeKey = key;
        const source = (chapter.workKnown ? chapter.workTitle + ' · ' : '') + key[0];
        const heading = $('chapter-head');
        heading.replaceChildren(el('h1', chapter.chapterTitle));
        if (chapter.chapterSubtitle) heading.append(japaneseSubtitle(chapter, 'p', 'chapter-subtitle'));
        heading.append(el('p', source, 'source'), el('p', countText(chapter)));
        document.title = chapter.chapterTitle + ' · KomaGlide';
        $('reader-end').replaceChildren(...chapterNeighbors(chapter, data.chapters));
        addPages(key, chapter, indices, current);
        return;
      }
      const data = await shelf();
      if (version !== token) return;
      const { used, limit } = data.state;
      document.title = (storage ? t('storageSettings') : t('library')) + ' · KomaGlide';
      if (storage) {
        $('storage-summary').textContent = t('storageUsage', {used: size(used), limit: size(limit)});
        if (reset) $('limit').value = String(limit / MiB);
        if (reset) void checkStorageProtection();
      } else {
        $('usage').textContent = size(used) + ' / ' + size(limit);
        for (const [id, active] of [['all-tab', !starred && !exporting], ['star-tab', starred], ['export-tab', exporting]]) {
          if (active) $(id).setAttribute('aria-current', 'page');
          else $(id).removeAttribute('aria-current');
        }
        showBooks(data, starred, exporting);
      }
    } catch (error) {
      if (version === token) {
        if (reading) {
          disposePages();
          activeKey = undefined;
          $('chapter-head').replaceChildren(el('h1', t('chapterOpenFailed')));
          $('reader-end').replaceChildren();
        }
        notify(messageFor(error));
      }
    }
  }

  $('request-retention').onclick = requestStorageProtection;
  $('limit-form').onsubmit = async event => {
    event.preventDefault();
    const button = event.submitter;
    if (button) button.disabled = true;
    try {
      await setLimit(Number($('limit').value) * MiB);
      announce({ kind: 'limit' });
      notify(t('storageLimitSaved'));
    } catch (error) {
      notify(messageFor(error));
    } finally {
      if (button) button.disabled = false;
    }
  };

  changes.addEventListener('change', ({ detail }) => {
    if (detail.kind === 'error') {
      notify(detail.message);
      return;
    }
    if (location.hash.startsWith(routePrefix + 'read/')) {
      // Avoid losing the reading position when background transfers arrive.
      if (activeKey && detail.kind === 'saved' && activeKey[0] === detail.site &&
          activeKey[1] === detail.workId && activeKey[2] === detail.chapterId) {
        notify(t('newPagesSaved'));
        const refresh = el('button', t('refreshPages'));
        refresh.onclick = () => { notify(); render(); };
        $('notice').append(' ', refresh);
      }
      return;
    }
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => render(), 120);
  });

  window.addEventListener('hashchange', () => render(true));
  render(true);
}


  // Remember the page that can host each site's shelf. Comic bytes stay in that site's IndexedDB.
  let rememberedSite = false;
  async function rememberSite() {
    if (rememberedSite) return;
    rememberedSite = true;
    const url = new URL(location.href);
    url.hash = '';
    url.username = url.password = '';
    try {
      await write(PREFIX + 'shelf-entry.' + url.origin, url.href);
      await write(PREFIX + 'last-shelf-site', url.origin);
    } catch {
      rememberedSite = false;
    }
  }

  async function openShelf() {
    const siteEntry = origin => read(PREFIX + 'shelf-entry.' + origin);
    const current = webUrl(await siteEntry(location.origin));
    let entry = current?.origin === location.origin ? current : null;
    if (!entry) {
      const last = webUrl(await read(PREFIX + 'last-shelf-site'));
      const saved = last && webUrl(await siteEntry(last.origin));
      entry = saved && saved.origin === last.origin ? saved : new URL(location.href);
    }
    entry.hash = SHELF_HASH + 'shelf';
    GM_openInTab(entry.href, {active: true, setParent: false});
  }

  function displayShelf() {
    // This explicitly opened tab uses the comic site's storage origin. Its UI is bundled.
    // The chapter document has finished parsing. Drop its event handlers and
    // install the bundled DOM before mounting controls or observing page slots.
    const shell = new DOMParser().parseFromString("<!doctype html>\n<html lang=\"zh-Hant\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n  <meta name=\"theme-color\" content=\"#f7f6f2\">\n  <meta name=\"referrer\" content=\"no-referrer\">\n  <link rel=\"icon\" href=\"data:,\">\n  <title>本站書庫 · KomaGlide</title>\n<style>:root {\n  color-scheme: light;\n  font-family: \"DM Sans\", \"PingFang TC\", \"Microsoft JhengHei\", sans-serif;\n  line-height: 1.6;\n  color: var(--ink);\n  background: var(--paper);\n  --ink: #222520;\n  --muted: #586158;\n  --line: #d4d7cd;\n  --accent: #305c46;\n  --paper: #f7f6f2;\n  --panel: #e9ede2;\n  --slot: #edeee7;\n  --field: #fff;\n  --field-border: #9ca79b;\n  --hover: #e3e9df;\n  --active: #d3ded0;\n  --favorite-ink: #23492d;\n  --favorite-fill: #e3ecd7;\n  --favorite-border: #72866a;\n  --on-accent: #fff;\n  --accent-hover: #244432;\n}\n:root[data-reader-theme=\"dark\"] {\n  color-scheme: dark;\n  --ink: #e8ebe5;\n  --muted: #b2baaf;\n  --line: #434c43;\n  --accent: #b3dbbc;\n  --paper: #161a17;\n  --panel: #202721;\n  --slot: #202520;\n  --field: #29302a;\n  --field-border: #798779;\n  --hover: #344238;\n  --active: #415146;\n  --favorite-ink: #c3dfbe;\n  --favorite-fill: #2d3d30;\n  --favorite-border: #798e78;\n  --on-accent: #192d20;\n  --accent-hover: #c5e5cd;\n}\n:root[data-reader-theme=\"dark\"] :focus-visible {\n  outline-color: #a4c790;\n}\n:root[data-reader-theme=\"dark\"] ::selection {\n  background: #416049;\n  color: #f2f5f0;\n}\n* { box-sizing: border-box; }\nbody { margin: 0; }\n[hidden] { display: none !important; }\nbutton, input { font: inherit; }\na { color: inherit; text-underline-offset: .24em; }\na:hover { color: var(--accent); }\nbutton { cursor: pointer; }\nbutton:disabled { opacity: .55; cursor: wait; }\n:focus-visible { outline: 3px solid #6a8552; outline-offset: 3px; }\n::selection { background: #d6e5c4; }\n.masthead { border-bottom: 1px solid var(--line); }\n.topline, main { width: min(100% - 3rem, 64rem); margin-inline: auto; }\n.topline { min-height: 3.35rem; display: flex; align-items: center; justify-content: space-between; gap: .5rem; }\n.masthead-tools { display: flex; min-width: 0; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: .25rem .75rem; padding-block: .5rem; }\n.brand { font-family: \"DM Sans\", sans-serif; font-size: 1.2rem; font-weight: 750; letter-spacing: -.035em; text-decoration: none; }\n#offline-state, .source, .count, #usage, .hint, figcaption, .back { color: var(--muted); font-size: .88rem; }\n#offline-state { font-size: .75rem; overflow-wrap: anywhere; }\nmain { padding-block: 3rem 5rem; }\nh1, h2, p, figure { margin: 0; }\nh1, h2 { overflow-wrap: anywhere; line-height: 1.35; }\nh1 { font-size: 2.5rem; letter-spacing: -.025em; }\nh2 { font-size: 1.26rem; }\n.title-row, .work-head, .shelf-tools { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }\n.title-row { margin-bottom: 1.1rem; }\n.title-row h1 { min-width: 0; font-size: clamp(1.8125rem, 3vw, 2.25rem); letter-spacing: .015em; }\n.nav-action, button { border: 1px solid var(--field-border); border-radius: .35rem; background: transparent; padding: .38rem .75rem; color: var(--ink); text-decoration: none; white-space: nowrap; }\n.nav-action { color: var(--muted); font-size: .8125rem; padding: .32rem .56rem; border-color: var(--line); }\n.nav-action:hover, button:enabled:hover { background: var(--hover); }\n.nav-action:active, button:enabled:active { background: var(--active); }\n.shelf-tools { border-bottom: 1px solid var(--line); flex-wrap: wrap; gap: .25rem 1rem; }\n.shelf-tools nav { display: flex; flex-wrap: wrap; column-gap: 1.3rem; }\n.shelf-tools a { display: flex; align-items: center; min-height: 44px; padding-bottom: .375rem; font-size: .875rem; color: var(--muted); text-decoration: none; }\n.shelf-tools a[aria-current] { color: var(--accent); box-shadow: inset 0 -2px var(--accent); font-weight: 700; }\n#usage, .count, figcaption { font-variant-numeric: tabular-nums; }\n#usage, .work .source, .chapter-row .count { font-size: .75rem; }\n.work { padding-top: clamp(1.5rem, 3vw, 2rem); }\n.work-head { margin-bottom: .875rem; }\n.work-head > div { min-width: 0; }\n.work-head h2 {\n  font: 700 clamp(1.9375rem, 3vw, 2.375rem)/1.35 \"Songti TC\", \"Noto Serif TC\", \"PMingLiU\", serif;\n  letter-spacing: .025em;\n}\n.source { overflow-wrap: anywhere; }\n.chapter-row {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) auto 44px;\n  align-items: center;\n  column-gap: 1rem;\n  border-top: 1px solid var(--line);\n  padding-block: .75rem;\n}\n.chapter-row:last-child { border-bottom: 1px solid var(--line); }\n.chapter-link { font-weight: 570; overflow-wrap: anywhere; }\n.chapter-row .chapter-link { display: block; min-width: 0; font-size: 1.125rem; line-height: 1.48; font-weight: 650; letter-spacing: .015em; text-decoration: none; }\n.chapter-row .chapter-link:is(:hover, :focus-visible) { color: var(--accent); text-decoration: underline; }\n.chapter-heading { display: flex; align-items: baseline; gap: .625rem; }\n.chapter-heading > span { min-width: 0; }\n.chapter-ordinal { flex: none; max-width: 42%; font-size: .8125rem; font-weight: 500; letter-spacing: normal; color: var(--muted); }\n.chapter-separator { font-size: 0; }\n.chapter-subtitle { display: block; color: var(--muted); font-size: .88rem; font-weight: normal; overflow-wrap: anywhere; }\n.favorite { color: var(--muted); font-size: .75rem; padding: .32rem .56rem; border-color: var(--line); }\n.favorite[aria-pressed=\"true\"] { color: var(--favorite-ink); border-color: var(--favorite-border); background: var(--favorite-fill); }\n.chapter-row .favorite { display: grid; place-items: center; justify-self: end; width: 44px; height: 44px; padding: 0; border: 0; background: transparent; }\n.chapter-row .favorite[aria-pressed=\"true\"] { color: var(--accent); }\n.chapter-row .favorite:hover { background: var(--hover); }\n.chapter-row .favorite:active { background: var(--active); }\n.favorite[aria-disabled=\"true\"] { opacity: .55; cursor: wait; }\n.chapter-row .favorite svg { width: 19px; height: 19px; stroke: currentColor; stroke-width: 1.6; stroke-linejoin: round; fill: none; }\n.chapter-row .favorite[aria-pressed=\"true\"] svg { fill: currentColor; }\n#export-tools { position: sticky; top: 0; z-index: 1; display: grid; gap: .25rem; padding-block: .75rem; background: var(--paper); border-bottom: 1px solid var(--line); }\n.export-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }\n.export-actions > :is(button, a) { display: inline-flex; align-items: center; min-height: 44px; font-size: .875rem; }\n#export-tools button:disabled { cursor: default; }\n#export-status { margin-top: .25rem; font-size: .875rem; overflow-wrap: anywhere; }\n#export-status[data-error] { font-weight: 650; }\n.export-check { display: grid; place-items: center; width: 44px; height: 44px; cursor: pointer; }\n.export-check input { margin: 0; width: 1.125rem; height: 1.125rem; accent-color: var(--accent); scroll-margin-top: 10rem; }\n.chapter-row label.chapter-link { cursor: pointer; }\n.empty { padding: 4.5rem 0; }\n.empty p, .hint { margin-top: .7rem; color: var(--muted); max-width: 39rem; }\n#notice { margin-bottom: 1.25rem; padding: .7rem 1rem; background: var(--notice-surface, #f2e9cf); color: var(--notice-ink, #574722); border-radius: .3rem; overflow-wrap: anywhere; }\n#notice[data-tone=\"success\"] { background: var(--favorite-fill); color: var(--favorite-ink); font-weight: 650; }\n.notice-detail { display: block; margin-top: .25rem; font-weight: 400; }\n.notice-detail:empty { display: none; }\n.notice-detail a { display: inline-block; }\n.storage-retention { margin-top: 1.75rem; overflow-wrap: anywhere; }\n#request-retention { margin-top: .75rem; min-height: 44px; }\n.back { display: inline-block; margin-bottom: 1.25rem; }\n#storage h1 { margin-bottom: 1rem; }\nform { margin: 1.75rem 0 0; }\nlabel { display: block; font-weight: 650; }\n.field { display: flex; gap: .65rem; margin-top: .5rem; }\ninput { min-width: 0; width: 9rem; padding: .4rem .6rem; border: 1px solid var(--field-border); border-radius: .35rem; background: var(--field); color: var(--ink); }\n.primary { color: var(--on-accent); background: var(--accent); border-color: var(--accent); }\n.primary:is(a, :enabled):is(:hover, :active) { color: var(--on-accent); background: var(--accent-hover); }\n#reader { max-width: 48rem; margin-inline: auto; }\n#chapter-head p { margin-top: .35rem; }\n.reading-chapter #chapter-head h1 { font-size: 1.12rem; }\n.reading-chapter #chapter-head p { color: var(--muted); font-size: .85rem; }\n.reading-chapter #reader-return { margin: 0; }\n#reader-end { display: grid; gap: .6rem; }\n#reader-end:empty { display: none; }\n#reader-tools { height: 0; }\n.reading-chapter .masthead { display: none; }\n.reading-chapter main { width: 100%; padding: 0; }\n.reading-chapter #notice {\n  position: fixed;\n  z-index: 1;\n  inset: auto 0 .75rem;\n  margin: auto;\n  width: max-content;\n  max-width: calc(100% - 2rem);\n  max-height: 35dvh;\n  overflow: auto;\n}\n#pages figcaption {\n  position: absolute;\n  width: 1px;\n  height: 1px;\n  overflow: hidden;\n  clip-path: inset(50%);\n  white-space: nowrap;\n}\n#reader[data-mode=\"scroll\"] #pages > * + * { margin-top: .25rem; }\n.page-slot { background: var(--slot); aspect-ratio: 2 / 3; width: 100%; }\n.page-slot img { display: block; width: 100%; height: auto; }\n.gap { padding: 1rem; text-align: center; background: var(--slot); color: var(--muted); }\n.theme-picker, .kg-reader-controls label {\n  display: flex;\n  align-items: center;\n  gap: .5rem;\n  font-size: .85rem;\n  font-weight: 500;\n  color: var(--muted);\n}\n.kg-reader-controls select, .theme-picker select {\n  border: 1px solid var(--field-border);\n  border-radius: .35rem;\n  color: var(--ink);\n  background: var(--field);\n  font: inherit;\n  font-size: .88rem;\n  padding: .3rem .55rem;\n  min-height: 2.1rem;\n}\n.kg-reader-controls select:hover, .theme-picker select:hover { background: var(--hover); }\n.theme-picker { flex: none; gap: .3125rem; font-size: .75rem; }\n.theme-picker select { min-height: 1.875rem; padding: .125rem .25rem; font-size: .75rem; border-color: var(--line); background: transparent; }\n.kg-reader-controls button:disabled { cursor: default; }\n.paged-reader #reader { max-width: none; }\n.paged-reader #pages {\n  display: flex;\n  justify-content: center;\n  width: 100%;\n  height: 100dvh;\n  gap: 2px;\n}\n.paged-reader #pages > * {\n  flex: 1 1 0;\n  min-width: 0;\n  direction: ltr;\n}\n.paged-reader .page-slot {\n  height: 100%;\n  background: transparent;\n}\n.paged-reader .page-slot img {\n  height: 100%;\n  object-fit: contain;\n}\n#pages[dir=\"rtl\"] { --first-spine: left; --second-spine: right; }\n#pages[dir=\"ltr\"] { --first-spine: right; --second-spine: left; }\n#reader[data-mode=\"double\"] figure:first-child:not(:only-child) img { object-position: var(--first-spine) center; }\n#reader[data-mode=\"double\"] figure:nth-child(2) img { object-position: var(--second-spine) center; }\n.paged-reader #pages > .gap { display: grid; place-items: center; }\n:root[data-reader-theme=\"dark\"] #notice { --notice-surface: #423b28; --notice-ink: #f0e2bc; }\n@media (max-width: 38rem) {\n  .topline, main { width: calc(100% - 2.5rem); }\n  main { padding-top: 1.6875rem; }\n  h1 { font-size: 1.95rem; }\n  .chapter-row { grid-template-columns: minmax(0, 1fr) 44px; column-gap: .375rem; padding-block: .8125rem .75rem; }\n  .chapter-row .count { grid-column: 1; margin-top: .125rem; }\n  .chapter-row :is(.favorite, .export-check) { grid-column: 2; grid-row: 1 / 3; }\n}\n@media (max-width: 22rem) {\n  .work-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .375rem .5rem; }\n  .work-head > div { display: contents; }\n  .work-head h2, .work-head > :only-child .source { grid-column: 1 / -1; }\n  .work-head .favorite { grid-column: 2; }\n}\n\n.kg-page-gestures { touch-action: pan-y pinch-zoom; }\n\n.kg-reader-controls input[type=\"checkbox\"] {\n  width: 1rem;\n  height: 1rem;\n  margin: 0;\n  padding: 0;\n  accent-color: var(--accent);\n}\n.kg-page-turns[data-direction=\"rtl\"] { flex-direction: row-reverse; }\n\ndialog.kg-thumb-picker {\n  position: fixed;\n  inset: 0;\n  margin: auto;\n  box-sizing: border-box;\n  width: 94vw;\n  height: 92dvh;\n  max-width: 100%;\n  max-height: 100dvh;\n  padding: 0;\n  overflow: hidden;\n  border: 1px solid var(--line);\n  border-radius: .6rem;\n  background: var(--paper);\n  color: var(--ink);\n  font: inherit;\n  text-align: start;\n}\ndialog.kg-thumb-picker[open] { display: flex; flex-direction: column; }\n.kg-thumb-picker::backdrop { background: rgb(9 14 10 / 68%); }\n.kg-thumb-head, .kg-thumb-footer {\n  display: flex;\n  flex: none;\n  align-items: center;\n  gap: .75rem;\n  padding: .75rem 1rem;\n}\n.kg-thumb-head { flex-wrap: wrap; border-bottom: 1px solid var(--line); }\n.kg-thumb-head strong { font-size: 1.1rem; margin: 0; }\n.kg-thumb-range {\n  color: var(--muted, var(--ink));\n  font-size: .85rem;\n  font-variant-numeric: tabular-nums;\n}\n.kg-thumb-head .kg-thumb-size {\n  display: inline-flex;\n  align-items: center;\n  gap: .4rem;\n  margin-inline-start: auto;\n  color: var(--muted, var(--ink));\n  font-size: .85rem;\n  white-space: nowrap;\n}\n.kg-thumb-size select { min-height: 2.1rem; }\n.kg-thumb-footer { justify-content: space-between; border-top: 1px solid var(--line); }\n.kg-thumb-grid {\n  --tile-min: 6rem;\n  display: grid;\n  flex: 1 1 0;\n  min-height: 0;\n  grid-template-columns: repeat(auto-fill, minmax(min(100%, var(--tile-min)), 1fr));\n  grid-auto-rows: max-content;\n  align-content: start;\n  gap: .75rem;\n  padding: 1rem;\n  overflow-y: auto;\n  overscroll-behavior: contain;\n  scroll-padding: 1rem;\n}\n.kg-thumb-grid[data-size=\"small\"] { --tile-min: 4rem; }\n.kg-thumb-grid[data-size=\"large\"] { --tile-min: clamp(15rem, 24vw, 26rem); }\n.kg-thumb-grid .kg-thumb-page {\n  display: flex;\n  flex-direction: column;\n  align-items: stretch;\n  gap: .22rem;\n  min-width: 0;\n  padding: .25rem;\n  border: 1px solid transparent;\n  border-radius: .35rem;\n  background: transparent;\n  color: var(--ink);\n  font: inherit;\n  font-size: .85rem;\n  font-variant-numeric: tabular-nums;\n  text-align: center;\n  white-space: normal;\n  cursor: pointer;\n}\n.kg-thumb-grid .kg-thumb-page:hover { background: var(--hover); }\n.kg-thumb-grid .kg-thumb-page[aria-current=\"page\"] {\n  border-color: var(--accent);\n  color: var(--accent);\n  font-weight: 700;\n}\n.kg-thumb-frame {\n  display: grid;\n  place-items: center;\n  width: 100%;\n  flex: none;\n  aspect-ratio: 3 / 4;\n  overflow: hidden;\n  background: var(--slot, var(--well));\n  color: var(--muted, var(--ink));\n  font-size: .8rem;\n}\n.kg-thumb-frame img {\n  display: block;\n  width: 100%;\n  height: 100%;\n  min-height: 0;\n  object-fit: contain;\n}\n@media (max-width: 38rem) {\n  dialog.kg-thumb-picker { width: calc(100vw - .5rem); height: calc(100dvh - 1rem); }\n  .kg-thumb-head { gap: .4rem .6rem; padding: .6rem; }\n  .kg-thumb-grid { --tile-min: 4.8rem; gap: .5rem; padding: .65rem; }\n  .kg-thumb-grid[data-size=\"small\"] { --tile-min: 3.3rem; }\n  .kg-thumb-grid[data-size=\"large\"] { --tile-min: 12rem; }\n}\n.kg-reader-controls {\n  --edge-width: 2.5rem;\n  --edge-surface: var(--paper);\n  display: contents;\n}\n.kg-edge, .kg-edge-panel {\n  display: flex;\n  align-items: center;\n}\n.kg-edge {\n  position: fixed;\n  top: 50%;\n  transform: translateY(-50%);\n  z-index: 8;\n  pointer-events: none;\n}\n.kg-edge-left { left: env(safe-area-inset-left, 0px); }\n.kg-edge-right { right: env(safe-area-inset-right, 0px); flex-direction: row-reverse; }\n.kg-reader-controls .kg-edge-toggle {\n  position: relative;\n  padding: .7rem .35rem;\n  width: var(--edge-width);\n  min-height: 3.8rem;\n  display: grid;\n  place-items: center;\n  border: 1px solid var(--line);\n  background: color-mix(in srgb, var(--edge-surface) 91%, transparent);\n  color: var(--ink);\n  font: inherit;\n  font-size: .8rem;\n  font-weight: 600;\n  letter-spacing: .1em;\n  line-height: 1;\n  writing-mode: vertical-rl;\n  text-orientation: upright;\n  pointer-events: auto;\n  cursor: pointer;\n}\n.kg-edge-left .kg-edge-toggle { border-left: 0; border-radius: 0 .45rem .45rem 0; }\n.kg-edge-right .kg-edge-toggle { border-right: 0; border-radius: .45rem 0 0 .45rem; }\n.kg-edge-toggle:lang(en) { text-orientation: mixed; }\n.kg-reader-controls .kg-edge-toggle:is(:hover, [aria-expanded=\"true\"]) {\n  background: var(--hover);\n  color: var(--accent);\n}\n.kg-edge .kg-edge-panel {\n  position: absolute;\n  width: 15rem;\n  max-width: calc(100vw - 2 * var(--edge-width) - 1.25rem);\n  max-height: calc(100dvh - 2rem);\n  flex-direction: column;\n  align-items: stretch;\n  gap: .65rem;\n  margin: 0;\n  padding: 1rem;\n  overflow: auto;\n  overscroll-behavior: contain;\n  border: 1px solid var(--line);\n  border-radius: .6rem;\n  background: var(--edge-surface);\n  color: var(--ink);\n  box-shadow: 0 .3rem 1.2rem rgb(0 0 0 / 18%);\n  font-size: .9rem;\n  line-height: 1.45;\n  pointer-events: auto;\n}\n.kg-edge-panel[hidden] { display: none; }\n.kg-edge-left .kg-edge-panel { left: calc(100% + .35rem); }\n.kg-edge-right .kg-edge-panel { right: calc(100% + .35rem); }\n.kg-edge-panel h2 {\n  margin: 0 0 .2rem;\n  color: var(--ink);\n  font: inherit;\n  font-size: 1.05rem;\n  font-weight: 700;\n}\n.kg-edge-panel > label {\n  display: flex;\n  flex-wrap: wrap;\n  align-items: center;\n  justify-content: space-between;\n  gap: .6rem;\n  font-size: .875rem;\n}\n.kg-edge-panel > label > select { max-width: 100%; margin-inline-start: auto; }\n.kg-edge-panel > label:has(input) { justify-content: start; }\n.kg-edge-extras {\n  display: grid;\n  gap: .6rem;\n  min-width: 0;\n  padding-top: .75rem;\n  border-top: 1px solid var(--line);\n}\n.kg-edge-extras:not(:has(> :not([hidden]))) { display: none; }\n.kg-page-turns {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: .25rem;\n}\n.kg-page-count { font-variant-numeric: tabular-nums; text-align: center; }\n.kg-edge-panel .kg-page-turns button { padding-inline: .45rem; }\n.kg-edge-panel button, .kg-edge-panel select { min-height: 2.15rem; }\n</style></head>\n<body>\n  <header class=\"masthead\">\n    <div class=\"topline\">\n      <a class=\"brand\" href=\"#shelf\" aria-label=\"KomaGlide 本站書庫首頁\" data-i18n-label=\"siteLibraryHome\">KomaGlide</a>\n      <div class=\"masthead-tools\">\n        <span id=\"offline-state\" role=\"status\" data-i18n=\"preparingLibrary\"></span>\n        <label class=\"theme-picker\" for=\"library-theme\"><span data-i18n=\"appearance\">外觀</span>\n          <select id=\"library-theme\">\n            <option value=\"system\" data-i18n=\"systemTheme\">跟隨系統</option>\n            <option value=\"light\" data-i18n=\"lightTheme\">淺色</option>\n            <option value=\"dark\" data-i18n=\"darkTheme\">深色</option>\n          </select>\n        </label>\n        <label class=\"theme-picker\" for=\"library-language\">\n          <span data-i18n=\"language\">語言</span>\n          <select id=\"library-language\"></select>\n        </label>\n      </div>\n    </div>\n  </header>\n  <main>\n    <p id=\"notice\" role=\"status\" hidden></p>\n    <section id=\"shelf\">\n      <div class=\"title-row\">\n        <h1 data-i18n=\"siteLibrary\">本站書庫</h1>\n        <a class=\"nav-action\" href=\"#storage\" data-i18n=\"storageSettings\">容量設定</a>\n      </div>\n      <div class=\"shelf-tools\">\n        <nav aria-label=\"書庫篩選\" data-i18n-label=\"libraryFilters\">\n          <a href=\"#shelf\" id=\"all-tab\" data-i18n=\"allWorks\">全部作品</a>\n          <a href=\"#favorites\" id=\"star-tab\" data-i18n=\"favorites\">收藏</a>\n          <a href=\"#export\" id=\"export-tab\" data-i18n=\"exportMode\">匯出模式</a>\n        </nav>\n        <span id=\"usage\"></span>\n      </div>\n      <div id=\"export-tools\" hidden>\n        <div class=\"export-actions\">\n          <button id=\"export-select-all\" type=\"button\" data-i18n=\"exportSelectAll\" disabled>全選</button>\n          <button id=\"export-prepare\" class=\"primary\" type=\"button\" data-i18n=\"exportPrepare\" disabled>準備 ZIP</button>\n          <a id=\"export-download\" class=\"nav-action primary\" data-i18n=\"exportDownload\" hidden>下載 ZIP</a>\n        </div>\n        <p id=\"export-selection\" class=\"count\" role=\"status\"></p>\n        <p class=\"count\" data-i18n=\"exportSavedOnly\">ZIP 只包含已儲存的頁面。</p>\n        <p id=\"export-status\" role=\"status\" hidden></p>\n      </div>\n      <div id=\"books\"></div>\n    </section>\n    <section id=\"storage\" hidden>\n      <a class=\"back\" href=\"#shelf\" data-i18n=\"backToLibrary\">返回書庫</a>\n      <h1 data-i18n=\"storageSettings\">容量設定</h1>\n      <p id=\"storage-summary\"></p>\n      <form id=\"limit-form\">\n        <label for=\"limit\" data-i18n=\"storageLimit\">書庫容量上限（MiB）</label>\n        <div class=\"field\"><input type=\"number\" id=\"limit\" required min=\"1\" step=\"1\"><button class=\"primary\" type=\"submit\" data-i18n=\"saveLimit\">儲存上限</button></div>\n      </form>\n      <p class=\"hint\" data-i18n=\"limitHint\">收藏和一般快取共用容量。調低上限時，書庫會從最久沒讀、尚未收藏的一話開始，整話移除。</p>\n      <section class=\"storage-retention\" aria-labelledby=\"retention-title\">\n        <h2 id=\"retention-title\" data-i18n=\"storageProtection\">瀏覽器儲存保護</h2>\n        <p class=\"hint\" id=\"retention\" role=\"status\"></p>\n        <p class=\"hint\" data-i18n=\"storageProtectionHint\">空間不足時，瀏覽器可能清除未受保護的網站資料。</p>\n        <button id=\"request-retention\" type=\"button\" data-i18n=\"requestPersistence\">申請持久儲存</button>\n        <p class=\"hint\" id=\"retention-result\" role=\"status\"></p>\n      </section>\n    </section>\n    <section id=\"reader\" hidden>\n      <a id=\"reader-return\" class=\"back\" href=\"#shelf\" data-i18n=\"backToLibrary\">返回書庫</a>\n      <div id=\"chapter-head\"></div>\n      <div id=\"reader-tools\"></div>\n      <div id=\"pages\"></div>\n      <nav id=\"reader-end\" aria-label=\"話數導覽\" data-i18n-label=\"chapterNavigation\"></nav>\n    </section>\n    <noscript>請啟用 JavaScript 以開啟本機書庫。</noscript>\n  </main>\n</body>\n</html>\n", 'text/html');
    document.open();
    document.close();
    const root = document.importNode(shell.documentElement, true);
    if (document.documentElement) document.documentElement.replaceWith(root);
    else document.appendChild(root);
    mountShelf(SHELF_HASH, {
      ...getShelfEvents(),
      saveLanguage: value => write(languageKey, value),
    });
    document.getElementById('offline-state').textContent = location.host;
  }

  const notContent = 'nav,aside,footer,header,[role="navigation"],[role="banner"],[aria-hidden="true"],[hidden],.advertisement,.ads,.promo,.navigation';
  function isComicImage(img) {
    if (img.closest(notContent)) return false;
    const marker = [img.className, img.id, img.alt, img.getAttribute('role')].join(' ');
    if (/(?:^|[\s_-])(logo|banner|advertisement|advert|ads?|promo|avatar|thumbnail|icon|presentation)(?:$|[\s_-])/i.test(marker)) return false;
    const w = Number(img.getAttribute('width')), h = Number(img.getAttribute('height'));
    return !(w > 0 && h > 0 && w <= 64 && h <= 64);
  }

  const siteAdapters = [];
  siteAdapters.push(function detect8comic(root, address) {
  const route = /^\/online\/new-(\d+)\.html$/.exec(address.pathname);
  if (address.origin !== 'https://articles.onemoreplace.tw' || !route) return null;

  const workId = route[1];
  const workLink = [...root.querySelectorAll('.view-titles a[href]')].find(link => {
    const url = webUrl(link.getAttribute('href'), address);
    return url?.origin === 'https://www.8comic.com' && url.pathname === '/html/' + workId + '.html';
  });
  if (!workLink) return null;
  const labels = [...workLink.querySelectorAll('small')].map(el => el.textContent.trim());
  const chapterLabel = labels.map(label => /^第\s*(\d+(?:\.\d+)?)\s*([集話])$/.exec(label)).find(Boolean);
  if (!chapterLabel) return null;
  const workTitle = [...workLink.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
  const chapterNumber = chapterLabel[1];
  // Split chapters can share a displayed number (ch=2a and ch=2b both say 第2集).
  const chapterToken = address.searchParams.get('ch') || chapterNumber;
  const chapterUrl = new URL(address.pathname, address.origin);
  chapterUrl.searchParams.set('ch', chapterToken);
  const chapterTitle = '第' + chapterNumber + chapterLabel[2] +
    (chapterNumber === chapterToken ? '' : '（' + chapterToken + '）');
  const declared = labels.map(label => /^\(\s*(\d+)\s*P\s*\)$/i.exec(label)).find(Boolean);
  const total = declared ? Number(declared[1]) : undefined;

  const pages = new Map();
  for (const slot of root.querySelectorAll('.pinch-zoom .comics-pic')) {
    const img = slot.querySelector(':scope > img');
    const label = slot.querySelector(':scope > b')?.textContent.trim();
    if (!img || !isComicImage(img) || !/^\d+$/.test(label || '')) continue;
    const index = Number(label);
    if (index < 1 || (total && index > total) || pages.has(index)) continue;
    // Unloaded slots reserve their page number. The capture loop waits for
    // the site's native loader to set src and finish decoding the image.
    const selected = img.currentSrc || img.getAttribute('src');
    const source = selected && comic8ImageUrl(selected, chapterUrl);
    if (selected && !source) continue;
    pages.set(index, { img, index, imageUrl: source?.href });
  }
  if (!pages.size) return null;
  // Scrolling the original numbered slot activates the site's own lazy loader.
  // Parsed continuation documents do not have a live viewport.
  function revealPage(index) {
    const slot = pages.get(index)?.img.parentElement;
    if (!slot?.isConnected) return false;
    slot.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    return true;
  }
  return {
    workId, workTitle, chapterId: workId + ':' + chapterToken, chapterTitle, chapterUrl: chapterUrl.href,
    total, entries: [...pages.values()].sort((a, b) => a.index - b.index),
    revealPage: root === document ? revealPage : undefined,
    nextPage: null, nextChapter: null,
  };
});

// The gallery publishes signed /s/ links in thumbnail batches. Only its reader
// pages publish full images. Keep those links across scans of the live document.
const ehOrigins = new Set(['https://e-hentai.org', 'https://exhentai.org']);
const ehDirectories = new WeakMap();
const ehGalleryRoute = /^\/g\/(\d+)\/([a-f0-9]+)\/?$/;
const ehReaderRoute = /^\/s\/[a-f0-9]+\/(\d+)-(\d+)$/;

function ehImageUrl(value, base) {
  const url = webUrl(value, base);
  return url?.protocol === 'https:' && url.hostname.endsWith('.hath.network') &&
    url.pathname.startsWith('/h/') ? url : null;
}

function ehReadGallery(root, address, galleryId, directory) {
  const title = root.querySelector('#gn')?.textContent.trim();
  const range = /Showing\s+([\d,]+)\s*-\s*([\d,]+)\s+of\s+([\d,]+)\s+images?/i.exec(
    root.querySelector('.gpc')?.textContent || '');
  if (!title || !range || ehGalleryRoute.exec(address.pathname)?.[1] !== galleryId) return null;
  const [first, last, total] = range.slice(1).map(n => Number(n.replaceAll(',', '')));
  const batch = Number(address.searchParams.get('p') || 0);
  if (!Number.isSafeInteger(total) || first < 1 || last < first || last > total ||
      !Number.isSafeInteger(batch) || batch < 0) return null;
  const perBatch = batch === 0 ? last : (first - 1) / batch;
  if (!Number.isSafeInteger(perBatch) || perBatch < 1 || first !== batch * perBatch + 1) return null;

  for (const link of root.querySelectorAll('#gdt a[href]')) {
    const url = webUrl(link.getAttribute('href'), address);
    const route = url?.origin === address.origin && ehReaderRoute.exec(url.pathname);
    if (route && route[1] === galleryId && +route[2] >= first && +route[2] <= last) {
      directory.links.set(+route[2], url.href);
    }
  }
  directory.perBatch = perBatch;
  const subtitle = root.querySelector('#gj')?.textContent.trim();
  directory.subtitle = subtitle && subtitle !== title ? subtitle : '';
  return {title, total, index:first};
}

function ehReadImage(root, address, galleryId) {
  const route = ehReaderRoute.exec(address.pathname);
  const index = Number(route?.[2]);
  const counter = /^(\d+)\s*\/\s*(\d+)$/.exec(root.querySelector('#i2 .sn div')?.textContent.trim() || '');
  const total = Number(counter?.[2]);
  if (route?.[1] !== galleryId || !counter || +counter[1] !== index || index < 1 || index > total) return null;
  const img = root.querySelector('#i3 img#img');
  const url = ehImageUrl(img?.getAttribute('src'), address);
  const title = root.querySelector('#i1 h1')?.textContent.trim();
  return title ? {title, total, index, entry:url ? {index, img, imageUrl:url.href} : null} : null;
}

siteAdapters.push(function detectEHentai(root, address) {
  if (!ehOrigins.has(address.origin)) return null;
  const gallery = ehGalleryRoute.exec(address.pathname);
  const reader = ehReaderRoute.exec(address.pathname);
  if (!gallery && !reader) return null;
  const galleryUrl = gallery ? new URL(address) : webUrl(root.querySelector('.sb a[href*="/g/"]')?.getAttribute('href'), address);
  const id = galleryUrl && ehGalleryRoute.exec(galleryUrl.pathname)?.[1];
  if (!id || galleryUrl.origin !== address.origin || (reader && reader[1] !== id)) return null;
  galleryUrl.search = galleryUrl.hash = '';
  let directory = ehDirectories.get(root);
  if (directory?.gallery !== galleryUrl.href) {
    directory = {gallery:galleryUrl.href, links:new Map(), batches:new WeakMap(), perBatch:0};
    ehDirectories.set(root, directory);
  }
  const data = gallery ? ehReadGallery(root, address, id, directory) : ehReadImage(root, address, id);
  if (!data) return null;
  async function readBatch(batch, signal) {
    const url = new URL(galleryUrl);
    if (batch) url.searchParams.set('p', batch);
    const parsed = await fetchDocument(url.href, signal);
    if (parsed.address.origin !== address.origin || parsed.address.pathname !== galleryUrl.pathname ||
        !ehReadGallery(parsed.root, parsed.address, id, directory)) throw new Error(t('galleryFailed'));
  }
  function loadBatch(batch, signal) {
    let pending = directory.batches.get(signal);
    if (!pending) {
      pending = new Map();
      directory.batches.set(signal, pending);
    }
    if (!pending.has(batch)) pending.set(batch, readBatch(batch, signal).finally(() => pending.delete(batch)));
    return pending.get(batch);
  }
  async function resolvePage(index, signal) {
    if (!directory.links.has(index)) {
      // Direct image URLs have no directory information until the first lookup.
      if (!directory.perBatch) await loadBatch(0, signal);
      if (!directory.links.has(index)) await loadBatch(Math.floor((index - 1) / directory.perBatch), signal);
    }
    const url = directory.links.get(index);
    if (!url) return null;
    const parsed = await fetchDocument(url, signal);
    if (parsed.address.origin !== address.origin) return null;
    const page = ehReadImage(parsed.root, parsed.address, id);
    return page?.index === index ? page.entry : null;
  }
  return {workId:id, workTitle:data.title, chapterId:id, chapterTitle:data.title, chapterUrl:galleryUrl.href,
    chapterSubtitle:directory.subtitle,
    async loadChapterSubtitle(signal) {
      if (directory.subtitle === undefined) await loadBatch(0, signal);
      return directory.subtitle;
    },
    entries:data.entry ? [data.entry] : [], total:data.total, startIndex:data.index, resolvePage, parallelPages:true,
    pageLabelSelector:'#i2 .sn div', nextPage:null, nextChapter:null};
});

// The native pager reuses its main image. Scroll mode also appends captioned images.
const manhuaguiImages = new WeakMap();

function manhuaguiImageUrl(value, base) {
  const url = webUrl(value, base);
  return url && /^https:\/\/[a-z0-9-]+\.hamreus\.com$/i.test(url.origin) &&
    /\.(?:webp|jpe?g|png|gif|avif)$/i.test(url.pathname) ? url : null;
}

siteAdapters.push(function detectManhuagui(root, address) {
  const route = /^\/comic\/(\d+)\/(\d+)\.html$/.exec(address.pathname);
  if (address.origin !== 'https://tw.manhuagui.com' || !route || root !== document) return null;
  const [, workId, chapterId] = route;
  const work = root.querySelector('.title h1 a[href]');
  const workUrl = webUrl(work?.getAttribute('href'), address);
  const workTitle = work?.textContent.trim();
  const chapterTitle = root.querySelector('.title h2')?.textContent.trim();
  if (workUrl?.origin !== address.origin || workUrl.pathname !== '/comic/' + workId + '/' || !workTitle || !chapterTitle) return null;

  const select = root.querySelector('select#pageSelect');
  const counter = root.querySelector('.title #page');
  const box = root.querySelector('#mangaBox');
  const total = select?.options.length;
  if (!box || !counter || !total || ![...select.options].every((option, i) => option.value === String(i + 1))) return null;

  function loadedEntry(img, index) {
    if (!img?.complete || img.naturalWidth <= 2 || img.naturalHeight <= 2) return null;
    const url = manhuaguiImageUrl(img.currentSrc, address);
    if (!url || url.href !== webUrl(img.getAttribute('src'), address)?.href) return null;
    return {index, img, imageUrl: url.href};
  }

  function currentPage() {
    const index = Number(counter.textContent.trim());
    if (!Number.isInteger(index) || index < 1 || index > total || select.value !== String(index)) return null;
    const entry = loadedEntry(box.querySelector('img#mangaFile'), index);
    if (!entry) return null;
    const previous = manhuaguiImages.get(box);
    if (previous?.imageUrl === entry.imageUrl && previous.index !== index) return null;
    manhuaguiImages.set(box, entry);
    return entry;
  }

  function resolvePage(index, signal) {
    if (signal.aborted || !select.isConnected || !select.options[index - 1] || location.pathname !== address.pathname) return null;
    const before = currentPage();
    if (before?.index === index) return before;
    return new Promise(resolve => {
      function finish(result) {
        clearTimeout(timer);
        observer.disconnect();
        box.removeEventListener('load', check, true);
        signal.removeEventListener('abort', cancel);
        resolve(result);
      }
      function check() {
        const entry = currentPage();
        if (entry?.index === index) finish(entry);
      }
      const cancel = () => finish(null);
      const observer = new MutationObserver(check);
      const timer = setTimeout(cancel, 15_000);
      observer.observe(box, {subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'srcset']});
      observer.observe(counter, {subtree: true, childList: true, characterData: true});
      box.addEventListener('load', check, true);
      signal.addEventListener('abort', cancel, {once: true});
      select.value = String(index);
      select.dispatchEvent(new Event('change', {bubbles: true}));
      check();
    });
  }

  const native = currentPage();
  const entries = new Map();
  if (native) entries.set(native.index, native);
  // The site puts each scroll page number BELOW its image. Filenames may skip
  // numbers after a double-page spread, and the native select can remain at 1.
  const pageLabelSelector = '#mangaMoreBox > p.img_info';
  for (const label of root.querySelectorAll(pageLabelSelector)) {
    const img = label.previousElementSibling;
    if (!img?.matches('img[data-tag="mangaFile"]')) continue;
    const number = /^\s*\(\s*(\d+)\s*\/\s*(\d+)\s*\)\s*$/.exec(label.textContent);
    if (!number || Number(number[2]) !== total) continue;
    const index = Number(number[1]);
    if (index < 1 || index > total || entries.has(index)) continue;
    const entry = loadedEntry(img, index);
    if (entry) entries.set(index, entry);
  }
  return {workId, workTitle, chapterId, chapterTitle, chapterUrl: address.origin + address.pathname,
    total, entries: [...entries.values()], pageLabelSelector, resolvePage, nextPage: null, nextChapter: null};
});

const nhOrigin = 'https://nhentai.net';
const nhRoute = /^\/g\/([1-9]\d*)(?:\/([1-9]\d*))?\/?$/;
const nhPageLabel = '.reader-pagination .page-number';

function nhImageUrl(value, address, index) {
  const url = webUrl(value, address);
  if (!url || !/^https:\/\/i\d*\.nhentai\.net$/.test(url.origin)) return null;
  const image = /^\/galleries\/[1-9]\d*\/([1-9]\d*)\.(?:jpe?g|png|webp|gif|avif)$/i.exec(url.pathname);
  return image?.[1] === String(index) ? url : null;
}

function nhReadPage(root, address) {
  const route = nhRoute.exec(address.pathname);
  const index = Number(route?.[2]);
  const label = root.querySelector(nhPageLabel);
  const total = Number(label?.querySelector('.num-pages')?.textContent);
  const title = /^(.*?)\s+-\s+Page\s+(\d+)\s+»\s+nhentai$/is.exec(
    root.querySelector('title')?.textContent.trim() || '');
  if (!title?.[1].trim() || +title[2] !== index ||
      Number(label?.querySelector('.current')?.textContent) !== index ||
      !Number.isSafeInteger(total) || index < 1 || index > total) return null;
  const img = root.querySelector('#image-container img');
  const url = nhImageUrl(img?.getAttribute('src'), address, index);
  return {title:title[1].trim(), total, index, entry:url ? {index, img, imageUrl:url.href} : null};
}

siteAdapters.push(function detectNhentai(root, address) {
  if (address.origin !== nhOrigin) return null;
  const route = nhRoute.exec(address.pathname);
  if (!route) return null;
  const [, id, page] = route;
  const chapterUrl = nhOrigin + '/g/' + id + '/';
  let data;
  if (page) {
    data = nhReadPage(root, address);
  } else {
    const heading = root.querySelector('#info h1.title');
    const pages = [...root.querySelectorAll('#info #tags .tag-container')]
      .map(node => /^Pages:\s*(\d+)$/i.exec(node.textContent.trim()))
      .find(Boolean);
    const total = Number(pages?.[1]);
    if (!heading || !Number.isSafeInteger(total) || total < 1) return null;
    const title = root.querySelector('title')?.textContent.replace(/\s+»\s+nhentai\s*$/i, '').trim() ||
      heading.textContent.trim();
    if (title) data = {title, total, index:1};
  }
  if (!data) return null;

  async function resolvePage(index, signal) {
    if (!Number.isSafeInteger(index) || index < 1 || index > data.total) return null;
    const url = new URL(index + '/', chapterUrl);
    const {root, address} = await fetchDocument(url.href, signal);
    const target = nhRoute.exec(address.pathname);
    if (address.origin !== nhOrigin || target?.[1] !== id || target[2] !== String(index)) return null;
    const resolved = nhReadPage(root, address);
    return resolved?.total === data.total ? resolved.entry : null;
  }

  return {workId:id, workTitle:data.title, chapterId:id, chapterTitle:data.title, chapterUrl,
    entries:data.entry ? [data.entry] : [], total:data.total, startIndex:data.index,
    resolvePage, parallelPages:true, pageLabelSelector:nhPageLabel, nextPage:null, nextChapter:null};
});

siteAdapters.push(function detectPepper(root, address) {
  const episode = address.pathname.match(/^\/([^/]+)\/webcomic\/(ep\d+_[^/]+?)(?:__(?:hd|sbs))?\.html$/i);
  if (!episode) return null;
  const images = [...root.querySelectorAll('.webcomic-page img, #comicpage img')];
  const entries = [];
  for (const img of images) {
    if (!isComicImage(img) || /^(header|footer|credits)$/i.test(img.alt.trim())) continue;
    const number = (img.getAttribute('src') || img.dataset.src || '').match(/_E\d+P(\d+)(?:[^\d/]*)\.(?:jpe?g|webp|png)(?:[?#]|$)/i)
      || img.alt.match(/\bpage\s+(\d+)\s*$/i);
    const index = Number(number?.[1]);
    if (index > 0 && !entries.some(e => e.index === index)) entries.push({index, img});
  }
  if (!entries.length) return null;
  const chapterId = '/' + episode[1] + '/webcomic/' + episode[2] + '.html';
  const chapterTitle = (root.querySelector('h1')?.textContent || (root.querySelector('title')?.textContent || '')).replace(/\s+[-–|]\s+Pepper\s*&\s*Carrot.*$/i, '').trim();
  return {chapterId, chapterTitle, chapterUrl: address.origin + chapterId,
    workId: 'pepper-and-carrot', workTitle: 'Pepper&Carrot', entries,
    total: Math.max(...entries.map(e => e.index))};
});

siteAdapters.push(function detectGeneric(root, address) {
  const area = root.querySelector('[data-comic-pages], #comic, .comic-pages, #comic-pages, [itemtype$="/ComicStory"] [itemprop="image"]');
  if (!area) return null;
  const images = (area.matches('img') ? [area] : [...area.querySelectorAll('img')]).filter(isComicImage);
  if (!images.length) return null;
  const title = root.querySelector('[data-comic-title], #ctitle, h1')?.textContent.trim() ||
    root.querySelector('meta[property="og:title"]')?.content || (root.querySelector('title')?.textContent || '').trim();
  if (!title) return null;
  const series = root.querySelector('[data-comic-work], [itemtype$="/ComicSeries"] [itemprop="name"]');
  const workTitle = (series?.getAttribute('data-comic-work') || series?.getAttribute('content') || series?.textContent || '').trim();
  const declared = webUrl(root.querySelector('link[rel="canonical"]')?.getAttribute('href'), address) ||
    webUrl(root.querySelector('meta[property="og:url"]')?.content, address);
  const url = declared?.origin === address.origin ? declared : new URL(address);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
  }
  return {chapterId: url.pathname + url.search, chapterUrl: url.href, chapterTitle: title,
    workId: workTitle, workTitle, total: images.length, entries: images.map((img, i) => ({img, index: i + 1}))};
});


  function detectChapter(root = document, address = new URL(location.href)) {
    for (const adapter of siteAdapters) {
      const found = adapter(root, address);
      if (!found) continue;
      const base = webUrl(root.querySelector('base[href]')?.getAttribute('href'), address);
      const baseURL = base?.origin === address.origin ? base.href : address.href;
      function nextLink(override, selector) {
        const candidates = override === undefined
          ? [...root.querySelectorAll(selector)].map(a => a.getAttribute('href') || a.dataset.nextPage || a.dataset.nextChapter)
          : [override];
        for (const candidate of candidates) {
          const next = webUrl(candidate, baseURL);
          if (!next || next.origin !== address.origin || next.href.split('#')[0] === address.href.split('#')[0]) continue;
          next.hash = '';
          return next.href;
        }
        return null;
      }
      return {...found, baseURL,
        nextPage: nextLink(found.nextPage, '[data-next-page], a[rel~="next-page"]'),
        nextChapter: nextLink(found.nextChapter, '[data-next-chapter], a[rel~="next"]:not([data-next-page]), link[rel~="next"]:not([data-next-page])')};
    }
    return null;
  }

  function pageFor(chapter, entry, live = false) {
    const {img, index} = entry;
    const selected = img.currentSrc || img.getAttribute('src');
    const src = live ? selected : entry.imageUrl || img.dataset.src || img.dataset.lazySrc ||
      selected || img.getAttribute('srcset')?.split(',')[0]?.trim().split(/\s+/)[0];
    const url = webUrl(src, chapter.baseURL);
    // A lazy reader may not have published src yet; the offline copy is keyed
    // by chapter and page number and can still be read without a URL.
    if (live && !url) return null;
    if (live && entry.imageUrl && webUrl(entry.imageUrl, chapter.baseURL)?.href !== url.href) return null;
    return {...chapterInfo(chapter), index, imageUrl:url?.href || ''};
  }
  function chapterInfo({chapterId, chapterTitle, chapterSubtitle, chapterUrl, workId, workTitle, total}) {
    return {site: location.origin, chapterId, chapterTitle, chapterSubtitle, chapterUrl, workId, workTitle,
      workKnown: Boolean(workId), total};
  }
  function checkedMime(value) {
    const mime = (value || '').split(';')[0].trim().toLowerCase();
    if (!MIME.test(mime)) throw new Error(t('unsupportedImage'));
    return mime;
  }

  function comic8ImageUrl(value, address, fallbackChapter) {
    if (address.origin !== 'https://articles.onemoreplace.tw') return null;
    const work = address.pathname.match(/^\/online\/new-(\d+)\.html$/);
    if (!work) return null;
    const url = webUrl(value, address);
    if (!url || !/^https:\/\/img\d+\.8comic\.com$/.test(url.origin)) return null;
    const image = url.pathname.match(/^\/\d+\/(\d+)\/(\d+(?:\.\d+|[a-z])?)\/\d+_[\w-]+\.jpg$/i);
    const chapter = new URL(address.href).searchParams.get('ch') ?? fallbackChapter;
    return image?.[1] === work[1] && image[2] === chapter ? url : null;
  }

  function fetchPublicImage(url, readerOrigin) {
    return new Promise((resolve, reject) => {
      const fail = () => reject(new Error(t('imageReadFailed')));
      const xhr = GM_xmlhttpRequest({url: url.href, method: 'GET', responseType: 'blob',
        anonymous: true, timeout: 30_000, redirect: 'error',
        ...(readerOrigin ? {headers: {Referer: readerOrigin + '/'}} : {}),
        onprogress(event) { if (event.loaded > IMAGE_LIMIT) { xhr.abort(); fail(); } },
        onload(response) {
          try {
            const blob = response.response;
            if (response.status !== 200) return reject(new Error(t('imageHttpStatus', {status: response.status})));
            if (readerOrigin && /^cache-control:[^\r\n]*\bno-store\b/im.test(response.responseHeaders || '')) {
              return reject(new Error(t('onlineOnly')));
            }
            if (!blob || !blob.size || blob.size > IMAGE_LIMIT) return fail();
            const mime = checkedMime(blob.type);
            resolve(blob.type === mime ? blob : blob.slice(0, blob.size, mime));
          } catch (err) { reject(err); }
        }, ontimeout: fail, onabort: fail, onerror: fail});
    });
  }

  async function fetchImage(page) {
    const url = new URL(page.imageUrl);
    if (ehOrigins.has(location.origin) && ehImageUrl(url, location)) {
      return fetchPublicImage(url, location.origin);
    }
    if (location.origin === nhOrigin && nhRoute.exec(location.pathname)?.[1] === page.chapterId &&
        nhImageUrl(url, location, page.index)) return fetchPublicImage(url, nhOrigin);
    if (location.origin === 'https://tw.manhuagui.com' &&
        location.pathname === '/comic/' + page.workId + '/' + page.chapterId + '.html' &&
        manhuaguiImageUrl(url, location)) return fetchPublicImage(url, location.origin);
    if (['https://img7.8comic.com', 'https://img9.8comic.com'].includes(url.origin)) {
      const canonical = new URL(page.chapterUrl);
      const fallback = canonical.origin === location.origin && canonical.pathname === location.pathname
        ? canonical.searchParams.get('ch') : null;
      if (comic8ImageUrl(url, location, fallback)) return fetchPublicImage(url);
    }
    let response;
    try {
      response = await fetch(url.href, {cache: 'force-cache', credentials: 'same-origin', signal: AbortSignal.timeout(30_000)});
    } catch (error) {
      if (/^(?:www\.)?xkcd\.com$/i.test(location.hostname) && url.origin === 'https://imgs.xkcd.com' && url.pathname.startsWith('/comics/')) {
        return fetchPublicImage(url);
      }
      throw error;
    }
    if (!response.ok) throw new Error(t('imageHttpFailed', {status: response.status}));
    const mime = checkedMime(response.headers.get('content-type'));
    const stream = response.body.getReader();
    const parts = [];
    let size = 0;
    try {
      while (true) {
        const {done, value} = await stream.read();
        if (done) break;
        size += value.length;
        if (size > IMAGE_LIMIT) { await stream.cancel(); throw new Error(t('imageTooLarge')); }
        parts.push(value);
      }
    } finally { stream.releaseLock(); }
    if (!size) throw new Error(t('blankImage'));
    return new Blob(parts, {type: mime});
  }

  const inFlightWrites = new Map();
  const chapterSubtitles = new Map();
  function capture(page) {
    const key = JSON.stringify([page.site, page.workId, page.chapterId, page.index]);
    if (!inFlightWrites.has(key)) {
      const task = (async () => {
        const blob = await fetchImage(page);
        try {
          const chapterSubtitle = chapterSubtitles.get(page.chapterUrl) ?? page.chapterSubtitle;
          await putPage({...page, chapterSubtitle}, blob);
          notifyPageSaved(page);
          void rememberSite();
          return {blob};
        } catch (storageError) {
          return {blob, storageError};
        }
      })().finally(() => inFlightWrites.delete(key));
      inFlightWrites.set(key, task);
    }
    return inFlightWrites.get(key);
  }

  async function saveLoaded(page) {
    if ((await lookupPage(page, false)).exists) {
      void rememberSite();
      return;
    }
    const {storageError} = await capture(page);
    if (storageError) throw storageError;
  }

  function element(tag, text, className) {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    if (className) el.className = className;
    return el;
  }
  function button(text, action) {
    const el = element('button', text);
    el.type = 'button';
    el.addEventListener('click', action);
    return el;
  }

  // This module is also bundled into the userscript's isolated reader dialog.
function watchReaderTheme(paint, signal) {
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  let choice = 'system';
  function apply() {
    paint(choice === 'system' ? (systemDark.matches ? 'dark' : 'light') : choice);
  }
  systemDark.addEventListener('change', apply, { signal });
  return theme => { choice = theme; apply(); };
}

async function makeReaderThumbnail(blob, size = 'medium') {
  if (!blob) return null;
  const bitmap = await createImageBitmap(blob);
  try {
    const large = size === 'large';
    const scale = Math.min(1, (large ? 512 : 192) / bitmap.width, (large ? 682 : 256) / bitmap.height);
    if (scale === 1 && blob.size <= 64 * 1024) return blob;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', large ? .84 : .78));
  } finally { bitmap.close(); }
}

function readerButton(label, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', action);
  return button;
}

// Reads already sent to the library may finish after a picker closes or reopens.
let activeThumbnailReads = 0;
const thumbnailPumps = new Set();

// Only the visible rows of one group need decoded thumbnails and Blob URLs.
function openThumbnailPicker(container, { total, current, direction, thumbnailSize, onThumbnailSize, getThumbnail, onPick, onClose }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'kg-thumb-picker';
  dialog.setAttribute('aria-label', t('thumbnails'));
  const header = document.createElement('div');
  header.className = 'kg-thumb-head';
  const heading = document.createElement('strong');
  heading.textContent = t('thumbnails');
  const range = document.createElement('span');
  range.className = 'kg-thumb-range';
  const sizeLabel = document.createElement('label');
  sizeLabel.className = 'kg-thumb-size';
  const sizeMenu = document.createElement('select');
  sizeMenu.setAttribute('aria-label', t('thumbnailSize'));
  for (const value of ['small', 'medium', 'large']) {
    sizeMenu.add(new Option(t(value), value));
  }
  sizeMenu.value = thumbnailSize;
  sizeLabel.append(t('thumbnailSize'), sizeMenu);
  const close = readerButton(t('close'), dispose);
  close.setAttribute('aria-label', t('closeThumbnails'));
  header.append(heading, range, sizeLabel, close);
  const grid = document.createElement('div');
  grid.className = 'kg-thumb-grid';
  grid.dir = direction;
  grid.dataset.size = thumbnailSize;
  const footer = document.createElement('div');
  footer.className = 'kg-thumb-footer';
  const batch = 60;
  let start = current - ((current - 1) % batch);
  const back = readerButton(t('previousBatch'), () => show(start - batch, start - 1));
  const more = readerButton(t('nextBatch'), () => show(start + batch, start + batch));
  footer.append(back, more);
  footer.hidden = total <= batch;
  dialog.append(header, grid, footer);
  container.append(dialog);

  const waiting = new Set();
  const entries = new Map();
  let closed = false;
  let lastFocusedTile;
  grid.addEventListener('focusin', event => { lastFocusedTile = event.target.closest('button[data-page]'); });
  function resize(size) {
    if (grid.dataset.size === size) return;
    const viewport = grid.getBoundingClientRect();
    const inView = tile => {
      const box = tile.getBoundingClientRect();
      return box.bottom > viewport.top && box.top < viewport.bottom;
    };
    // Keep the page being browsed in view even after the grid changes its column count.
    const anchor = lastFocusedTile && grid.contains(lastFocusedTile) && inView(lastFocusedTile)
      ? lastFocusedTile : Array.from(grid.children).find(inView);
    const offset = anchor ? anchor.getBoundingClientRect().top - viewport.top : 0;
    sizeMenu.value = size;
    grid.dataset.size = size;
    if (anchor) {
      const box = anchor.getBoundingClientRect();
      const top = Math.max(0, Math.min(offset, grid.clientHeight - box.height));
      grid.scrollTop += box.top - grid.getBoundingClientRect().top - top;
    }
    if (size === 'large') {
      for (const [tile, entry] of entries) {
        if (entry.visible && entry.url && !entry.large && !entry.loading) waiting.add(tile);
      }
      pump();
    }
  }
  sizeMenu.addEventListener('change', () => onThumbnailSize(sizeMenu.value));
  function release(tile) {
    waiting.delete(tile);
    const entry = entries.get(tile);
    if (!entry) return;
    entry.visible = false;
    if (entry.url) URL.revokeObjectURL(entry.url);
    entry.url = null;
    if (!entry.loading) entries.delete(tile);
    tile.firstElementChild.replaceChildren();
  }
  async function load(tile, entry, large) {
    const frame = tile.firstElementChild;
    let url;
    try {
      const blob = await getThumbnail(Number(tile.dataset.page), large ? 'large' : 'medium');
      if (!entry.visible) return;
      if (!blob) {
        if (!entry.url) frame.textContent = t('noPreview');
        return;
      }
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      url = URL.createObjectURL(blob);
      img.src = url;
      await img.decode();
      if (!entry.visible) return;
      frame.replaceChildren(img);
      if (entry.url) URL.revokeObjectURL(entry.url);
      entry.url = url;
      entry.large = large;
      url = null;
    } catch {
      if (entry.visible && !entry.url) frame.textContent = t('noPreview');
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }
  function pump() {
    while (!closed && activeThumbnailReads < 2 && waiting.size) {
      const tile = waiting.values().next().value;
      waiting.delete(tile);
      const entry = entries.get(tile);
      const large = grid.dataset.size === 'large';
      if (entry.loading || (entry.url && (entry.large || !large))) continue;
      entry.loading = true;
      activeThumbnailReads++;
      load(tile, entry, large).finally(() => {
        entry.loading = false;
        if (!entry.visible) entries.delete(tile);
        else if (!large && entry.url && grid.dataset.size === 'large') waiting.add(tile);
        activeThumbnailReads--;
        for (const next of thumbnailPumps) next();
      });
    }
  }
  thumbnailPumps.add(pump);
  const observer = new IntersectionObserver(changes => {
    for (const { target, isIntersecting } of changes) {
      if (!grid.contains(target)) continue;
      if (!isIntersecting) release(target);
      else {
        const entry = entries.get(target) || {};
        if (entry.visible) continue;
        entry.visible = true;
        entries.set(target, entry);
        if (!entry.loading) waiting.add(target);
      }
    }
    pump();
  }, { root: grid, rootMargin: '60px 0px' });
  function clearGrid() {
    observer.disconnect();
    observer.takeRecords();
    for (const tile of entries.keys()) release(tile);
    grid.replaceChildren();
  }
  function show(first, focusPage) {
    clearGrid();
    start = first;
    const last = Math.min(total, start + batch - 1);
    range.textContent = total <= batch
      ? t(total === 1 ? 'pageCountOne' : 'pageCount', {count: total})
      : t('pageRange', {start, end: last, total});
    back.disabled = start === 1;
    more.disabled = last === total;
    for (let page = start; page <= last; page++) {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'kg-thumb-page';
      tile.dataset.page = page;
      tile.setAttribute('aria-label', t('pageNumber', {page}));
      if (page === current) tile.setAttribute('aria-current', 'page');
      const frame = document.createElement('span');
      frame.className = 'kg-thumb-frame';
      const label = document.createElement('span');
      label.textContent = String(page);
      tile.append(frame, label);
      grid.append(tile);
      observer.observe(tile);
    }
    const focus = grid.children[focusPage - start];
    focus.focus({ preventScroll: true });
    focus.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  grid.addEventListener('click', event => {
    const tile = event.target.closest('button[data-page]');
    if (!tile) return;
    dispose();
    onPick(Number(tile.dataset.page));
  });
  grid.addEventListener('keydown', event => {
    const tile = event.target.closest('button[data-page]');
    if (!tile) return;
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
    const step = { ArrowRight: direction === 'rtl' ? -1 : 1, ArrowLeft: direction === 'rtl' ? 1 : -1,
      ArrowUp: -cols, ArrowDown: cols }[event.key];
    if (!step) return;
    event.preventDefault();
    event.stopPropagation();
    const target = Math.min(total, Math.max(1, Number(tile.dataset.page) + step));
    if (target < start || target >= start + batch) show(target - ((target - 1) % batch), target);
    else grid.children[target - start].focus();
  });
  function dispose() {
    if (closed) return;
    closed = true;
    thumbnailPumps.delete(pump);
    if (dialog.open) dialog.close();
    clearGrid();
    dialog.remove();
    onClose();
  }
  dialog.addEventListener('close', dispose, { once: true });
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    dispose();
  });
  dialog.showModal();
  show(start, current);
  return { close: dispose, resize };
}

function bindPageGestures(target, enabled, tapEnabled, navigate, listen) {
  const interactive = 'a, button, input, select, textarea, [contenteditable="true"]';
  let press;
  target.addEventListener('pointerdown', event => {
    press = enabled() && event.isPrimary && event.button === 0
      ? { x: event.clientX, y: event.clientY, id: event.pointerId, time: event.timeStamp,
        swipe: event.pointerType === 'touch' && !event.target.closest(interactive), moved: false } : null;
  }, listen);
  target.addEventListener('pointermove', event => {
    if (press?.id === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 12) {
      press.moved = true;
    }
  }, listen);
  target.addEventListener('pointerup', event => {
    if (!press?.swipe || press.id !== event.pointerId) return;
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    if (Math.abs(dx) < 48 || Math.abs(dx) < 1.5 * Math.abs(dy)) return;
    press = null; // A subsequent click must not also turn the page.
    if (enabled() && !event.defaultPrevented) navigate(dx > 0 ? 'left' : 'right');
  }, listen);
  for (const type of ['pointercancel', 'dragstart', 'contextmenu']) {
    target.addEventListener(type, () => { press = null; }, listen);
  }
  target.addEventListener('click', event => {
    const down = press;
    press = null;
    if (!down || down.moved || !enabled() || !tapEnabled() || event.defaultPrevented || event.button !== 0 || event.detail === 0 ||
        (event.pointerId != null && event.pointerId !== down.id) || event.timeStamp - down.time > 650 ||
        Math.hypot(event.clientX - down.x, event.clientY - down.y) > 12 ||
        event.ctrlKey || event.metaKey || event.shiftKey || event.altKey ||
        event.target.closest(interactive)) return;
    const rect = target.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    if (x >= 0 && x < 1 / 3) navigate('left');
    else if (x > 2 / 3 && x <= 1) navigate('right');
  }, listen);
}

function mountReaderControls(container, options) {
  const { keyTarget, themeTarget, onMode, onTheme, onTurn } = options;
  const toolbar = document.createElement('div');
  toolbar.className = 'kg-reader-controls';
  const lifetime = new AbortController();
  const listen = { signal: lifetime.signal };
  const setTheme = themeTarget && watchReaderTheme(theme => {
    themeTarget.dataset.readerTheme = theme;
  }, lifetime.signal);
  let state = { mode: 'scroll', theme: 'system', direction: 'rtl', tapToTurn: true, current: 1, total: 0 };
  let first = 1;
  let stride = 1;
  let picker;
  let openDrawer;
  const restoreExtras = [];

  function setDrawer(next, returnFocus = false) {
    const previous = openDrawer;
    if (previous) {
      previous.panel.hidden = true;
      previous.toggle.setAttribute('aria-expanded', 'false');
    }
    openDrawer = next;
    if (next) {
      next.panel.hidden = false;
      next.toggle.setAttribute('aria-expanded', 'true');
    } else if (returnFocus) previous?.toggle.focus({ preventScroll: true });
  }

  function drawer(side, title, shortTitle) {
    const wrapper = document.createElement('div');
    wrapper.className = 'kg-edge kg-edge-' + side;
    const panel = document.createElement('section');
    panel.id = 'kg-' + side + '-panel';
    panel.className = 'kg-edge-panel';
    panel.hidden = true;
    const heading = document.createElement('h2');
    heading.id = panel.id + '-title';
    heading.textContent = title;
    panel.setAttribute('aria-labelledby', heading.id);
    panel.append(heading);
    const toggle = readerButton(shortTitle, () => setDrawer(openDrawer === entry ? null : entry));
    toggle.className = 'kg-edge-toggle';
    toggle.title = title;
    toggle.setAttribute('aria-label', title);
    toggle.setAttribute('aria-controls', panel.id);
    toggle.setAttribute('aria-expanded', 'false');
    const entry = { panel, toggle };
    wrapper.append(toggle, panel);
    toolbar.append(wrapper);
    return entry;
  }

  // The chapter links, title, and exit action belong to the surrounding reader.
  // Put them back when navigating to another chapter or refreshing its cache.
  function attachExtras(panel, nodes) {
    if (!nodes?.length) return;
    const extras = document.createElement('div');
    extras.className = 'kg-edge-extras';
    for (const node of nodes) {
      const marker = document.createComment('reader control');
      node.before(marker);
      extras.append(node);
      restoreExtras.push(() => marker.replaceWith(node));
    }
    panel.append(extras);
  }

  const settings = drawer('left', t('readerSettings'), t('settings'));
  const navigation = drawer('right', t('pageNavigation'), t('navigation'));

  function menu(name, choices, change) {
    const label = document.createElement('label');
    const select = document.createElement('select');
    select.setAttribute('aria-label', name);
    for (const [value, text] of choices) select.add(new Option(text, value));
    select.addEventListener('change', () => change(select.value), listen);
    label.append(name, select);
    settings.panel.append(label);
    return select;
  }

  const mode = menu(t('readingMode'), [['scroll', t('verticalScroll')], ['single', t('singlePage')], ['double', t('doublePage')]], onMode);
  if (options.onBufferMode) {
    const buffer = menu(t('bufferMode'), [['chapter', t('bufferChapter')], ['ahead', t('bufferAhead')]], options.onBufferMode);
    buffer.value = options.bufferMode;
  }
  if (options.parallelPreload) {
    const {value, choices, onChange} = options.parallelPreload;
    const preload = menu(t('parallelPreload'), choices.map(count => [count, t(count === 1 ? 'pageCountOne' : 'pageCount', {count})]), onChange);
    preload.value = String(value);
  }
  const theme = menu(t('appearance'), [['system', t('systemTheme')], ['light', t('lightTheme')], ['dark', t('darkTheme')]], onTheme);
  const direction = menu(t('pageDirection'), [['rtl', t('rtl')], ['ltr', t('ltr')]], options.onDirection);
  const tapLabel = document.createElement('label');
  const tap = document.createElement('input');
  tap.type = 'checkbox';
  tap.addEventListener('change', () => options.onTapToTurn(tap.checked), listen);
  tapLabel.append(tap, t('tapToTurn'));
  const browse = readerButton(t('thumbnails'), () => {
    if (picker || state.total < 1) return;
    const current = Math.max(1, Math.min(options.getCurrentPage(), state.total));
    picker = openThumbnailPicker(toolbar, { ...state, current, getThumbnail: options.getThumbnail,
      onThumbnailSize: options.onThumbnailSize,
      onPick: page => { setDrawer(null, true); options.onPick(page); },
      onClose: () => { picker = null; } });
  });
  browse.setAttribute('aria-haspopup', 'dialog');
  settings.panel.append(tapLabel);
  attachExtras(settings.panel, options.settingsExtras);
  navigation.panel.append(browse);
  const pager = document.createElement('span');
  pager.className = 'kg-page-turns';
  function turn(step) {
    const target = first + step * stride;
    if (state.mode !== 'scroll' && target >= 1 && target <= state.total) onTurn(target);
  }
  function sideStep(side) { return (side === 'left') === (state.direction === 'rtl') ? 1 : -1; }
  options.tapTarget.classList.add('kg-page-gestures');
  bindPageGestures(options.tapTarget, () => !picker && !openDrawer, () => state.tapToTurn, side => {
    const step = sideStep(side);
    if (state.mode !== 'scroll') { turn(step); return; }
    const target = options.getCurrentPage() + step;
    if (target >= 1 && target <= state.total) options.onPick(target);
  }, listen);
  const previous = readerButton(t('previousPage'), () => turn(-1));
  const next = readerButton(t('nextPage'), () => turn(1));
  const count = document.createElement('span');
  count.className = 'kg-page-count';
  count.setAttribute('aria-live', 'polite');
  pager.append(previous, count, next);
  navigation.panel.append(pager);
  attachExtras(navigation.panel, options.navigationExtras);
  container.append(toolbar);

  keyTarget.addEventListener('click', event => {
    if (!openDrawer || picker || event.composedPath().includes(toolbar)) return;
    event.preventDefault();
    event.stopPropagation();
    setDrawer(null, true);
  }, { capture: true, signal: lifetime.signal });
  keyTarget.addEventListener('keydown', event => {
    if (event.key === 'Escape' && picker && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      picker.close();
      return;
    }
    if (event.key === 'Escape' && openDrawer && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      setDrawer(null, true);
      return;
    }
    if (picker || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        state.mode === 'scroll' || event.composedPath().some(node =>
          node instanceof Element && (node.matches('select, input, textarea') || node.isContentEditable))) return;
    const step = { ArrowLeft: sideStep('left'), ArrowRight: sideStep('right'), PageDown: 1, PageUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    event.stopPropagation();
    turn(step);
  }, listen);

  function update(changes) {
    const old = state;
    state = { ...state, ...changes };
    if (state.chapterKey !== old.chapterKey || state.total !== old.total || state.direction !== old.direction) picker?.close();
    else if (state.thumbnailSize !== old.thumbnailSize) picker?.resize(state.thumbnailSize);
    stride = state.mode === 'double' ? 2 : 1;
    const page = Math.max(1, Math.min(state.current, state.total));
    first = page - ((page - 1) % stride);
    const last = Math.min(first + stride - 1, state.total);
    mode.value = state.mode;
    theme.value = state.theme;
    direction.value = state.direction;
    tap.checked = state.tapToTurn;
    const rtl = state.direction === 'rtl';
    tapLabel.title = rtl ? t('tapRtl') : t('tapLtr');
    previous.setAttribute('aria-keyshortcuts', rtl ? 'ArrowRight PageUp' : 'ArrowLeft PageUp');
    next.setAttribute('aria-keyshortcuts', rtl ? 'ArrowLeft PageDown' : 'ArrowRight PageDown');
    setTheme?.(state.theme);
    browse.disabled = state.total < 1;
    pager.hidden = state.mode === 'scroll';
    pager.dataset.direction = state.direction;
    previous.disabled = first <= 1;
    next.disabled = last >= state.total;
    const range = first < last ? first + '–' + last : first;
    count.textContent = state.total ? range + ' / ' + state.total : '0 / 0';
  }
  update({ mode: options.mode || 'scroll', theme: options.theme || 'system', direction: options.direction || 'rtl',
    tapToTurn: options.tapToTurn !== false, thumbnailSize: options.thumbnailSize || 'medium',
    current: options.current || 1, total: options.total || 0 });
  return { update, destroy() {
    picker?.close();
    lifetime.abort();
    options.tapTarget.classList.remove('kg-page-gestures');
    for (const restore of restoreExtras) restore();
    if (themeTarget) delete themeTarget.dataset.readerTheme;
    toolbar.remove();
  } };
}


  const readerCSS = `
    :host {color-scheme:light; font:15px/1.5 "DM Sans","PingFang TC","Microsoft JhengHei",sans-serif; color:#222520}
    *,*::before,*::after {box-sizing:border-box} [hidden] {display:none!important}
    :host,dialog:not(.kg-thumb-picker) {--paper:#f7f6f2;--ink:#222520;--surface:#e9ede2;--line:#9ca79b;--well:#eaece5;--hover:#dbe3d6;--alert:#733b2e;--accent:#39654c}
    dialog[data-reader-theme="dark"] {color-scheme:dark;--paper:#171b18;--ink:#e5e9e2;--surface:#242b24;--line:#636e63;--well:#202620;--hover:#354237;--alert:#eeb9a5;--accent:#a7c8ad}
    button,select {font:inherit;font-size:14px;color:var(--ink);background:var(--paper);border:1px solid var(--line);border-radius:5px;padding:5px 9px}
    button {cursor:pointer} button:hover:not(:disabled),select:hover {background:var(--hover)} button:disabled {cursor:default;opacity:.5}
    :focus-visible {outline:3px solid var(--accent);outline-offset:2px}
    :host(.kg-source-tools) {display:contents!important}
    .dock {
      all:initial;direction:ltr;box-sizing:border-box;font:14px/1.25 "DM Sans","PingFang TC","Microsoft JhengHei",sans-serif;
      --paper:#f7f6f2;--ink:#222520;--muted:#586158;--line:#9ca79b;--surface:#e9ede2;--hover:#dbe3d6;--accent:#39654c;--alert:#733b2e;
      --dock-bottom-gap:max(8px, var(--dock-toolbar-clearance, 0px), calc(env(safe-area-inset-bottom,0px) + 8px));
      color-scheme:light;position:fixed;z-index:2147483646;right:calc(env(safe-area-inset-right,0px) + 8px);
      bottom:var(--dock-bottom-gap);
      max-width:calc(100vw - env(safe-area-inset-left,0px) - env(safe-area-inset-right,0px) - 16px);
      display:flex;align-items:stretch;background:var(--paper);color:var(--ink);
      border:1px solid var(--line);border-radius:8px;box-shadow:0 2px 7px rgb(0 0 0 / 14%);
    }
    @supports (height:100dvh) {
      .dock {
        top:calc(min(100dvh, var(--dock-visible-bottom, 100dvh)) - var(--dock-bottom-gap));
        bottom:auto;
        transform:translateY(-100%);
      }
    }
    @supports (-webkit-touch-callout:none) {
      /* Leave room for iOS/iPadOS browser controls drawn over the page. */
      .dock {--dock-toolbar-clearance:48px}
    }
    @media(prefers-color-scheme:dark) {
      .dock {color-scheme:dark;--paper:#171b18;--ink:#e5e9e2;--muted:#b2baaf;--line:#636e63;--surface:#242b24;--hover:#354237;--accent:#a7c8ad;--alert:#eeb9a5}
    }
    .dock button {min-width:44px;min-height:44px;margin:0;padding:4px 12px;border:0;border-radius:0;font:inherit;color:var(--ink)}
    .dock button:focus-visible {outline-offset:-3px}
    .dock .dock-reader {border-radius:7px 0 0 7px;background:var(--surface);color:var(--accent);font-weight:700}
    .dock .dock-reader:hover {background:var(--hover)}
    .dock .dock-shelf {border-left:1px solid var(--line);border-radius:0 7px 7px 0;text-align:start;font-weight:600}
    .dock-count {display:block;color:var(--muted);font-size:12px;font-weight:400;line-height:1.35;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
    .dock-error {
      position:absolute;right:0;bottom:calc(100% + 5px);width:max-content;max-width:min(300px,calc(100vw - env(safe-area-inset-left,0px) - env(safe-area-inset-right,0px) - 18px));
      max-height:min(8em,35dvh);overflow:auto;overscroll-behavior:contain;margin:0;padding:8px 10px;border:1px solid var(--line);border-radius:6px;
      background:var(--paper);color:var(--alert);font-size:13px;line-height:1.45;overflow-wrap:anywhere;
    }
    .dock-error:empty {display:none}
    .tail {display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap}
    dialog:not(.kg-thumb-picker) {width:100vw;max-width:none;height:100dvh;max-height:none;inset:0;margin:0;border:0;padding:0;background:var(--paper);color:var(--ink);font:inherit;overflow:auto;overscroll-behavior:contain}
    dialog:not(.kg-thumb-picker)::backdrop {background:var(--paper)}
    .source-chapter-title {font-size:15px;font-weight:650;overflow-wrap:anywhere}
    .source-chapter-subtitle {font-size:13px;overflow-wrap:anywhere}
    .buffer-progress {position:fixed;bottom:max(8px,env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);padding:2px 9px;border-radius:5px;background:var(--paper);color:var(--ink);border:1px solid var(--line);font-size:12px;white-space:nowrap;pointer-events:none}
    .chapter-actions {display:grid;gap:.5rem}
    .chapter-actions [role="status"]:empty {display:none}
    .chapter-boundary {height:1px;pointer-events:none}
    .tail {margin:16px auto;padding:12px;background:var(--surface);border-radius:5px}
    .pages,.tail {width:min(100%,960px);margin-inline:auto}
    h2 {font:600 1.35rem/1.35 "DM Sans","PingFang TC",sans-serif;margin:1.2rem 0;overflow-wrap:anywhere}
    figure {padding:0;margin:0 auto 10px;background:var(--well);width:100%}
    figure img {display:block;max-width:100%;height:auto;margin:auto} figure figcaption {padding:8px;color:var(--alert)}
    label {display:inline-flex;align-items:center;gap:4px;white-space:nowrap} input {accent-color:var(--accent)}
    dialog.paged[open] {overflow:hidden}
    .paged .chapter-boundary {display:none}
    .paged .pages {display:flex;align-items:stretch;direction:rtl;justify-content:center;height:100%;width:100%;gap:2px;overflow:hidden}
    .paged[data-reader-direction="ltr"] .pages {direction:ltr}
    .paged .pages h2 {display:none}
    .paged figure {direction:ltr;display:flex;flex-flow:column;align-items:center;justify-content:center;flex:0 1 auto;width:100%;min-height:0!important;min-width:0;margin:0;background:var(--paper)}
    .paged figure img {width:100%;height:100%;min-height:0;object-fit:contain}
    .paged[data-reader-mode="double"] figure:not(:only-of-type) {max-width:50%}
    .paged figure.spread-single {max-width:100%!important}
    .paged figure.spread-right img {object-position:left center}
    .paged figure.spread-left img {object-position:right center}
    @media(max-width:600px){button,select{font-size:13px}}
    .kg-page-gestures { touch-action: pan-y pinch-zoom; }

.kg-reader-controls input[type="checkbox"] {
  width: 1rem;
  height: 1rem;
  margin: 0;
  padding: 0;
  accent-color: var(--accent);
}
.kg-page-turns[data-direction="rtl"] { flex-direction: row-reverse; }

dialog.kg-thumb-picker {
  position: fixed;
  inset: 0;
  margin: auto;
  box-sizing: border-box;
  width: 94vw;
  height: 92dvh;
  max-width: 100%;
  max-height: 100dvh;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: .6rem;
  background: var(--paper);
  color: var(--ink);
  font: inherit;
  text-align: start;
}
dialog.kg-thumb-picker[open] { display: flex; flex-direction: column; }
.kg-thumb-picker::backdrop { background: rgb(9 14 10 / 68%); }
.kg-thumb-head, .kg-thumb-footer {
  display: flex;
  flex: none;
  align-items: center;
  gap: .75rem;
  padding: .75rem 1rem;
}
.kg-thumb-head { flex-wrap: wrap; border-bottom: 1px solid var(--line); }
.kg-thumb-head strong { font-size: 1.1rem; margin: 0; }
.kg-thumb-range {
  color: var(--muted, var(--ink));
  font-size: .85rem;
  font-variant-numeric: tabular-nums;
}
.kg-thumb-head .kg-thumb-size {
  display: inline-flex;
  align-items: center;
  gap: .4rem;
  margin-inline-start: auto;
  color: var(--muted, var(--ink));
  font-size: .85rem;
  white-space: nowrap;
}
.kg-thumb-size select { min-height: 2.1rem; }
.kg-thumb-footer { justify-content: space-between; border-top: 1px solid var(--line); }
.kg-thumb-grid {
  --tile-min: 6rem;
  display: grid;
  flex: 1 1 0;
  min-height: 0;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, var(--tile-min)), 1fr));
  grid-auto-rows: max-content;
  align-content: start;
  gap: .75rem;
  padding: 1rem;
  overflow-y: auto;
  overscroll-behavior: contain;
  scroll-padding: 1rem;
}
.kg-thumb-grid[data-size="small"] { --tile-min: 4rem; }
.kg-thumb-grid[data-size="large"] { --tile-min: clamp(15rem, 24vw, 26rem); }
.kg-thumb-grid .kg-thumb-page {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: .22rem;
  min-width: 0;
  padding: .25rem;
  border: 1px solid transparent;
  border-radius: .35rem;
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: .85rem;
  font-variant-numeric: tabular-nums;
  text-align: center;
  white-space: normal;
  cursor: pointer;
}
.kg-thumb-grid .kg-thumb-page:hover { background: var(--hover); }
.kg-thumb-grid .kg-thumb-page[aria-current="page"] {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 700;
}
.kg-thumb-frame {
  display: grid;
  place-items: center;
  width: 100%;
  flex: none;
  aspect-ratio: 3 / 4;
  overflow: hidden;
  background: var(--slot, var(--well));
  color: var(--muted, var(--ink));
  font-size: .8rem;
}
.kg-thumb-frame img {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 0;
  object-fit: contain;
}
@media (max-width: 38rem) {
  dialog.kg-thumb-picker { width: calc(100vw - .5rem); height: calc(100dvh - 1rem); }
  .kg-thumb-head { gap: .4rem .6rem; padding: .6rem; }
  .kg-thumb-grid { --tile-min: 4.8rem; gap: .5rem; padding: .65rem; }
  .kg-thumb-grid[data-size="small"] { --tile-min: 3.3rem; }
  .kg-thumb-grid[data-size="large"] { --tile-min: 12rem; }
}
.kg-reader-controls {
  --edge-width: 2.5rem;
  --edge-surface: var(--paper);
  display: contents;
}
.kg-edge, .kg-edge-panel {
  display: flex;
  align-items: center;
}
.kg-edge {
  position: fixed;
  top: 50%;
  transform: translateY(-50%);
  z-index: 8;
  pointer-events: none;
}
.kg-edge-left { left: env(safe-area-inset-left, 0px); }
.kg-edge-right { right: env(safe-area-inset-right, 0px); flex-direction: row-reverse; }
.kg-reader-controls .kg-edge-toggle {
  position: relative;
  padding: .7rem .35rem;
  width: var(--edge-width);
  min-height: 3.8rem;
  display: grid;
  place-items: center;
  border: 1px solid var(--line);
  background: color-mix(in srgb, var(--edge-surface) 91%, transparent);
  color: var(--ink);
  font: inherit;
  font-size: .8rem;
  font-weight: 600;
  letter-spacing: .1em;
  line-height: 1;
  writing-mode: vertical-rl;
  text-orientation: upright;
  pointer-events: auto;
  cursor: pointer;
}
.kg-edge-left .kg-edge-toggle { border-left: 0; border-radius: 0 .45rem .45rem 0; }
.kg-edge-right .kg-edge-toggle { border-right: 0; border-radius: .45rem 0 0 .45rem; }
.kg-edge-toggle:lang(en) { text-orientation: mixed; }
.kg-reader-controls .kg-edge-toggle:is(:hover, [aria-expanded="true"]) {
  background: var(--hover);
  color: var(--accent);
}
.kg-edge .kg-edge-panel {
  position: absolute;
  width: 15rem;
  max-width: calc(100vw - 2 * var(--edge-width) - 1.25rem);
  max-height: calc(100dvh - 2rem);
  flex-direction: column;
  align-items: stretch;
  gap: .65rem;
  margin: 0;
  padding: 1rem;
  overflow: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--line);
  border-radius: .6rem;
  background: var(--edge-surface);
  color: var(--ink);
  box-shadow: 0 .3rem 1.2rem rgb(0 0 0 / 18%);
  font-size: .9rem;
  line-height: 1.45;
  pointer-events: auto;
}
.kg-edge-panel[hidden] { display: none; }
.kg-edge-left .kg-edge-panel { left: calc(100% + .35rem); }
.kg-edge-right .kg-edge-panel { right: calc(100% + .35rem); }
.kg-edge-panel h2 {
  margin: 0 0 .2rem;
  color: var(--ink);
  font: inherit;
  font-size: 1.05rem;
  font-weight: 700;
}
.kg-edge-panel > label {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: .6rem;
  font-size: .875rem;
}
.kg-edge-panel > label > select { max-width: 100%; margin-inline-start: auto; }
.kg-edge-panel > label:has(input) { justify-content: start; }
.kg-edge-extras {
  display: grid;
  gap: .6rem;
  min-width: 0;
  padding-top: .75rem;
  border-top: 1px solid var(--line);
}
.kg-edge-extras:not(:has(> :not([hidden]))) { display: none; }
.kg-page-turns {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: .25rem;
}
.kg-page-count { font-variant-numeric: tabular-nums; text-align: center; }
.kg-edge-panel .kg-page-turns button { padding-inline: .45rem; }
.kg-edge-panel button, .kg-edge-panel select { min-height: 2.15rem; }

  `;
  function readerRoot(host) {
    host.lang = locale;
    const root = host.attachShadow({mode: 'open'});
    root.append(element('style', readerCSS));
    return root;
  }

  async function fetchDocument(address, signal) {
    const timeout = AbortSignal.timeout(20_000);
    const response = await fetch(address, {mode:'same-origin', credentials:'same-origin',
      signal:signal ? AbortSignal.any([signal, timeout]) : timeout});
    if (!response.ok || !/text\/html/i.test(response.headers.get('content-type') || '')) throw new Error(t('nextPageNotHtml'));
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let html = '', size = 0;
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error(t('chapterHtmlTooLarge')); }
        html += decoder.decode(value, {stream:true});
      }
      html += decoder.decode();
    } finally { reader.releaseLock(); }
    // A template has an inert owner document. We only read attributes/text from it
    // and never attach, clone, execute, or copy a site's elements into the reader.
    const template = document.createElement('template');
    template.innerHTML = html;
    return {root:template.content, address:new URL(response.url)};
  }

  async function fetchChapter(address) {
    const parsed = await fetchDocument(address);
    const chapter = detectChapter(parsed.root, parsed.address);
    if (!chapter) throw new Error(t('nextChapterUnrecognized'));
    return chapter;
  }

  const AUTO = PREFIX + 'auto-next-chapter';
  let autoNext = false;
  const settingsChanged = new EventTarget();
  function applyAuto(value) {
    autoNext = value === true;
    settingsChanged.dispatchEvent(new Event('change'));
  }
  function toggleControl(signal) {
    const label = element('label');
    const input = element('input');
    input.type = 'checkbox';
    input.checked = autoNext;
    input.addEventListener('change', async () => {
      const enabled = input.checked;
      await write(AUTO, enabled);
      applyAuto(enabled);
    });
    settingsChanged.addEventListener('change', () => { input.checked = autoNext; }, {signal});
    label.append(input, document.createTextNode(t('autoContinue')));
    return label;
  }

  const VIEW = PREFIX + 'reader-view';
  const PARALLEL_PRELOAD = PREFIX + 'parallel-preload';
  const PARALLEL_PRELOAD_CHOICES = [1, 2, 3, 4, 5, 6];
  const DEFAULT_PARALLEL_PRELOAD = 3;
  const READ_AHEAD_PAGES = 3;
  const BUFFER_IDLE_MS = 1200;
  function createFlow(root, first, overlay, view = {}) {
    const controller = new AbortController();
    const pane = element('main', '', 'pages');
    const chapterActions = element('div', '', overlay ? 'chapter-actions' : 'tail');
    const endMarker = overlay ? element('div', '', 'chapter-boundary') : chapterActions;
    const chapterTitle = overlay ? element('strong', first.chapterTitle, 'source-chapter-title') : null;
    const chapterSubtitle = overlay ? element('span', '', 'source-chapter-subtitle') : null;
    if (chapterSubtitle) chapterSubtitle.lang = 'ja';
    const message = element('span');
    message.setAttribute('role','status');
    const nextButton = button('', () => appendNext());
    const visited = new Set([first.baseURL, first.chapterUrl]);
    const displayedImages = new Map();
    const groups = [];
    let liveChapter = first;
    let sourceScroll;
    let group, position = first.startIndex || 1, controls, scrollFrame = 0, scrollAnchor = null;
    let mode = ['single', 'double'].includes(view.mode) ? view.mode : 'scroll';
    let theme = ['light', 'dark'].includes(view.theme) ? view.theme : 'system';
    let direction = view.direction === 'ltr' ? 'ltr' : 'rtl';
    let tapToTurn = view.tapToTurn !== false;
    let thumbnailSize = ['small', 'large'].includes(view.thumbnailSize) ? view.thumbnailSize : 'medium';
    let current = first, busy = false, nearEnd = false, stopped = false;
    let imageTasks = Promise.resolve();
    let bufferMode = view.bufferMode === 'ahead' ? 'ahead' : 'chapter';
    let parallelPreload = PARALLEL_PRELOAD_CHOICES.includes(view.parallelPreload)
      ? view.parallelPreload : DEFAULT_PARALLEL_PRELOAD;
    let bufferScheduled = false, bufferReadyAt = 0, bufferCursor = 0;
    let bufferGroup, bufferPosition, bufferLayout, bufferRevision = 0;
    const bufferAttempts = new WeakMap();
    const bufferRetries = new WeakMap();
    const pendingBuffers = new WeakMap();
    const failedBuffers = new Map();
    const pendingDraws = new WeakMap();
    let progressTimer;
    let checkNativeBuffer;
    const bufferProgress = element('span', '', 'buffer-progress');
    bufferProgress.hidden = true;
    const bufferError = element('div');
    bufferError.hidden = true;
    const entries = new WeakMap();
    const requests = new WeakMap();
    const waitingForSource = new WeakSet();
    const options = {root: overlay || null, rootMargin:'360px 0px'};
    const imageObserver = new IntersectionObserver(changes => {
      for (const change of changes) {
        const figure = change.target;
        if (change.isIntersecting) loadFigure(figure);
        else if (liveChapter?.resolvePage && mode === 'scroll' && requests.has(figure) && !figure.querySelector('img')) {
          // After a long jump, leave the native pager free for the new viewport.
          releaseFigure(figure);
        }
      }
      scheduleBuffer();
    }, options);
    function showPageRetry(figure, message) {
      const caption = element('figcaption', message + ' ');
      caption.append(button(t('retry'), () => {
        releaseFigure(figure);
        loadFigure(figure);
      }));
      figure.append(caption);
    }
    function loadFigure(figure) {
      if (figure.hidden || requests.has(figure)) return;
      const ticket = Symbol();
      requests.set(figure, ticket);
      pendingDraws.set(figure, ticket);
      imageTasks = imageTasks.then(() => drawPage(figure, ticket)).catch(err => {
        if (!stopped && requests.get(figure) === ticket) showPageRetry(figure, err.message);
      }).finally(() => {
        if (pendingDraws.get(figure) === ticket) pendingDraws.delete(figure);
        scheduleBuffer();
      });
    }
    function releaseFigure(figure) {
      requests.delete(figure);
      waitingForSource.delete(figure);
      const image = displayedImages.get(figure);
      if (image) URL.revokeObjectURL(image.url);
      displayedImages.delete(figure);
      figure.replaceChildren();
      figure.style.minHeight = 'min(60vh, 420px)';
    }
    function revealNativePage(figure, index) {
      if (!overlay || !liveChapter?.revealPage || groups[0].figures.get(index) !== figure) return false;
      const before = {left:window.scrollX, top:window.scrollY, behavior:'instant'};
      if (!liveChapter.revealPage(index)) return false;
      if (window.scrollX !== before.left || window.scrollY !== before.top) sourceScroll ??= before;
      return true;
    }
    async function resolveFigure(figure, showNotice) {
      const page = entries.get(figure);
      const source = liveChapter;
      if (page.imageUrl || !overlay || !source?.resolvePage || groups[0].figures.get(page.index) !== figure) return page;
      const notice = showNotice && element('figcaption', t('waitingForPage', {page: page.index}));
      if (notice) figure.append(notice);
      try {
        const entry = await source.resolvePage(page.index, controller.signal);
        if (stopped || !liveChapter) return page;
        const resolved = entry?.index === page.index && entry.imageUrl && pageFor(source, entry);
        if (!resolved?.imageUrl) throw new Error(t('sitePageFailed', {page: page.index}));
        entries.set(figure, resolved);
        return resolved;
      } finally {
        if (notice) notice.remove();
      }
    }

    function restartBuffer() {
      bufferRevision++;
      checkNativeBuffer?.();
      bufferCursor = 0;
      bufferReadyAt = performance.now() + (bufferMode === 'chapter' ? BUFFER_IDLE_MS : 0);
      scheduleBuffer();
    }
    function lastVisiblePage() {
      let end = visibleEnd();
      if (mode === 'scroll') {
        const bottom = overlay.getBoundingClientRect().bottom;
        while (end < group.total && group.figures.get(end + 1)?.getBoundingClientRect().top < bottom) end++;
      }
      return end;
    }
    // A lazy slot can take several scans to publish its URL after scrolling.
    // Keep the slot in view until the native loader responds or reading moves on.
    function waitForNativeBuffer(figure, stillWanted) {
      return new Promise((resolve, reject) => {
        function finish(page) {
          clearTimeout(timer);
          checkNativeBuffer = null;
          resolve(page);
        }
        const timer = setTimeout(() => {
          checkNativeBuffer = null;
          reject(new Error(t('siteImageTimeout')));
        }, 8000);
        checkNativeBuffer = () => {
          const page = entries.get(figure);
          if (!stillWanted()) finish(null);
          else if (page.imageUrl) finish(page);
        };
        checkNativeBuffer();
      });
    }
    async function updateBufferProgress() {
      const section = group;
      const {site, workId, chapterId} = section.chapter;
      try {
        const count = await savedPageCount([site, workId || '', chapterId]);
        if (stopped || group !== section) return;
        const failed = [...failedBuffers].some(([figure]) => section.figures.get(Number(figure.dataset.index)) === figure);
        bufferProgress.hidden = false;
        bufferProgress.textContent = t(failed ? 'bufferProgressMissing' : 'bufferProgress', {count, total: section.total});
      } catch {
        if (!stopped && group === section) bufferProgress.textContent = t('bufferProgressFailed');
      }
    }
    function scheduleBufferProgress() {
      clearTimeout(progressTimer);
      progressTimer = setTimeout(updateBufferProgress, 80);
    }
    async function bufferNextPage() {
      if (stopped || document.hidden) return false;
      if (performance.now() < bufferReadyAt) return true;
      const full = bufferMode === 'chapter';
      const end = lastVisiblePage();
      const count = full ? group.total : Math.min(READ_AHEAD_PAGES, group.total - end);
      const parallel = group === groups[0] && liveChapter?.parallelPages;
      const limit = parallel ? parallelPreload : 1;
      const figures = [];
      const start = full ? bufferCursor || end : end;
      // Walk forward from the current spread, then wrap to earlier missing pages.
      for (let n = 0; n < count && figures.length < limit; n++) {
        const index = full ? (start + n) % count + 1 : start + n + 1;
        const figure = group.figures.get(index);
        if (!figure || pendingDraws.has(figure) || failedBuffers.has(figure) ||
            bufferAttempts.get(figure) === entries.get(figure)) continue;
        figures.push(figure);
        bufferCursor = index;
      }
      if (!figures.length) {
        const needsNextPage = full || group.total - end < READ_AHEAD_PAGES;
        if (needsNextPage && !busy && !message.textContent && group === groups.at(-1) && target()?.same) {
          await appendNext(true);
          return !message.textContent;
        }
        return false;
      }
      await Promise.all(figures.map(figure => {
        const task = bufferPage(figure).finally(() => pendingBuffers.delete(figure));
        pendingBuffers.set(figure, task);
        return task;
      }));
      return true;
    }
    async function bufferPage(figure) {
      const revision = bufferRevision;
      const page = entries.get(figure);
      const stillWanted = () => !stopped && !document.hidden && revision === bufferRevision;
      try {
        let resolved = page;
        if (!(await lookupPage(page, false)).exists) {
          if (!stillWanted()) return true;
          resolved = await resolveFigure(figure, false);
          if (!stillWanted()) return true;
          if (!resolved.imageUrl && revealNativePage(figure, page.index)) {
            resolved = await waitForNativeBuffer(figure, stillWanted);
            if (!resolved || !stillWanted()) return true;
          }
          if (!resolved.imageUrl) throw new Error(t('imageNotAvailable'));
          await saveLoaded(resolved);
        }
        bufferAttempts.set(figure, resolved);
        bufferRetries.delete(figure);
      } catch (error) {
        if (!stillWanted()) return true;
        const retries = bufferRetries.get(figure) || 0;
        if (retries < 2) {
          bufferRetries.set(figure, retries + 1);
          bufferReadyAt = performance.now() + 1000;
        } else {
          failedBuffers.set(figure, error.message);
          showBufferErrors();
        }
      }
    }
    function showBufferErrors() {
      const missing = [...failedBuffers].filter(([figure]) => group.figures.get(Number(figure.dataset.index)) === figure);
      bufferError.hidden = !missing.length;
      if (missing.length) {
        const [figure, reason] = missing[0];
        bufferError.replaceChildren(t('bufferMissing', {count: missing.length, page: figure.dataset.index, reason}) + ' ',
          button(t('retryPages'), () => {
            for (const [page] of missing) {
              failedBuffers.delete(page);
              bufferRetries.delete(page);
            }
            showBufferErrors();
            restartBuffer();
          }));
      }
      scheduleBufferProgress();
    }
    function scheduleBuffer() {
      if (!overlay || stopped || document.hidden || bufferScheduled) return;
      bufferScheduled = true;
      // Start behind queued visible work. Native pagers keep using the same
      // serial queue because selecting a new page replaces the current image.
      setTimeout(() => {
        const task = imageTasks.then(bufferNextPage);
        // Independent requests don't block a turn to a page outside their batch.
        const finished = task.catch(error => {
          console.warn('[KomaGlide]', error);
          return false;
        });
        if (!(group === groups[0] && liveChapter?.parallelPages)) imageTasks = finished;
        void finished.then(more => {
          bufferScheduled = false;
          if (more) scheduleBuffer();
        });
      }, Math.max(100, bufferReadyAt - performance.now()));
    }

    async function drawPage(figure, ticket) {
      const obsolete = () => stopped || requests.get(figure) !== ticket;
      if (obsolete()) return;
      await pendingBuffers.get(figure);
      if (obsolete()) return;
      const cached = await lookupPage(entries.get(figure), true);
      if (cached.exists) {
        bufferAttempts.set(figure, entries.get(figure));
        if (failedBuffers.delete(figure)) showBufferErrors();
      }
      if (obsolete()) return;
      let page = entries.get(figure);
      const img = element('img');
      img.alt = t('pageNumber', {page: page.index});
      img.dataset.index = String(page.index);
      let blob = cached.blob;
      if (!blob) {
        page = await resolveFigure(figure, true);
        if (obsolete()) return;
        if (!page.imageUrl) {
          waitingForSource.add(figure);
          if (revealNativePage(figure, page.index)) {
            showPageRetry(figure, t('waitingForPage', {page: page.index}));
          } else {
            figure.append(element('figcaption', t('pageNotSavedOnSite', {page: page.index})));
          }
          return;
        }
        try {
          const result = await capture(page);
          blob = result.blob;
          if (result.storageError) {
            if (!obsolete()) figure.append(element('figcaption', result.storageError.message));
          } else {
            bufferAttempts.set(figure, page);
            if (failedBuffers.delete(figure)) showBufferErrors();
          }
        } catch (err) {
          if (obsolete()) return;
          figure.append(element('figcaption', t('onlineDisplay', {reason: err.message})));
          img.src = page.imageUrl;
        }
      }
      if (obsolete()) return;
      if (blob) {
        img.src = URL.createObjectURL(blob);
        displayedImages.set(figure, {url:img.src, blob});
      }
      img.addEventListener('load', () => { figure.style.minHeight = ''; });
      img.addEventListener('error', () => figure.append(element('figcaption',t('imageDisplayFailed'))));
      figure.prepend(img);
    }

    function insertFigure(section, page) {
      const following = page.index < section.lastIndex && [...section.figures].find(([n]) => n > page.index);
      const before = following?.[1] || groups[groups.indexOf(section) + 1]?.title || null;
      const figure = element('figure');
      figure.dataset.index = String(page.index);
      figure.style.minHeight = 'min(60vh, 420px)';
      entries.set(figure, page);
      section.figures.set(page.index, figure);
      if (following) section.figures = new Map([...section.figures].sort(([a], [b]) => a - b));
      section.lastIndex = Math.max(section.lastIndex, page.index);
      pane.insertBefore(figure, before);
      imageObserver.observe(figure);
      return figure;
    }
    function ensureFigure(section, index) {
      if (section.figures.has(index)) return section.figures.get(index);
      // Some readers publish a page count before they create every image slot.
      // An absent slot can still have a local copy keyed by this page number.
      return insertFigure(section, {...section.chapter, index, imageUrl:''});
    }
    function addPages(chapter, heading) {
      let section = groups.at(-1);
      if (!section || heading) {
        const title = heading ? element('h2', chapter.chapterTitle) : null;
        if (title) pane.append(title);
        section = {title, chapter:chapterInfo(chapter), figures:new Map(), total:0, lastIndex:0};
        groups.push(section);
        if (!group) group = section;
      }
      mergePages(section, chapter);
      return section;
    }
    function mergePages(section, chapter) {
      const previousTotal = section.total;
      let changed = false;
      if (Number.isSafeInteger(chapter.total)) section.total = Math.max(section.total, chapter.total);
      // A single-image native pager exposes just the current page's URL.
      // Reserve its numbered slots so a scroll can request any page, including offline copies.
      if (overlay && chapter.resolvePage) {
        for (let index = previousTotal + 1; index <= section.total; index++) ensureFigure(section, index);
      }
      for (const entry of [...chapter.entries].sort((a, b) => a.index - b.index)) {
        const page = pageFor(chapter, entry);
        if (!page) continue;
        const existing = section.figures.get(page.index);
        if (existing) {
          const previousUrl = entries.get(existing).imageUrl;
          if (!page.imageUrl || previousUrl === page.imageUrl) continue;
          entries.set(existing, page);
          if (!displayedImages.has(existing) && (previousUrl || waitingForSource.has(existing))) {
            releaseFigure(existing);
            imageObserver.unobserve(existing);
            imageObserver.observe(existing);
          }
        } else insertFigure(section, page);
        section.total = Math.max(section.total, page.index);
        changed = true;
      }
      return changed || previousTotal !== section.total;
    }
    function firstVisible() {
      const top = overlay.getBoundingClientRect().top;
      if (scrollAnchor) {
        const bounds = scrollAnchor.getBoundingClientRect();
        if (bounds.bottom > top && bounds.top < overlay.getBoundingClientRect().bottom) return;
        scrollAnchor = null;
      }
      for (const section of groups) {
        for (const [index, figure] of section.figures) {
          if (figure.getBoundingClientRect().bottom > top + 1) {
            group = section;
            position = index;
            return;
          }
        }
      }
    }
    function visibleEnd() {
      const start = mode === 'double' ? position - ((position - 1) % 2) : position;
      return Math.min(group.total, start + (mode === 'double' ? 1 : 0));
    }
    function syncControls() {
      controls.update({mode, theme, direction, tapToTurn, thumbnailSize, current:position, total:group.total,
        chapterKey:JSON.stringify([group.chapter.workId, group.chapter.chapterId])});
      chapterTitle.textContent = group.chapter.chapterTitle;
      const subtitle = group.chapter.chapterSubtitle;
      chapterSubtitle.textContent = subtitle || '';
      chapterSubtitle.hidden = !subtitle;
      if (bufferGroup !== group || bufferPosition !== position || bufferLayout !== mode) {
        if (bufferGroup !== group) showBufferErrors();
        bufferGroup = group;
        bufferPosition = position;
        bufferLayout = mode;
        restartBuffer();
      } else scheduleBuffer();
    }
    function updateView() {
      if (!overlay || !group) return;
      syncControls();
      overlay.dataset.readerMode = mode;
      overlay.dataset.readerDirection = direction;
      overlay.classList.toggle('paged', mode !== 'scroll');
      const start = mode === 'double' ? position - ((position - 1) % 2) : position;
      const end = visibleEnd();
      if (mode !== 'scroll') {
        for (let index = start; index <= end; index++) ensureFigure(group, index);
      }
      for (const section of groups) {
        if (section.title) section.title.hidden = mode !== 'scroll';
        for (const [index, figure] of section.figures) {
          const hidden = mode !== 'scroll' && (section !== group || index < start || index > end);
          if (hidden && !figure.hidden) releaseFigure(figure);
          figure.hidden = hidden;
          const onSpread = mode === 'double' && !hidden;
          figure.classList.toggle('spread-single', onSpread && start === end);
          figure.classList.toggle('spread-right', onSpread && start < end && index === (direction === 'rtl' ? start : end));
          figure.classList.toggle('spread-left', onSpread && start < end && index === (direction === 'rtl' ? end : start));
          if (!hidden && mode !== 'scroll') loadFigure(figure);
        }
      }
      renderEnd();
    }
    function saveView() { void write(VIEW, {mode, theme, direction, tapToTurn, thumbnailSize, bufferMode}); }
    function scrollToPosition() {
      // At the end of a short chapter the viewport may also show an earlier page.
      // Keep the selected page until the reader scrolls again.
      scrollAnchor = ensureFigure(group, position);
      overlay.scrollTop += scrollAnchor.getBoundingClientRect().top - overlay.getBoundingClientRect().top;
    }
    function pickPage(index) {
      if (!Number.isSafeInteger(index) || index < 1 || index > group.total) return;
      position = index;
      updateView();
      if (mode === 'scroll') scrollToPosition();
    }
    function changeMode(value) {
      if (mode === 'scroll') firstVisible();
      mode = value;
      updateView();
      if (mode === 'scroll') scrollToPosition();
      else overlay.scrollTop = 0;
      saveView();
    }
    function target() {
      if (current.nextPage && !visited.has(current.nextPage)) return {url:current.nextPage, same:true};
      if (current.nextChapter && !visited.has(current.nextChapter)) return {url:current.nextChapter, same:false};
      return null;
    }
    function renderEnd() {
      const next = target();
      const paged = overlay && mode !== 'scroll';
      const atEnd = !paged || visibleEnd() === group.total;
      const loadedNext = paged && groups.indexOf(group) < groups.length - 1;
      previousGroup.hidden = !paged || groups.indexOf(group) < 1 || position > (mode === 'double' ? 2 : 1);
      nextButton.textContent = loadedNext ? t('nextChapter') : next?.same ? t('continuePage') : t('continueChapter');
      nextButton.disabled = busy;
      nextButton.hidden = !atEnd || (!loadedNext && !next);
      chapterActions.hidden = previousGroup.hidden && nextButton.hidden && !message.textContent;
    }
    async function appendNext(background = false) {
      if (stopped || busy) return;
      if (overlay && mode !== 'scroll' && groups.indexOf(group) < groups.length - 1) {
        group = groups[groups.indexOf(group) + 1];
        position = 1;
        updateView();
        return;
      }
      const next = target();
      if (!next) return;
      busy = true;
      message.textContent = t('connecting');
      renderEnd();
      try {
        let chapter = await fetchChapter(next.url);
        if (stopped) return;
        visited.add(next.url);
        if (next.same) {
          const previous = current;
          const last = Math.max(...previous.entries.map(e => e.index));
          const more = chapter.entries.map((entry, i) => ({...entry, index:last + i + 1}));
          chapter = {...chapter, chapterId:previous.chapterId, chapterUrl:previous.chapterUrl,
            chapterTitle:previous.chapterTitle, workId:previous.workId, workTitle:previous.workTitle,
            total:last + more.length, entries:more};
        }
        current = chapter;
        const added = addPages(chapter, !next.same);
        if (overlay) {
          if (background) updateView();
          else if (mode === 'scroll') {
            firstVisible();
            syncControls();
          } else {
            group = added;
            position = chapter.entries[0]?.index || 1;
            updateView();
          }
        }
        message.textContent = '';
        if (overlay) scheduleBufferProgress();
        // Re-observe the boundary after layout. Small chapters may still fit in view.
        boundary.unobserve(endMarker);
        boundary.observe(endMarker);
      } catch (err) {
        message.textContent = err.message;
      } finally {
        busy = false;
        renderEnd();
      }
    }
    function maybeContinue() {
      if ((!overlay || mode === 'scroll') && nearEnd && !message.textContent && (target()?.same || autoNext)) void appendNext();
    }
    const boundary = new IntersectionObserver(changes => {
      nearEnd = changes[changes.length-1].isIntersecting;
      maybeContinue();
    }, options);
    settingsChanged.addEventListener('change', maybeContinue, {signal:controller.signal});
    const previousGroup = button(t('previousChapter'), () => {
      group = groups[groups.indexOf(group) - 1];
      position = group.total;
      updateView();
    });
    chapterActions.append(message, previousGroup, nextButton);
    if (!overlay) chapterActions.append(toggleControl(controller.signal));
    root.append(pane, endMarker);
    if (overlay) {
      addPages(first, false);
      const settingsExtras = [chapterTitle, chapterSubtitle, bufferError, toggleControl(controller.signal), button(t('closeReader'), () => overlay.close())];
      overlay.append(...settingsExtras, chapterActions, bufferProgress);
      getShelfEvents().changes.addEventListener('change', ({detail}) => {
        if (detail.kind === 'limit' || (detail.kind === 'saved' && detail.workId === group.chapter.workId &&
            detail.chapterId === group.chapter.chapterId)) scheduleBufferProgress();
      }, {signal:controller.signal});
      controls = mountReaderControls(overlay, {
        mode, theme, direction, tapToTurn, thumbnailSize, keyTarget:overlay, themeTarget:overlay, tapTarget:pane, onMode:changeMode,
        settingsExtras, navigationExtras:[chapterActions], bufferMode,
        parallelPreload: first.parallelPages ? {
          value: parallelPreload,
          choices: PARALLEL_PRELOAD_CHOICES,
          onChange(value) {
            parallelPreload = Number(value);
            // Let in-flight requests finish. The next batch uses the new limit.
            void write(PARALLEL_PRELOAD, parallelPreload);
            scheduleBuffer();
          }
        } : null,
        onBufferMode(value) {
          bufferMode = value;
          saveView();
          restartBuffer();
        },
        onTheme(value) {
          theme = value;
          controls.update({theme});
          saveView();
        },
        onDirection(value) { direction = value; updateView(); saveView(); },
        onTapToTurn(value) { tapToTurn = value; controls.update({tapToTurn}); saveView(); },
        onThumbnailSize(value) { thumbnailSize = value; controls.update({thumbnailSize}); saveView(); },
        onTurn:pickPage, onPick:pickPage,
        getCurrentPage() {
          if (mode === 'scroll') { firstVisible(); syncControls(); }
          return position;
        },
        async getThumbnail(index, size) {
          if (!Number.isSafeInteger(index) || index < 1 || index > group.total) return null;
          const figure = group.figures.get(index);
          const local = displayedImages.get(figure);
          if (local) return makeReaderThumbnail(local.blob, size);
          // A preview reads only from the local library. Missing pages stay selectable.
          const page = entries.get(figure) || {...group.chapter, index};
          const {blob} = await lookupPage(page, true);
          return blob ? makeReaderThumbnail(blob, size) : null;
        }
      });
      updateView();
      if (mode === 'scroll' && position > 1) scrollToPosition();
      document.addEventListener('visibilitychange', restartBuffer, {signal:controller.signal});
      const clearScrollAnchor = () => { scrollAnchor = null; if (mode === 'scroll') restartBuffer(); };
      const scrollInput = {passive:true, signal:controller.signal};
      for (const type of ['wheel', 'touchmove']) overlay.addEventListener(type, clearScrollAnchor, scrollInput);
      overlay.addEventListener('keydown', event => {
        if (['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key)) clearScrollAnchor();
      }, scrollInput);
      overlay.addEventListener('pointerdown', event => {
        if (event.target === overlay) clearScrollAnchor();
      }, scrollInput);
      overlay.addEventListener('scroll', () => {
        if (scrollFrame || mode !== 'scroll') return;
        scrollFrame = requestAnimationFrame(() => {
          scrollFrame = 0;
          if (mode === 'scroll' && !stopped) {
            firstVisible();
            syncControls();
          }
        });
      }, {passive:true, signal:controller.signal});
    }
    renderEnd();
    boundary.observe(endMarker);
    function dispose() {
      stopped = true;
      checkNativeBuffer?.();
      controller.abort();
      controls?.destroy();
      cancelAnimationFrame(scrollFrame);
      clearTimeout(progressTimer);
      imageObserver.disconnect();
      boundary.disconnect();
      for (const {url} of displayedImages.values()) URL.revokeObjectURL(url);
      if (sourceScroll && liveChapter) window.scrollTo(sourceScroll);
    }
    function refreshSource(chapter) {
      liveChapter = chapter.workId === first.workId && chapter.chapterId === first.chapterId ? chapter : null;
      if (liveChapter) {
        const section = groups[0];
        const subtitleChanged = section.chapter.chapterSubtitle !== liveChapter.chapterSubtitle;
        section.chapter.chapterSubtitle = liveChapter.chapterSubtitle;
        if (mergePages(section, liveChapter) || subtitleChanged) updateView();
      }
      checkNativeBuffer?.();
    }
    return {dispose, refreshSource};
  }

  function trackDockViewport(dock) {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let frame = 0;
    function update() {
      frame = 0;
      if (viewport.height > 0) {
        dock.style.setProperty('--dock-visible-bottom', (viewport.offsetTop + viewport.height) + 'px');
      }
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(update);
    }
    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule, {passive:true});
    window.addEventListener('resize', schedule);
    window.addEventListener('pageshow', schedule);
    update();
  }

  function sourceReader() {
    const host = element('div');
    host.className = 'kg-source-tools';
    const root = readerRoot(host);
    const dock = element('div','', 'dock');
    dock.setAttribute('role', 'group');
    dock.setAttribute('aria-label', 'KomaGlide');
    const status = button(t('library'), openShelf);
    status.className = 'dock-shelf';
    status.title = t('openSiteLibrary');
    const count = element('span', '', 'dock-count');
    status.append(count);
    const errorNotice = element('p', '', 'dock-error');
    errorNotice.setAttribute('role', 'status');
    errorNotice.tabIndex = 0;
    const open = button(t('verticalReader'), openReader);
    open.className = 'dock-reader';
    dock.append(open, status, errorNotice);
    root.append(dock);
    document.body.append(host);
    trackDockViewport(dock);
    let chapter, inlineHost, inlineFlow, dialog, overlayFlow;
    async function openReader() {
      if (dialog || !chapter) return;
      dialog = element('dialog');
      dialog.setAttribute('aria-label',t('verticalReader'));
      const [view, parallelPreload] = await Promise.all([
        read(VIEW).catch(() => null),
        chapter.parallelPages ? read(PARALLEL_PRELOAD).catch(() => null) : null
      ]);
      root.append(dialog);
      dialog.showModal();
      const savedOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = 'hidden';
      dialog.addEventListener('close', () => {
        overlayFlow?.dispose();
        overlayFlow = null;
        dialog.remove();
        dialog = null;
        document.documentElement.style.overflow = savedOverflow;
        open.focus({preventScroll:true});
      }, {once:true});
      overlayFlow = createFlow(dialog, chapter, dialog, {...view, parallelPreload});
    }
    GM_registerMenuCommand(t('verticalReader'), openReader);
    return {
      update(value) {
        const changed = chapter?.chapterId !== value.chapterId || chapter?.workId !== value.workId;
        chapter = value;
        overlayFlow?.refreshSource(value);
        if (!changed) return;
        inlineFlow?.dispose();
        inlineFlow = null;
        inlineHost?.remove();
        if (!value.nextPage && !value.nextChapter) return;
        const last = value.entries[value.entries.length-1].img;
        const anchor = last.closest('.webcomic-page,[data-comic-pages],#comic,.comic-pages,#comic-pages,#comicpage') ||
          last.closest('picture,a') || last;
        inlineHost = element('div');
        anchor.after(inlineHost);
        inlineFlow = createFlow(readerRoot(inlineHost), chapter, null);
      },
      show(text, error) {
        count.textContent = text;
        const detail = error || '';
        if (errorNotice.textContent !== detail) errorNotice.textContent = detail;
      }
    };
  }

  function runSource() {
    const saved = new Set();
    const failures = new Map();
    const queue = [];
    const pending = new Set();
    let active = false;
    let scanScheduled = false;
    let hasNativePager = false;
    let pageLabelSelector;
    let controls;
    let chapterKey;
    let chapterTotal;
    let statusRevision = 0;
    let statusTimer;
    GM_addValueChangeListener(AUTO, (_name, _old, value) => applyAuto(value));
    void read(AUTO).then(applyAuto);

    function show(text, error) { controls?.show(text, error); }

    function isCurrentChapter(page) {
      return page.chapterId === chapterKey[2] && (page.workId || '') === chapterKey[1];
    }

    function refreshStatus() {
      const revision = ++statusRevision;
      clearTimeout(statusTimer);
      if (active) return;
      const failure = [...failures.values()].find(item => isCurrentChapter(item.page));
      if (failure) {
        show(t('savingPaused'), failure.error);
        return;
      }
      // One metadata read per burst, including writes by the reader or another tab.
      statusTimer = setTimeout(async () => {
        try {
          const count = await savedPageCount(chapterKey);
          if (revision !== statusRevision || active) return;
          const key = chapterTotal >= count && chapterTotal > 0 ? 'savedPagesOfTotal' : 'savedPages';
          show(t(key, {count, total: chapterTotal}));
        } catch (error) {
          if (revision === statusRevision && !active) show(t('savedCountFailed'), error.message);
        }
      }, 60);
    }

    async function drain() {
      if (active || !queue.length) return;
      active = true;
      while (queue.length) {
        const {page, key} = queue.shift();
        if (isCurrentChapter(page)) show(t('savingPage', {page: page.index}));
        try {
          await saveLoaded(page);
          saved.add(key);
          failures.delete(key);
        } catch (err) {
          const attempts = (failures.get(key)?.attempts || 0) + 1;
          failures.set(key, {page, attempts, error: String(err.message), retryAt: Date.now() + 2500 * attempts});
          if (attempts < 3) setTimeout(schedule, 2600 * attempts);
          console.warn('[KomaGlide]', err.message);
        } finally { pending.delete(key); }
      }
      active = false;
      refreshStatus();
    }

    let pendingSubtitle;
    function rememberSubtitle(chapter, key, subtitle) {
      if (chapterSubtitles.get(chapter.chapterUrl) === subtitle) return;
      chapterSubtitles.set(chapter.chapterUrl, subtitle);
      void setChapterSubtitle(key, subtitle).then(changed => {
        if (changed) getShelfEvents().announce({kind:'subtitle'});
      }).catch(() => {});
    }
    function syncSubtitle(chapter) {
      if (!chapter.loadChapterSubtitle) return;
      if (chapter.chapterSubtitle !== undefined) {
        rememberSubtitle(chapter, chapterKey, chapter.chapterSubtitle);
      } else if (chapterSubtitles.has(chapter.chapterUrl)) {
        chapter.chapterSubtitle = chapterSubtitles.get(chapter.chapterUrl);
      } else if (pendingSubtitle?.url !== chapter.chapterUrl) {
        pendingSubtitle?.controller.abort();
        const controller = new AbortController();
        pendingSubtitle = {url:chapter.chapterUrl, controller};
        const key = chapterKey;
        void (async () => {
          // A cached chapter can show its subtitle even with the gallery offline.
          const storedSubtitle = await readChapterSubtitle(key).catch(() => undefined);
          const subtitle = storedSubtitle ?? await chapter.loadChapterSubtitle(controller.signal);
          if (controller.signal.aborted || subtitle === undefined) return;
          if (!chapterSubtitles.has(chapter.chapterUrl)) rememberSubtitle(chapter, key, subtitle);
          schedule();
        })().catch(() => {});
      }
    }

    function scan() {
      const chapter = detectChapter();
      if (!chapter) return;
      hasNativePager = Boolean(chapter.resolvePage);
      pageLabelSelector = chapter.pageLabelSelector;
      if (!controls) {
        controls = sourceReader();
        getShelfEvents().changes.addEventListener('change', ({detail}) => {
          // A write to another chapter can also evict the displayed chapter.
          if (detail.kind === 'saved' || detail.kind === 'limit') refreshStatus();
        });
      }
      if (!chapterKey || !isCurrentChapter(chapter) || chapterTotal !== chapter.total) {
        chapterKey = [location.origin, chapter.workId || '', chapter.chapterId];
        chapterTotal = chapter.total;
        refreshStatus();
      }
      syncSubtitle(chapter);
      controls.update(chapter);
      for (const entry of chapter.entries) {
        const {img, index} = entry;
        if (!img.complete || !img.naturalWidth || (img.naturalWidth <= 2 && img.naturalHeight <= 2)) continue;
        const page = pageFor(chapter, entry, true);
        if (!page) continue;
        const key = JSON.stringify([page.site, page.workId, page.chapterId, index]);
        const failure = failures.get(key);
        if (saved.has(key) || pending.has(key) || (failure && (failure.attempts >= 3 || Date.now() < failure.retryAt))) continue;
        queue.push({page, key});
        pending.add(key);
      }
      void drain();
    }
    function schedule() {
      if (scanScheduled) return;
      scanScheduled = true;
      setTimeout(() => {
        scanScheduled = false;
        scan();
      }, 120);
    }
    document.addEventListener('load', event => {
      if (!(event.target instanceof HTMLImageElement)) return;
      // Take a snapshot after the native load handler updates its page number
      // and before the next user action can replace the shared image node.
      if (hasNativePager) queueMicrotask(scan);
      else schedule();
    }, true);
    new MutationObserver(changes => {
      // Some readers finish labelling an already decoded image in a later DOM update.
      const selector = pageLabelSelector ? 'img,source,' + pageLabelSelector : 'img,source';
      if (changes.some(({target, addedNodes}) => target instanceof HTMLImageElement ||
        (pageLabelSelector && target.closest?.(pageLabelSelector)) ||
        [...addedNodes].some(node => node.nodeType === 1 && (node.matches(selector) || node.querySelector(selector))))) schedule();
    }).observe(document.documentElement, {subtree:true, childList:true, attributes:true, attributeFilter:['src','srcset']});
    window.addEventListener('popstate', schedule);
    window.addEventListener('hashchange', schedule);
    scan();
  }

  const language = read(languageKey).catch(() => null);
  async function start() {
    setLocale(await language);
    GM_registerMenuCommand(t('openKomaGlideLibrary'), openShelf);
    if (location.hash.startsWith(SHELF_HASH)) displayShelf();
    else runSource();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, {once: true});
  } else {
    void start();
  }
})();
