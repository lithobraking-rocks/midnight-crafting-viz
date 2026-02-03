import fs from "node:fs/promises";
import path from "node:path";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";

function hashToUnit(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) % 1_000_000_007;
  }
  return (hash % 10_000) / 10_000;
}

function initialRadialPosition(node) {
  const angle = hashToUnit(node.id) * Math.PI * 2;
  const baseRadius = node.type === "recipe" ? 320 : node.type === "product" ? 420 : 140;
  const jitter = (hashToUnit(node.label ?? node.id) - 0.5) * 40;
  const radius = baseRadius + jitter;
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius,
  };
}

const workspaceRoot = path.resolve(process.cwd(), "..");
const inputPath = path.join(
  workspaceRoot,
  "data",
  "normalized",
  "midnight_graph.json",
);
const outputPath = path.join(process.cwd(), "public", "midnight_graph.json");

const raw = JSON.parse(await fs.readFile(inputPath, "utf-8"));
const graph = new Graph({ multi: true });
const edgePairs = new Set();

const affinityGroups = {
  reagent: [],
  recipe: [],
  product: [],
};

raw.nodes.forEach((node) => {
  const pos = initialRadialPosition(node);
  graph.addNode(node.id, { x: pos.x, y: pos.y });

  if (node.type === "recipe") {
    affinityGroups.recipe.push(node);
  } else if (node.type === "product") {
    affinityGroups.product.push(node);
  } else {
    affinityGroups.reagent.push(node);
  }
});

raw.edges.forEach((edge) => {
  if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) {
    return;
  }
  const pairKey = `${edge.source}->${edge.target}`;
  if (edgePairs.has(pairKey) || graph.hasEdge(edge.id)) {
    return;
  }
  graph.addEdgeWithKey(edge.id, edge.source, edge.target, {
    weight: 1,
  });
  edgePairs.add(pairKey);
});

const addAffinityEdges = (groupKey, groupNodes) => {
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
        weight: 0.15,
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

const nodesWithPositions = raw.nodes.map((node) => ({
  ...node,
  x: graph.getNodeAttribute(node.id, "x"),
  y: graph.getNodeAttribute(node.id, "y"),
}));

const output = {
  ...raw,
  nodes: nodesWithPositions,
};

await fs.writeFile(outputPath, JSON.stringify(output));
console.log(`Wrote precomputed layout to ${outputPath}`);
