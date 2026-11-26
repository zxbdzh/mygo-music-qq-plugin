// Run with node --test test.mjs. QQ response fixtures are provisional.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const mid = '0039MnYb0qxYhV';
const song = { mid, songmid: mid, id: 42, songid: 42, name: 'Fixture Song',
  title: 'Fixture Song', songname: 'Fixture Song', interval: 123,
  singer: [{ mid: 'artist-mid', name: 'Fixture Artist' }],
  album: { mid: 'album-mid', name: 'Fixture Album' } };
let calls = [];
let settings = {};
let respond;
const storage = new Map();
const envelope = (data) => ({ code: 0, data, req: { code: 0, data },
  req_0: { code: 0, data }, req_1: { code: 0, data } });
const response = (data, status = 200) => new Response(JSON.stringify(data),
  { status, headers: { 'content-type': 'application/json' } });
const results = (list, total) => ({ body: { song: { list, total } },
  song: { list, total }, list, total, meta: { sum: total } });
const requested = () => decodeURIComponent(calls.map((x) =>
  `${x.url} ${JSON.stringify(x.init ?? {})}`).join('\n'));
const rpcParam = (call = calls.at(-1)) => JSON.parse(call.init.body).req_0.param;

globalThis.host = {
  platform: 'linux', arch: 'amd64', dir: '.', dataDir: '.',
  setting: (k) => settings[k] ?? '', t: (x) => x, language: () => 'en',
  storage: { get: (k) => storage.get(k), set: (k, v) => storage.set(k, v),
    remove: (k) => storage.delete(k) },
  crypto: { md5: (text) => createHash('md5').update(text).digest('hex'), aesEcbEncrypt: () => 'mock-aes' },
  signInPrompt: () => {}, openURL: () => {},
};
globalThis.fetch = async (input, init) => {
  calls.push({ url: input instanceof Request ? input.url : String(input), init });
  return respond(input, init);
};

let plugin;
try {
  plugin = await import(new URL('./index.js', import.meta.url));
} catch (cause) {
  throw new Error('Could not import index.js; the plugin must be a Node-importable ES module.', { cause });
}
beforeEach(() => {
  calls = [];
  settings = {};
  storage.clear();
  respond = () => { throw new Error('Unexpected fetch'); };
});

test('search maps query and track metadata using MID as ID', async () => {
  respond = () => response(envelope(results([song], 1)));
  const result = await plugin.search({ query: 'Fixture Song', kind: 'tracks', offset: 0 });
  assert.ok(calls.length);
  assert.match(requested(), /Fixture(?:\+|\s)Song/i);
  assert.equal(rpcParam().query, 'Fixture Song');
  assert.equal(rpcParam().search_type, 0);
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].id, mid);
  assert.equal(result.tracks[0].name, 'Fixture Song');
  assert.equal(result.tracks[0].artists[0].name, 'Fixture Artist');
  assert.equal(result.tracks[0].duration, 123000);
});

test('search propagates offset and reports pagination', async () => {
  respond = () => response(envelope(results([song], 100)));
  const first = await plugin.search({ query: 'fixture', kind: 'tracks', offset: 0 });
  const firstRequest = requested();
  assert.equal(first.more, true);
  assert.equal(rpcParam().page_num, 1);
  assert.equal(rpcParam().num_per_page, 20);
  calls = [];
  await plugin.search({ query: 'fixture', kind: 'tracks', offset: 30 });
  assert.notEqual(requested(), firstRequest, 'offset must affect the request');
  assert.equal(rpcParam().page_num, 2);
  respond = () => response(envelope(results([], 0)));
  const last = await plugin.search({ query: 'fixture', kind: 'tracks', offset: 60 });
  assert.deepEqual(last.tracks ?? [], []);
  assert.equal(Boolean(last.more), false);
});

test('search continues after a result without a MID is filtered out', async () => {
  respond = () => response(envelope(results([song, { name: 'missing MID' }], 50)));
  const first = await plugin.search({ query: 'sparse', kind: 'tracks', offset: 0 });
  assert.equal(first.tracks.length, 1);
  await plugin.search({ query: 'sparse', kind: 'tracks', offset: first.tracks.length });
  assert.equal(rpcParam().page_num, 2);
});

test('suggestions are ordered, deduplicated and return names', async () => {
  respond = () => response({ code: 0, data: {
    song: { order: 1, itemlist: [{ name: 'Song' }, { name: 'Song' }] },
    singer: { order: 0, itemlist: [{ name: 'Artist' }] },
  } });
  assert.deepEqual(await plugin.suggest({ query: 'Artist' }), ['Artist', 'Song']);
});

test('artist pages include albums from the QQ album catalog', async () => {
  respond = (_input, init) => response(envelope(JSON.parse(init.body).req_0.method === 'get_singer_detail_info'
    ? { singer_info: { mid: 'artist-mid', name: 'Artist' }, songlist: [song] }
    : { albumList: [{ mid: 'album-mid', name: 'Album' }] }));
  const page = await plugin.artist({ id: 'artist-mid' });
  assert.equal(page.tracks[0].id, mid);
  assert.equal(page.albums[0].id, 'album-mid');
});

test('album pages include the account saved status', async () => {
  storage.set('qqmusic.auth.v1', { musicid: '12345', musickey: 'Q_test', loginType: 2 });
  respond = (url, init) => String(url).includes('/v8/')
    ? response({ code: 0, data: { mid: 'album1', name: 'Album', list: [song] } })
    : response(envelope({ m_fan: { album1: true } }));
  const page = await plugin.album({ id: 'album1' });
  assert.equal(page.album.saved, true);
  assert.equal(JSON.parse(calls[1].init.body).req_0.method, 'IsAlbumFan');
});

test('personal radio needs an account and returns QQ radio tracks', async () => {
  await assert.rejects(() => plugin.stationNext({ id: 'personal-fm' }), { code: 'signIn' });
  storage.set('qqmusic.auth.v1', { musicid: '12345', musickey: 'Q_test', loginType: 2 });
  respond = () => response(envelope({ tracks: [song] }));
  const tracks = await plugin.stationNext({ id: 'personal-fm' });
  assert.equal(tracks[0].id, mid);
  assert.equal(rpcParam().id, 99);
});

test('search surfaces HTTP errors', async () => {
  respond = () => response({ message: 'unavailable' }, 503);
  await assert.rejects(() => plugin.search({ query: 'fixture', kind: 'tracks', offset: 0 }));
});

test('search rejects unsupported kinds without a request', async () => {
  await assert.rejects(() => plugin.search({ query: 'fixture', kind: 'shows', offset: 0 }),
    { code: 'unsupported' });
  assert.equal(calls.length, 0);
});

test('search surfaces QQ service errors', async () => {
  respond = () => response({ code: 0, req_0: { code: 123, data: {} } });
  await assert.rejects(() => plugin.search({ query: 'fixture', kind: 'tracks', offset: 0 }));
});

test('stream requests the MID and returns a supported audio URL', async () => {
  respond = (_input, init) => {
    const { method } = JSON.parse(init.body).req_0;
    return response(envelope(method === 'get_song_detail_yqq'
      ? { track_info: { mid, file: { media_mid: 'media-mid' } } }
      : { sip: ['https://stream.qqmusic.qq.com/'],
        midurlinfo: [{ songmid: mid, purl: 'fixture.mp3' }] }));
  };
  const result = await plugin.stream({ id: mid, quality: 'standard' });
  assert.ok(calls.length);
  assert.ok(requested().includes(mid));
  assert.equal(rpcParam(calls[0]).song_mid, mid);
  assert.deepEqual(rpcParam(calls[1]).songmid, [mid]);
  assert.deepEqual(rpcParam(calls[1]).filename, [`M500${mid}media-mid.mp3`]);
  assert.equal(result.url, 'https://stream.qqmusic.qq.com/fixture.mp3');
  assert.match(result.url, /^https?:\/\//);
  assert.ok(['mp3', 'flac', 'ogg'].includes(result.type));
});

test('stream reports unavailable when no playable URL is returned', async () => {
  respond = (_input, init) => response(envelope(
    JSON.parse(init.body).req_0.method === 'get_song_detail_yqq'
      ? { track_info: { mid } } : { sip: [], midurlinfo: [] }));
  await assert.rejects(() => plugin.stream({ id: mid, quality: 'standard' }),
    { code: 'unavailable' });
});

test('signed-in lossless playback falls back to high quality without claiming lossless', async () => {
  storage.set('qqmusic.auth.v1', { musicid: '12345', musickey: 'Q_test', loginType: 2 });
  respond = (_input, init) => {
    const req = JSON.parse(init.body).req_0;
    if (req.method === 'get_song_detail_yqq') return response(envelope({ track_info: { mid, file: { media_mid: 'media-mid', size_320mp3: 500 } } }));
    assert.equal(req.method, 'UrlGetVkey');
    const purl = req.param.filename[0].startsWith('M800') ? 'high.mp3' : '';
    return response(envelope({ sip: ['https://stream.qqmusic.qq.com/'], midurlinfo: [{ songmid: mid, purl }] }));
  };
  const result = await plugin.stream({ id: mid, quality: 'lossless' });
  assert.equal(result.quality, 'high');
  assert.equal(result.size, 500);
  assert.match(rpcParam(calls[1]).filename[0], /^F000/);
  assert.match(rpcParam(calls[2]).filename[0], /^M800/);
  assert.match(calls[2].init.headers.Cookie, /qm_keyst=Q_test/);
});

test('stream surfaces HTTP errors', async () => {
  respond = () => response({ message: 'unavailable' }, 503);
  await assert.rejects(() => plugin.stream({ id: mid, quality: 'standard' }));
});

test('lyrics requests the MID and returns LRC', async () => {
  const lrc = '[00:01.00]Fixture lyric';
  respond = () => response({ code: 0, lyric: Buffer.from(lrc).toString('base64'),
    trans: Buffer.from('[00:01.00]Translation').toString('base64') });
  const result = await plugin.lyrics({ id: mid });
  assert.ok(calls.length);
  assert.ok(requested().includes(mid));
  assert.match(result.lrc, /Fixture lyric/);
  assert.match(result.translation, /Translation/);
});

test('lyrics use the translation endpoint when legacy lyrics have no translation', async () => {
  respond = (url) => String(url).includes('/lyric/')
    ? response({ code: 0, lyric: Buffer.from('[00:01.00]Original').toString('base64') })
    : response(envelope({ trans: Buffer.from('[00:01.00]Translated').toString('base64') }));
  assert.equal((await plugin.lyrics({ id: mid })).translation, '[00:01.00]Translated');
});

test('home adds the signed-in recommendation feed', async () => {
  storage.set('qqmusic.auth.v1', { musicid: '12345', musickey: 'Q_test', loginType: 2 });
  respond = (_url, init) => {
    const req = JSON.parse(init.body).req_0;
    if (req.method === 'GetRecommendFeed') return response(envelope({ List: [] }));
    if (req.method === 'GetAll') return response(envelope({ group: [] }));
    if (req.method === 'get_recommend_feed') return response(envelope({ retcode: 0, v_shelf: [{ v_niche: [{ v_card: [{ id: '100', type: 500, subtype: 0, jumptype: 10014, title: 'For you' }] }] }] }));
    throw new Error(`Unexpected request: ${req.method}`);
  };
  const result = await plugin.home();
  assert.equal(result.sections[0].playlists[0].id, '100');
});

test('Daily 30 comes first in recommended playlists', () => {
  const card = (id, subtype, title, extra = {}) => ({ type: 500, subtype, jumptype: 10014, id, title, cover: `${id}.jpg`, ...extra });
  const result = plugin.recommendedPlaylists([
    card('111', 0, 'First'),
    card('222', 510, '每日30首'),
    card('333', 513, 'Not a playlist', { jumptype: 3003 }),
    card('111', 0, 'Duplicate'),
    card('444', 0, 'Second'),
  ]);
  assert.deepEqual(result.map(p => [p.id, p.name]), [['222', '每日30首'], ['111', 'First'], ['444', 'Second']]);
  assert.equal(result[0].imageUrl, '222.jpg');
});

test('lyrics surfaces HTTP errors', async () => {
  respond = () => response({ message: 'unavailable' }, 503);
  await assert.rejects(() => plugin.lyrics({ id: mid }));
});

test('integrated sign-in passes the authenticated session to the library', async () => {
  respond = (_url, init) => {
    const method = JSON.parse(init.body).req_0.method;
    if (method === 'GetLoginUserInfo') return response(envelope({ info: { nick: 'Listener' } }));
    if (method === 'IsSongFanByMid') return response(envelope({ m_fan: { [mid]: true } }));
    throw new Error(`Unexpected request: ${method}`);
  };
  assert.equal((await plugin.qqFinishSignIn({ musicid: '12345', musickey: 'Q_test', loginType: 2 })).name, 'Listener');
  assert.deepEqual(await plugin.isLiked({ ids: [mid] }), { [mid]: true });
  assert.equal(JSON.parse(calls.at(-1).init.body).comm.authst, 'Q_test');
  plugin.signOut();
  assert.deepEqual(await plugin.isLiked({ ids: [mid] }), { [mid]: false });
});

test('comments use the anonymous endpoint even after signing in', async () => {
  storage.set('qqmusic.auth.v1', { musicid: '12345', musickey: 'Q_test', loginType: 2 });
  respond = (_url, init) => {
    const req = JSON.parse(init.body).req_0;
    if (req.method === 'get_song_detail_yqq') return response(envelope({ track_info: { mid, id: 42 } }));
    assert.equal(init.headers.Cookie, undefined);
    return response(envelope({ CommentList: { Total: 0, HasMore: 0, Comments: [] } }));
  };
  assert.deepEqual((await plugin.comments({ trackId: mid })).comments, []);
});
// ---- 外部 LX 音源 ----
const LX_SCRIPT = 'https://audio-source.test/api/script/lx?key=fixture-key';
const LX_API = 'https://audio-source.test/api';
const LX_CDN = 'https://ws.stream.qqmusic.qq.com';
const LX_SCRIPT_BODY = 'const API_URL = "https://audio-source.test/api";\nconst API_KEY = "fixture-key";\nconst MUSIC_QUALITY = {"tx":["128k","320k","flac"]};';
const LX_TX_MISSING = 'const API_URL = "https://audio-source.test/api";\nconst MUSIC_QUALITY = {"wy":["128k","320k","flac"]};';
const FLAC_HEAD = [0x66, 0x4c, 0x61, 0x43, 0x00, 0x00, 0x00, 0x22];
const MP3_HEAD = [0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00];
const LX_CACHE_KEY = 'qqmusic.lx-script.' + host.crypto.md5(LX_SCRIPT);
const LX_BACKUP_SCRIPT = 'https://backup-source.test/script/lxmusic?key=backup-url-key';
const LX_BACKUP_API = 'https://backup-source.test/api';
const LX_BACKUP_CDN = 'https://backup-cdn.test';
const LX_BACKUP_BODY = `const API_URL = "${LX_BACKUP_API}"; const API_KEY = "backup-key";
const MUSIC_QUALITY = {"tx":["128k","320k","flac"]};
const request = { method: "POST", body: JSON.stringify({ source, musicId, quality }) };`;
const lxOn = (backup = '') => { settings = { externalSourceEnabled: 'true', externalSourceScript: LX_SCRIPT, externalSourceBackupScript: backup }; };
function lxClock(t) {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  return (elapsed) => { now += elapsed; };
}
const audioReply = (head, status = 206) => new Response(Uint8Array.from(head), { status });
const officialStream = (_input, init) => response(envelope(
  JSON.parse(init.body).req_0.method === 'get_song_detail_yqq'
    ? { track_info: { mid, file: { media_mid: 'media-mid' } } }
    : { sip: ['https://stream.qqmusic.qq.com/'], midurlinfo: [{ songmid: mid, purl: 'fixture.mp3' }] }));
function lxRoute({ script = LX_SCRIPT_BODY, payload = { code: 200, url: LX_CDN + '/a.flac' }, media = () => audioReply(FLAC_HEAD) } = {}) {
  return (input) => {
    const target = String(input);
    if (target === LX_SCRIPT) return new Response(script);
    if (target.startsWith(LX_API + '/music/url')) return response(payload);
    if (target.startsWith(LX_CDN)) return media(target);
    throw new Error('unexpected ' + target);
  };
}

function lxPairRoute({ primary = lxRoute(), script = LX_BACKUP_BODY, payload = { code: 200, url: LX_BACKUP_CDN + '/a.flac' }, media = () => audioReply(FLAC_HEAD) } = {}) {
  return (input, init) => {
    const target = String(input);
    if (target === LX_BACKUP_SCRIPT) return new Response(script);
    if (target.startsWith(LX_BACKUP_API + '/music/url')) return response(payload);
    if (target.startsWith(LX_BACKUP_CDN)) return media(target);
    if (target.startsWith('https://u.y.qq.com')) return officialStream(input, init);
    return primary(input, init);
  };
}

test('external source returns the LX link and skips vkey', async () => {
  lxOn();
  respond = lxRoute();
  const result = await plugin.stream({ id: mid, quality: 'lossless' });
  assert.equal(result.type, 'flac');
  assert.equal(result.quality, 'lossless');
  assert.equal(result.url, LX_CDN + '/a.flac');
  const target = new URL(calls.find(call => call.url.startsWith(LX_API + '/music/url')).url);
  assert.equal(target.searchParams.get('source'), 'tx');
  assert.equal(target.searchParams.get('songId'), mid);
  assert.equal(target.searchParams.get('quality'), 'flac');
  assert.equal(calls.find(call => call.url === LX_CDN + '/a.flac').init.redirect, 'error');
  assert.ok(!requested().includes('vkey'));
});

test('the container decides the type, not the requested quality', async () => {
  lxOn();
  respond = lxRoute({ media: () => audioReply(MP3_HEAD) });
  const result = await plugin.stream({ id: mid, quality: 'lossless' });
  assert.equal(result.type, 'mp3');
  assert.equal(result.quality, 'high', '降档后不能仍标无损');
});

test('a dead media link falls back to the official path', async () => {
  lxOn();
  const route = lxRoute({ media: () => audioReply([], 403) });
  respond = (input, init) => String(input).startsWith('https://u.y.qq.com') ? officialStream(input, init) : route(input);
  const result = await plugin.stream({ id: mid, quality: 'lossless' });
  assert.equal(result.url, 'https://stream.qqmusic.qq.com/fixture.mp3');
  assert.ok(requested().includes('vkey'));
});

test('a script without tx falls back to the official path', async () => {
  lxOn();
  const route = lxRoute({ script: LX_TX_MISSING });
  respond = (input, init) => String(input).startsWith('https://u.y.qq.com') ? officialStream(input, init) : route(input);
  const result = await plugin.stream({ id: mid, quality: 'standard' });
  assert.equal(result.url, 'https://stream.qqmusic.qq.com/fixture.mp3');
});

test('the script is pulled once per URL', async () => {
  lxOn();
  let pulled = 0;
  const route = lxRoute();
  respond = (input) => { if (String(input) === LX_SCRIPT) pulled++; return route(input); };
  await plugin.stream({ id: mid, quality: 'standard' });
  await plugin.stream({ id: '000SecondMid001', quality: 'standard' });
  assert.equal(pulled, 1);
});

// 成功缓存必须到 24 小时边界才刷新，避免永久使用过期接口或密钥。
test('an unexpired persisted script is reused without downloading', async (t) => {
  lxOn();
  lxClock(t);
  storage.set(LX_CACHE_KEY, { v: 1, ok: true, apiUrl: LX_API, key: 'persisted-key', supported: true, protocol: 'get', expiresAt: Date.now() + 86400000 });
  respond = lxRoute();
  assert.equal((await plugin.stream({ id: mid })).url, LX_CDN + '/a.flac');
  assert.equal(calls.filter(call => call.url === LX_SCRIPT).length, 0);
  assert.equal(calls.find(call => call.url.startsWith(LX_API + '/music/url')).init.headers['X-API-Key'], 'persisted-key');
});

// 到期前复用，到期当次重新拉取，不能因读取缓存而顺延过期时间。
test('a successful script expires after 24 hours', async (t) => {
  lxOn();
  const advance = lxClock(t);
  const ttl = 24 * 60 * 60 * 1000;
  let pulled = 0;
  const route = lxRoute();
  respond = (input) => { if (String(input) === LX_SCRIPT) pulled++; return route(input); };
  await plugin.stream({ id: mid, quality: 'lossless' });
  assert.equal(storage.get(LX_CACHE_KEY).expiresAt, Date.now() + ttl);
  advance(ttl - 1);
  await plugin.stream({ id: mid, quality: 'lossless' });
  assert.equal(pulled, 1);
  advance(1);
  const result = await plugin.stream({ id: mid, quality: 'lossless' });
  assert.equal(pulled, 2);
  assert.equal(result.type, 'flac');
  assert.equal(storage.get(LX_CACHE_KEY).expiresAt, Date.now() + ttl);
});

// 服务恢复后在退避到期时重试，解析失败与平台不支持不能按网络故障短缓存。
for (const { name, failure, ttl } of [
  { name: 'network failure', failure: () => { throw new TypeError('offline'); }, ttl: 60000 },
  { name: 'HTTP failure', failure: () => new Response('', { status: 503 }), ttl: 60000 },
  { name: 'timeout', failure: () => { throw new DOMException('aborted', 'AbortError'); }, ttl: 60000 },
  { name: 'parse failure', failure: () => new Response('invalid script'), ttl: 600000 },
  { name: 'unsupported platform', failure: () => new Response(LX_TX_MISSING), ttl: 600000 },
]) {
  test(`the script recovers from ${name} after its cache expires`, async (t) => {
    lxOn();
    const advance = lxClock(t);
    let pulled = 0;
    let recovered = false;
    const route = lxRoute();
    respond = (input, init) => {
      if (String(input) === LX_SCRIPT) {
        pulled++;
        if (!recovered) return failure();
      }
      return String(input).startsWith('https://u.y.qq.com') ? officialStream(input, init) : route(input);
    };
    assert.equal((await plugin.stream({ id: mid })).url, 'https://stream.qqmusic.qq.com/fixture.mp3');
    assert.equal(storage.get(LX_CACHE_KEY).expiresAt, Date.now() + ttl);
    recovered = true;
    advance(ttl - 1);
    assert.equal((await plugin.stream({ id: mid })).url, 'https://stream.qqmusic.qq.com/fixture.mp3');
    assert.equal(pulled, 1);
    advance(1);
    assert.equal((await plugin.stream({ id: mid })).url, LX_CDN + '/a.flac');
    assert.equal(pulled, 2);
    assert.equal(storage.get(LX_CACHE_KEY).expiresAt, Date.now() + 86400000);
  });
}

// 旧版本的成功或失败缓存都没有时间戳，升级后必须重新拉取。
for (const cached of [
  { v: 1, ok: true, apiUrl: LX_API, key: 'stale-key', supported: true },
  { v: 1, ok: false, reason: 'script' },
  { v: 1, ok: true, apiUrl: LX_API, supported: false },
]) {
  test(`a legacy cache is refreshed (${cached.ok ? cached.supported ? 'success' : 'unsupported' : 'failure'})`, async () => {
    lxOn();
    storage.set(LX_CACHE_KEY, cached);
    respond = lxRoute();
    assert.equal((await plugin.stream({ id: mid })).url, LX_CDN + '/a.flac');
    assert.equal(calls.filter(call => call.url === LX_SCRIPT).length, 1);
    assert.ok(Number.isFinite(storage.get(LX_CACHE_KEY).expiresAt));
    assert.equal(storage.get(LX_CACHE_KEY).key, 'fixture-key');
  });
}

// 并发播放只共享脚本下载，不共享不同歌曲或音质的取流结果。
test('concurrent requests for the same script share one download', async () => {
  lxOn();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const route = lxRoute();
  respond = async (input) => {
    if (String(input) === LX_SCRIPT) await gate;
    return route(input);
  };
  const pending = [plugin.stream({ id: mid }), plugin.stream({ id: '000SecondMid001', quality: 'lossless' })];
  try {
    assert.equal(calls.filter(call => call.url === LX_SCRIPT).length, 1);
  } finally {
    release();
  }
  const result = await Promise.all(pending);
  assert.ok(result.every(item => item.type === 'flac'));
  const requests = calls.filter(call => call.url.startsWith(LX_API + '/music/url')).map(call => new URL(call.url));
  assert.deepEqual(requests.map(url => url.searchParams.get('songId')), [mid, '000SecondMid001']);
  assert.deepEqual(requests.map(url => url.searchParams.get('quality')), ['128k', 'flac']);
});

// 换地址或轮换 URL 中的 key 时，既不合并在途请求，也不命中旧地址的缓存。
test('different script URLs keep concurrent loads and caches separate', async (t) => {
  lxOn();
  t.mock.method(host.crypto, 'md5', script => script);
  const rotated = LX_SCRIPT.replace('fixture-key', 'rotated-key');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const route = lxRoute();
  respond = async (input) => {
    if (String(input) === LX_SCRIPT || String(input) === rotated) {
      await gate;
      return new Response(LX_SCRIPT_BODY);
    }
    return route(input);
  };
  const first = plugin.stream({ id: mid });
  settings.externalSourceScript = rotated;
  const second = plugin.stream({ id: mid });
  release();
  assert.ok((await Promise.all([first, second])).every(result => result.type === 'flac'));
  assert.equal(calls.filter(call => call.url === LX_SCRIPT).length, 1);
  assert.equal(calls.filter(call => call.url === rotated).length, 1);
  for (const script of [LX_SCRIPT, rotated]) {
    settings.externalSourceScript = script;
    assert.equal((await plugin.stream({ id: mid })).type, 'flac');
  }
  assert.equal(calls.filter(call => call.url === LX_SCRIPT || call.url === rotated).length, 2);
});

// 缓存存储损坏或只读不能阻止外部取流，仍由网络结果决定是否回落。
test('unavailable script storage does not prevent playback', async (t) => {
  lxOn();
  t.mock.method(host.storage, 'get', () => { throw new Error('unreadable storage'); });
  t.mock.method(host.storage, 'set', () => { throw new Error('read-only storage'); });
  respond = lxRoute();
  assert.equal((await plugin.stream({ id: mid })).type, 'flac');
  assert.equal(calls.filter(call => call.url === LX_SCRIPT).length, 1);
});

// 服务器忽略 Range 返回整首歌时，只取前 8KB 并主动取消后续响应。
test('media verification bounds reads even when the server ignores Range', async () => {
  lxOn();
  let canceled = false;
  let chunks = 0;
  respond = lxRoute({ media: () => new Response(new ReadableStream({
    pull(controller) {
      chunks++;
      controller.enqueue(Uint8Array.from(chunks === 1 ? FLAC_HEAD : new Uint8Array(8192)));
    },
    cancel() { canceled = true; },
  }, { highWaterMark: 0 }), { status: 200 }) });
  assert.equal((await plugin.stream({ id: mid })).type, 'flac');
  assert.equal(chunks, 2);
  assert.equal(canceled, true);
  const request = calls.find(call => call.url === LX_CDN + '/a.flac');
  assert.equal(request.init.headers.Range, 'bytes=0-8191');
  assert.equal(request.init.redirect, 'error');
});

// 脚本即使开头有效也不能无限读取或截断后当作有效脚本缓存。
test('an oversized streamed script is canceled and cached as a parse failure', async (t) => {
  lxOn();
  lxClock(t);
  let chunks = 0;
  let canceled = false;
  respond = (input, init) => String(input) === LX_SCRIPT ? new Response(new ReadableStream({
    pull(controller) {
      chunks++;
      controller.enqueue(chunks === 1 ? new TextEncoder().encode(LX_SCRIPT_BODY) : new Uint8Array(65536).fill(32));
    },
    cancel() { canceled = true; },
  }, { highWaterMark: 0 })) : officialStream(input, init);
  assert.equal((await plugin.stream({ id: mid })).url, 'https://stream.qqmusic.qq.com/fixture.mp3');
  assert.equal(chunks, 5);
  assert.equal(canceled, true);
  assert.equal(storage.get(LX_CACHE_KEY).reason, 'script');
  assert.equal(storage.get(LX_CACHE_KEY).expiresAt, Date.now() + 600000);
});

// Range 探测拒绝跳转，不能让通过校验的公网地址跳转访问内网。
test('a redirected media probe falls back without following the Location', async () => {
  lxOn();
  const route = lxRoute({ media: () => new Response(null, { status: 302, headers: { Location: 'https://127.0.0.1/private' } }) });
  respond = (input, init) => String(input).startsWith('https://u.y.qq.com') ? officialStream(input, init) : route(input);
  assert.equal((await plugin.stream({ id: mid })).url, 'https://stream.qqmusic.qq.com/fixture.mp3');
  assert.equal(calls.find(call => call.url === LX_CDN + '/a.flac').init.redirect, 'error');
  assert.ok(calls.every(call => !call.url.includes('127.0.0.1')));
});

test('a non-songmid id skips the external source entirely', async () => {
  lxOn(LX_BACKUP_SCRIPT);
  let scripts = 0;
  const route = lxRoute();
  respond = (input, init) => {
    if (String(input) === LX_SCRIPT || String(input) === LX_BACKUP_SCRIPT) scripts++;
    if (String(input).startsWith('https://u.y.qq.com')) return officialStream(input, init);
    return route(input);
  };
  await plugin.stream({ id: 'program:123', quality: 'standard' }).catch(() => {});
  assert.equal(scripts, 0);
});

test('a healthy primary does not download or call the backup', async (t) => {
  lxOn(LX_BACKUP_SCRIPT);
  const warnings = t.mock.method(console, 'warn', () => {});
  respond = lxPairRoute();
  assert.equal((await plugin.stream({ id: mid })).url, LX_CDN + '/a.flac');
  assert.ok(calls.every(call => !call.url.includes('backup-')));
  assert.equal(warnings.mock.callCount(), 0);
});

for (const [name, primary] of [
  ['script download failure', () => { throw new TypeError('offline'); }],
  ['invalid script', lxRoute({ script: 'invalid script' })],
  ['unsupported platform', lxRoute({ script: LX_TX_MISSING })],
  ['business failure', lxRoute({ payload: { code: 503 } })],
  ['unsafe media URL', lxRoute({ payload: { code: 200, url: 'https://127.0.0.1/private' } })],
  ['unplayable media', lxRoute({ media: () => audioReply([], 403) })],
]) {
  test(`a primary ${name} switches to the backup before official playback`, async (t) => {
    lxOn(LX_BACKUP_SCRIPT);
    const warnings = t.mock.method(console, 'warn', () => {});
    respond = lxPairRoute({ primary });
    const result = await plugin.stream({ id: mid, quality: 'lossless' });
    assert.equal(result.url, LX_BACKUP_CDN + '/a.flac');
    assert.equal(result.type, 'flac');
    assert.equal(result.quality, 'lossless');
    assert.deepEqual(result.headers, { Referer: 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0' });
    assert.equal(calls[0].url, LX_SCRIPT);
    assert.ok(calls.findIndex(call => call.url === LX_BACKUP_SCRIPT) > 0);
    assert.ok(!requested().includes('vkey'));
    assert.equal(warnings.mock.callCount(), 1);
    assert.match(warnings.mock.calls[0].arguments[0], /^external source fallback: (network|script|unsupported|failure)$/);
  });
}

test('two failing sources fall back to official playback in order and log once each', async (t) => {
  lxOn(LX_BACKUP_SCRIPT);
  const warnings = t.mock.method(console, 'warn', () => {});
  respond = lxPairRoute({ primary: lxRoute({ payload: { code: 503 } }), payload: { code: 503 } });
  assert.equal((await plugin.stream({ id: mid })).url, 'https://stream.qqmusic.qq.com/fixture.mp3');
  const targets = calls.map(call => call.url);
  assert.ok(targets.indexOf(LX_SCRIPT) < targets.indexOf(LX_BACKUP_SCRIPT));
  assert.ok(targets.findIndex(url => url.startsWith(LX_BACKUP_API + '/music/url'))
    < targets.findIndex(url => url.startsWith('https://u.y.qq.com')));
  assert.deepEqual(warnings.mock.calls.map(call => call.arguments), [
    ['external source fallback: failure'], ['external source fallback: failure'],
  ]);
});

for (const [quality, expected] of [['lossless', 'flac'], ['high', '320k'], ['standard', '128k']]) {
  test(`POST scripts send the JSON body and API key for ${quality}`, async () => {
    lxOn();
    settings.externalSourceScript = LX_BACKUP_SCRIPT;
    respond = lxPairRoute();
    assert.equal((await plugin.stream({ id: mid, quality })).url, LX_BACKUP_CDN + '/a.flac');
    const request = calls.find(call => call.url === LX_BACKUP_API + '/music/url');
    assert.ok(request);
    assert.equal(request.init.method, 'POST');
    assert.deepEqual(JSON.parse(request.init.body), { source: 'tx', musicId: mid, quality: expected });
    assert.equal(request.init.headers['X-Api-Key'], 'backup-key');
    assert.equal(request.init.headers['X-API-Key'], undefined);
    assert.equal(request.init.headers['Content-Type'], 'application/json');
    assert.equal(request.init.headers['User-Agent'], 'lx-music-desktop/2.99.0');
    assert.ok(request.init.signal instanceof AbortSignal);
    const probe = calls.find(call => call.url === LX_BACKUP_CDN + '/a.flac');
    assert.equal(probe.init.headers.Range, 'bytes=0-8191');
    assert.equal(probe.init.redirect, 'error');
  });
}

for (const [declaration, protocol] of [
  ["method : 'POST', musicId", 'post'],
  ['method: "POST", songId', 'get'],
  ['method: "GET", musicId', 'get'],
  ['method: "POSTING", musicId', 'get'],
]) {
  test(`protocol detection requires both POST and musicId (${declaration})`, async () => {
    lxOn();
    respond = lxRoute({ script: LX_SCRIPT_BODY + '\nconst request = { ' + declaration + ' };' });
    assert.equal((await plugin.stream({ id: mid, quality: 'high' })).type, 'flac');
    const request = calls.find(call => call.url.startsWith(LX_API + '/music/url'));
    assert.equal(request.init.method, protocol.toUpperCase());
    assert.equal(storage.get(LX_CACHE_KEY).protocol, protocol);
    if (protocol === 'get') {
      assert.equal(request.init.body, undefined);
      assert.equal(request.init.headers['X-API-Key'], 'fixture-key');
      assert.equal(request.init.headers['X-Api-Key'], undefined);
      assert.equal(new URL(request.url).searchParams.get('songId'), mid);
    }
  });
}

test('GET and POST scripts retain separate cached endpoints, keys and protocols', async (t) => {
  lxOn(LX_BACKUP_SCRIPT);
  t.mock.method(console, 'warn', () => {});
  let recovered = false;
  respond = lxPairRoute({ primary: (input) => lxRoute({ payload: recovered
    ? { code: 200, url: LX_CDN + '/a.flac' } : { code: 503 } })(input) });
  assert.equal((await plugin.stream({ id: mid })).url, LX_BACKUP_CDN + '/a.flac');
  recovered = true;
  assert.equal((await plugin.stream({ id: mid })).url, LX_CDN + '/a.flac');
  recovered = false;
  assert.equal((await plugin.stream({ id: mid })).url, LX_BACKUP_CDN + '/a.flac');
  assert.equal(calls.filter(call => call.url === LX_SCRIPT).length, 1);
  assert.equal(calls.filter(call => call.url === LX_BACKUP_SCRIPT).length, 1);
  const backupKey = 'qqmusic.lx-script.' + host.crypto.md5(LX_BACKUP_SCRIPT);
  assert.notEqual(LX_CACHE_KEY, backupKey);
  assert.equal(storage.get(LX_CACHE_KEY).apiUrl, LX_API);
  assert.equal(storage.get(LX_CACHE_KEY).key, 'fixture-key');
  assert.equal(storage.get(LX_CACHE_KEY).protocol, 'get');
  assert.equal(storage.get(backupKey).apiUrl, LX_BACKUP_API);
  assert.equal(storage.get(backupKey).key, 'backup-key');
  assert.equal(storage.get(backupKey).protocol, 'post');
});

test('a negative primary cache cannot overwrite or reuse the backup cache', async (t) => {
  lxOn(LX_BACKUP_SCRIPT);
  t.mock.method(console, 'warn', () => {});
  respond = lxPairRoute({ primary: () => { throw new TypeError('offline'); } });
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await plugin.stream({ id: mid })).url, LX_BACKUP_CDN + '/a.flac');
  }
  assert.equal(calls.filter(call => call.url === LX_SCRIPT).length, 1);
  assert.equal(calls.filter(call => call.url === LX_BACKUP_SCRIPT).length, 1);
  assert.equal(storage.get(LX_CACHE_KEY).ok, false);
  assert.equal(storage.get('qqmusic.lx-script.' + host.crypto.md5(LX_BACKUP_SCRIPT)).protocol, 'post');
});

test('a cached script without a protocol is parsed again before POST playback', async () => {
  lxOn();
  settings.externalSourceScript = LX_BACKUP_SCRIPT;
  const cacheKey = 'qqmusic.lx-script.' + host.crypto.md5(LX_BACKUP_SCRIPT);
  storage.set(cacheKey, { v: 1, ok: true, apiUrl: LX_BACKUP_API, key: 'stale-key', supported: true, expiresAt: Date.now() + 86400000 });
  respond = lxPairRoute();
  assert.equal((await plugin.stream({ id: mid })).type, 'flac');
  assert.equal(calls.filter(call => call.url === LX_BACKUP_SCRIPT).length, 1);
  assert.equal(storage.get(cacheKey).protocol, 'post');
  assert.equal(calls.find(call => call.url === LX_BACKUP_API + '/music/url').init.headers['X-Api-Key'], 'backup-key');
});

for (const [name, failure] of [
  ['HTTP failure', () => response({ code: 200, url: LX_BACKUP_CDN + '/a.flac' }, 503)],
  ['business failure', () => response({ code: 500, url: LX_BACKUP_CDN + '/a.flac' })],
  ['invalid JSON', () => new Response('{')],
  ['unsafe URL', () => response({ code: 200, url: 'https://127.0.0.1/private' })],
  ['timeout', () => { throw new DOMException('aborted', 'AbortError'); }],
]) {
  test(`a POST ${name} falls back without bypassing validation`, async (t) => {
    lxOn();
    settings.externalSourceScript = LX_BACKUP_SCRIPT;
    const warnings = t.mock.method(console, 'warn', () => {});
    const route = lxPairRoute();
    respond = (input, init) => String(input) === LX_BACKUP_API + '/music/url' ? failure() : route(input, init);
    assert.equal((await plugin.stream({ id: mid })).url, 'https://stream.qqmusic.qq.com/fixture.mp3');
    assert.equal(warnings.mock.callCount(), 1);
    assert.equal(warnings.mock.calls[0].arguments[0], `external source fallback: ${name === 'timeout' ? 'timeout' : 'failure'}`);
    assert.ok(calls.every(call => !call.url.includes('127.0.0.1')));
  });
}

test('fallback logs redact exception reasons, script keys, endpoints and direct links', async (t) => {
  lxOn(LX_BACKUP_SCRIPT);
  const warnings = t.mock.method(console, 'warn', () => {});
  const direct = LX_BACKUP_CDN + '/private.flac?key=direct-secret';
  const secret = [LX_SCRIPT, LX_API, LX_BACKUP_SCRIPT, LX_BACKUP_API, direct, 'fixture-key', 'backup-key'].join(' ');
  respond = lxPairRoute({
    primary: (input) => {
      if (String(input) === LX_SCRIPT) return new Response(LX_SCRIPT_BODY);
      throw Object.assign(new Error(secret), { reason: secret });
    },
    payload: { code: 200, url: direct },
    media: () => { throw new Error(secret); },
  });
  assert.equal((await plugin.stream({ id: mid })).url, 'https://stream.qqmusic.qq.com/fixture.mp3');
  assert.ok(calls.some(call => call.url === direct));
  assert.deepEqual(warnings.mock.calls.map(call => call.arguments), [
    ['external source fallback: failure'], ['external source fallback: failure'],
  ]);
});

test('disabled external sources skip both configured scripts', async () => {
  lxOn(LX_BACKUP_SCRIPT);
  settings.externalSourceEnabled = 'false';
  respond = officialStream;
  assert.equal((await plugin.stream({ id: mid })).url, 'https://stream.qqmusic.qq.com/fixture.mp3');
  assert.ok(calls.every(call => call.url.startsWith('https://u.y.qq.com')));
});
