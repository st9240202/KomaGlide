# KomaGlide

[繁體中文](README.md) · [日本語](README.ja.md) · **English** · [简体中文](README.zh-Hans.md)

Read comics continuously on their original sites. KomaGlide automatically saves loaded comic images to the site's IndexedDB. Gear on iPhone and Tampermonkey on desktop use the same [KomaGlide userscript][install]. The reader, library, and site detection are bundled into one file.

## Installation and Automatic Updates

1. On iPhone, open the [installation link][install] in Gear and follow the prompts to install and enable the script. You can also save the file to Files and import it from Gear's userscript manager. On desktop, open the same link in a browser with Tampermonkey enabled.
2. Open a supported comic chapter such as [xkcd #1](https://xkcd.com/1/). Once the site loads the images, KomaGlide displays the number of saved pages. New pages require a connection to the original site. On subsequent visits, the reader uses saved images when available.

Starting with 0.7.10, the script manager can check for and download new versions from GitHub according to its update settings. If you imported an older version from a local file or pasted the script manually, use the [installation link][install] to update once.

[install]: https://raw.githubusercontent.com/st9240202/KomaGlide/main/dist/komaglide.user.js

## Open the Library

On any regular webpage, open the Gear or Tampermonkey script menu and choose **Open KomaGlide Library**. The library opens in a new foreground tab. On a site where you've saved comics, it opens that site's library. From another site, it opens the most recently recorded comic site's library. If you haven't saved any comics yet, it shows an empty library for the current site. On a comic page, the **Library** button in the lower right shows the save progress and opens the site's library. Reading and saving images take place in the original tab.

Each site origin has its own library with a default limit of 1 GiB. Storage limits, whole-chapter eviction, and favorites for works and individual chapters apply per site. Clearing a site's data also removes its saved images. Images saved in the legacy central library still belong to its original URL. The current version builds a per-site cache as you read on the original site.

The script loads the library interface directly. After restarting Gear or Chrome, the browser still needs to open a page on the site to run the script. A bookmark may fail to open the library from a cold start in airplane mode. Once the library is open, it can read saved pages directly from the device.

## Change the Interface Language

The default language is Traditional Chinese. Open the KomaGlide library and use **Language** at the top to choose 繁體中文, 日本語, English, or 简体中文. This setting applies to the library, reader, and script menu across comic sites in the same script manager. Reload any open comic tabs to apply the change. Work and chapter titles come from the original site.

## Reader Controls

Select **Vertical Reader** on a comic page to use vertical scroll, single-page, or double-page mode. By default, after you stay on the same page for about one second, the reader preloads the entire chapter one page at a time. It starts from the current page and then fills in any earlier missing pages. You can also choose **Preload next 3 pages** under **Reading Settings** → **Preload Mode**. The reader remembers your choice, and both modes use saved images first. Use the settings on the left to change the appearance, reading direction, or tap-to-turn behavior. Use the navigation on the right to turn pages, jump with thumbnails, or go to an adjacent chapter. You can continue to the next chapter at the end, and the reader remembers the **Continue Automatically** setting.

On desktop Manhuagui, the site's page selector and continuous scrolling are supported. When the selector is on page 1, images loaded as you scroll are saved using the page numbers below them. On mobile, open a chapter from the list, then choose Start Preload to save the chapter or Vertical Reader to read it.

Built-in site detection covers xkcd, Pepper&Carrot, selected 8comic reader pages, desktop and mobile reader pages on Manhuagui, and gallery and reader pages on nhentai.net and Hitomi.la. The limit per cached image is 32 MiB.

## Build

Run `node scripts/build.mjs` to generate `dist/komaglide.user.js`. You can specify an output directory as the first argument. After installing the script, you can read, save images, and open the library directly on your device.

To publish a new version, increment `@version` in `src/userscript.meta`, rebuild, and push both the source and the installable script to `main`. Script managers will see the new version during their next update check.

## Add Site Support

Add a JavaScript file under `src/sites/` and register it with `siteAdapters.push(function (root, address) { … })`. Use the [Pepper&Carrot adapter](src/sites/pepper-carrot.js) as an example. The build includes adapters in filename order and tries [generic detection](src/sites/generic.js) last.

- `root` is the current document or the detached contents of the next page. `address` is the URL of that page. Read from the supplied `root` so the adapter works in both reading contexts.
- Return `null` when the page does not match. On success, return stable `chapterId`, `chapterTitle`, `chapterUrl`, `workId`, `workTitle`, and `entries` fields. Each entry includes the comic image element `img` and a 1-based page number `index`. Leave the work fields empty if the work is unknown.
- You can include the known page count `total` and the opening page `startIndex`. Use `nextPage` for the next page in the chapter and `nextChapter` for the next chapter. Omitted fields fall back to generic link detection. Set a field to `null` to stop there. Continuation stays within the same origin.
- For sites that load images as you scroll, provide `revealPage(index)` to scroll the original page into view and return whether it was found. The pop-up reader checks the library first and calls this only when the page is missing and the original site has yet to provide an image URL.
- For sites that show one image at a time, provide an asynchronous `resolvePage(index, signal)`. The reader checks the library first and uses the original site's page selector for a missing page. Wait for the page number and loaded image to match before returning the entry. See the [Manhuagui adapter](src/sites/manhuagui.js).
- Adapters that can load pages independently can set `parallelPages: true` and specify `defaultParallelPreload` (1–6, defaults to 3). Users can override the setting for the current site in Reading Settings or select “Site default” to restore it.
- Rebuild and install the generated userscript. Check page order and network requests when opening a chapter directly, continuing on the original tab, using the pop-up reader, and opening the library from the script menu.

## Testing

The [standalone test](tests/standalone.cjs) uses mock comic pages to check automatic image saving at mobile sizes, reading the same images after closing a tab, and opening the library from another site's script menu. Run the WebKit variant with `TEST_BROWSER=webkit node tests/standalone.cjs`.

The [desktop integration test](tests/browser-smoke.cjs) uses Chromium and the official Tampermonkey extension. Additional tests cover [8comic](tests/8comic.cjs), [Manhuagui](tests/manhuagui.cjs), and [per-site storage limits](tests/library-capacity.cjs). Browser tests require Playwright Core and the corresponding browser.
