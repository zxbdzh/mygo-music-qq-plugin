# QQ Music plugin for MyGo Music

在 MyGo Music 的“设置 > 插件”中，通过右上角“+ > 从文件夹…”选择 `dist` 文件夹安装。

也可以直接导入打包好的 ZIP：从 [Releases](https://github.com/zxbdzh/mygo-music-qq-plugin/releases) 下载 `qqmusic-<version>.zip`，在插件设置中导入。

直接连接 QQ 音乐，无需另行启动服务。

登录默认使用手机 QQ 扫码。在插件设置的“扫码登录方式”中输入“微信”并提交，再点击登录，可以使用微信扫码。

登录凭据以明文保存在本机 MyGo Music 的插件数据中，并非系统密钥链。退出登录会删除本地凭据，但不会撤销 QQ 服务器上的登录会话。

支持 QQ 返回的逐字歌词和翻译，缺少逐字数据时回退至 LRC。目前不支持收听历史、关注歌手和发表评论。官方路径下歌曲能否完整播放由 QQ 音乐的版权、账号及地区限制决定。

## 最高音质

插件设置里的「最高音质」是上限：跟随播放器、标准、高音质、无损。播放器要求更高时降到所选档位，要求更低时保持原样；外部音源与官方取流都按这个档位请求。

## External source (optional, added by this fork)

Off by default. When enabled, playback first asks an LX source for a direct audio link and silently falls back to the official vkey path when that fails. Your session and account data are untouched.

1. Open the plugin settings and turn on **Use external source**.
2. Put the full LX script URL in **LX script URL**, for example:

   ```text
   https://source.shiqianjiang.cn/api/script/lx?key=your-key
   ```

3. Optionally put a second full script URL in **Backup LX script URL**. Playback tries the primary source first, then the backup, and finally official playback. Each failed source logs a sanitized fallback reason without keys or URLs.
4. Play. Changing either URL (including rotating its key) makes the next playback read that script again. The two URLs have independent caches.

The plugin only reads the endpoint, key and whether the script declares QQ (`tx`). It **never executes the script**. If the script has no `tx` source, the URL is wrong, or the service is unavailable, playback is still completed by the official path.

Scripts containing both `method: "POST"` (single quotes also work) and `musicId` use a JSON POST request with `source`, `musicId` and `quality`, authenticated by `X-Api-Key`. Other scripts keep the GET protocol with `source`, `songId` and `quality` query parameters and `X-API-Key`.

Script results are cached for **24 hours**. Network, HTTP and timeout failures are retried after **60 seconds**; invalid scripts or scripts without `tx` after **10 minutes**. Expired caches and legacy entries without an expiry are fetched again. Concurrent requests for the same script URL share one download. Script reads are limited to 256 KiB (plus one byte to detect oversized responses); audio verification reads only the first 8 KiB, cancels the remaining response and refuses redirects.

Differences to be aware of:

- With the external source on, the plugin does not check membership or region; whatever the source returns is played. The upstream statement about "not bypassing permissions" only describes the official path.
- High/Standard requests are labelled `mp3`, only the lossless request is labelled `flac`; the container is checked before playback, so a dead link falls back instead of failing.
- Availability depends on a third-party service; this fork makes no claim about its stability or licensing.

> **Permission note:** the script and endpoint hosts are entered by you and cannot be listed in advance, so the plugin asks for access to any website. No external request is made while **Use external source** is off.

运行 `npm test` 执行离线协议测试；修改源码后运行 `npm run build` 重新生成安装目录。
