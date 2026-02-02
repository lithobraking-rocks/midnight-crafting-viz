import { useEffect, useMemo, useRef, useState } from "react";
import { SigmaContainer, useLoadGraph, useSigma } from "@react-sigma/core";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";

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


function hashToUnit(value: string) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) % 1_000_000_007;
  }
  return (hash % 10_000) / 10_000;
}

function initialRadialPosition(node: RenderNode) {
  const angle = hashToUnit(node.id) * Math.PI * 2;
  const baseRadius = node.type === "recipe" ? 320 : node.type === "product" ? 420 : 140;
  const jitter = (hashToUnit(node.label ?? node.id) - 0.5) * 40;
  const radius = baseRadius + jitter;
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius,
  };
}

function buildSigmaGraph(nodes: RenderNode[], edges: RenderEdge[]) {
  const graph = new Graph({ multi: true });
  const edgePairs = new Set<string>();

  const affinityGroups: Record<string, RenderNode[]> = {
    reagent: [],
    recipe: [],
    product: [],
  };

  nodes.forEach((node) => {
    const pos = initialRadialPosition(node);
    graph.addNode(node.id, {
      label: node.label,
      x: pos.x,
      y: pos.y,
      size: node.type === "recipe" ? 10 : 8,
      color: TYPE_COLOR[node.type] ?? "#2d3443",
    });

    if (node.type === "recipe") {
      affinityGroups.recipe.push(node);
    } else if (node.type === "product") {
      affinityGroups.product.push(node);
    } else {
      affinityGroups.reagent.push(node);
    }
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
      weight: 1,
    });
    edgePairs.add(pairKey);
  });

  const addAffinityEdges = (groupKey: string, groupNodes: RenderNode[]) => {
    if (groupNodes.length < 2) {
      return;
    }
    const sorted = [...groupNodes].sort((a, b) => a.label.localeCompare(b.label));
    const neighborCount = Math.min(3, sorted.length - 1);
    sorted.forEach((node, index) => {
      for (let offset = 1; offset <= neighborCount; offset += 1) {
        const target = sorted[(index + offset) % sorted.length];
        const pairKey = `${node.id}->${target.id}`;
        if (edgePairs.has(pairKey) || graph.hasEdge(pairKey)) {
          continue;
        }
        graph.addEdgeWithKey(pairKey, node.id, target.id, {
          color: "rgba(0, 0, 0, 0)",
          size: 0.1,
          weight: 0.15,
          hidden: true,
          affinity: groupKey,
        });
        edgePairs.add(pairKey);
      }
    });
  };

  Object.entries(affinityGroups).forEach(([groupKey, groupNodes]) => {
    addAffinityEdges(groupKey, groupNodes);
  });

  if (graph.order > 0) {
    forceAtlas2.assign(graph, {
      iterations: 150,
      settings: {
        gravity: 1.2,
        scalingRatio: 2.5,
        slowDown: 2,
        edgeWeightInfluence: 0.8,
      },
    });
  }

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
