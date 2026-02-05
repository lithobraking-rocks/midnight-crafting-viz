#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

import httpx


def save_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def download_icons(graph: dict, icons_dir: Path, icon_prefix: str) -> dict:
    icons_dir.mkdir(parents=True, exist_ok=True)
    existing_by_stem = {p.stem: p.name for p in icons_dir.iterdir() if p.is_file()}

    with httpx.Client() as client:
        for node in graph.get("nodes", []):
            node_id = node.get("id")
            if not isinstance(node_id, str):
                continue

            existing_name = existing_by_stem.get(node_id)
            if existing_name:
                node["icon"] = f"{icon_prefix.rstrip('/')}/{existing_name}"
                continue

            icon_url = node.get("icon")
            if not isinstance(icon_url, str) or not icon_url.startswith("http"):
                continue

            ext = ".jpg"
            if "." in icon_url.rsplit("/", 1)[-1]:
                ext = "." + icon_url.rsplit(".", 1)[-1]
                if len(ext) > 5:
                    ext = ".jpg"
            file_name = f"{node_id}{ext}"
            file_path = icons_dir / file_name
            if not file_path.exists():
                resp = client.get(icon_url, timeout=30)
                resp.raise_for_status()
                file_path.write_bytes(resp.content)
            existing_by_stem[node_id] = file_name
            node["icon"] = f"{icon_prefix.rstrip('/')}/{file_name}"
    return graph


def main() -> None:
    parser = argparse.ArgumentParser(description="Download icons referenced in a graph JSON.")
    parser.add_argument(
        "--graph",
        default=str(Path(__file__).resolve().parents[1] / "data" / "normalized" / "midnight_graph.json"),
        help="Graph JSON path.",
    )
    parser.add_argument(
        "--out",
        default=None,
        help="Output graph JSON path (default: overwrite input).",
    )
    parser.add_argument(
        "--icons-dir",
        default=str(Path(__file__).resolve().parents[1] / "data" / "normalized" / "icons"),
        help="Directory to save downloaded icons.",
    )
    parser.add_argument(
        "--icon-prefix",
        default="/icons",
        help="Prefix for icon paths stored in the graph (e.g. /icons).",
    )
    args = parser.parse_args()

    graph_path = Path(args.graph)
    graph = json.loads(graph_path.read_text(encoding="utf-8"))
    graph = download_icons(graph, Path(args.icons_dir), args.icon_prefix)

    out_path = Path(args.out) if args.out else graph_path
    save_json(out_path, graph)
    print(f"Saved graph with local icons to {out_path}")


if __name__ == "__main__":
    main()
