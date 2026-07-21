import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";
import { errMsg } from "./pipeline/http-utils";

let mermaidInitialized = false;

function ensureMermaidInit() {
  if (mermaidInitialized) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: "neutral",
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
    fontSize: 13,
    flowchart: { curve: "linear", padding: 12 },
    sequence: { mirrorActors: false }
  });
  mermaidInitialized = true;
}

let renderCounter = 0;

interface MermaidChartProps {
  diagram: string;
  style?: React.CSSProperties;
}

export default function MermaidChart({ diagram, style }: MermaidChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const normalizedDiagram = diagram.trim();
    if (!normalizedDiagram) {
      containerRef.current.innerHTML = "";
      setError(null);
      return;
    }
    ensureMermaidInit();
    let cancelled = false;

    const id = `mermaid-chart-${++renderCounter}`;
    setError(null);

    mermaid
      .render(id, normalizedDiagram)
      .then(({ svg }) => {
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
          // Make SVG responsive
          const svgEl = containerRef.current.querySelector("svg");
          if (svgEl) {
            svgEl.style.maxWidth = "100%";
            svgEl.style.height = "auto";
          }
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(errMsg(err));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [diagram]);

  if (error) {
    return (
      <div
        style={{
          padding: "0.75rem",
          background: "#fef2f2",
          border: "1px solid #fecaca",
          borderRadius: "0.375rem",
          color: "#dc2626",
          fontSize: "0.75rem",
          fontFamily: "monospace"
        }}
      >
        Diagram error: {error}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{
        overflowX: "auto",
        background: "#fafafa",
        borderRadius: "0.5rem",
        padding: "1rem",
        ...style
      }}
    />
  );
}
