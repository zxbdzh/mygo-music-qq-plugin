import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLibrary } from './index.js';

const signed = { musicid: '10001', musickey: 'test', loginType: 2, encryptUin: 'encrypted' };
function setup(handler, session = signed, options = {}) {
  const calls = [];
  const lib = createLibrary({
    qqReadSession: () => session,
    qqAuthRpc: async (module, method, param, s) => { calls.push({ module, method, param }); assert.equal(s, session); return handler(method, param); },
    cgi: options.cgi || (async () => ({ cdlist: [{ dissname: 'Public', songlist: [{ mid: 'song1' }] }] })),
    qqAuthCgi: options.qqAuthCgi,
    fetch: options.fetch,
    trackOf: t => ({ id: t.mid, name: t.name || '' }),
  });
  return { lib, calls };
}
const own = { tid: 900, dirId: 12, dirType: 0, dirName: 'Mine', uin: '10001' };
const ok = { retCode: 0, result: { tid: 900, dirId: 12 } };

test('missing encryptUin is an error, not an empty library', async () => {
  const { lib, calls } = setup(() => { throw new Error('unexpected'); }, { musicid: '10001', musickey: 'test', loginType: 2 }, { fetch: async () => new Response(JSON.stringify({ code: 0, data: { creator: {} } })) });
  await assert.rejects(lib.playlists(), /encryptUin/);
  await assert.rejects(lib.liked({}), /encryptUin/);
  assert.equal(calls.length, 0);
});

test('playlists combines owned and paginated favorites', async () => {
  const { lib } = setup((method, p) => {
    if (method === 'GetPlaylistByUin') return { v_playlist: [own] };
    assert.equal(method, 'CgiGetPlaylistFavInfo');
    assert.equal(p.uin, 'encrypted');
    return p.offset === 0 ? { v_list: [{ tid: 901, name: 'Saved' }], hasmore: 1 } : { v_list: [{ tid: 902, name: 'Next' }], hasmore: 0 };
  });
  assert.deepEqual((await lib.playlists()).map(p => [p.id, p.name, p.mine]), [['900', 'Mine', true], ['901', 'Saved', false], ['902', 'Next', false]]);
});

test('liked loads every page in one call and skips songs without a MID', async () => {
  const { lib, calls } = setup((method, p) => {
    assert.equal(method, 'CgiGetDiss');
    assert.equal(p.song_num, 1000); assert.equal(p.enc_host_uin, 'encrypted');
    return p.song_begin === 20
      ? { songlist: [{ mid: 'song1' }, { mid: '', title: 'Uploaded file' }], hasmore: 1 }
      : { songlist: [{ mid: 'song1' }, { mid: 'song2' }], hasmore: 0 };
  });
  assert.deepEqual(await lib.liked({ offset: 20 }), { tracks: [{ id: 'song1', name: '' }, { id: 'song2', name: '' }], more: false });
  assert.deepEqual(calls.map(c => c.param.song_begin), [20, 1020]);
});

test('liked rejects an empty page that claims more songs', async () => {
  const { lib } = setup(() => ({ songlist: [], hasmore: 1 }));
  await assert.rejects(lib.liked({}), /incomplete/);
});

test('like resolves MID to numeric song ID and confirms state', async () => {
  let liked = false, writes = 0;
  const { lib } = setup((method, p) => {
    if (method === 'IsSongFanByMid') return { m_fan: { song1: liked } };
    if (method === 'get_song_detail_yqq') return { track_info: { mid: 'song1', id: 42 } };
    if (method === 'AddSonglist') { writes++; assert.deepEqual(p, { dirId: 201, v_songInfo: [{ songId: 42, songType: 0 }] }); liked = true; return ok; }
    throw new Error(method);
  }, { musicid: '10001', musickey: 'test', loginType: 2 });
  await lib.like({ id: 'song1', on: true });
  await lib.like({ id: 'song1', on: true });
  assert.equal(writes, 1);
  assert.deepEqual(await lib.isLiked({ ids: ['song1'] }), { song1: true });
});

test('playlist edit resolves owned directory and rejects system lists', async () => {
  const { lib, calls } = setup((method, p) => {
    if (method === 'GetPlaylistByUin') return { v_playlist: [own, { tid: 901, dirId: 201, dirType: 0 }] };
    if (method === 'get_song_detail_yqq') return { track_info: { mid: p.song_mid, id: 42 } };
    if (method === 'AddSonglist') { assert.deepEqual(p, { dirId: 12, v_songInfo: [{ songId: 42, songType: 0 }] }); return ok; }
    throw new Error(method);
  });
  await lib.addToPlaylist({ id: '900', trackIds: ['song1'] });
  await assert.rejects(lib.addToPlaylist({ id: '901', trackIds: ['song1'] }), /ordinary/);
  assert.equal(calls.filter(c => c.method === 'AddSonglist').length, 1);
});

test('owned and saved playlists load every authenticated page before public CGI', async () => {
  const { lib } = setup((method, p) => {
    if (method === 'GetPlaylistByUin') return { v_playlist: [own] };
    assert.equal(method, 'CgiGetDiss');
    assert.equal(p.enc_host_uin, 'encrypted');
    return { dirinfo: { title: 'Mine' }, total_song_num: 2, songlist: [{ mid: p.song_begin ? 'song2' : 'song1' }], hasmore: p.song_begin ? 0 : 1 };
  }, signed, { cgi: async () => { assert.fail('authenticated playlists must not use public CGI'); } });
  assert.deepEqual((await lib.playlist({ id: '900' })).tracks.map(t => t.id), ['song1', 'song2']);
  const saved = await lib.playlist({ id: '901' });
  assert.deepEqual([saved.name, saved.mine, saved.tracks.map(t => t.id)], ['Mine', false, ['song1', 'song2']]);
});

test('non-owned playlist falls back to public CGI when CgiGetDiss fails', async () => {
  const { lib } = setup(method => {
    if (method === 'GetPlaylistByUin') return { v_playlist: [own] };
    return { code: 1 };
  });
  assert.equal((await lib.playlist({ id: '901' })).name, 'Public');
  await assert.rejects(lib.playlist({ id: '900' }), /rejected/);
});

test('rename preserves settings and verifies them', async () => {
  let title = 'Mine';
  const info = () => ({ dirid: 12, title, desc: 'desc', picurl: 'cover', picurl2: '', tag: [{ id: 3 }], dir_show: 2 });
  const { lib } = setup((method, p) => {
    if (method === 'GetPlaylistByUin') return { v_playlist: [own] };
    if (method === 'uniform_get_Dissinfo') return { dirinfo: info() };
    if (method === 'EditPlaylist') { assert.equal(p.dirNewDesc, 'desc'); assert.equal(p.dirNewtaglist, '3'); title = p.dirNewName; return ok; }
    throw new Error(method);
  });
  await lib.renamePlaylist({ id: '900', name: 'Renamed' });
});

test('failed or incomplete writes are errors', async () => {
  const { lib } = setup(method => {
    if (method === 'GetPlaylistByUin') return { v_playlist: [own] };
    if (method === 'get_song_detail_yqq') return { track_info: { mid: 'song1', id: 42 } };
    if (method === 'DelSonglist') return { retCode: 1, result: {} };
    throw new Error(method);
  });
  await assert.rejects(lib.removeFromPlaylist({ id: '900', trackIds: ['song1'] }), /confirm/);
});

test('create and delete verify the account playlist listing', async () => {
  let entries = [];
  const { lib } = setup(method => {
    if (method === 'GetPlaylistByUin') return { v_playlist: entries };
    if (method === 'AddPlaylist') { entries = [own]; return ok; }
    if (method === 'DelPlaylist') { entries = []; return { retCode: 0, result: { tid: 900, dirId: 12, updateTime: 0 } }; }
    throw new Error(method);
  });
  assert.equal((await lib.createPlaylist({ name: 'Mine' })).id, '900');
  await lib.deletePlaylist({ id: '900' });
});

test('system playlist is not editable and inner errors are rejected', async () => {
  const { lib } = setup(method => {
    if (method === 'GetPlaylistByUin') return { v_playlist: [{ ...own, dirId: 201 }, { ...own, tid: 901, dirId: 205 }] };
    if (method === 'CgiGetPlaylistFavInfo') return { v_list: [], hasmore: 0 };
    return { subcode: 5, songlist: [] };
  });
  assert.deepEqual((await lib.playlists()).map(p => [p.id, p.mine]), [['901', false]]);
  await assert.rejects(lib.liked({}), /rejected/);
});

test('signed out returns empty playlists and false statuses without network', async () => {
  const { lib, calls } = setup(() => { throw new Error('unexpected'); }, null);
  assert.deepEqual(await lib.playlists(), []);
  assert.deepEqual(await lib.isLiked({ ids: ['song1', 'song2'] }), { song1: false, song2: false });
  for (const f of [() => lib.liked(), () => lib.like({ id: 'song1', on: true }), () => lib.savedAlbums(), () => lib.saveAlbum({ id: 'album1', on: true }), () => lib.createPlaylist({ name: 'x' })]) await assert.rejects(f, { code: 'signIn' });
  assert.equal(calls.length, 0);
});

test('profile CGI resolves encrypt_uin from musicid for library calls', async () => {
  const urls = [];
  const { lib } = setup((method, p) => {
    if (method === 'GetPlaylistByUin') return { v_playlist: [] };
    if (method === 'CgiGetPlaylistFavInfo') { assert.equal(p.uin, 'resolved'); return { v_list: [], hasmore: 0 }; }
    assert.equal(p.enc_host_uin, 'resolved');
    return { songlist: [], hasmore: 0 };
  }, { musicid: '10001', musickey: 'test', loginType: 2 }, { fetch: async url => {
    urls.push(new URL(url));
    return new Response(JSON.stringify({ code: 0, data: { creator: { encrypt_uin: 'resolved' } } }));
  } });
  await lib.playlists(); await lib.liked();
  assert.equal(urls.length, 2);
  assert.equal(urls[0].hostname, 'c6.y.qq.com');
  assert.equal(urls[0].pathname, '/rsc/fcgi-bin/fcg_get_profile_homepage.fcg');
  assert.deepEqual(Object.fromEntries(urls[0].searchParams), { ct: '20', cv: '4747474', cid: '205360838', userid: '10001', format: 'json' });
});

test('profile CGI HTTP and service errors do not access the library', async () => {
  for (const reply of [new Response('', { status: 503 }), new Response(JSON.stringify({ code: 100, data: { creator: { encrypt_uin: 'wrong' } } }))]) {
    const { lib, calls } = setup(() => { throw new Error('unexpected'); }, { musicid: '10001', musickey: 'test', loginType: 2 }, { fetch: async () => reply });
    await assert.rejects(lib.playlists());
    assert.equal(calls.length, 0);
  }
});

test('saved albums use authenticated CGI, inclusive ranges and MID metadata', async () => {
  const { lib } = setup(() => { throw new Error('unexpected'); }, signed, { qqAuthCgi: async (path, p, s) => {
    assert.equal(s, signed); assert.equal(path, '/fav/fcgi-bin/fcg_get_profile_order_asset.fcg');
    assert.deepEqual(p, { ct: 20, cid: 205360956, userid: '10001', reqtype: 2, sin: 20, ein: 39 });
    return { code: 0, data: { totalalbum: 22, albumlist: [{ albummid: 'AlbumMID', albumname: 'Album', singername: 'Singer' }] } };
  } });
  const page = await lib.savedAlbums({ offset: 20 });
  assert.equal(page.more, true); assert.equal(page.albums[0].id, 'AlbumMID'); assert.equal(page.albums[0].artists[0].name, 'Singer');
});

test('album save and unsave use MID, avoid duplicates and verify writes', async () => {
  let saved = false, writes = 0;
  const { lib } = setup((method, p) => {
    assert.deepEqual(p.v_albumMid, ['AlbumMID']);
    if (method === 'IsAlbumFan') { assert.equal(p.uin, 10001); return { m_fan: { AlbumMID: saved } }; }
    assert.equal(p.uin, '10001'); writes++; saved = method === 'FavAlbum';
    return { result: 0, v_failedAlbumId: [], v_failedAlbumMid: [] };
  });
  await lib.saveAlbum({ id: 'AlbumMID', on: true });
  await lib.saveAlbum({ id: 'AlbumMID', on: true });
  await lib.saveAlbum({ id: 'AlbumMID', on: false });
  assert.equal(writes, 2);
});

test('album errors do not masquerade as success', async () => {
  const { lib } = setup(method => method === 'IsAlbumFan' ? { m_fan: { AlbumMID: false } } : { result: 0 }, signed, { qqAuthCgi: async () => ({ code: 0, data: { totalalbum: 1, albumlist: [] } }) });
  await assert.rejects(lib.savedAlbums(), /incomplete/);
  await assert.rejects(lib.saveAlbum({ id: 'AlbumMID', on: true }), /confirm/);
});

test('playlists without dirType (current QQ response) are editable', async () => {
  const bare = { tid: 900, dirId: 12, dirName: 'Mine', uin: '10001' };
  const { lib } = setup((method, p) => {
    if (method === 'GetPlaylistByUin') return { v_playlist: [bare, { tid: 901, dirId: 201, dirName: 'Liked' }] };
    if (method === 'CgiGetPlaylistFavInfo') return { v_list: [], hasmore: 0 };
    if (method === 'AddPlaylist') return ok;
    if (method === 'get_song_detail_yqq') return { track_info: { mid: p.song_mid, id: 42 } };
    if (method === 'AddSonglist') return ok;
    throw new Error(method);
  });
  assert.deepEqual((await lib.playlists()).map(p => [p.id, p.mine]), [['900', true]]);
  assert.equal((await lib.createPlaylist({ name: 'Mine' })).id, '900');
  await lib.addToPlaylist({ id: '900', trackIds: ['song1'] });
});

test('owned playlist tolerates uploaded songs and fewer rows than the reported total', async () => {
  const { lib, calls } = setup((method, p) => {
    if (method === 'GetPlaylistByUin') return { v_playlist: [own] };
    assert.equal(method, 'CgiGetDiss');
    assert.equal(p.song_num, 1000);
    return { dirinfo: { title: 'Mine' }, total_song_num: 3, songlist: [{ mid: 'song1' }, { mid: '', title: 'Uploaded file' }], hasmore: 0 };
  });
  assert.deepEqual((await lib.playlist({ id: '900' })).tracks.map(t => t.id), ['song1']);
  assert.equal(calls.filter(c => c.method === 'CgiGetDiss').length, 1);
});

test('saved playlist uses CgiGetDiss when public CGI would refuse it', async () => {
  const { lib } = setup((method, p) => {
    if (method === 'GetPlaylistByUin') return { v_playlist: [own] };
    assert.equal(method, 'CgiGetDiss');
    assert.equal(p.disstid, 901); assert.equal(p.enc_host_uin, 'encrypted');
    return { dirinfo: { title: 'Private CGI' }, total_song_num: 1, songlist: [{ mid: 'song1' }], hasmore: 0 };
  }, signed, { cgi: async () => { throw new Error('QQ Music: 0'); } });
  const result = await lib.playlist({ id: '901' });
  assert.equal(result.name, 'Private CGI');
  assert.deepEqual(result.tracks.map(t => t.id), ['song1']);
});

test('saved playlist reports an error when both sources refuse it', async () => {
  const { lib } = setup(method => method === 'GetPlaylistByUin' ? { v_playlist: [own] } : { code: -100006 }, signed, { cgi: async () => { throw new Error('QQ Music: 10'); } });
  await assert.rejects(lib.playlist({ id: '901' }), /QQ Music: 10/);
});

// 播放上报走官方两个免签名通道，都只认数字歌曲 ID；失败静默，不打断播放。
test('played and stopped report the play count and the play time beacon', async () => {
  const requests = [];
  const { lib } = setup(
    method => { assert.equal(method, 'get_song_detail_yqq'); return { track_info: { mid: 'song1', id: 42 } }; },
    signed,
    { fetch: async (url, init) => { requests.push({ url, init }); return new Response('GIF89a'); } },
  );
  await lib.played({ id: 'song1' });
  assert.equal(requests[0].url, 'https://stat6.y.qq.com/sdk/fcgi-bin/sdk.fcg');
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.items[0].cmd, '25');
  assert.equal(body.items[0].int1, 3);
  assert.equal(body.items[0].int2, 42);
  assert.equal(body.common._uid, '10001');

  await lib.stopped({ id: 'song1', heard: 30000, duration: 200000, finished: false });
  assert.match(requests[1].url, /^https:\/\/stat6\.y\.qq\.com\/pc\/fcgi-bin\/cgi_music_webreport\.fcg\?/);
  assert.match(requests[1].url, /Fsong_id=42/);
  assert.match(requests[1].url, /Fplay_time=30/);
  assert.match(requests[1].url, /Fqq=10001/);
  assert.match(requests[1].url, /Fguid=[0-9a-f]{32}/);
});

// 官方只认数字歌曲 ID：歌曲详情拿不到，或没登录，就什么都不发。
test('reporting skips a song without a numeric ID, and a signed-out listener', async () => {
  const requests = [];
  const handler = async (url, init) => { requests.push({ url, init }); return new Response(''); };
  const { lib } = setup(
    () => ({ track_info: { mid: 'song1', id: '' } }),
    signed,
    { fetch: handler },
  );
  await lib.played({ id: 'song1' });
  await lib.stopped({ id: 'song1', heard: 30000, duration: 200000, finished: true });
  assert.equal(requests.length, 0);

  const { lib: guest } = setup(() => { throw new Error('must not read'); }, null, { fetch: handler });
  await guest.played({ id: 'song1' });
  await guest.stopped({ id: 'song1', heard: 30000, duration: 200000, finished: true });
  assert.equal(requests.length, 0);
});

// 上报失败不能抛出：播放器收到错误会以为播放出了问题。
test('reporting failures are swallowed', async () => {
  const { lib } = setup(
    () => { throw new Error('detail unavailable'); },
    signed,
    { fetch: async () => { throw new Error('network down'); } },
  );
  await lib.played({ id: 'song1' });
  await lib.stopped({ id: 'song1', heard: 30000, duration: 200000, finished: true });
});
