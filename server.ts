/**
 * アーティスト名を検索し、そのアーティストを中心としたフィーチャリング
 * ネットワークをその場で構築して返すローカルAPIサーバー。
 *
 * ── セットアップ ──────────────────────────────────────────────
 * npm install express cors
 * npm install -D @types/express @types/cors tsx dotenv
 *
 * .env に SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET を設定してから:
 *   npx tsx server.ts
 *
 * → http://localhost:3001/api/network?artist=名前 が使えるようになる
 *
 * フロントエンド(Vite dev server, 通常 http://localhost:5173)から
 * このAPIを叩く構成。Spotifyのクライアントシークレットはこのサーバー
 * プロセス内だけで使われ、ブラウザには一切渡らない。
 */

import "dotenv/config";
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
const MARKET = "JP";
// appears_on を含めると膨大になるアーティストがいるため、処理するアルバム数の上限
const MAX_ALBUMS = 80;

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------
interface TokenResponse {
  access_token: string;
  expires_in: number;
}
interface SpotifyArtist {
  id: string;
  name: string;
  genres: string[];
  popularity: number;
  followers: { total: number };
}
interface SpotifyArtistRef {
  id: string;
  name: string;
}
interface SpotifyTrack {
  id: string;
  name: string;
  artists: SpotifyArtistRef[];
}
interface SpotifyAlbum {
  id: string;
  name: string;
  release_date: string;
  album_group?: string;
}
interface SpotifyPagedResponse<T> {
  items: T[];
  next: string | null;
}

interface NetworkNode {
  id: string;
  name: string;
  group: string;
  bio: string;
  releases: number;
  isCenter: boolean;
}
interface NetworkLink {
  source: string;
  target: string;
  collabs: { title: string; year: number }[];
}

// ---------------------------------------------------------------------------
// Spotify API ヘルパー(トークンはプロセス内でキャッシュして使い回す)
// ---------------------------------------------------------------------------
let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET が設定されていません(.env を確認してください)");
  }
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`トークン取得失敗: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as TokenResponse;
  cachedToken = { value: json.access_token, expiresAt: Date.now() + (json.expires_in - 60) * 1000 };
  return cachedToken.value;
}

async function spotifyFetch<T>(url: string, token: string, retryCount = 0): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 429 && retryCount < 5) {
    const waitSec = Number(res.headers.get("retry-after") ?? "1");
    await new Promise((r) => setTimeout(r, waitSec * 1000));
    return spotifyFetch<T>(url, token, retryCount + 1);
  }
  if (!res.ok) throw new Error(`APIエラー ${res.status}: ${url}`);
  return (await res.json()) as T;
}

async function searchArtist(name: string, token: string): Promise<SpotifyArtist | null> {
  const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(
    name
  )}&type=artist&market=${MARKET}&limit=5`;
  const data = await spotifyFetch<{ artists: SpotifyPagedResponse<SpotifyArtist> }>(url, token);
  const exact = data.artists.items.find((a) => a.name === name);
  return exact ?? data.artists.items[0] ?? null;
}

async function getAllAlbums(artistId: string, token: string): Promise<SpotifyAlbum[]> {
  const albums: SpotifyAlbum[] = [];
  let url: string | null =
    `https://api.spotify.com/v1/artists/${artistId}/albums?include_groups=album,single,appears_on&market=${MARKET}&limit=50`;
  while (url) {
    const data: SpotifyPagedResponse<SpotifyAlbum> = await spotifyFetch(url, token);
    albums.push(...data.items);
    url = data.next;
  }
  return albums;
}

async function getAlbumTracks(albumId: string, token: string): Promise<SpotifyTrack[]> {
  const tracks: SpotifyTrack[] = [];
  let url: string | null = `https://api.spotify.com/v1/albums/${albumId}/tracks?market=${MARKET}&limit=50`;
  while (url) {
    const data: SpotifyPagedResponse<SpotifyTrack> = await spotifyFetch(url, token);
    tracks.push(...data.items);
    url = data.next;
  }
  return tracks;
}

// ---------------------------------------------------------------------------
// センターアーティストを軸にネットワークを構築
// ---------------------------------------------------------------------------
async function buildNetworkForArtist(artistName: string) {
  const token = await getAccessToken();

  const center = await searchArtist(artistName, token);
  if (!center) {
    const err = new Error(`アーティストが見つかりませんでした: ${artistName}`) as Error & { status?: number };
    err.status = 404;
    throw err;
  }

  const albums = await getAllAlbums(center.id, token);
  const targetAlbums = albums.slice(0, MAX_ALBUMS);

  // 名前だけ分かっている段階のキャッシュ(詳細は後でまとめて取得)
  const knownArtists = new Map<string, SpotifyArtist>();
  knownArtists.set(center.id, center);

  const collabMap = new Map<string, { title: string; year: number }[]>();
  const seenAlbumIds = new Set<string>();
  let ownReleaseCount = 0;

  for (const album of targetAlbums) {
    if (album.album_group !== "appears_on") ownReleaseCount += 1;
    if (seenAlbumIds.has(album.id)) continue;
    seenAlbumIds.add(album.id);

    const tracks = await getAlbumTracks(album.id, token);
    const year = Number((album.release_date || "0").slice(0, 4)) || 0;

    for (const track of tracks) {
      const onTrack = track.artists;
      const centerPresent = onTrack.some((a) => a.id === center.id);
      if (!centerPresent || onTrack.length < 2) continue;

      // このトラックに載っている全アーティストの組み合わせにエッジを張る
      // (センター⇄共演者だけでなく、共演者同士の関係も同時に拾える)
      for (let i = 0; i < onTrack.length; i++) {
        for (let j = i + 1; j < onTrack.length; j++) {
          const a = onTrack[i];
          const b = onTrack[j];
          const [x, y] = a.id < b.id ? [a, b] : [b, a];
          const key = `${x.id}__${y.id}`;
          const list = collabMap.get(key) ?? [];
          if (!list.some((c) => c.title === track.name)) {
            list.push({ title: track.name, year });
          }
          collabMap.set(key, list);

          for (const ref of [a, b]) {
            if (!knownArtists.has(ref.id)) {
              knownArtists.set(ref.id, {
                id: ref.id,
                name: ref.name,
                genres: [],
                popularity: 0,
                followers: { total: 0 },
              });
            }
          }
        }
      }
    }
  }

  // 登場した全アーティストのジャンル・人気度をまとめて取得(50件ずつ)
  const allIds = Array.from(knownArtists.keys());
  for (let i = 0; i < allIds.length; i += 50) {
    const chunk = allIds.slice(i, i + 50);
    const url = `https://api.spotify.com/v1/artists?ids=${chunk.join(",")}`;
    const data = await spotifyFetch<{ artists: (SpotifyArtist | null)[] }>(url, token);
    for (const a of data.artists) {
      if (a) knownArtists.set(a.id, a);
    }
  }

  const nodes: NetworkNode[] = allIds.map((id) => {
    const info = knownArtists.get(id)!;
    return {
      id,
      name: info.name,
      group: info.genres[0] ?? "ジャンル不明",
      bio: `人気度 ${info.popularity}/100・フォロワー ${info.followers.total.toLocaleString()}人`,
      releases: id === center.id ? ownReleaseCount : 0,
      isCenter: id === center.id,
    };
  });

  const links: NetworkLink[] = Array.from(collabMap.entries()).map(([key, collabs]) => {
    const [sourceId, targetId] = key.split("__");
    return { source: sourceId, target: targetId, collabs: collabs.sort((p, q) => p.year - q.year) };
  });

  return { nodes, links, centerId: center.id };
}

// ---------------------------------------------------------------------------
// エンドポイント
// ---------------------------------------------------------------------------
app.get("/api/network", async (req, res) => {
  const artist = String(req.query.artist ?? "").trim();
  if (!artist) {
    res.status(400).json({ error: "artist パラメータが必要です" });
    return;
  }
  try {
    const result = await buildNetworkForArtist(artist);
    res.json(result);
  } catch (err) {
    const e = err as Error & { status?: number };
    console.error(e);
    res.status(e.status ?? 500).json({ error: e.message ?? "内部エラー" });
  }
});

app.listen(PORT, () => {
  console.log(`Spotify network API を起動しました: http://localhost:${PORT}/api/network?artist=名前`);
});
