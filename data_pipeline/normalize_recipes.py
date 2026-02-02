#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

import httpx
from dotenv import load_dotenv
from tqdm import tqdm


def get_default_namespace(region: str) -> str:
    region = region.lower()
    if region in {"us", "eu", "kr", "tw"}:
        return f"static-{region}"
    if region == "cn":
        return "static-cn"
    return f"static-{region}"


def load_config(args: argparse.Namespace) -> dict:
    load_dotenv()
    client_id = args.client_id or os.getenv("BLIZZARD_CLIENT_ID")
    client_secret = args.client_secret or os.getenv("BLIZZARD_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise RuntimeError(
            "Missing BLIZZARD_CLIENT_ID or BLIZZARD_CLIENT_SECRET. "
            "Set environment variables or pass --client-id / --client-secret."
        )
    region = (args.region or os.getenv("BLIZZARD_REGION") or "us").lower()
    namespace = args.namespace or os.getenv("BLIZZARD_NAMESPACE") or get_default_namespace(region)
    locale = args.locale or os.getenv("BLIZZARD_LOCALE") or "en_US"
    return {
        "client_id": client_id,
        "client_secret": client_secret,
        "region": region,
        "namespace": namespace,
        "locale": locale,
    }


def get_oauth_token(client: httpx.Client, cfg: dict) -> str:
    token_url = f"https://{cfg['region']}.battle.net/oauth/token"
    resp = client.post(
        token_url,
        data={"grant_type": "client_credentials"},
        auth=(cfg["client_id"], cfg["client_secret"]),
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


def fetch_json(client: httpx.Client, url: str, params: dict, headers: dict) -> dict:
    resp = client.get(url, params=params, headers=headers, timeout=30)
    resp.raise_for_status()
    return resp.json()


def save_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def iter_recipe_files(recipes_root: Path) -> Iterable[Path]:
    return recipes_root.glob("**/recipes/*.json")


def read_recipe_media_icon(recipe_path: Path) -> Optional[str]:
    recipe_id = recipe_path.stem
    media_path = recipe_path.parents[1] / "recipe_media" / f"{recipe_id}.json"
    if not media_path.exists():
        return None
    try:
        media_json = json.loads(media_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    for asset in media_json.get("assets", []) or []:
        if asset.get("key") == "icon":
            return asset.get("value")
    return None


def extract_reagents(recipe: dict) -> List[Tuple[int, str, int]]:
    reagents: List[Tuple[int, str, int]] = []
    for entry in recipe.get("reagents", []) or []:
        reagent = entry.get("reagent", {})
        rid = reagent.get("id")
        name = reagent.get("name")
        qty = entry.get("quantity")
        if isinstance(rid, int) and isinstance(name, str) and isinstance(qty, int):
            reagents.append((rid, name, qty))
    return reagents


def extract_crafted_items(recipe: dict) -> List[Tuple[int, Optional[str], Optional[int]]]:
    items: List[Tuple[int, Optional[str], Optional[int]]] = []

    crafted = recipe.get("crafted_item")
    if isinstance(crafted, dict):
        cid = crafted.get("id") or crafted.get("item", {}).get("id")
        name = crafted.get("name") or crafted.get("item", {}).get("name")
        qty = crafted.get("quantity") or recipe.get("crafted_quantity")
        if isinstance(cid, int):
            items.append((cid, name if isinstance(name, str) else None, qty if isinstance(qty, int) else None))

    crafted_list = recipe.get("crafted_items")
    if isinstance(crafted_list, list):
        for entry in crafted_list:
            if not isinstance(entry, dict):
                continue
            item = entry.get("item") or entry
            cid = item.get("id")
            name = item.get("name")
            qty = entry.get("quantity") or recipe.get("crafted_quantity")
            if isinstance(cid, int):
                items.append((cid, name if isinstance(name, str) else None, qty if isinstance(qty, int) else None))

    return items


def extract_slot_types(recipe: dict, exclude_names: List[str]) -> List[Tuple[int, str]]:
    slots: List[Tuple[int, str]] = []
    for entry in recipe.get("modified_crafting_slots", []) or []:
        slot_type = entry.get("slot_type", {})
        sid = slot_type.get("id")
        name = slot_type.get("name")
        if isinstance(sid, int) and isinstance(name, str):
            lower_name = name.lower()
            if any(excl in lower_name for excl in exclude_names):
                continue
            slots.append((sid, name))
    return slots


def load_recipe(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def build_graph(
    recipes_root: Path,
    create_product_nodes: bool,
    include_slot_types: bool,
    exclude_slot_names: List[str],
) -> Tuple[dict, List[int]]:
    nodes: Dict[str, dict] = {}
    edges: List[dict] = []
    item_ids: List[int] = []
    recipes_seen: List[Tuple[int, str, Optional[int]]] = []

    for recipe_path in iter_recipe_files(recipes_root):
        profession_id: Optional[int] = None
        for part in recipe_path.parts:
            if part.startswith("profession_"):
                try:
                    profession_id = int(part.split("_", 1)[1])
                except ValueError:
                    profession_id = None
                break
        recipe = load_recipe(recipe_path)
        recipe_id = recipe.get("id")
        recipe_name = recipe.get("name")
        if not isinstance(recipe_id, int) or not isinstance(recipe_name, str):
            continue

        reagents = extract_reagents(recipe)
        crafted_items = extract_crafted_items(recipe)
        slot_types = extract_slot_types(recipe, exclude_slot_names) if include_slot_types else []
        if not reagents and not crafted_items and not slot_types:
            continue

        recipe_node_id = f"recipe-{recipe_id}"
        recipe_icon = read_recipe_media_icon(recipe_path)
        nodes.setdefault(
            recipe_node_id,
            {
                "id": recipe_node_id,
                "type": "recipe",
                "recipeId": recipe_id,
                "label": recipe_name,
                "icon": recipe_icon,
                "professionId": profession_id,
            },
        )
        recipes_seen.append((recipe_id, recipe_name, profession_id))

        for item_id, item_name, qty in reagents:
            item_node_id = f"item-{item_id}"
            nodes.setdefault(
                item_node_id,
                {
                    "id": item_node_id,
                    "type": "item",
                    "itemId": item_id,
                    "label": item_name,
                },
            )
            edges.append(
                {
                    "id": f"e-{item_node_id}-{recipe_node_id}",
                    "source": item_node_id,
                    "target": recipe_node_id,
                    "quantity": qty,
                    "edgeType": "reagent",
                    "professionId": profession_id,
                }
            )
            item_ids.append(item_id)

        for slot_id, slot_name in slot_types:
            slot_node_id = f"slot-{slot_id}"
            nodes.setdefault(
                slot_node_id,
                {
                    "id": slot_node_id,
                    "type": "slot",
                    "slotId": slot_id,
                    "label": slot_name,
                },
            )
            edges.append(
                {
                    "id": f"e-{slot_node_id}-{recipe_node_id}",
                    "source": slot_node_id,
                    "target": recipe_node_id,
                    "edgeType": "optional",
                    "professionId": profession_id,
                }
            )

        if crafted_items:
            for item_id, item_name, qty in crafted_items:
                item_node_id = f"item-{item_id}"
                nodes.setdefault(
                    item_node_id,
                    {
                        "id": item_node_id,
                        "type": "item",
                        "itemId": item_id,
                        "label": item_name,
                    },
                )
                edges.append(
                    {
                        "id": f"e-{recipe_node_id}-{item_node_id}",
                        "source": recipe_node_id,
                        "target": item_node_id,
                        "quantity": qty,
                        "edgeType": "crafted",
                        "professionId": profession_id,
                    }
                )
                item_ids.append(item_id)
        elif create_product_nodes:
            product_node_id = f"product-{recipe_id}"
            nodes.setdefault(
                product_node_id,
                {
                    "id": product_node_id,
                    "type": "product",
                    "label": recipe_name,
                    "recipeId": recipe_id,
                    "icon": recipe_icon,
                    "professionId": profession_id,
                },
            )
            edges.append(
                {
                    "id": f"e-{recipe_node_id}-{product_node_id}",
                    "source": recipe_node_id,
                    "target": product_node_id,
                    "edgeType": "crafted",
                    "professionId": profession_id,
                }
            )

    graph = {
        "nodes": list(nodes.values()),
        "edges": edges,
    }
    # Collapse slot nodes into matching item nodes by label.
    item_by_label: Dict[str, str] = {}
    for node in graph["nodes"]:
        if node.get("type") == "item":
            label = node.get("label")
            if isinstance(label, str):
                item_by_label[label.lower()] = node["id"]

    remapped_edges: List[dict] = []
    referenced_nodes: set[str] = set()
    for edge in graph["edges"]:
        source_id = edge.get("source")
        if isinstance(source_id, str) and source_id.startswith("slot-"):
            slot_node = next((n for n in graph["nodes"] if n.get("id") == source_id), None)
            slot_label = slot_node.get("label") if isinstance(slot_node, dict) else None
            if isinstance(slot_label, str):
                mapped_item_id = item_by_label.get(slot_label.lower())
                if mapped_item_id:
                    edge = {**edge, "source": mapped_item_id}
        remapped_edges.append(edge)
        src = edge.get("source")
        tgt = edge.get("target")
        if isinstance(src, str):
            referenced_nodes.add(src)
        if isinstance(tgt, str):
            referenced_nodes.add(tgt)

    graph["edges"] = remapped_edges
    graph["nodes"] = [n for n in graph["nodes"] if n.get("id") in referenced_nodes]
    return graph, sorted(set(item_ids))


def enrich_items(
    item_ids: List[int],
    out_dir: Path,
    cfg: dict,
    sleep_s: float,
) -> Dict[int, dict]:
    base = f"https://{cfg['region']}.api.blizzard.com"
    item_data: Dict[int, dict] = {}

    with httpx.Client() as client:
        token = get_oauth_token(client, cfg)
        headers = {"Authorization": f"Bearer {token}"}
        params = {"namespace": cfg["namespace"], "locale": cfg["locale"]}

        for item_id in tqdm(item_ids, desc="Items", unit="item"):
            try:
                item_path = out_dir / "items" / f"{item_id}.json"
                media_path = out_dir / "item_media" / f"{item_id}.json"

                if item_path.exists():
                    item_json = json.loads(item_path.read_text(encoding="utf-8"))
                else:
                    item_url = f"{base}/data/wow/item/{item_id}"
                    item_json = fetch_json(client, item_url, params, headers)
                    save_json(item_path, item_json)

                if media_path.exists():
                    media_json = json.loads(media_path.read_text(encoding="utf-8"))
                else:
                    media_url = f"{base}/data/wow/media/item/{item_id}"
                    media_json = fetch_json(client, media_url, params, headers)
                    save_json(media_path, media_json)

                icon = None
                for asset in media_json.get("assets", []) or []:
                    if asset.get("key") == "icon":
                        icon = asset.get("value")
                        break

                item_data[item_id] = {
                    "id": item_id,
                    "name": item_json.get("name"),
                    "icon": icon,
                    "quality": item_json.get("quality", {}).get("name"),
                }
            except Exception:
                item_data[item_id] = {"id": item_id}
            if sleep_s > 0:
                time.sleep(sleep_s)

    return item_data


def apply_item_enrichment(graph: dict, item_data: Dict[int, dict]) -> dict:
    for node in graph.get("nodes", []):
        if node.get("type") != "item":
            continue
        item_id = node.get("itemId")
        if isinstance(item_id, int) and item_id in item_data:
            data = item_data[item_id]
            if data.get("name") and not node.get("label"):
                node["label"] = data.get("name")
            if data.get("icon"):
                node["icon"] = data.get("icon")
            if data.get("quality"):
                node["quality"] = data.get("quality")
    return graph




def main() -> None:
    parser = argparse.ArgumentParser(description="Normalize recipe data into a single graph JSON.")
    parser.add_argument(
        "--recipes-root",
        default=str(Path(__file__).resolve().parents[1] / "data" / "raw" / "midnight_recipes"),
        help="Root folder containing profession_* recipe folders.",
    )
    parser.add_argument(
        "--out",
        default=str(Path(__file__).resolve().parents[1] / "data" / "normalized" / "midnight_graph.json"),
        help="Output graph JSON path.",
    )
    parser.add_argument(
        "--fetch-items",
        action="store_true",
        help="Fetch and cache item + item media for icons.",
    )
    parser.add_argument(
        "--product-nodes",
        action="store_true",
        help="Enable synthetic product nodes when crafted items are missing.",
    )
    parser.add_argument(
        "--no-slot-types",
        action="store_true",
        help="Disable modified crafting slot type nodes.",
    )
    parser.add_argument(
        "--exclude-slot-names",
        default="embellishment,customize secondary stats,empower,artisan's authenticity,spark,infuse with power,secret ingredient",
        help="Comma-separated substrings of slot names to exclude.",
    )
    parser.add_argument(
        "--no-name-output-links",
        action="store_true",
        help="Disable heuristic recipe->item links based on matching names.",
    )
    parser.add_argument("--region", default=None)
    parser.add_argument("--namespace", default=None)
    parser.add_argument("--locale", default=None)
    parser.add_argument("--client-id", default=None)
    parser.add_argument("--client-secret", default=None)
    parser.add_argument("--sleep", type=float, default=0.05, help="Seconds to sleep between requests.")
    parser.add_argument(
        "--items-cache-dir",
        default=str(Path(__file__).resolve().parents[1] / "data" / "raw"),
        help="Cache directory for item and item media JSON files.",
    )
    args = parser.parse_args()

    exclude_slot_names = [
        part.strip().lower() for part in args.exclude_slot_names.split(",") if part.strip()
    ]
    graph, item_ids = build_graph(
        Path(args.recipes_root),
        args.product_nodes,
        not args.no_slot_types,
        exclude_slot_names,
    )

    if not args.no_name_output_links:
        items_by_label: Dict[str, List[str]] = {}
        recipe_nodes = [n for n in graph["nodes"] if n.get("type") == "recipe"]
        item_nodes = [n for n in graph["nodes"] if n.get("type") in {"item", "slot"}]

        for item in item_nodes:
            label = item.get("label")
            if isinstance(label, str):
                items_by_label.setdefault(label.lower(), []).append(item["id"])

        existing_edges = {e["id"] for e in graph["edges"]}
        for recipe in recipe_nodes:
            label = recipe.get("label")
            if not isinstance(label, str):
                continue
            for item_id in items_by_label.get(label.lower(), []):
                edge_id = f"e-{recipe['id']}-{item_id}-name"
                if edge_id in existing_edges:
                    continue
                graph["edges"].append(
                    {
                        "id": edge_id,
                        "source": recipe["id"],
                        "target": item_id,
                        "edgeType": "crafted",
                        "professionId": recipe.get("professionId"),
                    }
                )
                existing_edges.add(edge_id)

    # Merge slot nodes into item/recipe nodes by label (prefer recipe targets).
    recipe_by_label: Dict[str, str] = {}
    item_by_label: Dict[str, str] = {}
    slot_by_id: Dict[str, dict] = {}
    for node in graph.get("nodes", []):
        node_id = node.get("id")
        label = node.get("label")
        if not isinstance(node_id, str) or not isinstance(label, str):
            continue
        lower_label = label.lower()
        if node.get("type") == "recipe":
            recipe_by_label.setdefault(lower_label, node_id)
        elif node.get("type") == "item":
            item_by_label.setdefault(lower_label, node_id)
        elif node.get("type") == "slot":
            slot_by_id[node_id] = node

    slot_target_by_id: Dict[str, str] = {}
    for slot_id, slot_node in slot_by_id.items():
        label = slot_node.get("label")
        if not isinstance(label, str):
            continue
        lower_label = label.lower()
        preferred = recipe_by_label.get(lower_label) or item_by_label.get(lower_label)
        if preferred:
            slot_target_by_id[slot_id] = preferred

    if slot_target_by_id:
        remapped_edges: List[dict] = []
        referenced_nodes: set[str] = set()
        seen_edges: set[str] = set()
        for edge in graph.get("edges", []):
            source_id = edge.get("source")
            target_id = edge.get("target")
            if isinstance(source_id, str) and source_id in slot_target_by_id:
                source_id = slot_target_by_id[source_id]
            if isinstance(target_id, str) and target_id in slot_target_by_id:
                target_id = slot_target_by_id[target_id]

            updated_edge = {**edge, "source": source_id, "target": target_id}
            edge_id = updated_edge.get("id")
            if isinstance(edge_id, str) and edge_id in seen_edges:
                continue
            if isinstance(edge_id, str):
                seen_edges.add(edge_id)
            remapped_edges.append(updated_edge)

            if isinstance(source_id, str):
                referenced_nodes.add(source_id)
            if isinstance(target_id, str):
                referenced_nodes.add(target_id)

        graph["edges"] = remapped_edges
        graph["nodes"] = [n for n in graph.get("nodes", []) if n.get("id") in referenced_nodes]

    if args.fetch_items:
        cfg = load_config(args)
        item_data = enrich_items(item_ids, Path(args.items_cache_dir), cfg, args.sleep)
        graph = apply_item_enrichment(graph, item_data)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    save_json(out_path, graph)
    print(f"Saved graph to {out_path}")


if __name__ == "__main__":
    main()
