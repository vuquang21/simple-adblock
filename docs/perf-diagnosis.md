# Simple AdBlock — vì sao youtube.com đứng và Chrome treo

Chẩn đoán tĩnh (không đo trên máy), ngày 2026-10-24. Không sửa dòng code nào trong lần chẩn đoán
này. Cập nhật: **nhóm A đã sửa** ở commit `e614446` (tick 300ms chỉ trong `#movie_player`, sweep
1500ms cho 14 selector) — các nhóm B, C, D, E dưới đây vẫn còn nguyên.
Baseline: 6 test trong AGENTS.md xanh; `git diff` chỉ có 3 file dirty sẵn từ trước
(`.claude/CLAUDE.md`, `background.js` fix unhandled rejection, `test/background.test.js`) — không phải thay đổi của lần chẩn đoán này.

## 1. Đường nóng (hot path)

### background.js — service worker

| Dòng | Tần suất | Chi phí |
|---|---|---|
| `background.js:186` `chrome.webRequest.onBeforeRequest.addListener(track, { urls: ["<all_urls>"] })` | mỗi request, mọi tab | Extension đăng ký `webRequest` non-blocking: Chrome vẫn phải dispatch event sang SW cho **từng** request. Một video YouTube bắn hàng trăm request (`googlevideo.com/videoplayback`, `youtubei/v1/*`); mỗi dispatch đánh thức MV3 SW vừa bị kill sau 30s idle. |
| `background.js:115-131` `track()` | mỗi request khớp | 2× `new URL()` (`:119`, `:122`) — URL `videoplayback` dài 500-900 ký tự; `AD_HINT.test(host)` (`shared.js:214`, alternation ~200 literal); `baseDomain` (`shared.js:223`); `isWhitelisted` (`shared.js:152`). |
| `background.js:96-112` `refreshBadge` | tối đa 1 lần/giây/tab | `DNR.getMatchedRules({tabId})` trả về **toàn bộ** matched rules của tab (không phân trang) rồi `.filter()` — xem càng lâu, mảng càng dài; cộng `chrome.action.setBadgeText` mỗi giây. |
| `background.js:134-154` `scheduleFlush` | mỗi 2s khi có request ad-like | `storage.local.get(["domains","detected"])` (`:145`) + `storage.local.set({ detected, domains: domains.sort() })` (`:152`): ghi lại **toàn bộ** mảng domains (867 host mặc định, 10k-30k sau import) + `sort()` mỗi lần, dù không có host mới. |
| `background.js:173-176` → `syncRules()` (`:30-85`) | mỗi lần `domains` đổi | `DNR.getDynamicRules()` (`:46`) serialize **tất cả** dynamic rule qua IPC; `storage.local.set({ ruleIds })` (`:79`) ghi map 1 entry/domain. Với list 30k: mỗi chu kỳ ~chục MB JSON, hai chiều. |
| `background.js:177-184` `tabs.onUpdated` | mỗi navigation | `setBadgeText` per nav. |

### cosmetic.js — content script (top frame)

| Dòng | Tần suất | Chi phí |
|---|---|---|
| `cosmetic.js:161` `setInterval(youtubeAdTick, 300)` | 3.3 lần/giây, **vĩnh viễn**, không clear | Chạy cả khi trang không có quảng cáo, cả sau SPA navigation. |
| `cosmetic.js:136-137` `for (const sel of YOUTUBE_REMOVE) for (const el of document.querySelectorAll(sel)) …` | 14 lượt **duyệt toàn document** mỗi tick | 14 selector × 3.3/s ≈ **46 lượt duyệt toàn DOM mỗi giây** trên trang watch. Đây là chi phí main-thread thuần. |
| `cosmetic.js:108-109,112,133,138` `querySelector` mỗi tick | 5 lượt/tick | `#movie_player:has(…)` (`:112`) chạy mỗi tick khi không có ad. |
| `cosmetic.js:85-91` `injectHiding` với `GENERIC_COSMETIC` | 1 lần/page load | Một `<style>` chứa **13.634 rule** (đo từ `cosmetic-rules.js`, ~535KB text). Mỗi element được chèn vào DOM đều phải match lại rule set. |
| `cosmetic.js:146-157` `storage.local.get` | 1 lần/page load | Đọc `siteRules` + `cosmetic`. |
| `cosmetic.js:137` `.remove()` | mỗi lần match | Gây mutation → nuôi MutationObserver của `auto-hide.js`. |

### auto-hide.js — content script

| Dòng | Tần suất | Chi phí |
|---|---|---|
| `auto-hide.js:111-116` `MutationObserver(…).observe(document.documentElement, { childList: true, subtree: true })` | mỗi mutation | Mỗi element node được chèn vào `autoPending` (`:113`) — **không giới hạn, không dedupe**. |
| `auto-hide.js:97-101` `autoScan` | mỗi node pending | `[root, ...root.querySelectorAll("iframe, ins, img, a, div, section, aside, object, embed")]` (`:99`) quét lại toàn subtree của node đó. Khi YouTube chèn một subtree N node, observer báo **cả N node** (cha + con) → mỗi node quét lại phần subtree còn lại → **O(N²)**. |
| `auto-hide.js:58-65` `autoShaped` | mỗi node ứng viên | `getBoundingClientRect()` (`:59`) ép **synchronous layout / forced reflow**; `querySelector("video, article, h1, form")` (`:64`) + `querySelectorAll("a[href]")` (`:65`) là subtree scan thêm. |
| `auto-hide.js:110` `autoScan(document.body)` | 1 lần/page load | Quét toàn body ngay sau DOMContentLoaded. |
| `auto-hide.js:125` `storage.local.get(["…","domains"])` | 1 lần/page load | Đọc + `new Set(domains.map(…))` (`:130`) với 867-30k host. |

### youtube-main.js — MAIN world

| Dòng | Tần suất | Chi phí |
|---|---|---|
| `youtube-main.js:41-58` wrapper `window.fetch` | mỗi fetch trên YouTube | `await origFetch` thêm một frame; với `/youtubei/v1/player` (`:47-56`): `res.clone().json()` → **parse JSON lần 2 + giữ bản clone 1-3MB trong RAM**, rồi `JSON.stringify` lại và `new Response`. |
| `youtube-main.js:61-79` override `XHR.prototype.responseText`/`response` | mỗi lượt đọc XHR | Accessor native bị thay bằng JS getter → deopt đường đọc XHR của trang; chỉ scrub khi `__sabPlayer`. |
| `youtube-main.js:33-38` `defineProperty(ytInitialPlayerResponse)` | 1 lần | Rẻ. |

### manifest.json

| Dòng | Chi phí |
|---|---|
| `manifest.json:19-25` `<all_urls>` @ `document_start`, gồm `cosmetic-rules.js` 235KB | Parse/compile 235KB mỗi page load. |
| `manifest.json:26-32` `youtube-main.js` world MAIN @ `document_start` | Hook fetch/XHR chạy trước cả code YouTube → mọi request của page đi qua JS của extension. |
| `manifest.json:7` permissions có `webRequest` | Điều kiện để Chrome dispatch `onBeforeRequest` (`background.js:186`). |

## 2. Xếp hạng nguyên nhân

1. **`cosmetic.js:161` + `cosmetic.js:136-137`** — 14 lượt duyệt toàn document mỗi 300ms, vĩnh viễn, kể cả khi không có ad. ≈46 lượt/giây trên trang watch. → "YouTube đứng/giật", cuộn và input bị trễ.
2. **`auto-hide.js:113` + `auto-hide.js:99` + `auto-hide.js:59`** — O(N²) subtree scan, không cap, cộng forced reflow ngay trong lúc YouTube đang chèn DOM → layout thrash, main thread bị khoá theo từng đợt (rõ nhất khi cuộn feed / mở comment / live chat).
3. **`cosmetic.js:85-91` — 13.634 rule trong một stylesheet** trên mọi trang: mỗi lần style recalc phải match lại toàn bộ rule set cho node mới. Cộng 535KB string build mỗi page load.
4. **`background.js:152` → `background.js:173` → `syncRules()` (`:46`, `:79`)** — vòng storage → DNR. Giải thích "Chrome treo": mỗi lần `domains` đổi, `getDynamicRules()` trả về toàn bộ rule (867 mặc định, tới 30k sau import) và `set({ruleIds})` ghi map tương ứng. List càng lớn càng nặng; đây là chỗ browser (không chỉ tab) thấy đau.
5. **`background.js:186` + `background.js:119-128`** — dispatch per-request + 2× `new URL()` cho mỗi request, gồm toàn bộ media segment của YouTube.
6. **`background.js:104`** — `getMatchedRules` mỗi giây/tab, kích thước mảng tăng theo thời gian xem.

### Không phải nguyên nhân chính (dù trông đáng ngờ)

- `youtube-main.js` hook `fetch`/XHR: chỉ đụng `/youtubei/v1/player` (1 lần/video) → làm chậm khởi động video chục ms, không gây treo. Việc `clone().json()` 1-3MB là lãng phí nhưng không phải thủ phạm.
- `youtube-main.js:33` `defineProperty`: chạy 1 lần.
- 30.000 DNR rule: Chrome index theo `urlFilter`, matching không phải nút cổ chai. Cái đắt là **serialize** qua `getDynamicRules`, không phải match.
- Kích thước `cosmetic-rules.js` 235KB: parse 1 lần/page (~vài ms). Vấn đề là **13.634 rule trong stylesheet**, không phải file JS.
- `setInterval` bị throttle khi tab ẩn: đúng, nhưng triệu chứng xảy ra khi tab đang active.

## 3. Kế hoạch sửa theo nhóm (chờ duyệt từng nhóm)

### Nhóm A — nhịp tick YouTube (`cosmetic.js`) · rủi ro thấp · lợi ích lớn nhất · ĐÃ SỬA (`e614446`)
- `cosmetic.js:161`: thay `setInterval(youtubeAdTick, 300)` bằng nhịp thích nghi: observer class của `#movie_player` (`.ad-showing`/`.ad-interrupting`) hoặc `yt-navigate-finish` để bật nhịp 300ms **chỉ trong lúc có ad**, idle 1000-2000ms khi không có.
- `cosmetic.js:136-137`: chỉ chạy vòng dọn node khi có ad hoặc trong ~1s sau khi ad kết thúc; và scope query về `#movie_player` + `ytd-watch-next-secondary-results-renderer` + feed container thay vì `document`.
- Rủi ro: ad có thể tồn tại thêm tối đa ~1 nhịp idle trước khi bị dọn khỏi feed; seek/skip trong player không đổi.
- Test (`test/cosmetic.test.js`): "khi không có ad, một tick không chạy quá N `querySelectorAll`"; "khi `.ad-showing` xuất hiện, seek+skip xảy ra trong 300ms"; "sau khi ad hết, nhịp quay về idle".

### Nhóm B — auto-hide O(N²) + forced layout (`auto-hide.js`) · rủi ro thấp-trung bình
- `auto-hide.js:113`: lọc tag ngay trong observer (`AUTO_TAGS.has(node.tagName)`) — rẻ, không đụng DOM — và cap `autoPending` (`AUTO_MAX_PENDING = 200`, dư thì bỏ; false negative chấp nhận được theo tinh thần file này).
- `auto-hide.js:99`: không `querySelectorAll` toàn subtree cho **mỗi** node pending; chỉ judge `root`, và chỉ mở rộng xuống con khi `root.children.length` lớn hơn 0 và chưa có node con nào trong pending là hậu duệ (bỏ qua node có ancestor đã nằm trong pending cùng batch).
- `auto-hide.js:58-65`: đảo thứ tự trong `autoShaped` — kiểm tra `querySelector("video, article, h1, form")` và đếm `a[href]` **trước**, gọi `getBoundingClientRect()` sau cùng (hiện RCB chạy trước, ép layout cho cả node sẽ bị loại).
- Rủi ro: một số banner lồng sâu trong subtree lớn có thể bị bỏ sót (đúng chiều ưu tiên của repo: bỏ sót tốt hơn ẩn nhầm).
- Test (`test/auto-hide.test.js`): "subtree 3 tầng chỉ bị quét 1 lần, không N²" (đếm số lần `querySelectorAll`); "pending vượt cap thì không nhận thêm"; "không gọi `getBoundingClientRect` cho node sai tag"; giữ nguyên case "box chiếm >50% viewport không bị ẩn".

### Nhóm C — vòng storage → DNR (`background.js`) · rủi ro trung bình · sửa "Chrome treo"
- `background.js:152`: chỉ `set({ domains })` khi thực sự có host mới; ghi `detected` bằng một lần `set` riêng, bỏ `sort()` trong flush (sort lúc đọc/import).
- `background.js:46` + `background.js:79`: `syncRules()` dựa trên `ruleIds` đã lưu để tính delta, chỉ gọi `getDynamicRules()` khi cần remove (hoặc dùng `getDynamicRules` một lần rồi cache trong `chrome.storage.session`), và chỉ ghi `ruleIds` khi có rule thêm/bớt.
- `background.js:104`: nới `getMatchedRules` lên 3-5s, hoặc chỉ cập nhật badge khi popup mở.
- Rủi ro: một rule "mồ côi" nếu SW bị kill giữa chừng — cần test cho trường hợp `ruleIds` lệch với rule thật.
- Test (`test/background.test.js`): "flush không có host mới không ghi `domains`"; "syncRules với `ruleIds` đầy đủ không gọi `getDynamicRules`"; "rule mồ côi vẫn bị remove khi lệch".

### Nhóm D — `webRequest` per-request (`background.js:186`, `manifest.json:7`) · rủi ro thấp
- Thêm filter `types: ["image", "sub_frame", "xmlhttprequest", "script"]` để request `media` (toàn bộ media segment YouTube) không dispatch sang SW.
- Test (`test/background.test.js`): "listener đăng ký với type filter loại `media`".

### Nhóm E — bỏ 13.634 rule generic trên YouTube (`cosmetic.js:155-157`) · rủi ro thấp · lợi ích lớn
- Với `youtube.com`, chỉ inject `siteRules` + `cosmetic` (rule người dùng) + `YOUTUBE_SELECTORS`; EasyList xử lý YouTube bằng rule scoped `youtube.com##`, không phải `##` generic, nên `GENERIC_COSMETIC` gần như không đóng góp gì ở đây.
- Rủi ro: mất các hide generic trên YouTube (rất ít khả năng trúng); nếu thấy sót, whitelist bằng `siteRules`.
- Test (`test/cosmetic.test.js`): "youtube.com không nhận `GENERIC_COSMETIC`"; "trang khác vẫn nhận đủ".

## 4. Cách tự kiểm chứng trên máy
1. `chrome://extensions` → Simple AdBlock → *Service worker* → Performance: xem có burst mỗi 2s không (nhóm C).
2. `Shift+Esc` (Task Manager): cột CPU/Memory của tab YouTube và của "Extension: Simple AdBlock" trước/sau khi tắt extension.
3. DevTools → Performance, record 10s trên trang watch: nhìn **Recalculate Style** (nhóm E/1) và **Layout / Forced reflow** (nhóm B).
4. Kiểm nhanh nhóm A: mở DevTools console, chạy `PerformanceObserver` hoặc chỉ đếm bằng cách patch `document.querySelectorAll` rồi xem số lần gọi/giây.
