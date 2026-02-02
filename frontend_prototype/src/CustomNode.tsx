import { Handle, Position, type NodeProps } from "reactflow";

export type WowNodeData = {
  label: string;
  icon?: string;
  kind?: "item" | "recipe" | "product";
  quality?: string;
};

export default function CustomNode({ data }: NodeProps<WowNodeData>) {
  return (
    <div className={`node node--${data.kind ?? "item"}`}>
      <Handle type="target" position={Position.Left} className="node__handle" />
      <Handle type="source" position={Position.Right} className="node__handle" />
      {data.icon ? <img className="node__icon" src={data.icon} alt="" /> : null}
      <div className="node__content">
        <div className="node__label">{data.label}</div>
        {data.quality ? <div className="node__meta">{data.quality}</div> : null}
      </div>
    </div>
  );
}
