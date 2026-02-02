import { useEffect, useMemo, useState } from "react";
import ReactFlow, { Background, Controls, type Edge, type Node, type NodeMouseHandler } from "reactflow";
import dagre from "dagre";
import CustomNode, { type WowNodeData } from "./CustomNode";
import OffsetEdge from "./OffsetEdge";

const NODE_WIDTH = 240;
const NODE_HEIGHT = 76;

type GraphData = {
  nodes: Array<{
    id: string;
    type: string;
    label: string;
    icon?: string;
    quality?: string;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    quantity?: number;
    edgeType?: string;
  }>;
};

const nodeTypes = { wowNode: CustomNode };
const edgeTypes = { offsetBezier: OffsetEdge };

function layout(nodes: Node<WowNodeData>[], edges: Edge[]) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", nodesep: 80, ranksep: 140 });

  nodes.forEach((node) => {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  });
  edges.forEach((edge) => g.setEdge(edge.source, edge.target));
  dagre.layout(g);

  const layouted = nodes.map((node) => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
    };
  });

  return { nodes: layouted, edges };
}

export default function App() {
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/midnight_graph.json")
      .then((res) => res.json())
      .then((data: GraphData) => setGraph(data));
  }, []);

  const { nodes, edges } = useMemo(() => {
    if (!graph) {
      return { nodes: [], edges: [] };
    }

    const connectedNodeIds = new Set<string>();
    const connectedEdgeIds = new Set<string>();
    if (selectedNodeId) {
      graph.edges.forEach((e) => {
        if (e.source === selectedNodeId || e.target === selectedNodeId) {
          connectedEdgeIds.add(e.id);
          connectedNodeIds.add(e.source);
          connectedNodeIds.add(e.target);
        }
      });
    }

    const filteredNodes = selectedNodeId
      ? graph.nodes.filter((n) => connectedNodeIds.has(n.id))
      : graph.nodes;

    const nodes: Node<WowNodeData>[] = filteredNodes.map((n) => ({
      id: n.id,
      type: "wowNode",
      data: {
        label: n.label,
        icon: n.icon,
        kind: n.type as WowNodeData["kind"],
        quality: n.quality,
      },
      position: { x: 0, y: 0 },
    }));

    const edgesByTarget = new Map<string, string[]>();
    graph.edges.forEach((e) => {
      const list = edgesByTarget.get(e.target) ?? [];
      list.push(e.id);
      edgesByTarget.set(e.target, list);
    });

    const filteredEdges = selectedNodeId
      ? graph.edges.filter((e) => connectedEdgeIds.has(e.id))
      : graph.edges;

    const edges: Edge[] = filteredEdges.map((e) => {
      const siblings = edgesByTarget.get(e.target) ?? [];
      const index = siblings.indexOf(e.id);
      const offset = (index - (siblings.length - 1) / 2) * 14;
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        type: "offsetBezier",
        data: { offset },
        label: e.quantity ? String(e.quantity) : undefined,
      };
    });

    return layout(nodes, edges);
  }, [graph, selectedNodeId]);

  const onNodeClick: NodeMouseHandler = (_, node) => {
    setSelectedNodeId((prev) => (prev === node.id ? null : node.id));
  };

  return (
    <div className="app">
      <header className="app__header">
        <h1>Midnight Profession Graph</h1>
        <p>Reagents → Recipe → Product</p>
      </header>
      <main className="app__main">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          onNodeClick={onNodeClick}
          onPaneClick={() => setSelectedNodeId(null)}
        >
          <Background color="#2a2f3a" gap={18} />
          <Controls />
        </ReactFlow>
      </main>
    </div>
  );
}
