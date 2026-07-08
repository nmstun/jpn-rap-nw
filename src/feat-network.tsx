import React, { useEffect, useRef, useState, useMemo } from "react";
import * as d3 from "d3";

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------
interface Collab {
  title: string;
  year: number;
  url: string;
}

interface ArtistNode {
  id: string;
  name: string;
  group: string;
  bio: string;
  releases: number;
  isCenter: boolean;
}

interface FeatLink {
  source: string;
  target: string;
  collabs: Collab[];
}

interface NetworkResponse {
  nodes: ArtistNode[];
  links: FeatLink[];
  centerId: string;
}

interface SimNode extends ArtistNode, d3.SimulationNodeDatum {}

interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  source: SimNode | string;
  target: SimNode | string;
  collabs: Collab[];
}

interface SearchCandidate {
  id: number;
  name: string;
  isVerified: boolean;
}

// ローカルAPIサーバー(server.ts)のエンドポイント
const API_BASE = "http://localhost:3001";

const PALETTE = ["#FF3D6E", "#2DE0C6", "#E8B84B", "#B98CFF", "#5CC8FF", "#7BE07A", "#FF9F5C", "#6FA8FF"];
const CENTER_COLOR = "#FFD24C";

function endpointName(end: SimNode | string, nodes: ArtistNode[]): string {
  if (typeof end === "string") return nodes.find((n) => n.id === end)?.name ?? end;
  return end.name;
}
function endpointId(end: SimNode | string): string {
  return typeof end === "string" ? end : end.id;
}

function openSongUrl(url: string) {
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

// ホバーパネル・ドリルダウンの両方で使う楽曲リスト。
// クリックでGeniusの該当ページを新しいタブで開く。
function SongList({ collabs }: { collabs: Collab[] }) {
  return (
    <>
      {collabs.map((c, i) => (
        <div
          key={i}
          onClick={() => openSongUrl(c.url)}
          title={c.url ? "Geniusのページを開く" : undefined}
          style={{
            fontSize: 12.5,
            color: "#D8D0E0",
            padding: "6px 0",
            borderBottom: i < collabs.length - 1 ? "1px solid #241D2B" : "none",
            cursor: c.url ? "pointer" : "default",
          }}
          onMouseEnter={(e) => {
            if (c.url) e.currentTarget.style.color = CENTER_COLOR;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "#D8D0E0";
          }}
        >
          {c.title} <span style={{ color: "#6E6478" }}>({c.year || "年不明"})</span>
        </div>
      ))}
    </>
  );
}

type Status = "idle" | "loading" | "ready" | "error";

export default function FeatNetwork(): JSX.Element {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number }>({ w: 900, h: 600 });
  const [selected, setSelected] = useState<ArtistNode | null>(null);
  const [hoveredLink, setHoveredLink] = useState<SimLink | null>(null);

  const [query, setQuery] = useState("");
  const [data, setData] = useState<NetworkResponse | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  // 現在(再)検索中のアーティスト名。ローディング表示に使う
  const [searchingName, setSearchingName] = useState("");
  // フィーチャリング相手リストで「曲一覧」をドリルダウン表示中のノードID
  const [expandedCollabId, setExpandedCollabId] = useState<string | null>(null);

  // あいまい検索の候補一覧(オートコンプリート)
  const [candidates, setCandidates] = useState<SearchCandidate[]>([]);
  const [showCandidates, setShowCandidates] = useState(false);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 日本語入力(IME)の変換中かどうか。変換確定のEnterと検索実行のEnterを区別するために使う
  const [isComposing, setIsComposing] = useState(false);

  // シミュレーション本体とD3選択をrefで保持し、ハイライトの更新では
  // グラフを作り直さない(=位置が弾け直さない)ようにする
  const simulationRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null);
  const nodeSelRef = useRef<d3.Selection<SVGGElement, SimNode, SVGGElement, unknown> | null>(null);
  const linkSelRef = useRef<d3.Selection<SVGLineElement, SimLink, SVGGElement, unknown> | null>(null);
  const linksDataRef = useRef<SimLink[]>([]);

  // runSearch(名前で検索) と runSearchById(候補選択で検索) は、状態リセットと
  // フェッチ結果のハンドリングがほぼ同一なので共通化する。違うのはURLだけ。
  async function performSearch(url: string, displayName: string) {
    setStatus("loading");
    setErrorMsg("");
    setSelected(null);
    setHoveredLink(null);
    setExpandedCollabId(null);
    setSearchingName(displayName);
    setData(null); // 検索開始と同時に前回のグラフを消す
    setShowCandidates(false);
    try {
      const res = await fetch(url);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `取得に失敗しました (${res.status})`);
      setData(json as NetworkResponse);
      setStatus("ready");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[feat-network] search failed:", message);
      setErrorMsg(message);
      setStatus("error");
    }
  }

  async function runSearch(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    await performSearch(`${API_BASE}/api/network?artist=${encodeURIComponent(trimmed)}`, trimmed);
  }

  // 候補から選択したとき: IDが分かっているのであいまい検索をスキップして直接構築する
  // (Genius側へのリクエストが1回減り、狙ったアーティストと確実に一致する)
  async function runSearchById(id: number, name: string) {
    await performSearch(`${API_BASE}/api/network?artistId=${id}&artist=${encodeURIComponent(name)}`, name);
  }

  // 入力のたびに軽量な候補検索を投げる(300msデバウンス)。
  // フルのネットワーク構築より圧倒的に軽いので、タイプ中に何度呼んでも問題ない
  function handleQueryChange(value: string) {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmed = value.trim();
    if (!trimmed) {
      setCandidates([]);
      setShowCandidates(false);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setCandidatesLoading(true);
      try {
        const res = await fetch(`${API_BASE}/api/search-artist?q=${encodeURIComponent(trimmed)}`);
        const json = await res.json();
        setCandidates(json.candidates ?? []);
        setShowCandidates(true);
      } catch (err) {
        console.error("[feat-network] candidate search failed:", err);
        setCandidates([]);
      } finally {
        setCandidatesLoading(false);
      }
    }, 300);
  }

  function clearQuery() {
    setQuery("");
    setCandidates([]);
    setShowCandidates(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }

  // フィーチャリング相手の名前をクリックしたときに、そのアーティストを
  // 新しい検索対象として再検索する
  function searchFromCollaborator(name: string) {
    setQuery(name);
    runSearch(name);
  }

  const groupColors = useMemo<Record<string, string>>(() => {
    if (!data) return {};
    const groups = Array.from(new Set(data.nodes.filter((n) => !n.isCenter).map((n) => n.group)));
    return Object.fromEntries(groups.map((g, i) => [g, PALETTE[i % PALETTE.length]]));
  }, [data]);

  const degree = useMemo<Record<string, number>>(() => {
    if (!data) return {};
    const d: Record<string, number> = Object.fromEntries(data.nodes.map((n) => [n.id, 0]));
    data.links.forEach((l) => {
      d[l.source] = (d[l.source] ?? 0) + 1;
      d[l.target] = (d[l.target] ?? 0) + 1;
    });
    return d;
  }, [data]);

  // 検索対象(センター)と直接コラボしているアーティストを、
  // 一緒にやった曲数の多い順にランキングする
  const ranking = useMemo<{ artist: ArtistNode; count: number }[]>(() => {
    if (!data) return [];
    const rows: { artist: ArtistNode; count: number }[] = [];
    for (const l of data.links) {
      if (l.source !== data.centerId && l.target !== data.centerId) continue;
      const otherId = l.source === data.centerId ? l.target : l.source;
      const other = data.nodes.find((n) => n.id === otherId);
      if (!other) continue;
      rows.push({ artist: other, count: l.collabs.length });
    }
    return rows.sort((a, b) => b.count - a.count);
  }, [data]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const applySize = () => {
      const rect = el.getBoundingClientRect();
      setDims({ w: Math.max(320, rect.width), h: Math.max(360, rect.height) });
    };
    applySize();
    // window の resize イベントだけでなく、レイアウト由来のサイズ変化も
    // 確実に拾うために ResizeObserver を使う(サイドバーの中身が伸びても
    // グラフ側のcontainerサイズ自体は変わらないはずだが、念のため)
    const observer = new ResizeObserver(applySize);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // ---------------------------------------------------------------------------
  // グラフ本体の構築:data / dims が変わったときだけ実行する
  // (selected / hoveredLink はここに含めない = ハイライトではグラフを作り直さない)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select<SVGSVGElement, unknown>(svgRef.current);

    if (!data || data.nodes.length === 0) {
      svg.selectAll("*").remove();
      simulationRef.current?.stop();
      simulationRef.current = null;
      nodeSelRef.current = null;
      linkSelRef.current = null;
      return;
    }
    const { w, h } = dims;

    svg.selectAll("*").remove();

    const root = svg.attr("viewBox", `0 0 ${w} ${h}`).style("touch-action", "none");
    const zoomLayer = root.append("g").attr("class", "zoom-layer");

    root.call(
      d3
        .zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.25, 3])
        .on("zoom", (event) => zoomLayer.attr("transform", event.transform.toString()))
    );

    const nodes: SimNode[] = data.nodes.map((n) => ({ ...n }));
    const links: SimLink[] = data.links.map((l) => ({ ...l }));
    linksDataRef.current = links;

    // ノードの色(センターかどうかで出し分け)。d3のattrコールバックから何度も参照する
    const nodeStrokeColor = (d: SimNode) => (d.isCenter ? CENTER_COLOR : groupColors[d.group] ?? "#888");

    // 初期位置を中心アーティストを軸にした円状に配置しておく。
    // ランダムな初期位置のまま force を回すと、最初の数秒間ノード同士が
    // 重なりを解消しようと激しく弾け合って「揺れて気持ち悪い」原因になる。
    const centerNode = nodes.find((n) => n.id === data.centerId);
    const others = nodes.filter((n) => n.id !== data.centerId);
    const ringRadius = Math.min(w, h) * 0.32;
    others.forEach((n, i) => {
      const angle = (i / Math.max(1, others.length)) * Math.PI * 2;
      n.x = w / 2 + ringRadius * Math.cos(angle);
      n.y = h / 2 + ringRadius * Math.sin(angle);
    });
    if (centerNode) {
      centerNode.x = w / 2;
      centerNode.y = h / 2;
      // センターノードは常に画面中央に固定して視覚的な軸にする
      centerNode.fx = w / 2;
      centerNode.fy = h / 2;
    }

    const maxCollabs = d3.max(links, (l) => l.collabs.length) ?? 1;
    const linkWidth = d3.scaleLinear().domain([1, maxCollabs]).range([1.5, 6]);
    const maxDegree = d3.max(Object.values(degree)) ?? 1;
    const nodeRadius = d3.scaleLinear().domain([1, maxDegree]).range([20, 38]);
    const radiusFor = (d: SimNode) => (d.isCenter ? nodeRadius(degree[d.id] ?? 1) + 14 : nodeRadius(degree[d.id] ?? 1));

    const simulation = d3
      .forceSimulation<SimNode>(nodes)
      .velocityDecay(0.55) // 減衰を強めにして振動を抑える(既定値0.4だと揺れやすい)
      .alphaDecay(0.04) // 収束を速くして早めに静止させる(既定値0.0228)
      .force(
        "link",
        d3
          .forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance((l) => 130 - Math.min(l.collabs.length, 5) * 8)
          .strength(0.6)
      )
      .force("charge", d3.forceManyBody().strength((d) => (d.isCenter ? -500 : -260)).distanceMax(420))
      .force("center", d3.forceCenter(w / 2, h / 2).strength(0.05))
      .force(
        "collision",
        d3.forceCollide<SimNode>().radius((d) => radiusFor(d) + 16).strength(0.9)
      );

    simulationRef.current = simulation;

    const defs = root.append("defs");
    const glow = defs
      .append("filter")
      .attr("id", "glow")
      .attr("x", "-60%")
      .attr("y", "-60%")
      .attr("width", "220%")
      .attr("height", "220%");
    glow.append("feGaussianBlur").attr("stdDeviation", "5").attr("result", "coloredBlur");
    const merge = glow.append("feMerge");
    merge.append("feMergeNode").attr("in", "coloredBlur");
    merge.append("feMergeNode").attr("in", "SourceGraphic");

    const linkGroup = zoomLayer.append("g").attr("class", "links");
    const nodeGroup = zoomLayer.append("g").attr("class", "nodes");

    const linkSel = linkGroup
      .selectAll<SVGLineElement, SimLink>("line")
      .data(links)
      .join("line")
      .attr("stroke", "#3A3244")
      .attr("stroke-width", (d) => linkWidth(d.collabs.length))
      .attr("stroke-linecap", "round")
      .style("cursor", "pointer")
      .on("mouseenter", (_e, d) => setHoveredLink(d))
      .on("mouseleave", () => setHoveredLink(null));
    linkSelRef.current = linkSel;

    const nodeSel = nodeGroup
      .selectAll<SVGGElement, SimNode>("g.node")
      .data(nodes)
      .join("g")
      .attr("class", "node")
      .attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`)
      .style("cursor", "grab")
      .call(
        d3
          .drag<SVGGElement, SimNode>()
          .on("start", (event, d) => {
            if (!event.active) simulation.alphaTarget(0.15).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on("drag", (event, d) => {
            d.fx = event.x;
            d.fy = event.y;
          })
          .on("end", (event, d) => {
            if (!event.active) simulation.alphaTarget(0);
            // センターだけは離した後も中央に戻す。それ以外は自由に置ける
            if (d.isCenter) {
              d.fx = w / 2;
              d.fy = h / 2;
            } else {
              d.fx = null;
              d.fy = null;
            }
          })
      )
      .on("click", (_e, d) => {
        setSelected((prev) => (prev && prev.id === d.id ? null : d));
        setExpandedCollabId(null);
      });
    nodeSelRef.current = nodeSel;

    nodeSel
      .append("circle")
      .attr("class", "ring")
      .attr("r", (d) => radiusFor(d) + 6)
      .attr("fill", "none")
      .attr("stroke", nodeStrokeColor)
      .attr("stroke-width", (d) => (d.isCenter ? 1.5 : 1))
      .attr("opacity", (d) => (d.isCenter ? 0.55 : 0.35));

    nodeSel
      .append("circle")
      .attr("class", "core")
      .attr("r", (d) => radiusFor(d))
      .attr("fill", "#1C1620")
      .attr("stroke", nodeStrokeColor)
      .attr("stroke-width", (d) => (d.isCenter ? 3.5 : 2.5))
      .attr("filter", "url(#glow)");

    nodeSel
      .append("circle")
      .attr("r", (d) => (d.isCenter ? 4.5 : 3))
      .attr("fill", nodeStrokeColor);

    nodeSel
      .append("text")
      .attr("text-anchor", "middle")
      .attr("dy", (d) => radiusFor(d) + 20)
      .attr("fill", "#F4EFE6")
      .attr("font-size", (d) => (d.isCenter ? 14.5 : 13))
      .attr("font-weight", (d) => (d.isCenter ? 800 : 700))
      .style("letter-spacing", "0.02em")
      .text((d) => d.name);

    nodeSel
      .append("text")
      .attr("text-anchor", "middle")
      .attr("dy", (d) => radiusFor(d) + 36)
      .attr("fill", "#9C8FA6")
      .attr("font-size", 10.5)
      .text((d) => (d.isCenter ? "検索対象" : d.group));

    simulation.on("tick", () => {
      linkSel
        .attr("x1", (d) => (d.source as SimNode).x ?? 0)
        .attr("y1", (d) => (d.source as SimNode).y ?? 0)
        .attr("x2", (d) => (d.target as SimNode).x ?? 0)
        .attr("y2", (d) => (d.target as SimNode).y ?? 0);
      nodeSel.attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
    });

    return () => {
      simulation.stop();
      simulationRef.current = null;
      nodeSelRef.current = null;
      linkSelRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, dims]);

  // ---------------------------------------------------------------------------
  // ハイライトの更新だけを行う:selected / hoveredLink が変わったときのみ実行。
  // 既存のノード・線の見た目(色・透明度)だけを書き換え、位置やシミュレーションには触れない。
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const nodeSel = nodeSelRef.current;
    const linkSel = linkSelRef.current;
    if (!nodeSel || !linkSel) return;

    const activeId = selected?.id ?? null;
    const links = linksDataRef.current;

    nodeSel.attr("opacity", (d) => {
      if (!activeId) return 1;
      if (d.id === activeId) return 1;
      const connected = links.some(
        (l) =>
          (endpointId(l.source) === activeId && endpointId(l.target) === d.id) ||
          (endpointId(l.target) === activeId && endpointId(l.source) === d.id)
      );
      return connected ? 1 : 0.2;
    });

    linkSel
      .attr("stroke", (d) => {
        if (hoveredLink === d) return "#E8B84B";
        if (activeId && (endpointId(d.source) === activeId || endpointId(d.target) === activeId)) {
          return "#E8B84B";
        }
        return "#3A3244";
      })
      .attr("opacity", (d) => {
        if (!activeId) return hoveredLink === d ? 1 : 0.5;
        return endpointId(d.source) === activeId || endpointId(d.target) === activeId ? 1 : 0.08;
      });
  }, [selected, hoveredLink]);

  return (
    <div
      style={{
        width: "100%",
        height: "100vh",
        maxHeight: "100vh",
        background: "#120E14",
        color: "#F4EFE6",
        fontFamily: "'Zen Kaku Gothic New','Hiragino Kaku Gothic ProN','Noto Sans JP',sans-serif",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid #241D2B" }}>
        <div style={{ fontSize: 11, letterSpacing: "0.18em", color: "#9C8FA6", fontWeight: 700, marginBottom: 4 }}>
          FEATURING NETWORK — Genius連携
        </div>
        <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: "0.01em", marginBottom: 14 }}>
          日本語ラップ フィーチャリング相関図
        </div>

        <div style={{ display: "flex", gap: 8, maxWidth: 480, position: "relative" }}>
          <div style={{ position: "relative", flex: 1 }}>
            <input
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
              onFocus={() => {
                if (candidates.length > 0) setShowCandidates(true);
              }}
              onBlur={() => {
                setTimeout(() => setShowCandidates(false), 150);
              }}
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={() => setIsComposing(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  // IME変換確定のEnterでは検索を開始しない
                  if (isComposing || e.nativeEvent.isComposing || e.keyCode === 229) return;
                  runSearch(query);
                }
                if (e.key === "Escape") setShowCandidates(false);
              }}
              placeholder="アーティスト名で検索(例: 般若)"
              style={{
                width: "100%",
                padding: "10px 34px 10px 14px",
                borderRadius: 8,
                border: "1px solid #3A3244",
                background: "#1C1620",
                color: "#F4EFE6",
                fontSize: 14,
                outline: "none",
                boxSizing: "border-box",
              }}
            />
            {query.length > 0 && (
              <button
                type="button"
                onMouseDown={(e) => {
                  // input の blur より先に処理する
                  e.preventDefault();
                  clearQuery();
                }}
                aria-label="検索文字をクリア"
                style={{
                  position: "absolute",
                  right: 8,
                  top: "50%",
                  transform: "translateY(-50%)",
                  width: 22,
                  height: 22,
                  borderRadius: "50%",
                  border: "none",
                  background: "#3A3244",
                  color: "#F4EFE6",
                  fontSize: 13,
                  lineHeight: 1,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 0,
                }}
              >
                ×
              </button>
            )}
          </div>
          <button
            onClick={() => runSearch(query)}
            disabled={status === "loading"}
            style={{
              padding: "10px 20px",
              borderRadius: 8,
              border: "none",
              background: status === "loading" ? "#3A3244" : CENTER_COLOR,
              color: status === "loading" ? "#9C8FA6" : "#1C1620",
              fontWeight: 700,
              fontSize: 14,
              cursor: status === "loading" ? "default" : "pointer",
            }}
          >
            {status === "loading" ? "検索中…" : "検索"}
          </button>

          {showCandidates && (
            <div
              style={{
                position: "absolute",
                top: "calc(100% + 6px)",
                left: 0,
                width: 300,
                background: "#1C1620",
                border: "1px solid #3A3244",
                borderRadius: 8,
                boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                zIndex: 20,
                overflow: "hidden",
              }}
            >
              {candidatesLoading && (
                <div style={{ padding: "10px 14px", fontSize: 12.5, color: "#6E6478" }}>候補を検索中…</div>
              )}
              {!candidatesLoading && candidates.length === 0 && (
                <div style={{ padding: "10px 14px", fontSize: 12.5, color: "#6E6478" }}>
                  候補が見つかりませんでした
                </div>
              )}
              {!candidatesLoading &&
                candidates.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onMouseDown={(e) => {
                      // input が blur するより先に処理する(クリックの取りこぼし防止)
                      e.preventDefault();
                      setQuery(c.name);
                      runSearchById(c.id, c.name);
                    }}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "10px 14px",
                      background: "none",
                      border: "none",
                      borderBottom: "1px solid #241D2B",
                      color: "#F4EFE6",
                      fontSize: 13,
                      cursor: "pointer",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "#241D2B")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
                  >
                    {c.name}
                    {c.isVerified && <span style={{ color: CENTER_COLOR, marginLeft: 6, fontSize: 11 }}>✓認証済み</span>}
                  </button>
                ))}
            </div>
          )}
        </div>
      </div>

      <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>
        {status === "ready" && data && (
          <div
            style={{
              width: 230,
              flexShrink: 0,
              borderRight: "1px solid #241D2B",
              padding: "20px 16px",
              overflowY: "auto",
            }}
          >
            <div style={{ fontSize: 10, letterSpacing: "0.12em", color: "#9C8FA6", fontWeight: 700, marginBottom: 12 }}>
              客演数ランキング
            </div>
            {ranking.length === 0 && (
              <div style={{ color: "#6E6478", fontSize: 12.5, lineHeight: 1.7 }}>
                このアーティストの客演データが見つかりませんでした。
              </div>
            )}
            {ranking.map((row, i) => {
              const isActive = selected?.id === row.artist.id;
              return (
                <button
                  key={row.artist.id}
                  onClick={() => {
                    setSelected(row.artist);
                    setExpandedCollabId(null);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    width: "100%",
                    padding: "8px 8px",
                    marginBottom: 4,
                    borderRadius: 6,
                    border: "none",
                    background: isActive ? "#241D2B" : "none",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color: i < 3 ? CENTER_COLOR : "#6E6478",
                      width: 18,
                      flexShrink: 0,
                    }}
                  >
                    {i + 1}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 12.5,
                      fontWeight: 700,
                      color: "#F4EFE6",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {row.artist.name}
                  </span>
                  <span style={{ fontSize: 11, color: "#9C8FA6", flexShrink: 0 }}>{row.count}曲</span>
                </button>
              );
            })}
          </div>
        )}

        <div ref={containerRef} style={{ flex: 1, minWidth: 0, position: "relative" }}>
          {status === "idle" && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#6E6478", fontSize: 13, textAlign: "center", padding: 24 }}>
              アーティスト名を入力して検索すると、そのアーティストを中心にネットワークを表示します
            </div>
          )}
          {status === "loading" && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#6E6478", fontSize: 13, textAlign: "center", padding: 24 }}>
              『{searchingName}』を検索中…(Geniusからデータを取得中。客演の多いアーティストは少し時間がかかります)
            </div>
          )}
          {status === "error" && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
              <div style={{ maxWidth: 380, fontSize: 13, color: "#FF3D6E", lineHeight: 1.7, textAlign: "center" }}>
                {errorMsg}
                <br />
                <span style={{ color: "#6E6478" }}>server.ts(npx tsx server.ts)が起動しているか確認してください。</span>
              </div>
            </div>
          )}
          <svg ref={svgRef} style={{ width: "100%", height: "100%", display: "block" }} />
          {status === "ready" && (
            <div
              style={{
                position: "absolute",
                bottom: 14,
                left: 14,
                fontSize: 11,
                color: "#6E6478",
                display: "flex",
                gap: 14,
                flexWrap: "wrap",
                maxWidth: "60%",
              }}
            >
              {Object.entries(groupColors).map(([g, c]) => (
                <span key={g} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 999, background: c, display: "inline-block" }} />
                  {g}
                </span>
              ))}
            </div>
          )}
        </div>

        <div style={{ width: 280, flexShrink: 0, borderLeft: "1px solid #241D2B", padding: 20, overflowY: "auto" }}>
          {status === "ready" && !selected && !hoveredLink && (
            <div style={{ color: "#6E6478", fontSize: 13, lineHeight: 1.7 }}>
              金色のノードが検索対象です。ノードをクリックすると詳細とフィーチャリング相手を表示します。相手の名前をクリックするとそのアーティストで再検索、「▸ N曲」で楽曲一覧を展開、曲名をクリックするとGeniusのページが新しいタブで開きます。
            </div>
          )}

          {data && hoveredLink && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 10, letterSpacing: "0.12em", color: "#9C8FA6", marginBottom: 6 }}>
                COLLABORATION
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>
                {endpointName(hoveredLink.source, data.nodes)} × {endpointName(hoveredLink.target, data.nodes)}
              </div>
              <SongList collabs={hoveredLink.collabs} />
            </div>
          )}

          {data && selected && (
            <div>
              <div
                style={{
                  fontSize: 10,
                  letterSpacing: "0.12em",
                  color: selected.isCenter ? CENTER_COLOR : groupColors[selected.group] ?? "#9C8FA6",
                  fontWeight: 700,
                  marginBottom: 6,
                }}
              >
                {selected.isCenter ? "検索対象" : selected.group}
              </div>
              <div style={{ fontSize: 19, fontWeight: 800, marginBottom: 10 }}>{selected.name}</div>
              <div style={{ fontSize: 12.5, lineHeight: 1.8, color: "#D8D0E0", marginBottom: 12 }}>{selected.bio}</div>
              {!selected.isCenter && (
                <button
                  onClick={() => searchFromCollaborator(selected.name)}
                  style={{
                    display: "block",
                    width: "100%",
                    marginBottom: 16,
                    padding: "8px 12px",
                    borderRadius: 6,
                    border: `1px solid ${CENTER_COLOR}`,
                    background: "none",
                    color: CENTER_COLOR,
                    fontSize: 12.5,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  🔍 {selected.name} を検索
                </button>
              )}
              <div style={{ fontSize: 10, letterSpacing: "0.12em", color: "#9C8FA6", marginBottom: 8 }}>
                フィーチャリング相手
              </div>
              {data.links
                .filter((l) => l.source === selected.id || l.target === selected.id)
                .map((l, i) => {
                  const otherId = l.source === selected.id ? l.target : l.source;
                  const other = data.nodes.find((n) => n.id === otherId);
                  if (!other) return null;
                  const isExpanded = expandedCollabId === other.id;
                  return (
                    <div key={i} style={{ padding: "10px 0", borderBottom: "1px solid #241D2B", fontSize: 12.5 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                        <button
                          onClick={() => searchFromCollaborator(other.name)}
                          title={`${other.name}を新しい検索対象にする`}
                          style={{
                            background: "none",
                            border: "none",
                            padding: 0,
                            fontWeight: 700,
                            fontSize: 12.5,
                            color: "#F4EFE6",
                            textAlign: "left",
                            cursor: "pointer",
                            textDecoration: "underline",
                            textDecorationColor: "#3A3244",
                            textUnderlineOffset: 3,
                          }}
                        >
                          {other.name}
                        </button>
                        <button
                          onClick={() => setExpandedCollabId(isExpanded ? null : other.id)}
                          style={{
                            background: "none",
                            border: "none",
                            padding: "2px 6px",
                            color: "#9C8FA6",
                            fontSize: 11,
                            cursor: "pointer",
                            flexShrink: 0,
                          }}
                        >
                          {isExpanded ? "▾ 閉じる" : `▸ ${l.collabs.length}曲`}
                        </button>
                      </div>
                      {isExpanded && (
                        <div style={{ marginTop: 8, paddingLeft: 4 }}>
                          <SongList collabs={l.collabs} />
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
