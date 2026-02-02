import { getBezierPath, type EdgeProps } from "reactflow";

type OffsetData = {
  offset?: number;
};

export default function OffsetEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  markerEnd,
  style,
}: EdgeProps<OffsetData>) {
  const offset = data?.offset ?? 0;
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY: sourceY + offset,
    targetX,
    targetY: targetY + offset,
  });

  return (
    <path
      id={id}
      className="react-flow__edge-path"
      d={edgePath}
      markerEnd={markerEnd}
      style={style}
    />
  );
}
