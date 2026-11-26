// SPDX-License-Identifier: AGPL-3.0-only
// 可选的外部 LX 音源：只读取脚本里声明的接口，绝不执行脚本。
// 第三方脚本一旦运行就能拿到 host 与登录态，所以这里只做文本抽取。
// 任一环节失败都静默回落官方取流，不修改 session、不写 storage（脚本缓存除外）。
const SOURCE = "tx";
const CACHE_PREFIX = "qqmusic.lx-script.";
const CACHE_TTL = { success: 24 * 60 * 60 * 1000, network: 60 * 1000, script: 10 * 60 * 1000 };
const scriptLoads = new Map();
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

function scriptURLs() {
  if (setting("externalSourceEnabled") !== "true") return [];
  return [setting("externalSourceScript"), setting("externalSourceBackupScript")].filter(Boolean);
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
  const protocol = /\bmethod\s*:\s*["']POST["']/.test(text) && /\bmusicId\b/.test(text) ? "post" : "get";
  return { apiUrl, key, supported: /["']tx["']\s*:/.test(text), protocol };
}

function urlKey(script) {
  try { return new URL(script).searchParams.get("key") || ""; } catch { return ""; }
}

function digest(text) {
  try { return host.crypto.md5(text); } catch { return null; }
}

async function readBytes(reply, limit) {
  if (!reply.body) return new Uint8Array();
  const reader = reply.body.getReader();
  const bytes = new Uint8Array(limit);
  let length = 0;
  try {
    while (length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, limit - length);
      bytes.set(chunk, length);
      length += chunk.length;
    }
    return bytes.subarray(0, length);
  } finally {
    // 宿主 moejs 支持响应流；取消剩余数据，不能信任服务器一定遵守 Range。
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}

async function loadScript(script) {
  // 缓存键含脚本地址：换地址（含换 key）即换键，自然会重新拉取。
  const hash = digest(script);
  const cacheKey = hash ? CACHE_PREFIX + hash : null;
  let cached;
  try { cached = cacheKey ? host.storage.get(cacheKey) : null; } catch { /* 缓存不可读时仍可重新拉取。 */ }
  // 旧成功缓存没有协议，须重新解析，避免把 POST 音源误当作 GET。
  if (cached && cached.v === 1 && Number.isFinite(cached.expiresAt) && cached.expiresAt > Date.now()
    && (!cached.ok || cached.protocol === "get" || cached.protocol === "post")) return cached;
  if (scriptLoads.has(script)) return scriptLoads.get(script);
  // 只合并同一地址的在途脚本请求，取流仍按歌曲与音质分别执行。
  const pending = fetchScript(script, cacheKey);
  scriptLoads.set(script, pending);
  try { return await pending; } finally { scriptLoads.delete(script); }
}

async function fetchScript(script, cacheKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCRIPT_TIMEOUT);
  let entry;
  try {
    const reply = await fetch(script, {
      method: "GET", redirect: "error", signal: controller.signal,
      headers: { "User-Agent": UA },
    });
    if (!reply || reply.status !== 200) throw new Error("script status");
    const bytes = await readBytes(reply, SCRIPT_LIMIT + 1);
    const parsed = bytes.length > SCRIPT_LIMIT ? null : parseScript(new TextDecoder().decode(bytes));
    entry = parsed
      ? { v: 1, ok: true, apiUrl: parsed.apiUrl, key: parsed.key || urlKey(script), supported: parsed.supported, protocol: parsed.protocol }
      : { v: 1, ok: false, reason: "script" };
  } catch (error) {
    // 网络故障只短暂退避，避免恢复后仍被坏缓存挡住。
    entry = { v: 1, ok: false, reason: error && error.name === "AbortError" ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  const ttl = entry.ok ? (entry.supported ? CACHE_TTL.success : CACHE_TTL.script)
    : entry.reason === "script" ? CACHE_TTL.script : CACHE_TTL.network;
  entry.expiresAt = Date.now() + ttl;
  if (cacheKey) { try { host.storage.set(cacheKey, entry); } catch { /* 缓存失败不影响播放。 */ } }
  return entry;
}

async function verify(url) {
  // 接口回 code=200 不代表链接能播（实测 flac24bit/hires 给 403 死链），取前 8KB 认容器。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MUSIC_TIMEOUT);
  try {
    const reply = await fetch(url, { headers: { Range: "bytes=0-8191" }, redirect: "error", signal: controller.signal });
    if (!reply || (reply.status !== 200 && reply.status !== 206)) return null;
    const bytes = await readBytes(reply, 8192);
    if (bytes.length < 8) return null;
    const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (tag === "fLaC") return "flac";
    if (tag === "OggS") return "ogg";
    if (tag === "RIFF") return "wav";
    if (String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]) === "ftyp") return "m4a";
    // MP3 可能带 ID3 头，也可能直接是帧同步；两种都要认。
    if (tag.startsWith("ID3") || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return "mp3";
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function resolve(entry, id, quality) {
  const target = new URL(entry.apiUrl.replace(/\/+$/, "") + "/music/url");
  const params = { source: SOURCE, quality: QUALITY[quality] || QUALITY.high };
  const post = entry.protocol === "post";
  if (!post) {
    target.searchParams.set("source", params.source);
    target.searchParams.set("songId", id);
    target.searchParams.set("quality", params.quality);
  }
  const headers = { "User-Agent": UA, "Content-Type": "application/json" };
  if (entry.key) headers[post ? "X-Api-Key" : "X-API-Key"] = entry.key;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MUSIC_TIMEOUT);
  try {
    const reply = await fetch(target.href, {
      method: post ? "POST" : "GET", headers, signal: controller.signal,
      ...(post ? { body: JSON.stringify({ source: params.source, musicId: id, quality: params.quality }) } : {}),
    });
    if (!reply || reply.status !== 200) throw new Error("music status");
    const payload = await reply.json();
    if (!payload || payload.code !== 200 || typeof payload.url !== "string" || !payload.url) throw new Error("music payload");
    const url = safeURL(payload.url.replace(/^http:\/\//i, "https://"));
    // 容器以字节为准：QQ 的 flac 已是 24bit，更高的 flac24bit/hires 是死链，
    // 所以这里只请求 flac，但仍要确认拿到的是真音频。
    const type = await verify(url);
    if (!type) throw new Error("unplayable");
    const lossless = type === "flac";
    return {
      url, type,
      quality: lossless ? "lossless" : quality === "standard" ? "standard" : "high",
      size: 0,
      headers: { Referer: "https://y.qq.com/", "User-Agent": "Mozilla/5.0" },
    };
  } finally {
    clearTimeout(timer);
  }
}

// 成功返回 stream 结果，任何失败返回 null，由调用方继续走官方取流。
export async function externalStream(id, quality) {
  if (typeof id !== "string" || !/^[0-9a-zA-Z]{10,20}$/.test(id)) return null;
  for (const script of scriptURLs()) {
    try {
      if (!/^https:\/\/\S+$/.test(script)) throw Object.assign(new Error("script"), { reason: "script" });
      const entry = await loadScript(script);
      if (!entry.ok) throw Object.assign(new Error("script"), { reason: entry.reason });
      if (!entry.supported) throw Object.assign(new Error("unsupported"), { reason: "unsupported" });
      return await resolve(entry, id, quality);
    } catch (error) {
      // 原因只允许固定枚举，网络异常或坏缓存也不能把 key、地址和直链带进日志。
      const reason = ["script", "unsupported", "timeout", "network"].includes(error && error.reason)
        ? error.reason : error && error.name === "AbortError" ? "timeout" : "failure";
      try { console.warn(`external source fallback: ${reason}`); } catch { /* 日志不是播放前提。 */ }
    }
  }
  return null;
}
