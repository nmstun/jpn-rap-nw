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
 *      LOG_LEVEL=info        # 省略可。debug / info / warn / error
 * 4. npm install express cors
 *    npm install -D @types/express @types/cors tsx dotenv
 * 5. 実行: npx tsx server.ts
 * → http://localhost:3001/api/network?artist=名前 でネットワーク構築
 * → http://localhost:3001/api/search-artist?q=名前 で候補検索(軽量・高速)
 *
 * ── データの拾い方について ──────────────────────────────────
 * Genius公式APIには「アーティスト検索」専用のエンドポイントがないため、
 * /search で曲を検索し、その結果の primary_artist からアーティストIDを
 * 特定する。またフィーチャリングだけの曲を直接一覧取得するエンドポイントも
 * 無いため、「そのアーティスト本人名義の曲」を軸にして、そこに載っている
 * 客演者(featured_artists)を拾う構成にしている。
 * つまり「他人の曲にfeatureとしてだけ参加している回」は拾いきれない点に
 * 留意してください(v1のスコープとして許容)。
 *
 * オートコンプリート(/api/search-artist)はまず非公式のアーティスト直接
 * 検索(genius.com/api/search/artist)を試し、失敗時は上記の「曲経由」の
 * 方式に自動フォールバックする。
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";

const app = express();

const CORS_ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (CORS_ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  }),
);

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
const GENIUS_BASE = "https://api.genius.com";

// 処理する曲数の上限(客演の多い人気アーティストで待たされすぎないため)
const MAX_SONGS = 150;
// Genius側への配慮のため、曲詳細取得の間に入れる待機時間(ms)
const REQUEST_INTERVAL_MS = 120;

// =============================================================================
// ロギング
// 外部ロギングライブラリ(pino/winstonなど)を導入するほどの規模ではないため、
// タイムスタンプ・レベル・リクエストID付きの軽量ロガーを自前で用意する。
// 本格的な本番運用(複数インスタンス・ログ集約基盤への転送など)をする場合は
// pino + 外部ログ収集サービスへの置き換えを推奨。
// =============================================================================
type LogLevel = "debug" | "info" | "warn" | "error";
const LOG_LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LOG_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? "info";

function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[CURRENT_LOG_LEVEL]) return;
  const line = {
    time: new Date().toISOString(),
    level,
    message,
    ...(meta ?? {}),
  };
  const out = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  out(JSON.stringify(line));
}
const logDebug = (message: string, meta?: Record<string, unknown>) => log("debug", message, meta);
const logInfo = (message: string, meta?: Record<string, unknown>) => log("info", message, meta);
const logWarn = (message: string, meta?: Record<string, unknown>) => log("warn", message, meta);
const logError = (message: string, meta?: Record<string, unknown>) => log("error", message, meta);

// リクエストごとにIDを振り、複数ログ行を追跡できるようにする
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

app.use((req, res, next) => {
  req.requestId = randomUUID();
  const startedAt = Date.now();
  logInfo("request:start", { requestId: req.requestId, method: req.method, path: req.path, query: req.query });

  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    logInfo("request:end", {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs,
    });
  });
  next();
});

// =============================================================================
// 型
// =============================================================================
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
  url: string;
  primary_artist: GeniusArtistRef;
  featured_artists: GeniusArtistRef[];
  release_date_components?: { year?: number; month?: number; day?: number };
}

interface Collab {
  title: string;
  year: number;
  url: string;
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
  collabs: Collab[];
}

class ApiError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

// =============================================================================
// Genius API ヘルパー
// =============================================================================
function getToken(): string {
  const token = process.env.GENIUS_ACCESS_TOKEN;
  if (!token) {
    throw new ApiError("GENIUS_ACCESS_TOKEN が設定されていません(.env を確認してください)", 500);
  }
  return token;
}

async function geniusFetch<T>(url: string, requestId?: string, retryCount = 0): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${getToken()}` } });

  if ((res.status === 429 || res.status >= 500) && retryCount < 4) {
    const waitMs = 800 * (retryCount + 1);
    logWarn("genius:retry", { requestId, url, status: res.status, attempt: retryCount + 1, waitMs });
    await new Promise((r) => setTimeout(r, waitMs));
    return geniusFetch<T>(url, requestId, retryCount + 1);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logError("genius:error", { requestId, url, status: res.status, body: body.slice(0, 500) });
    throw new ApiError(`Genius APIエラー ${res.status}: ${url}`, res.status >= 500 ? 502 : res.status);
  }
  return (await res.json()) as T;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Genius公式APIには「アーティスト検索」専用のエンドポイントが無いため、
// /search(曲検索)のヒットから primary_artist を重複排除して取り出す共通処理。
// searchArtist()(単一候補を確定させたいとき)と searchArtistCandidates()の
// フォールバック(複数候補を並べたいとき)の両方から使う。
async function fetchPrimaryArtistsFromSongSearch(name: string, requestId?: string): Promise<GeniusArtistRef[]> {
  const url = `${GENIUS_BASE}/search?q=${encodeURIComponent(name)}`;
  const data = await geniusFetch<{ response: { hits: { result: GeniusSongSummary }[] } }>(url, requestId);

  const seen = new Set<number>();
  const artists: GeniusArtistRef[] = [];
  for (const hit of data.response.hits) {
    const a = hit.result.primary_artist;
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    artists.push(a);
  }
  return artists;
}

async function searchArtist(name: string, requestId?: string): Promise<GeniusArtistRef | null> {
  const candidates = await fetchPrimaryArtistsFromSongSearch(name, requestId);

  const exact = candidates.find((a) => a.name === name);
  if (exact) return exact;

  // 完全一致がなければ、名前に検索語が含まれる最初の候補を採用
  const partial = candidates.find((a) => a.name.toLowerCase().includes(name.toLowerCase()));
  return partial ?? candidates[0] ?? null;
}

// アーティスト名とクエリ自体の一致度で並べ替える。
// Genius の /search は「曲」を検索語との関連度でランキングしたものなので、
// そのまま並べると「アーティスト名としては一致度が低いが、たまたま人気曲が
// ヒットした」ケースが上位に来てしまう(例:「漢」で検索すると
// 「漢 a.k.a. GAMI」のような連名クレジットが混ざって上位に出ることがある)。
function sortByNameMatch(artists: GeniusArtistRef[], query: string): GeniusArtistRef[] {
  const q = query.trim().toLowerCase();
  function matchTier(artistName: string): number {
    const n = artistName.toLowerCase();
    if (n === q) return 0; // 完全一致
    if (n.startsWith(q)) return 1; // 前方一致
    if (n.includes(q)) return 2; // 部分一致
    return 3; // クエリを含まない(曲名側でのみヒットしたなど)
  }
  return artists
    .map((a, i) => ({ a, tier: matchTier(a.name), i }))
    .sort((x, y) => (x.tier !== y.tier ? x.tier - y.tier : x.i - y.i))
    .map((x) => x.a);
}

// ---------------------------------------------------------------------------
// アーティスト名そのものの曖昧検索(実験的)
// Genius公式API(api.genius.com)には「アーティスト検索」が無いため、
// Genius自身のサイト内検索が使っている非公式のエンドポイントを試す。
// これは未文書化・非公式のため、レスポンス形式が変わったり塞がれたりする
// 可能性がある。失敗した場合は songベースの方式に自動でフォールバックする。
// ---------------------------------------------------------------------------
async function searchArtistCandidatesDirect(name: string, requestId?: string): Promise<GeniusArtistRef[] | null> {
  try {
    const url = `https://genius.com/api/search/artist?q=${encodeURIComponent(name)}`;
    const res = await fetch(url, {
      headers: {
        // 非公式エンドポイントのため、ブラウザからのアクセスに近づけておく
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      logWarn("genius:direct-artist-search:non-ok", { requestId, status: res.status });
      return null;
    }
    const data = await res.json();

    // レスポンス形式が複数パターンありうるため、両対応で拾う
    const rawHits: any[] = data?.response?.hits ?? data?.response?.sections?.flatMap((s: any) => s.hits ?? []) ?? [];

    const seen = new Set<number>();
    const candidates: GeniusArtistRef[] = [];
    for (const hit of rawHits) {
      const r = hit?.result ?? hit;
      const id = r?.id;
      const nm = r?.name;
      if (!id || !nm || seen.has(id)) continue;
      seen.add(id);
      candidates.push({ id, name: nm, is_verified: r?.is_verified, url: r?.url });
    }
    if (candidates.length === 0) {
      logWarn("genius:direct-artist-search:empty", { requestId, query: name });
      return null;
    }
    logDebug("genius:direct-artist-search:ok", { requestId, query: name, count: candidates.length });
    return candidates;
  } catch (err) {
    logWarn("genius:direct-artist-search:exception", { requestId, error: (err as Error).message });
    return null;
  }
}

// オートコンプリート用:候補となるアーティストを重複排除して複数返す(軽量・高速)
async function searchArtistCandidates(name: string, requestId?: string): Promise<GeniusArtistRef[]> {
  // まず非公式のアーティスト直接検索を試す(名前そのものへの曖昧検索として精度が高い)
  const direct = await searchArtistCandidatesDirect(name, requestId);
  if (direct) return direct.slice(0, 8);

  // 失敗した場合は、これまで通り「曲の検索結果からprimary_artistを拾う」方式にフォールバック
  logInfo("genius:search-artist:fallback-to-song-search", { requestId, query: name });
  const artists = await fetchPrimaryArtistsFromSongSearch(name, requestId);
  return sortByNameMatch(artists, name).slice(0, 8);
}

async function getAllArtistSongs(artistId: number, requestId?: string): Promise<GeniusSongSummary[]> {
  const songs: GeniusSongSummary[] = [];
  let page: number | null = 1;

  while (page && songs.length < MAX_SONGS) {
    const url = `${GENIUS_BASE}/artists/${artistId}/songs?per_page=50&page=${page}&sort=popularity`;
    const data: { response: { songs: GeniusSongSummary[]; next_page: number | null } } = await geniusFetch(
      url,
      requestId
    );
    songs.push(...data.response.songs);
    page = data.response.next_page;
    await sleep(REQUEST_INTERVAL_MS);
  }
  return songs.slice(0, MAX_SONGS);
}

async function getSongDetail(songId: number, requestId?: string): Promise<GeniusSongDetail> {
  const url = `${GENIUS_BASE}/songs/${songId}?text_format=plain`;
  const data = await geniusFetch<{ response: { song: GeniusSongDetail } }>(url, requestId);
  return data.response.song;
}

// ---------------------------------------------------------------------------
// センターアーティストを軸にネットワークを構築
// (center はすでに解決済みのアーティスト。呼び出し側で名前検索/ID指定を行う)
// ---------------------------------------------------------------------------

// 曲に載っている2アーティスト間のコラボを記録するヘルパー。
// collabMap への追加と knownArtists への登録をまとめて行い、
// buildNetworkForCenter 本体のネストを浅く保つ。
function addCollabEdge(
  collabMap: Map<string, Collab[]>,
  knownArtists: Map<string, GeniusArtistRef>,
  a: GeniusArtistRef,
  b: GeniusArtistRef,
  song: { title: string; year: number; url: string }
) {
  if (a.id === b.id) return;
  const [x, y] = a.id < b.id ? [a, b] : [b, a];
  const key = `${x.id}__${y.id}`;

  const list = collabMap.get(key) ?? [];
  if (!list.some((c) => c.title === song.title)) {
    list.push({ title: song.title, year: song.year, url: song.url });
  }
  collabMap.set(key, list);

  for (const ref of [a, b]) {
    if (!knownArtists.has(String(ref.id))) {
      knownArtists.set(String(ref.id), ref);
    }
  }
}

async function buildNetworkForCenter(center: GeniusArtistRef, requestId?: string) {
  const startedAt = Date.now();
  const allSongs = await getAllArtistSongs(center.id, requestId);

  // タイトルに feat. 表記がある曲(=客演がいる可能性が高い曲)だけ詳細を取得し、
  // Genius側へのリクエスト数を抑える
  const candidateSongs = allSongs.filter((s) => s.title_with_featured !== s.title);
  logInfo("network:songs-collected", {
    requestId,
    centerId: center.id,
    centerName: center.name,
    totalSongs: allSongs.length,
    candidateSongs: candidateSongs.length,
  });

  const knownArtists = new Map<string, GeniusArtistRef>();
  knownArtists.set(String(center.id), center);

  const collabMap = new Map<string, Collab[]>();
  let songsWithFeatures = 0;

  for (const summary of candidateSongs) {
    const detail = await getSongDetail(summary.id, requestId);
    await sleep(REQUEST_INTERVAL_MS);

    if (!detail.featured_artists || detail.featured_artists.length === 0) continue;
    songsWithFeatures += 1;

    const year = detail.release_date_components?.year ?? 0;
    const song = { title: detail.title, year, url: detail.url };
    // センター本人 + 曲に載っている客演者、全員の組み合わせにエッジを張る
    const onTrack: GeniusArtistRef[] = [detail.primary_artist, ...detail.featured_artists];

    for (let i = 0; i < onTrack.length; i++) {
      for (let j = i + 1; j < onTrack.length; j++) {
        addCollabEdge(collabMap, knownArtists, onTrack[i], onTrack[j], song);
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

  logInfo("network:build-complete", {
    requestId,
    centerId: center.id,
    centerName: center.name,
    songsWithFeatures,
    nodeCount: nodes.length,
    linkCount: links.length,
    durationMs: Date.now() - startedAt,
  });

  return { nodes, links, centerId: String(center.id) };
}

// =============================================================================
// エンドポイント
// =============================================================================
function sendError(res: express.Response, err: unknown, requestId: string) {
  const e = err instanceof ApiError ? err : new ApiError(err instanceof Error ? err.message : String(err), 500);
  logError("handler:error", { requestId, status: e.status, message: e.message });
  res.status(e.status).json({ error: e.message, requestId });
}

app.get("/api/search-artist", async (req, res) => {
  const requestId = req.requestId;
  const q = String(req.query.q ?? "").trim();
  if (!q) {
    res.json({ candidates: [] });
    return;
  }
  try {
    const candidates = await searchArtistCandidates(q, requestId);
    res.json({
      candidates: candidates.map((a) => ({ id: a.id, name: a.name, isVerified: a.is_verified ?? false })),
    });
  } catch (err) {
    sendError(res, err, requestId);
  }
});

app.get("/api/network", async (req, res) => {
  const requestId = req.requestId;
  const artistId = req.query.artistId ? Number(req.query.artistId) : null;
  const artistName = String(req.query.artist ?? "").trim();

  if (!artistId && !artistName) {
    sendError(res, new ApiError("artist または artistId パラメータが必要です", 400), requestId);
    return;
  }

  try {
    let center: GeniusArtistRef | null;
    if (artistId) {
      // ランキング/候補リストから選択済み: 再検索なしでそのまま使う
      center = { id: artistId, name: artistName || String(artistId) };
      logDebug("network:center-resolved-by-id", { requestId, artistId, artistName });
    } else {
      center = await searchArtist(artistName, requestId);
      logDebug("network:center-resolved-by-name", { requestId, artistName, resolved: center?.name ?? null });
    }
    if (!center) {
      throw new ApiError(`アーティストが見つかりませんでした: ${artistName}`, 404);
    }
    const result = await buildNetworkForCenter(center, requestId);
    res.json(result);
  } catch (err) {
    sendError(res, err, requestId);
  }
});

// =============================================================================
// プロセスレベルのエラーハンドリング
// 未捕捉の例外・rejectionでサーバーが無言で落ちる/ハングするのを防ぐ。
// =============================================================================
process.on("unhandledRejection", (reason) => {
  logError("process:unhandledRejection", { reason: reason instanceof Error ? reason.message : String(reason) });
});
process.on("uncaughtException", (err) => {
  logError("process:uncaughtException", { message: err.message, stack: err.stack });
  // 復旧不能な状態の可能性があるため、ログを出した上で明示的に終了する
  process.exit(1);
});

app.listen(PORT, () => {
  const tokenPresent = Boolean(process.env.GENIUS_ACCESS_TOKEN);
  logInfo("server:started", { port: PORT, logLevel: CURRENT_LOG_LEVEL, geniusTokenConfigured: tokenPresent });
  if (!tokenPresent) {
    logWarn("server:missing-token", { hint: ".env に GENIUS_ACCESS_TOKEN を設定してください" });
  }
});
