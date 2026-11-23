# KomaGlide

**繁體中文** · [日本語](README.ja.md) · [English](README.en.md) · [简体中文](README.zh-Hans.md)

在漫畫原站連續閱讀，自動把已載入的正文圖存到該站的 IndexedDB。iPhone 的 Gear 和桌面 Tampermonkey 使用同一份 [KomaGlide 使用者腳本][install]。閱讀器、書庫介面和網站辨識都已包在腳本裡。

## 安裝與自動更新

1. 在 iPhone 用 Gear 開啟[安裝連結][install]，依提示安裝並啟用。也可以將檔案存到「檔案」，再從 Gear 的使用者腳本管理匯入。桌面使用者請在已啟用 Tampermonkey 的瀏覽器開啟同一連結。
2. 開啟支援的漫畫章節，例如 [xkcd 第 1 話](https://xkcd.com/1/)。原站載入圖片後會顯示「已保存」頁數。第一次看新頁面需要連上漫畫站，之後閱讀器會優先讀取已存的圖片。

從 0.7.10 起，腳本管理器可依更新設定從 GitHub 檢查並下載新版。如果先前是從本機檔案匯入或貼上舊版程式碼，請先開啟[安裝連結][install]更新一次。

[install]: https://raw.githubusercontent.com/st9240202/KomaGlide/main/dist/komaglide.user.js

## 開啟書庫

在一般網頁打開 Gear 或 Tampermonkey 的腳本選單，選「開啟 KomaGlide 書庫」。書庫會在獨立的前景分頁開啟。在存過漫畫的網站會打開該站書庫。從其他網站開啟時，會前往最近記錄的漫畫站。尚未存過漫畫時會顯示目前網站的空書架。漫畫頁右下角的「書庫」按鈕會顯示保存進度，點一下即可開啟本站書庫。平常閱讀和存圖都在原分頁完成。

書庫依網站來源分開。每站預設上限為 1 GiB，容量設定、整話淘汰以及作品和單話收藏適用於該站。清除該站的網站資料會一併清除圖片。舊版集中書庫的圖片仍屬於舊書庫網址，新版在原站閱讀時會建立本站快取。

書庫介面直接從腳本載入。重新啟動 Gear 或 Chrome 後，瀏覽器仍須能開啟該站網頁才能執行腳本。飛航模式下可能無法從書籤冷啟動。已在書庫中的頁面可直接從本機讀圖。

## 切換介面語言

預設為繁體中文。打開 KomaGlide 書庫，從上方「語言」選擇繁體中文、日本語、English 或简体中文。選擇會套用到書庫、閱讀器和腳本選單，同一腳本管理器內的各漫畫站共用此設定。已開啟的漫畫分頁重新整理後會套用新語言。作品與章節名稱沿用原站內容。

## 閱讀操作

在漫畫分頁點「直向閱讀器」即可使用直向捲動、單頁和雙頁模式。在同一頁停留約 1 秒後，閱讀器預設會逐頁緩衝整話，從目前畫面往後讀，再補齊前面缺的頁面。也可在「閱讀設定」的「緩衝模式」改選「只預載後面 3 頁」。閱讀器會記住選擇，兩種模式都優先使用書庫已有的圖片。左側設定可切換外觀、翻頁方向和點按翻頁，右側導覽可翻頁、用小圖選頁或前往相鄰章節。話末可接續下一話，「自動接下一話」會記住選擇。

漫畫櫃桌面版支援原站選頁與連續捲動。原站選頁器停在第 1 頁時，向下捲動已載入的正文圖也會依圖下頁碼保存。手機版從列表進入章節後，可直接點「開始載入」存整話，或開啟「直向閱讀器」。

支援的網站包括 xkcd、Pepper&Carrot、8comic 的指定閱讀頁、漫畫櫃的桌面版與手機版閱讀頁，以及 nhentai.net 的圖庫與單頁閱讀頁。每張快取圖片的上限為 32 MiB。

## 建置

開發者執行 `node scripts/build.mjs` 即可產生 `dist/komaglide.user.js`。可用第一個參數指定輸出資料夾。安裝完成後，使用者可在裝置上獨立閱讀、存圖及開啟書庫。

發布新版時，先提高 `src/userscript.meta` 的 `@version`，重新建置，再將原始碼與安裝檔一併推送到 `main`。腳本管理器會在下次檢查時看到新版本。

## 新增網站支援

在 `src/sites/` 新增一個 JavaScript 檔，參考 [Pepper&Carrot 模組](src/sites/pepper-carrot.js)。使用 `siteAdapters.push(function (root, address) { … })` 註冊。建置會依檔名順序納入各模組，最後才使用[通用辨識](src/sites/generic.js)。

- `root` 是當前網頁或尚未掛入頁面的下一頁內容，`address` 是該頁網址。模組從傳入的 `root` 讀取內容，兩種閱讀模式就能共用。
- 網頁不符合時回傳 `null`。成功時提供穩定的 `chapterId`、`chapterTitle`、`chapterUrl`、`workId`、`workTitle`、`entries`。每個 entry 包含正文圖片元素 `img` 和從 1 開始的頁碼 `index`。作品未確認時將作品欄位留空。
- 可附上已知總頁數 `total`，以及開啟閱讀器時的起始頁碼 `startIndex`。用 `nextPage` 指向本話下一頁，`nextChapter` 指向下一話。缺省時採用通用連結辨識，指定 `null` 代表到此結束。接頁限於同一來源。
- 原站隨捲動載圖時，模組可提供 `revealPage(index)`，將原站對應的頁面捲入視窗，並回傳是否找到該頁。彈出閱讀器會先查書庫，只在該頁缺圖且原站尚未提供圖片網址時呼叫它。
- 原站一次顯示一張圖時，可提供非同步的 `resolvePage(index, signal)`。閱讀器會先查書庫，缺頁才操作原站選頁器。模組等到頁碼和已載入的圖片一致後，回傳該頁的 entry。[漫畫櫃模組](src/sites/manhuagui.js)
- 能獨立載入各頁的模組可設定 `parallelPages: true`，並用 `defaultParallelPreload` 指定預設並行數（1–6，省略時為 3）。使用者可在閱讀設定覆寫本站的並行數，或選「使用網站預設」恢復。
- 重新建置後安裝輸出的單一腳本。請以直接進章節、原站連讀、彈出閱讀器及從選單開書庫四種情境驗證頁序與流量。

## 驗證

[單檔測試](tests/standalone.cjs) 驗證手機尺寸下自動存圖、關閉分頁後讀取相同圖片，以及從其他網站的腳本選單開書庫。可用 `TEST_BROWSER=webkit node tests/standalone.cjs` 執行 WebKit 版本。這些測試使用模擬漫畫頁。

[桌面整合測試](tests/browser-smoke.cjs) 使用 Chromium 和官方 Tampermonkey。另有 [8comic](tests/8comic.cjs)、[漫畫櫃](tests/manhuagui.cjs) 及[本站容量測試](tests/library-capacity.cjs)。瀏覽器測試需要 Playwright Core 和對應瀏覽器。
