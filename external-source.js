// SPDX-License-Identifier: AGPL-3.0-only
// 可选的外部 LX 音源：只读取脚本里声明的接口，绝不执行脚本。
// 第三方脚本一旦运行就能拿到 host 与登录态，所以这里只做文本抽取。
// 任一环节失败都静默回落官方取流，不修改 session、不写 storage（脚本缓存除外）。
const SOURCE = "tx";
const CACHE_PREFIX = "qqmusic.lx-script.";
const SCRIPT_TIMEOUT = 5000;
const MUSIC_TIMEOUT = 8000;
const SCRIPT_LIMIT = 262144;
const UA = "lx-music-desktop/2.99.0";
const QUALITY = { standard: "128k", high: "320k", lossless: "flac" };
const IPV4 = /^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
const IPV6 = /^(?:\[::1?\]$|\[::ffff:|\[f[cd][0-9a-f]{0,2}:)/i;

function setting(key) {
  // 旧宿主没有 settings API 时必须视为未配置，播放不能被配置读取卡住。
  try { return String(typeof host.setting === "function" ? host.setting(key) ?? "" : ""); } catch { return ""; }
}

function scriptURL() {
  if (setting("externalSourceEnabled") !== "true") return null;
  const script = setting("externalSourceScript");
  return /^https:\/\/\S+$/.test(script) ? script : null;
}

function safeURL(value) {
  // 宿主会直接 GET 这个地址，放行内网地址等于把 SSRF 送进本机。
  if (typeof value !== "string" || !value || value.length > 16384) throw new Error("unsafe url");
  let url;
  try { url = new URL(value); } catch { throw new Error("unsafe url"); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("unsafe url");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) throw new Error("unsafe url");
  if (IPV4.test(hostname) || IPV6.test(hostname)) throw new Error("unsafe url");
  return value;
}

function parseScript(text) {
  if (typeof text !== "string" || !text || text.length > SCRIPT_LIMIT) return null;
  const apiUrl = /\bAPI_URL\s*=\s*["'`](https?:\/\/[^"'`\s]+)["'`]/.exec(text)?.[1];
  if (!apiUrl) return null;
  try { safeURL(apiUrl); } catch { return null; }
  const key = /\bAPI_KEY\s*=\s*["'`]([^"'`\s]+)["'`]/.exec(text)?.[1] || "";
  // 平台名在对象字面量与 JSON.parse 两种写法里都带引号，一个正则即可判定。
  return { apiUrl, key, supported: /["']tx["']\s*:/.test(text) };
}

function urlKey(script) {
  try { return new URL(script).searchParams.get("key") || ""; } catch { return ""; }
}

function digest(text) {
  try { return host.crypto.md5(text); } catch { return null; }
}

async function loadScript(script) {
  // 缓存键含脚本地址：换地址（含换 key）即换键，自然会重新拉取。
  const hash = digest(script);
  const cacheKey = hash ? CACHE_PREFIX + hash : null;
  const cached = cacheKey ? host.storage.get(cacheKey) : null;
  if (cached && cached.v === 1) return cached;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCRIPT_TIMEOUT);
  let entry;
  try {
    const reply = await fetch(script, {
      method: "GET", redirect: "error", signal: controller.signal,
      headers: { "User-Agent": UA },
    });
    if (!reply || reply.status !== 200) throw new Error("script status");
    const parsed = parseScript(await reply.text());
    entry = parsed
      ? { v: 1, ok: true, apiUrl: parsed.apiUrl, key: parsed.key || urlKey(script), supported: parsed.supported }
      : { v: 1, ok: false, reason: "script" };
  } catch (error) {
    // 失败也缓存，避免每首歌重复拉同一份坏脚本。
    entry = { v: 1, ok: false, reason: error && error.name === "AbortError" ? "timeout" : "script" };
  } finally {
    clearTimeout(timer);
  }
  if (cacheKey) { try { host.storage.set(cacheKey, entry); } catch { /* 缓存失败不影响播放。 */ } }
  return entry;
}

async function resolve(entry, id, quality) {
  const target = new URL(entry.apiUrl.replace(/\/+$/, "") + "/music/url");
  target.searchParams.set("source", SOURCE);
  target.searchParams.set("songId", id);
  target.searchParams.set("quality", QUALITY[quality] || QUALITY.high);
  const headers = { "User-Agent": UA, "Content-Type": "application/json" };
  if (entry.key) headers["X-API-Key"] = entry.key;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MUSIC_TIMEOUT);
  try {
    const reply = await fetch(target.href, { method: "GET", headers, signal: controller.signal });
    if (!reply || reply.status !== 200) throw new Error("music status");
    const payload = await reply.json();
    if (!payload || payload.code !== 200 || typeof payload.url !== "string" || !payload.url) throw new Error("music payload");
    const url = safeURL(payload.url.replace(/^http:\/\//i, "https://"));
    // QQ 的 320k/128k 是 MP3，只有 flac 档才是无损；不能沿用汽水的 m4a 回填。
    const declared = typeof payload.quality === "string" ? payload.quality.toLowerCase() : "";
    const flac = declared === "flac" || (declared === "" && quality === "lossless" && /\.flac$/i.test(new URL(url).pathname));
    return {
      url, type: flac ? "flac" : "mp3",
      quality: flac ? "lossless" : quality === "standard" ? "standard" : "high",
      size: 0,
      headers: { Referer: "https://y.qq.com/", "User-Agent": "Mozilla/5.0" },
    };
  } finally {
    clearTimeout(timer);
  }
}

// 成功返回 stream 结果，任何失败返回 null，由调用方继续走官方取流。
export async function externalStream(id, quality) {
  const script = scriptURL();
  if (!script) return null;
  if (typeof id !== "string" || !/^[0-9a-zA-Z]{10,20}$/.test(id)) return null;
  try {
    const entry = await loadScript(script);
    if (!entry.ok) throw Object.assign(new Error("script"), { reason: entry.reason });
    if (!entry.supported) throw Object.assign(new Error("unsupported"), { reason: "unsupported" });
    return await resolve(entry, id, quality);
  } catch (error) {
    // 只记录归一化原因，绝不带出 key、脚本地址或带签名的直链。
    const reason = (error && error.reason) || (error && error.name === "AbortError" ? "timeout" : "failure");
    try { console.warn(`external source fallback: ${reason}`); } catch { /* 日志不是播放前提。 */ }
    return null;
  }
}
