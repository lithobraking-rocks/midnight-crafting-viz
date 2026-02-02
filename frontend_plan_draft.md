# WoW Profession Graph - Static Frontend Implementation

## 1. Tech Stack Overview
This project is built as a static site using **Astro**. It leverages **React Flow** for the interactive graph visualization and **Dagre** to automatically handle the layout of interconnected nodes (ensuring ingredients that feed into multiple items are positioned correctly).

* **Core Framework:** [Astro](https://astro.build/) (v4+)
* **UI Framework:** React (via `@astrojs/react`)
* **Graph Library:** [React Flow](https://reactflow.dev/) (v11+)
* **Auto-Layout Engine:** [dagre](https://github.com/dagrejs/dagre) (To calculate the DAG positions)
* **Styling:** TailwindCSS (Optional, but recommended for node styling)

## 2. Project Structure
/
├── public/
│   └── images/              # WoW icons (e.g., inv_ore_bismuth.jpg)
├── src/
│   ├── data/
│   │   └── profession-data.json  # Your static "database"
│   ├── components/
│   │   ├── CraftingGraph.jsx     # The main React Flow canvas
│   │   └── CustomNode.jsx        # (Optional) Custom WoW-style item card
│   └── pages/
│       └── index.astro           # The static page rendering the graph
└── package.json

## 3. Data Structure (`profession-data.json`)
Since we are not fetching from the Blizzard API, we define our graph as a static list of **Nodes** (Items) and **Edges** (Recipes).

{
  "nodes": [
    { "id": "item-1", "data": { "label": "Iron Claw Alloy", "type": "final" } },
    { "id": "item-2", "data": { "label": "Bismuth", "type": "material" } },
    { "id": "item-3", "data": { "label": "Aqirite", "type": "material" } }
  ],
  "edges": [
    { "id": "e1-2", "source": "item-2", "target": "item-1", "animated": true },
    { "id": "e1-3", "source": "item-3", "target": "item-1", "animated": true }
  ]
}

## 4. Implementation Steps

### Step 1: Dependencies
Install the required libraries to handle the graph and the math for the layout.

npm install react react-dom @astrojs/react reactflow dagre

*Ensure you have added the React integration to your `astro.config.mjs`.*

### Step 2: The Layout Logic (`CraftingGraph.jsx`)
This is the heart of the application. It uses `dagre` to calculate positions so you don't have to manual set `x` and `y` coordinates.

import React, { useMemo } from 'react';
import ReactFlow, { 
  Background, 
  Controls, 
  useNodesState, 
  useEdgesState
} from 'reactflow';
import dagre from 'dagre';
import 'reactflow/dist/style.css'; 

// 1. Setup Dagre Graph
const dagreGraph = new dagre.graphlib.Graph();
dagreGraph.setDefaultEdgeLabel(() => ({}));

// 2. Layout Calculation Function
const getLayoutedElements = (nodes, edges, direction = 'TB') => {
  dagreGraph.setGraph({ rankdir: direction });

  nodes.forEach((node) => {
    // Width/Height must match your node CSS size
    dagreGraph.setNode(node.id, { width: 150, height: 50 });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const layoutedNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    // React Flow requires a position object
    node.position = {
      x: nodeWithPosition.x - 150 / 2,
      y: nodeWithPosition.y - 50 / 2,
    };
    return node;
  });

  return { nodes: layoutedNodes, edges };
};

export default function CraftingGraph({ initialNodes, initialEdges }) {
  // Calculate layout before rendering
  const { nodes: layoutedNodes, edges: layoutedEdges } = useMemo(
    () => getLayoutedElements(initialNodes, initialEdges),
    [initialNodes, initialEdges]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(layoutedNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layoutedEdges);

  return (
    <div style={{ width: '100%', height: '80vh' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        fitView
      >
        <Background color="#aaa" gap={16} />
        <Controls />
      </ReactFlow>
    </div>
  );
}

### Step 3: The Astro Page (`index.astro`)
This file loads the static JSON and hydrates the React component.

---
// Import your static data
import data from '../data/profession-data.json';
import CraftingGraph from '../components/CraftingGraph.jsx';

// Prepare data props
const { nodes, edges } = data;
---

<html lang="en">
  <head>
    <title>Midnight Crafting Trees</title>
  </head>
  <body class="bg-slate-900 text-white">
    <main class="p-10">
      <h1 class="text-3xl mb-4 font-bold">Blacksmithing: Iron Claw Alloy</h1>
      
      <div class="border border-slate-700 rounded-lg overflow-hidden">
        <CraftingGraph 
          initialNodes={nodes} 
          initialEdges={edges} 
          client:only="react" 
        />
      </div>
    </main>
  </body>
</html>

## 5. Next Actions
1.  **Mock Data:** Create a `profession-data.json` with 5-6 interconnected items to test the Dagre layout.
2.  **Custom Node:** Create a custom React component to replace the default grey boxes with WoW-style tooltips (Title, Icon, Quantity).
3.  **Build:** Run `npm run build`. Astro will strip all JS except for the graph chunk.