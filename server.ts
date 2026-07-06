/**
 * Genius API を使い、アーティスト名を検索してそのアーティストを中心とした
 * フィーチャリングネットワークを構築するローカルAPIサーバー。
 *
 * ── セットアップ ──────────────────────────────────────────────
 * 1. https://genius.com/api-clients で新しいAPI Clientを作成
 * 2. 作成画面にある「Generate Access Token」で Client Access Token を発行
 *    (Client ID / Secretではなく、この1本のトークンだけでOK。OAuthの
 *     認可コードフローは不要)
 * 3. .env に以下を設定
 *      GENIUS_ACCESS_TOKEN=xxxx
 * 4. npm install express cors
 *    npm install -D @types/express @types/cors tsx dotenv
 * 5. 実行: npx tsx server.ts
 * → http://localhost:3001/api/network?artist=名前 が使えるようになる
 *
 * ── データの拾い方について ──────────────────────────────────
 * Genius公式APIには「アーティスト検索」専用のエンドポイントがないため、
 * /search で曲を検索し、その結果の primary_artist からアーティストIDを
 * 特定する。またフィーチャリングだけの曲を直接一覧取得するエンドポイントも
 * 無いため、「そのアーティスト本人名義の曲」を軸にして、そこに載っている
 * 客演者(featured_artists)を拾う構成にしている。
 * つまり「他人の曲にfeatureとしてだけ参加している回」は拾いきれない点に
 * 留意してください(v1のスコープとして許容)。
 */

import "dotenv/config";
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
const GENIUS_BASE = "https://api.genius.com";

// 処理する曲数の上限(客演の多い人気アーティストで待たされすぎないため)
const MAX_SONGS = 150;
// Genius側への配慮のため、曲詳細取得の間に入れる待機時間(ms)
const REQUEST_INTERVAL_MS = 120;

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------
interface GeniusArtistRef {
  id: number;
  name: string;
  is_verified?: boolean;
  url?: string;
}

interface GeniusSongSummary {
  id: number;
  title: string;
  title_with_featured: string;
  full_title: string;
  primary_artist: GeniusArtistRef;
}

interface GeniusSongDetail {
  id: number;
  title: string;
  primary_artist: GeniusArtistRef;
  featured_artists: GeniusArtistRef[];
  release_date_components?: { year?: number; month?: number; day?: number };
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
// Genius API ヘルパー
// ---------------------------------------------------------------------------
function getToken(): string {
  const token = process.env.GENIUS_ACCESS_TOKEN;
  if (!token) {
    throw new Error("GENIUS_ACCESS_TOKEN が設定されていません(.env を確認してください)");
  }
  return token;
}

async function geniusFetch<T>(url: string, retryCount = 0): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${getToken()}` } });

  if ((res.status === 429 || res.status >= 500) && retryCount < 4) {
    const waitMs = 800 * (retryCount + 1);
    await new Promise((r) => setTimeout(r, waitMs));
    return geniusFetch<T>(url, retryCount + 1);
  }
  if (!res.ok) {
    throw new Error(`Genius APIエラー ${res.status}: ${url}`);
  }
  return (await res.json()) as T;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function searchArtist(name: string): Promise<GeniusArtistRef | null> {
  const url = `${GENIUS_BASE}/search?q=${encodeURIComponent(name)}`;
  const data = await geniusFetch<{ response: { hits: { result: GeniusSongSummary }[] } }>(url);

  const candidates = data.response.hits.map((h) => h.result.primary_artist);
  const exact = candidates.find((a) => a.name === name);
  if (exact) return exact;

  // 完全一致がなければ、名前に検索語が含まれる最初の候補を採用
  const partial = candidates.find((a) => a.name.toLowerCase().includes(name.toLowerCase()));
  return partial ?? candidates[0] ?? null;
}

async function getAllArtistSongs(artistId: number): Promise<GeniusSongSummary[]> {
  const songs: GeniusSongSummary[] = [];
  let page: number | null = 1;

  while (page && songs.length < MAX_SONGS) {
    const url = `${GENIUS_BASE}/artists/${artistId}/songs?per_page=50&page=${page}&sort=popularity`;
    const data: { response: { songs: GeniusSongSummary[]; next_page: number | null } } = await geniusFetch(url);
    songs.push(...data.response.songs);
    page = data.response.next_page;
    await sleep(REQUEST_INTERVAL_MS);
  }
  return songs.slice(0, MAX_SONGS);
}

async function getSongDetail(songId: number): Promise<GeniusSongDetail> {
  const url = `${GENIUS_BASE}/songs/${songId}?text_format=plain`;
  const data = await geniusFetch<{ response: { song: GeniusSongDetail } }>(url);
  return data.response.song;
}

// ---------------------------------------------------------------------------
// センターアーティストを軸にネットワークを構築
// ---------------------------------------------------------------------------
async function buildNetworkForArtist(artistName: string) {
  const center = await searchArtist(artistName);
  if (!center) {
    const err = new Error(`アーティストが見つかりませんでした: ${artistName}`) as Error & { status?: number };
    err.status = 404;
    throw err;
  }

  const allSongs = await getAllArtistSongs(center.id);

  // タイトルに feat. 表記がある曲(=客演がいる可能性が高い曲)だけ詳細を取得し、
  // Genius側へのリクエスト数を抑える
  const candidateSongs = allSongs.filter((s) => s.title_with_featured !== s.title);

  const knownArtists = new Map<string, GeniusArtistRef>();
  knownArtists.set(String(center.id), center);

  const collabMap = new Map<string, { title: string; year: number }[]>();

  for (const summary of candidateSongs) {
    const detail = await getSongDetail(summary.id);
    await sleep(REQUEST_INTERVAL_MS);

    if (!detail.featured_artists || detail.featured_artists.length === 0) continue;

    const year = detail.release_date_components?.year ?? 0;
    // センター本人 + 曲に載っている客演者、全員の組み合わせにエッジを張る
    const onTrack: GeniusArtistRef[] = [detail.primary_artist, ...detail.featured_artists];

    for (let i = 0; i < onTrack.length; i++) {
      for (let j = i + 1; j < onTrack.length; j++) {
        const a = onTrack[i];
        const b = onTrack[j];
        if (a.id === b.id) continue;
        const [x, y] = a.id < b.id ? [a, b] : [b, a];
        const key = `${x.id}__${y.id}`;
        const list = collabMap.get(key) ?? [];
        if (!list.some((c) => c.title === detail.title)) {
          list.push({ title: detail.title, year });
        }
        collabMap.set(key, list);

        for (const ref of [a, b]) {
          if (!knownArtists.has(String(ref.id))) {
            knownArtists.set(String(ref.id), ref);
          }
        }
      }
    }
  }

  const allIds = Array.from(knownArtists.keys());

  const nodes: NetworkNode[] = allIds.map((id) => {
    const info = knownArtists.get(id)!;
    const isCenter = Number(id) === center.id;
    return {
      id,
      name: info.name,
      group: info.is_verified ? "認証アーティスト" : "アーティスト",
      bio: info.url ? `Geniusページ: ${info.url}` : "",
      releases: isCenter ? candidateSongs.length : 0,
      isCenter,
    };
  });

  const links: NetworkLink[] = Array.from(collabMap.entries()).map(([key, collabs]) => {
    const [sourceId, targetId] = key.split("__");
    return { source: sourceId, target: targetId, collabs: collabs.sort((p, q) => p.year - q.year) };
  });

  return { nodes, links, centerId: String(center.id) };
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
  console.log(`Genius network API を起動しました: http://localhost:${PORT}/api/network?artist=名前`);
});
