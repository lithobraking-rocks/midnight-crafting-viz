import { useEffect, useMemo, useRef, useState } from "react";
import { SigmaContainer, useLoadGraph, useSigma } from "@react-sigma/core";
import Graph from "graphology";

const PROFESSION_NAMES: Record<number, string> = {
  164: "Blacksmithing",
  165: "Leatherworking",
  171: "Alchemy",
  182: "Herbalism",
  185: "Cooking",
  197: "Tailoring",
  202: "Engineering",
  333: "Enchanting",
  356: "Fishing",
  393: "Skinning",
  755: "Jewelcrafting",
};

type GraphData = {
  nodes: Array<{
    id: string;
    type: string;
    label: string;
    icon?: string;
    quality?: string;
    professionId?: number | null;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    quantity?: number;
    edgeType?: string;
    professionId?: number | null;
  }>;
};
type RenderNode = GraphData["nodes"][number];
type RenderEdge = GraphData["edges"][number];

const TYPE_COLUMN: Record<string, number> = {
  item: 0,
  slot: 0,
  recipe: 1,
  product: 2,
};

const TYPE_COLOR: Record<string, string> = {
  item: "#2d3443",
  slot: "#2b3140",
  recipe: "#3b2a57",
  product: "#2b5a3f",
};

function computePositions(nodes: RenderNode[]) {
  const columns: Record<number, RenderNode[]> = {};
  nodes.forEach((node) => {
    const column = TYPE_COLUMN[node.type] ?? 1;
    columns[column] = columns[column] ?? [];
    columns[column].push(node);
  });

  const positions = new Map<string, { x: number; y: number }>();
  const columnKeys = Object.keys(columns)
    .map(Number)
    .sort((a, b) => a - b);

  columnKeys.forEach((column, columnIndex) => {
    const list = columns[column];
    list.sort((a, b) => a.label.localeCompare(b.label));
    const x = columnIndex * 600;
    list.forEach((node, index) => {
      positions.set(node.id, { x, y: index * 80 });
    });
  });

  return positions;
}

function buildSigmaGraph(nodes: RenderNode[], edges: RenderEdge[]) {
  const graph = new Graph({ multi: true });
  const positions = computePositions(nodes);
  const edgePairs = new Set<string>();

  nodes.forEach((node) => {
    const pos = positions.get(node.id) ?? { x: 0, y: 0 };
    graph.addNode(node.id, {
      label: node.label,
      x: pos.x,
      y: pos.y,
      size: node.type === "recipe" ? 10 : 8,
      color: TYPE_COLOR[node.type] ?? "#2d3443",
    });
  });

  edges.forEach((edge) => {
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) {
      return;
    }
    const pairKey = `${edge.source}->${edge.target}`;
    if (edgePairs.has(pairKey) || graph.hasEdge(edge.id)) {
      return;
    }
    graph.addEdgeWithKey(edge.id, edge.source, edge.target, {
      color: "#5c6478",
      size: 1,
    });
    edgePairs.add(pairKey);
  });

  return graph;
}

function collectNeighborhood(
  edges: RenderEdge[],
  startId: string,
  maxDepth: number,
): Set<string> {
  const adjacency = new Map<string, Set<string>>();
  edges.forEach((edge) => {
    const { source, target } = edge;
    if (!adjacency.has(source)) {
      adjacency.set(source, new Set());
    }
    if (!adjacency.has(target)) {
      adjacency.set(target, new Set());
    }
    adjacency.get(source)?.add(target);
    adjacency.get(target)?.add(source);
  });

  const visited = new Map<string, number>();
  const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }];
  visited.set(startId, 0);

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (depth >= maxDepth) {
      continue;
    }
    const neighbors = adjacency.get(id);
    if (!neighbors) {
      continue;
    }
    neighbors.forEach((neighbor) => {
      const nextDepth = depth + 1;
      const seenDepth = visited.get(neighbor);
      if (seenDepth === undefined || nextDepth < seenDepth) {
        visited.set(neighbor, nextDepth);
        queue.push({ id: neighbor, depth: nextDepth });
      }
    });
  }

  return new Set(visited.keys());
}

function indexEdges(edges: RenderEdge[]) {
  const bySource = new Map<string, RenderEdge[]>();
  const byTarget = new Map<string, RenderEdge[]>();
  edges.forEach((edge) => {
    if (!bySource.has(edge.source)) {
      bySource.set(edge.source, []);
    }
    if (!byTarget.has(edge.target)) {
      byTarget.set(edge.target, []);
    }
    bySource.get(edge.source)!.push(edge);
    byTarget.get(edge.target)!.push(edge);
  });
  return { bySource, byTarget };
}

function collectRecipeChain(
  edges: RenderEdge[],
  selectedRecipeId: string,
  maxRecipeDepth: number,
): { nodeIds: Set<string>; edgeIds: Set<string> } {
  const { bySource, byTarget } = indexEdges(edges);
  const nodeIds = new Set<string>([selectedRecipeId]);
  const edgeIds = new Set<string>();

  const visitedRecipes = new Set<string>();
  const queue: Array<{ recipeId: string; depth: number }> = [
    { recipeId: selectedRecipeId, depth: 0 },
  ];

  while (queue.length > 0) {
    const { recipeId, depth } = queue.shift()!;
    if (visitedRecipes.has(recipeId)) {
      continue;
    }
    visitedRecipes.add(recipeId);
    nodeIds.add(recipeId);

    const inputEdges = (byTarget.get(recipeId) ?? []).filter(
      (edge) => edge.edgeType === "reagent" || edge.edgeType === "optional",
    );
    const inputItemIds: string[] = [];
    inputEdges.forEach((edge) => {
      edgeIds.add(edge.id);
      nodeIds.add(edge.source);
      nodeIds.add(edge.target);
      inputItemIds.push(edge.source);
    });

    const outputEdges = (bySource.get(recipeId) ?? []).filter(
      (edge) => edge.edgeType === "crafted",
    );
    outputEdges.forEach((edge) => {
      edgeIds.add(edge.id);
      nodeIds.add(edge.source);
      nodeIds.add(edge.target);
    });

    if (depth >= maxRecipeDepth) {
      continue;
    }

    inputItemIds.forEach((itemId) => {
      const craftedToItem = (byTarget.get(itemId) ?? []).filter(
        (edge) => edge.edgeType === "crafted",
      );
      craftedToItem.forEach((edge) => {
        edgeIds.add(edge.id);
        nodeIds.add(edge.source);
        nodeIds.add(edge.target);
        queue.push({ recipeId: edge.source, depth: depth + 1 });
      });
    });
  }

  return { nodeIds, edgeIds };
}

function GraphEvents({
  onNodeClick,
  onStageClick,
}: {
  onNodeClick: (nodeId: string) => void;
  onStageClick: () => void;
}) {
  const sigma = useSigma();
  const ignoreStageClickRef = useRef(false);

  useEffect(() => {
    const handleClickNode = (event: { node: string }) => {
      ignoreStageClickRef.current = true;
      onNodeClick(event.node);
    };
    const handleClickStage = () => {
      if (ignoreStageClickRef.current) {
        ignoreStageClickRef.current = false;
        return;
      }
      onStageClick();
    };

    sigma.on("clickNode", handleClickNode);
    sigma.on("clickStage", handleClickStage);

    return () => {
      sigma.off("clickNode", handleClickNode);
      sigma.off("clickStage", handleClickStage);
    };
  }, [sigma, onNodeClick, onStageClick]);
  return null;
}

function GraphLoader({ graph }: { graph: Graph }) {
  const loadGraph = useLoadGraph();
  const sigma = useSigma();
  useEffect(() => {
    loadGraph(graph);
    sigma.getCamera().animatedReset();
  }, [graph, loadGraph, sigma]);
  return null;
}

export default function App() {
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [viewGraph, setViewGraph] = useState<GraphData | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedProfession, setSelectedProfession] = useState<number | "all">("all");

  useEffect(() => {
    fetch("/midnight_graph.json")
      .then((res) => res.json())
      .then((data: GraphData) => setGraph(data));
  }, []);

  const professions = useMemo(() => {
    if (!graph) {
      return [] as number[];
    }
    const professionIds = new Set<number>();
    graph.nodes.forEach((n) => {
      if (n.type === "recipe" && typeof n.professionId === "number") {
        professionIds.add(n.professionId);
      }
    });
    return Array.from(professionIds).sort((a, b) => a - b);
  }, [graph]);

  useEffect(() => {
    if (!graph) {
      setViewGraph(null);
      return;
    }

    const recipeProfession = new Map<string, number>();
    graph.nodes.forEach((n) => {
      if (n.type === "recipe" && typeof n.professionId === "number") {
        recipeProfession.set(n.id, n.professionId);
      }
    });

    const professionFilteredEdges = graph.edges.filter((e) => {
      if (selectedProfession === "all") {
        return true;
      }
      if (typeof e.professionId === "number") {
        return e.professionId === selectedProfession;
      }
      const sourceProf = recipeProfession.get(e.source);
      const targetProf = recipeProfession.get(e.target);
      return sourceProf === selectedProfession || targetProf === selectedProfession;
    });

    let edgesForView = professionFilteredEdges;
    let filteredNodeIdSet: Set<string> | null = null;

    if (selectedNodeId) {
      const selectedNode = graph.nodes.find((n) => n.id === selectedNodeId);
      if (selectedNode?.type === "recipe") {
        const { nodeIds, edgeIds } = collectRecipeChain(
          professionFilteredEdges,
          selectedNodeId,
          5,
        );
        filteredNodeIdSet = nodeIds;
        edgesForView = professionFilteredEdges.filter((e) => edgeIds.has(e.id));
      } else {
        filteredNodeIdSet = collectNeighborhood(professionFilteredEdges, selectedNodeId, 1);
        edgesForView = professionFilteredEdges.filter(
          (e) => filteredNodeIdSet?.has(e.source) && filteredNodeIdSet?.has(e.target),
        );
      }
    }

    const nodeIdSet = filteredNodeIdSet ?? new Set(
      edgesForView.flatMap((e) => [e.source, e.target]),
    );
    if (selectedNodeId) {
      nodeIdSet.add(selectedNodeId);
    }

    const filteredNodes = graph.nodes.filter((n) => nodeIdSet.has(n.id));
    setViewGraph({ nodes: filteredNodes, edges: edgesForView });
  }, [graph, selectedProfession, selectedNodeId]);

  useEffect(() => {
    if (!graph || selectedProfession !== "all") {
      return;
    }
    const firstProfession = graph.nodes.find((n) => typeof n.professionId === "number")
      ?.professionId;
    if (typeof firstProfession === "number") {
      setSelectedProfession(firstProfession);
    }
  }, [graph, selectedProfession]);

  const sigmaGraph = useMemo(() => {
    if (!viewGraph) {
      return buildSigmaGraph([], []);
    }
    return buildSigmaGraph(viewGraph.nodes, viewGraph.edges);
  }, [viewGraph]);

  return (
    <div className="app">
      <header className="app__header">
        <h1>Midnight Profession Graph</h1>
        <p>Reagents → Recipe → Product</p>
        <div className="app__controls">
          <label>
            Profession
            <select
              value={selectedProfession}
              onChange={(event) => {
                const value = event.target.value;
                setSelectedNodeId(null);
                setSelectedProfession(value === "all" ? "all" : Number(value));
              }}
            >
              <option value="all">All</option>
              {professions.map((pid) => (
                <option key={pid} value={pid}>
                  {PROFESSION_NAMES[pid] ?? pid}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>
      <main className="app__main">
        <div className="debug-overlay">
          <div>Selected: {selectedNodeId ?? "none"}</div>
          <div>Nodes: {viewGraph?.nodes.length ?? 0}</div>
          <div>Edges: {viewGraph?.edges.length ?? 0}</div>
        </div>
        <SigmaContainer
          settings={{
            renderEdgeLabels: false,
            labelRenderedSizeThreshold: 14,
            defaultNodeColor: "#2d3443",
            defaultEdgeColor: "#5c6478",
            edgeProgramClasses: {},
          }}
          className="sigma-container"
        >
          <GraphLoader graph={sigmaGraph} />
          <GraphEvents
            onNodeClick={(nodeId) =>
              setSelectedNodeId((prev) => (prev === nodeId ? null : nodeId))
            }
            onStageClick={() => setSelectedNodeId(null)}
          />
        </SigmaContainer>
      </main>
    </div>
  );
}
