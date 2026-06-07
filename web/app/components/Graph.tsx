"use client";

import { useEffect, useRef, useState } from "react";
import * as d3 from "d3";

interface GraphNode extends d3.SimulationNodeDatum {
  id: string;
  type: "file" | "class";
  class_name?: string;
  chunk_count?: number;
}
interface GraphEdge {
  source: string;
  target: string;
  weight: number;
}
interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface TooltipState {
  x: number;
  y: number;
  node: GraphNode;
}

export default function Graph() {
  const svgRef = useRef<SVGSVGElement>(null);
  const [data, setData] = useState<GraphData | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/graph");
        if (!res.ok) throw new Error("API error");
        setData(await res.json());
      } catch (e) {
        setError("could not load graph");
      } finally {
        setLoading(false);
      }
    }
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!data || !svgRef.current) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const rect = svgRef.current.getBoundingClientRect();
    const W = rect.width || 800;
    const H = rect.height || 600;

    const nodes: GraphNode[] = data.nodes.map((n) => ({ ...n }));
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));

    const links = data.edges
      .map((e) => ({
        source: nodeMap.get(e.source)!,
        target: nodeMap.get(e.target)!,
        weight: e.weight,
      }))
      .filter((e) => e.source && e.target);

    // color scale per class
    const classes = [...new Set(nodes.filter((n) => n.type === "class").map((n) => n.id))];
    const palette = ["#a78bfa", "#7dd3fc", "#c084fc", "#818cf8", "#e879f9", "#38bdf8", "#a5b4fc"];
    const colorMap = new Map(classes.map((c, i) => [c, palette[i % palette.length]]));

    const getColor = (n: GraphNode) => {
      if (n.type === "class") return colorMap.get(n.id) ?? "#d4a054";
      return colorMap.get(n.class_name ?? "") ?? "#888";
    };

    // defs: glow filter
    const defs = svg.append("defs");
    const filter = defs.append("filter").attr("id", "glow");
    filter.append("feGaussianBlur").attr("stdDeviation", "3").attr("result", "coloredBlur");
    const merge = filter.append("feMerge");
    merge.append("feMergeNode").attr("in", "coloredBlur");
    merge.append("feMergeNode").attr("in", "SourceGraphic");

    // background grid
    const bg = svg.append("g").attr("class", "bg");
    const gridSize = 40;
    for (let x = 0; x < W; x += gridSize) {
      bg.append("line")
        .attr("x1", x).attr("y1", 0).attr("x2", x).attr("y2", H)
        .attr("stroke", "#1a1d21").attr("stroke-width", 0.5);
    }
    for (let y = 0; y < H; y += gridSize) {
      bg.append("line")
        .attr("x1", 0).attr("y1", y).attr("x2", W).attr("y2", y)
        .attr("stroke", "#1a1d21").attr("stroke-width", 0.5);
    }

    const g = svg.append("g");

    // zoom
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 4])
      .on("zoom", (event) => g.attr("transform", event.transform));
    svg.call(zoom);

    // simulation
    const sim = d3.forceSimulation<GraphNode>(nodes)
      .force("link", d3.forceLink(links).id((d: d3.SimulationNodeDatum) => (d as GraphNode).id)
        .distance((l) => l.weight > 0.5 ? 80 : 140)
        .strength((l) => l.weight * 0.6))
      .force("charge", d3.forceManyBody().strength(-200))
      .force("center", d3.forceCenter(W / 2, H / 2))
      .force("collision", d3.forceCollide().radius((d) => (d as GraphNode).type === "class" ? 40 : 24));

    // edges
    const link = g.append("g").selectAll("line")
      .data(links).join("line")
      .attr("stroke", (d) => d.weight > 0.5 ? "rgba(167,139,250,0.3)" : "rgba(255,255,255,0.05)")
      .attr("stroke-width", (d) => d.weight > 0.5 ? 1.5 : 0.8);

    // class nodes (rings)
    const classNodes = nodes.filter((n) => n.type === "class");
    const fileNodes = nodes.filter((n) => n.type === "file");

    const classG = g.append("g").selectAll("g")
      .data(classNodes).join("g")
      .call(drag(sim) as never);

    classG.append("circle")
      .attr("r", 28)
      .attr("fill", (d) => `${getColor(d)}10`)
      .attr("stroke", (d) => getColor(d))
      .attr("stroke-width", 1.5)
      .attr("filter", "url(#glow)");

    classG.append("text")
      .text((d) => d.id.length > 12 ? d.id.slice(0, 11) + "…" : d.id)
      .attr("text-anchor", "middle")
      .attr("dy", "0.35em")
      .attr("fill", (d) => getColor(d))
      .attr("font-size", 9)
      .attr("font-family", "inherit")
      .attr("letter-spacing", "0.08em")
      .style("pointer-events", "none");

    // file nodes (dots)
    const fileG = g.append("g").selectAll("g")
      .data(fileNodes).join("g")
      .style("cursor", "pointer")
      .call(drag(sim) as never)
      .on("mouseenter", function (event, d) {
        d3.select(this).select("circle").attr("r", 10).attr("filter", "url(#glow)");
        const svgRect = svgRef.current!.getBoundingClientRect();
        setTooltip({ x: event.clientX - svgRect.left, y: event.clientY - svgRect.top, node: d });
      })
      .on("mousemove", function (event) {
        const svgRect = svgRef.current!.getBoundingClientRect();
        setTooltip((t) => t ? { ...t, x: event.clientX - svgRect.left, y: event.clientY - svgRect.top } : null);
      })
      .on("mouseleave", function () {
        d3.select(this).select("circle").attr("r", 6).attr("filter", "none");
        setTooltip(null);
      });

    fileG.append("circle")
      .attr("r", 6)
      .attr("fill", (d) => getColor(d))
      .attr("fill-opacity", 0.85);

    fileG.append("text")
      .text((d) => {
        const name = d.id.replace(/\.[^.]+$/, "");
        return name.length > 14 ? name.slice(0, 13) + "…" : name;
      })
      .attr("x", 9).attr("dy", "0.35em")
      .attr("fill", "#828fa8")
      .attr("font-size", 8)
      .attr("font-family", "inherit")
      .style("pointer-events", "none");

    sim.on("tick", () => {
      link
        .attr("x1", (d) => (d.source as GraphNode).x!)
        .attr("y1", (d) => (d.source as GraphNode).y!)
        .attr("x2", (d) => (d.target as GraphNode).x!)
        .attr("y2", (d) => (d.target as GraphNode).y!);
      classG.attr("transform", (d) => `translate(${d.x},${d.y})`);
      fileG.attr("transform", (d) => `translate(${d.x},${d.y})`);
    });

    return () => { sim.stop(); };
  }, [data]);

  function drag(sim: d3.Simulation<GraphNode, undefined>) {
    return d3.drag<SVGGElement, GraphNode>()
      .on("start", (event, d) => {
        if (!event.active) sim.alphaTarget(0.3).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on("drag", (event, d) => { d.fx = event.x; d.fy = event.y; })
      .on("end", (event, d) => {
        if (!event.active) sim.alphaTarget(0);
        d.fx = null; d.fy = null;
      });
  }

  if (loading) return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 12 }}>
      loading graph…
    </div>
  );

  if (error) return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--red)", fontSize: 12 }}>
      {error}
    </div>
  );

  if (!data || data.nodes.length === 0) return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 12, gap: 8 }}>
      <div style={{ fontSize: 28, opacity: 0.2 }}>◎</div>
      <div>no nodes yet</div>
      <div style={{ fontSize: 10, color: "var(--muted)", opacity: 0.6 }}>upload files to see the graph</div>
    </div>
  );

  const fileCount = data.nodes.filter((n) => n.type === "file").length;
  const classCount = data.nodes.filter((n) => n.type === "class").length;
  const edgeCount = data.edges.filter((e) => {
    const src = data.nodes.find((n) => n.id === e.source);
    const tgt = data.nodes.find((n) => n.id === e.target);
    return src?.type === "file" && tgt?.type === "file";
  }).length;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>
      {/* header */}
      <div style={{
        padding: "12px 20px",
        borderBottom: "1px solid var(--line)",
        display: "flex", alignItems: "center", gap: 16, flexShrink: 0,
      }}>
        <span style={{ color: "var(--muted)", fontSize: 11 }}>claudia:graph</span>
        <span style={{ color: "var(--muted)", fontSize: 10 }}>
          <span style={{ color: "var(--amber)" }}>{fileCount}</span> files ·{" "}
          <span style={{ color: "var(--amber)" }}>{classCount}</span> classes ·{" "}
          <span style={{ color: "var(--amber)" }}>{edgeCount}</span> connections
        </span>
        <span style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 10, opacity: 0.6 }}>
          scroll to zoom · drag to pan · hover nodes
        </span>
      </div>

      {/* svg */}
      <svg
        ref={svgRef}
        style={{ flex: 1, width: "100%", background: "var(--bg)", cursor: "grab" }}
      />

      {/* tooltip */}
      {tooltip && (
        <div style={{
          position: "absolute",
          left: tooltip.x + 14,
          top: tooltip.y - 10,
          background: "var(--panel)",
          border: "1px solid var(--line2)",
          borderRadius: 4,
          padding: "8px 12px",
          fontSize: 11,
          pointerEvents: "none",
          zIndex: 10,
          maxWidth: 220,
        }}>
          <div style={{ color: "var(--text)", fontWeight: 600, marginBottom: 4, wordBreak: "break-all" }}>
            {tooltip.node.id}
          </div>
          {tooltip.node.class_name && (
            <div style={{ color: "var(--muted)" }}>class: {tooltip.node.class_name}</div>
          )}
          {tooltip.node.chunk_count !== undefined && (
            <div style={{ color: "var(--muted)" }}>chunks: {tooltip.node.chunk_count}</div>
          )}
        </div>
      )}
    </div>
  );
}
