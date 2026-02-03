import { useEffect, useMemo, useRef, useState } from "react";
import { SigmaContainer, useLoadGraph, useSigma } from "@react-sigma/core";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { createNodeBorderProgram } from "@sigma/node-border";
import { NodeCircleProgram } from "sigma/rendering";

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

const PROFESSION_COLORS: Record<number, string> = {
  164: "#6e86b6",
  165: "#b0896b",
  171: "#8b7aa8",
  182: "#6aa38a",
  185: "#b89a6a",
  197: "#b07b8c",
  202: "#6f9aa2",
  333: "#9a8fb3",
  356: "#6b92ad",
  393: "#8aa06b",
  755: "#b27a95",
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
  item: "#2a3140",
  slot: "#2a3140",
  recipe: "#3b2a57",
  product: "#24543d",
};

const DEFAULT_NODE_COLOR = "#2a3140";
const DEFAULT_EDGE_COLOR = "#3a4154";
const REAGENT_NEUTRAL_COLOR = "#9aa3b2";
const RECIPE_BORDER_COLOR = "#f2f4f8";
const HOVER_LABEL_BACKGROUND = "#0b0e15";
const HOVER_LABEL_TEXT = "#f5f7ff";

type HoverDrawFn = (
  context: CanvasRenderingContext2D,
  data: {
    x: number;
    y: number;
    size: number;
    label?: string | null;
  },
  settings: {
    labelSize: number;
    labelFont: string;
    labelWeight: string;
  },
) => void;

const drawDarkNodeHover: HoverDrawFn = (context, data, settings) => {
  if (!data.label) {
    return;
  }

  const label = String(data.label);
  const fontSize = settings.labelSize ?? 14;
  const fontFamily = settings.labelFont ?? "Inter";
  const fontWeight = settings.labelWeight ?? "600";
  const paddingX = 8;
  const paddingY = 5;
  const radius = 8;
  const labelOffset = data.size + 8;

  context.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
  const textWidth = context.measureText(label).width;
  const boxWidth = textWidth + paddingX * 2;
  const boxHeight = fontSize + paddingY * 2;
  const boxX = data.x + labelOffset;
  const boxY = data.y - boxHeight / 2;

  context.save();
  context.fillStyle = HOVER_LABEL_BACKGROUND;
  context.strokeStyle = "rgba(255, 255, 255, 0.08)";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(boxX + radius, boxY);
  context.lineTo(boxX + boxWidth - radius, boxY);
  context.quadraticCurveTo(boxX + boxWidth, boxY, boxX + boxWidth, boxY + radius);
  context.lineTo(boxX + boxWidth, boxY + boxHeight - radius);
  context.quadraticCurveTo(
    boxX + boxWidth,
    boxY + boxHeight,
    boxX + boxWidth - radius,
    boxY + boxHeight,
  );
  context.lineTo(boxX + radius, boxY + boxHeight);
  context.quadraticCurveTo(boxX, boxY + boxHeight, boxX, boxY + boxHeight - radius);
  context.lineTo(boxX, boxY + radius);
  context.quadraticCurveTo(boxX, boxY, boxX + radius, boxY);
  context.closePath();
  context.fill();
  context.stroke();

  context.fillStyle = HOVER_LABEL_TEXT;
  context.fillText(label, boxX + paddingX, boxY + boxHeight - paddingY - 1);
  context.restore();
};

const recipeBorderProgram = createNodeBorderProgram({
  borders: [
    {
      color: { attribute: "borderColor", defaultValue: RECIPE_BORDER_COLOR },
      size: { value: 0.12, mode: "relative" },
    },
    {
      color: { attribute: "color" },
      size: { fill: true },
    },
  ],
  drawHover: drawDarkNodeHover,
  drawLabel: undefined,
});


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

function resolveProfessionByNode(nodes: RenderNode[], edges: RenderEdge[]) {
  const professionByNode = new Map<string, number>();
  const recipeProfession = new Map<string, number>();

  nodes.forEach((node) => {
    if (node.type === "recipe" && typeof node.professionId === "number") {
      recipeProfession.set(node.id, node.professionId);
      professionByNode.set(node.id, node.professionId);
    }
  });

  const counts = new Map<string, Map<number, number>>();
  const addCount = (nodeId: string, professionId: number) => {
    if (!counts.has(nodeId)) {
      counts.set(nodeId, new Map());
    }
    const bucket = counts.get(nodeId)!;
    bucket.set(professionId, (bucket.get(professionId) ?? 0) + 1);
  };

  edges.forEach((edge) => {
    const edgeProfession =
      typeof edge.professionId === "number" ? edge.professionId : undefined;
    if (edgeProfession !== undefined) {
      if (!recipeProfession.has(edge.source)) {
        addCount(edge.source, edgeProfession);
      }
      if (!recipeProfession.has(edge.target)) {
        addCount(edge.target, edgeProfession);
      }
    }

    const sourceRecipeProfession = recipeProfession.get(edge.source);
    if (sourceRecipeProfession !== undefined && !recipeProfession.has(edge.target)) {
      addCount(edge.target, sourceRecipeProfession);
    }

    const targetRecipeProfession = recipeProfession.get(edge.target);
    if (targetRecipeProfession !== undefined && !recipeProfession.has(edge.source)) {
      addCount(edge.source, targetRecipeProfession);
    }
  });

  counts.forEach((professionCounts, nodeId) => {
    if (professionByNode.has(nodeId)) {
      return;
    }
    let selectedProfession: number | null = null;
    let maxCount = -1;
    professionCounts.forEach((count, professionId) => {
      if (count > maxCount) {
        maxCount = count;
        selectedProfession = professionId;
      }
    });
    if (selectedProfession !== null) {
      professionByNode.set(nodeId, selectedProfession);
    }
  });

  return professionByNode;
}

function buildSigmaGraph(
  nodes: RenderNode[],
  edges: RenderEdge[],
  professionByNode: Map<string, number>,
) {
  const graph = new Graph({ multi: true });
  const edgePairs = new Set<string>();

  const affinityGroups: Record<string, RenderNode[]> = {
    reagent: [],
    recipe: [],
    product: [],
  };

  nodes.forEach((node) => {
    const pos = initialRadialPosition(node);
    const professionId = professionByNode.get(node.id);
    const professionColor =
      typeof professionId === "number" ? PROFESSION_COLORS[professionId] : undefined;
    const isReagent = node.type === "item" || node.type === "slot";
    graph.addNode(node.id, {
      type: node.type === "recipe" ? "border" : "circle",
      label: node.label,
      x: pos.x,
      y: pos.y,
      size: node.type === "recipe" ? 10 : 8,
      color: isReagent
        ? REAGENT_NEUTRAL_COLOR
        : node.type === "recipe"
          ? professionColor ?? TYPE_COLOR.recipe
          : TYPE_COLOR[node.type] ?? DEFAULT_NODE_COLOR,
      borderColor: node.type === "recipe" ? RECIPE_BORDER_COLOR : undefined,
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
      color: DEFAULT_EDGE_COLOR,
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

  const professionByNode = useMemo(() => {
    if (!viewGraph) {
      return new Map<string, number>();
    }
    return resolveProfessionByNode(viewGraph.nodes, viewGraph.edges);
  }, [viewGraph]);

  const sigmaGraph = useMemo(() => {
    if (!viewGraph) {
      return buildSigmaGraph([], [], new Map());
    }
    return buildSigmaGraph(viewGraph.nodes, viewGraph.edges, professionByNode);
  }, [professionByNode, viewGraph]);

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
            labelColor: { color: "#e6e8ee" },
            labelHoverColor: { color: "#ffffff" },
            labelHoverBackgroundColor: "#0b0e15",
            labelHoverShadowColor: "#0b0e15",
            defaultNodeColor: DEFAULT_NODE_COLOR,
            defaultEdgeColor: DEFAULT_EDGE_COLOR,
            defaultDrawNodeHover: drawDarkNodeHover,
            nodeProgramClasses: {
              circle: NodeCircleProgram,
              border: recipeBorderProgram,
            },
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
