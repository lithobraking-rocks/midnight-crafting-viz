#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Set, Tuple

DEFAULT_EXCLUDED_PROFESSIONS = "Mining,Herbalism,Fishing,Cooking,Skinning"
DEFAULT_END_PROFESSION_WHITELIST = "Enchanting,Jewelcrafting,Alchemy"
DEFAULT_EXCLUDED_SLOT_NAMES = (
    "embellishment,customize secondary stats,customize gathering stat,customize crafting stat,"
    "amplify secondary stat,empower,artisan's authenticity,spark,infuse with power,secret ingredient,socket"
)
PROFESSION_ID_NORMALIZED_NAME = {
    164: "blacksmithing",
    165: "leatherworking",
    171: "alchemy",
    182: "herbalism",
    185: "cooking",
    186: "mining",
    197: "tailoring",
    202: "engineering",
    333: "enchanting",
    356: "fishing",
    393: "skinning",
    755: "jewelcrafting",
}


def normalize_name(name: str) -> str:
    normalized = name.casefold().replace("’", "'").strip()
    normalized = re.sub(r"\s+", " ", normalized)
    return normalized


def normalize_profession_name(name: str) -> str:
    return re.sub(r"[^a-z]", "", name.casefold())


def parse_excluded_professions(text: str) -> Set[str]:
    excluded: Set[str] = set()
    for raw in text.split(","):
        cleaned = raw.strip()
        if not cleaned:
            continue
        normalized = normalize_profession_name(cleaned)
        if normalized:
            excluded.add(normalized)
    return excluded


def parse_csv_terms(text: str) -> List[str]:
    terms: List[str] = []
    for raw in text.split(","):
        cleaned = raw.strip().casefold()
        if cleaned:
            terms.append(cleaned)
    return terms


@dataclass(frozen=True)
class Reagent:
    name: str
    normalized_name: str
    quantity: Optional[int]
    item_id: Optional[int]


@dataclass
class Recipe:
    recipe_id: int
    name: str
    profession_id: Optional[int]
    profession_name: Optional[str]
    reagents: List[Reagent]
    output_names: Set[str]
    output_display_names: Set[str]


@dataclass(frozen=True)
class CraftLink:
    producer_recipe_id: int
    consumer_recipe_id: int
    reagent_name: str
    reagent_quantity: Optional[int]


def parse_profession_id(path: Path) -> Optional[int]:
    for part in path.parts:
        if part.startswith("profession_"):
            try:
                return int(part.split("_", 1)[1])
            except ValueError:
                return None
    return None


def load_profession_names(recipes_root: Path) -> Dict[int, str]:
    names: Dict[int, str] = {}
    for profession_file in recipes_root.glob("profession_*/profession.json"):
        pid = parse_profession_id(profession_file)
        if pid is None:
            continue
        try:
            data = json.loads(profession_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        name = data.get("name")
        if isinstance(name, str) and name.strip():
            names[pid] = name.strip()
    return names


def extract_reagents(recipe_json: dict) -> List[Reagent]:
    reagents: List[Reagent] = []
    for entry in recipe_json.get("reagents", []) or []:
        if not isinstance(entry, dict):
            continue
        reagent = entry.get("reagent", {})
        if not isinstance(reagent, dict):
            continue
        name = reagent.get("name")
        if not isinstance(name, str):
            continue
        quantity = entry.get("quantity")
        rid = reagent.get("id")
        reagents.append(
            Reagent(
                name=name,
                normalized_name=normalize_name(name),
                quantity=quantity if isinstance(quantity, int) else None,
                item_id=rid if isinstance(rid, int) else None,
            )
        )
    return reagents


def extract_slot_reagents(recipe_json: dict, exclude_slot_name_terms: List[str]) -> List[Reagent]:
    slot_reagents: List[Reagent] = []
    for entry in recipe_json.get("modified_crafting_slots", []) or []:
        if not isinstance(entry, dict):
            continue
        slot_type = entry.get("slot_type", {})
        if not isinstance(slot_type, dict):
            continue
        name = slot_type.get("name")
        if not isinstance(name, str):
            continue
        normalized_name = normalize_name(name)
        if any(term in normalized_name for term in exclude_slot_name_terms):
            continue
        sid = slot_type.get("id")
        slot_reagents.append(
            Reagent(
                name=name,
                normalized_name=normalized_name,
                quantity=None,
                item_id=sid if isinstance(sid, int) else None,
            )
        )
    return slot_reagents


def extract_output_names(recipe_json: dict) -> Tuple[Set[str], Set[str]]:
    display_names: Set[str] = set()

    recipe_name = recipe_json.get("name")
    if isinstance(recipe_name, str) and recipe_name.strip():
        display_names.add(recipe_name.strip())

    crafted = recipe_json.get("crafted_item")
    if isinstance(crafted, dict):
        crafted_name = crafted.get("name")
        if not isinstance(crafted_name, str):
            crafted_name = crafted.get("item", {}).get("name") if isinstance(crafted.get("item"), dict) else None
        if isinstance(crafted_name, str) and crafted_name.strip():
            display_names.add(crafted_name.strip())

    crafted_list = recipe_json.get("crafted_items")
    if isinstance(crafted_list, list):
        for entry in crafted_list:
            if not isinstance(entry, dict):
                continue
            item = entry.get("item") if isinstance(entry.get("item"), dict) else entry
            crafted_name = item.get("name") if isinstance(item, dict) else None
            if isinstance(crafted_name, str) and crafted_name.strip():
                display_names.add(crafted_name.strip())

    normalized = {normalize_name(name) for name in display_names}
    normalized.discard("")
    return normalized, display_names


def load_recipes(
    recipes_root: Path,
    include_slot_types: bool,
    exclude_slot_name_terms: List[str],
) -> Dict[int, Recipe]:
    recipes: Dict[int, Recipe] = {}
    profession_names = load_profession_names(recipes_root)

    for recipe_file in recipes_root.glob("profession_*/recipes/*.json"):
        try:
            recipe_json = json.loads(recipe_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue

        recipe_id = recipe_json.get("id")
        recipe_name = recipe_json.get("name")
        if not isinstance(recipe_id, int) or not isinstance(recipe_name, str):
            continue

        profession_id = parse_profession_id(recipe_file)
        profession_name = profession_names.get(profession_id) if profession_id is not None else None
        output_names, output_display_names = extract_output_names(recipe_json)
        if not output_names:
            output_names = {normalize_name(recipe_name)}
            output_display_names = {recipe_name}

        recipe_reagents = extract_reagents(recipe_json)
        if include_slot_types:
            recipe_reagents.extend(extract_slot_reagents(recipe_json, exclude_slot_name_terms))
        deduped_reagents: Dict[str, Reagent] = {}
        for reagent in recipe_reagents:
            deduped_reagents.setdefault(reagent.normalized_name, reagent)

        recipes[recipe_id] = Recipe(
            recipe_id=recipe_id,
            name=recipe_name,
            profession_id=profession_id,
            profession_name=profession_name,
            reagents=list(deduped_reagents.values()),
            output_names=output_names,
            output_display_names=output_display_names,
        )
    return recipes


def filter_recipes_by_profession(
    recipes: Dict[int, Recipe], excluded_professions: Set[str]
) -> Tuple[Dict[int, Recipe], int]:
    if not excluded_professions:
        return recipes, 0

    filtered: Dict[int, Recipe] = {}
    removed = 0
    for recipe_id, recipe in recipes.items():
        profession_normalized = get_recipe_profession_normalized(recipe)

        if profession_normalized and profession_normalized in excluded_professions:
            removed += 1
            continue
        filtered[recipe_id] = recipe

    return filtered, removed


def get_recipe_profession_normalized(recipe: Recipe) -> Optional[str]:
    if recipe.profession_name:
        return normalize_profession_name(recipe.profession_name)
    if recipe.profession_id is not None:
        return PROFESSION_ID_NORMALIZED_NAME.get(recipe.profession_id)
    return None


def build_crafting_links(
    recipes: Dict[int, Recipe]
) -> Tuple[Dict[str, Set[int]], List[CraftLink], Dict[int, List[CraftLink]], Dict[int, List[CraftLink]]]:
    producers_by_output_name: Dict[str, Set[int]] = defaultdict(set)
    for recipe in recipes.values():
        for output_name in recipe.output_names:
            producers_by_output_name[output_name].add(recipe.recipe_id)

    links: List[CraftLink] = []
    seen: Set[Tuple[int, int, str]] = set()
    links_by_producer: Dict[int, List[CraftLink]] = defaultdict(list)
    links_by_consumer: Dict[int, List[CraftLink]] = defaultdict(list)

    for consumer in recipes.values():
        for reagent in consumer.reagents:
            for producer_id in producers_by_output_name.get(reagent.normalized_name, set()):
                if producer_id == consumer.recipe_id:
                    continue
                edge_key = (producer_id, consumer.recipe_id, reagent.normalized_name)
                if edge_key in seen:
                    continue
                seen.add(edge_key)
                link = CraftLink(
                    producer_recipe_id=producer_id,
                    consumer_recipe_id=consumer.recipe_id,
                    reagent_name=reagent.name,
                    reagent_quantity=reagent.quantity,
                )
                links.append(link)
                links_by_producer[producer_id].append(link)
                links_by_consumer[consumer.recipe_id].append(link)

    return producers_by_output_name, links, links_by_producer, links_by_consumer


def find_chains(
    links_by_producer: Dict[int, List[CraftLink]],
    min_chain_length: int,
    max_chain_length: int,
) -> List[List[Tuple[int, Optional[str]]]]:
    chains: List[List[Tuple[int, Optional[str]]]] = []
    adjacency: Dict[int, List[Tuple[int, str]]] = defaultdict(list)

    for producer_id, links in links_by_producer.items():
        for link in links:
            adjacency[producer_id].append((link.consumer_recipe_id, link.reagent_name))

    for start in adjacency.keys():
        stack: List[List[Tuple[int, Optional[str]]]] = [[(start, None)]]
        while stack:
            path = stack.pop()
            current_recipe_id = path[-1][0]
            if len(path) >= max_chain_length:
                if len(path) >= min_chain_length:
                    chains.append(path)
                continue

            visited = {recipe_id for recipe_id, _ in path}
            extensions: List[List[Tuple[int, Optional[str]]]] = []
            for next_recipe_id, reagent_name in adjacency.get(current_recipe_id, []):
                if next_recipe_id in visited:
                    continue
                extensions.append(path + [(next_recipe_id, reagent_name)])

            if not extensions:
                if len(path) >= min_chain_length:
                    chains.append(path)
                continue

            stack.extend(extensions)

    deduped: Dict[Tuple[Tuple[int, Optional[str]], ...], List[Tuple[int, Optional[str]]]] = {}
    for chain in chains:
        key = tuple(chain)
        deduped[key] = chain

    final_chains = list(deduped.values())
    final_chains.sort(key=lambda c: (-len(c), [recipe_id for recipe_id, _ in c]))
    return final_chains


def filter_chains_by_end_profession(
    chains: List[List[Tuple[int, Optional[str]]]],
    recipes: Dict[int, Recipe],
    links_by_producer: Dict[int, List[CraftLink]],
    end_profession_whitelist: Set[str],
) -> List[List[Tuple[int, Optional[str]]]]:
    if not end_profession_whitelist:
        return chains

    filtered: List[List[Tuple[int, Optional[str]]]] = []
    for chain in chains:
        end_recipe_id = chain[-1][0]
        end_recipe = recipes.get(end_recipe_id)
        end_profession = get_recipe_profession_normalized(end_recipe) if end_recipe else None
        end_is_whitelisted = bool(end_profession and end_profession in end_profession_whitelist)

        # Keep intermediate endings if the chain can extend to n+1.
        visited = {recipe_id for recipe_id, _ in chain}
        end_feeds_next_step = any(
            link.consumer_recipe_id not in visited for link in links_by_producer.get(end_recipe_id, [])
        )

        if end_is_whitelisted or end_feeds_next_step:
            filtered.append(chain)
    return filtered


def filter_opportunities_by_end_profession(
    opportunities: List[dict],
    recipes: Dict[int, Recipe],
    links_by_producer: Dict[int, List[CraftLink]],
    end_profession_whitelist: Set[str],
) -> List[dict]:
    if not end_profession_whitelist:
        return opportunities

    filtered: List[dict] = []
    for row in opportunities:
        recipe_id = row.get("recipe_id")
        if not isinstance(recipe_id, int):
            continue

        recipe = recipes.get(recipe_id)
        profession = get_recipe_profession_normalized(recipe) if recipe else None
        in_whitelist = bool(profession and profession in end_profession_whitelist)

        # Mirror chain behavior: keep if this node feeds another step.
        feeds_next_step = bool(links_by_producer.get(recipe_id))

        if in_whitelist or feeds_next_step:
            filtered.append(row)
    return filtered


def build_consumer_producer_index(
    links_by_consumer: Dict[int, List[CraftLink]]
) -> Dict[int, Dict[str, Set[int]]]:
    consumer_producer_by_reagent: Dict[int, Dict[str, Set[int]]] = defaultdict(lambda: defaultdict(set))
    for consumer_id, links in links_by_consumer.items():
        for link in links:
            normalized = normalize_name(link.reagent_name)
            consumer_producer_by_reagent[consumer_id][normalized].add(link.producer_recipe_id)
    return consumer_producer_by_reagent


def gather_upstream(
    recipe_id: int,
    consumer_to_producers: Dict[int, Set[int]],
    depth_remaining: int,
    visited: Optional[Set[int]] = None,
) -> Set[int]:
    if depth_remaining <= 0:
        return set()
    if visited is None:
        visited = set()

    upstream: Set[int] = set()
    for producer_id in consumer_to_producers.get(recipe_id, set()):
        if producer_id in visited:
            continue
        upstream.add(producer_id)
        upstream.update(
            gather_upstream(
                recipe_id=producer_id,
                consumer_to_producers=consumer_to_producers,
                depth_remaining=depth_remaining - 1,
                visited=visited | {producer_id},
            )
        )
    return upstream


def format_recipe_label(recipe: Recipe) -> str:
    if recipe.profession_name:
        return f"{recipe.name} [{recipe.profession_name}]"
    if recipe.profession_id is not None:
        return f"{recipe.name} [profession {recipe.profession_id}]"
    return recipe.name


def analyze_opportunities(
    recipes: Dict[int, Recipe],
    links_by_consumer: Dict[int, List[CraftLink]],
    depth: int,
) -> List[dict]:
    consumer_producer_by_reagent = build_consumer_producer_index(links_by_consumer)
    consumer_to_producers: Dict[int, Set[int]] = defaultdict(set)
    for consumer_id, links in links_by_consumer.items():
        for link in links:
            consumer_to_producers[consumer_id].add(link.producer_recipe_id)

    opportunities: List[dict] = []
    for recipe in recipes.values():
        if not recipe.reagents:
            continue

        craftable_reagent_names: List[str] = []
        for reagent in recipe.reagents:
            if consumer_producer_by_reagent[recipe.recipe_id].get(reagent.normalized_name):
                craftable_reagent_names.append(reagent.name)

        if not craftable_reagent_names:
            continue

        upstream_recipes = gather_upstream(recipe.recipe_id, consumer_to_producers, depth_remaining=depth)
        opportunities.append(
            {
                "recipe_id": recipe.recipe_id,
                "recipe_name": recipe.name,
                "profession_id": recipe.profession_id,
                "profession_name": recipe.profession_name,
                "total_reagents": len(recipe.reagents),
                "craftable_reagents": len(craftable_reagent_names),
                "craftable_reagent_names": sorted(set(craftable_reagent_names)),
                "upstream_recipe_count_within_depth": len(upstream_recipes),
                "upstream_recipe_ids_within_depth": sorted(upstream_recipes),
                "craftable_ratio": len(craftable_reagent_names) / max(1, len(recipe.reagents)),
            }
        )

    opportunities.sort(
        key=lambda row: (
            -row["upstream_recipe_count_within_depth"],
            -row["craftable_reagents"],
            -row["craftable_ratio"],
            row["recipe_name"],
        )
    )
    return opportunities


def render_chain(chain: Sequence[Tuple[int, Optional[str]]], recipes: Dict[int, Recipe]) -> str:
    out_parts: List[str] = []
    for index, (recipe_id, reagent_name) in enumerate(chain):
        recipe = recipes.get(recipe_id)
        label = format_recipe_label(recipe) if recipe else f"recipe {recipe_id}"
        if index == 0:
            out_parts.append(label)
        else:
            out_parts.append(f"--({reagent_name})--> {label}")
    return " ".join(out_parts)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Analyze raw recipe JSON for crafting chains and vertical-integration opportunities. "
            "Output linkage is name-based because crafted output item IDs are often not reliable in this dataset."
        )
    )
    parser.add_argument(
        "--recipes-root",
        default=str(Path(__file__).resolve().parents[1] / "data" / "raw" / "midnight_recipes"),
        help="Root folder containing profession_*/recipes/*.json files.",
    )
    parser.add_argument(
        "--min-chain-length",
        type=int,
        default=3,
        help="Minimum number of recipes in a reported chain (default: 3).",
    )
    parser.add_argument(
        "--max-chain-length",
        type=int,
        default=6,
        help="Maximum number of recipes explored in a chain (default: 6).",
    )
    parser.add_argument(
        "--depth",
        type=int,
        default=3,
        help="Upstream depth used for opportunity scoring (default: 3).",
    )
    parser.add_argument(
        "--top",
        type=int,
        default=20,
        help="Number of top opportunities to print (default: 20).",
    )
    parser.add_argument(
        "--exclude-professions",
        default=DEFAULT_EXCLUDED_PROFESSIONS,
        help=(
            "Comma-separated profession names to exclude before chain/opportunity analysis "
            f"(default: {DEFAULT_EXCLUDED_PROFESSIONS}). "
            "Set to an empty string to disable exclusions."
        ),
    )
    parser.add_argument(
        "--end-profession-whitelist",
        default=DEFAULT_END_PROFESSION_WHITELIST,
        help=(
            "Comma-separated whitelist for the final recipe profession in chain output "
            f"(default: {DEFAULT_END_PROFESSION_WHITELIST}). "
            "If the chain end can feed an n+1 step, it is still included even when not whitelisted. "
            "Set to an empty string to disable this filter."
        ),
    )
    parser.add_argument(
        "--no-slot-types",
        action="store_true",
        help="Ignore modified crafting slot types as possible input reagents.",
    )
    parser.add_argument(
        "--exclude-slot-names",
        default=DEFAULT_EXCLUDED_SLOT_NAMES,
        help=(
            "Comma-separated substrings of slot names to exclude when slot types are enabled "
            f"(default: {DEFAULT_EXCLUDED_SLOT_NAMES})."
        ),
    )
    parser.add_argument(
        "--json-out",
        default=None,
        help="Optional path to write full analysis JSON.",
    )
    args = parser.parse_args()

    if args.min_chain_length < 2:
        raise ValueError("--min-chain-length must be >= 2.")
    if args.max_chain_length < args.min_chain_length:
        raise ValueError("--max-chain-length must be >= --min-chain-length.")
    if args.depth < 1:
        raise ValueError("--depth must be >= 1.")

    recipes_root = Path(args.recipes_root)
    exclude_slot_name_terms = parse_csv_terms(args.exclude_slot_names)
    all_recipes = load_recipes(
        recipes_root=recipes_root,
        include_slot_types=not args.no_slot_types,
        exclude_slot_name_terms=exclude_slot_name_terms,
    )
    excluded_professions = parse_excluded_professions(args.exclude_professions)
    recipes, removed_recipe_count = filter_recipes_by_profession(all_recipes, excluded_professions)
    producers_by_output_name, links, links_by_producer, links_by_consumer = build_crafting_links(recipes)
    end_profession_whitelist = parse_excluded_professions(args.end_profession_whitelist)
    all_chains = find_chains(links_by_producer, args.min_chain_length, args.max_chain_length)
    chains = filter_chains_by_end_profession(
        chains=all_chains,
        recipes=recipes,
        links_by_producer=links_by_producer,
        end_profession_whitelist=end_profession_whitelist,
    )
    all_opportunities = analyze_opportunities(recipes, links_by_consumer, depth=args.depth)
    opportunities = filter_opportunities_by_end_profession(
        opportunities=all_opportunities,
        recipes=recipes,
        links_by_producer=links_by_producer,
        end_profession_whitelist=end_profession_whitelist,
    )

    print(f"Loaded {len(all_recipes)} recipes from {recipes_root}")
    if excluded_professions:
        excluded_text = ", ".join(sorted(excluded_professions))
        print(f"Excluded professions: {excluded_text}")
        print(f"Recipes removed by profession filter: {removed_recipe_count}")
        print(f"Recipes remaining for analysis: {len(recipes)}")
    print(f"Distinct output names: {len(producers_by_output_name)}")
    print(f"Direct name-based crafting links: {len(links)}")
    if end_profession_whitelist:
        whitelist_text = ", ".join(sorted(end_profession_whitelist))
        print(f"Chain end whitelist: {whitelist_text}")
        print(f"Chains kept after end filter: {len(chains)}/{len(all_chains)}")
        print(f"Opportunities kept after end filter: {len(opportunities)}/{len(all_opportunities)}")
    print()

    print(
        f"Chains with length >= {args.min_chain_length} (max explored {args.max_chain_length}): {len(chains)}"
    )
    for chain in chains:
        print(render_chain(chain, recipes))
    if not chains:
        print("No chains found at or above the configured minimum length.")
    print()

    print(f"Top {min(args.top, len(opportunities))} vertical-integration opportunities (depth={args.depth})")
    for row in opportunities[: args.top]:
        profession = row["profession_name"] or row["profession_id"] or "unknown"
        print(
            f"- {row['recipe_name']} [{profession}] ({row['recipe_id']}): "
            f"{row['craftable_reagents']}/{row['total_reagents']} reagents craftable by chain, "
            f"{row['upstream_recipe_count_within_depth']} upstream recipes in depth window"
        )
        print(f"  Craftable reagents: {', '.join(row['craftable_reagent_names'])}")

    if args.json_out:
        out_path = Path(args.json_out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_data = {
            "recipes_count": len(recipes),
            "distinct_output_names": len(producers_by_output_name),
            "direct_links": [link.__dict__ for link in links],
            "chains": [
                [{"recipe_id": rid, "reagent_name_from_prev": reagent_name} for rid, reagent_name in chain]
                for chain in chains
            ],
            "opportunities": opportunities,
            "parameters": {
                "recipes_root": str(recipes_root),
                "min_chain_length": args.min_chain_length,
                "max_chain_length": args.max_chain_length,
                "depth": args.depth,
                "exclude_professions": sorted(excluded_professions),
                "end_profession_whitelist": sorted(end_profession_whitelist),
                "include_slot_types": not args.no_slot_types,
                "exclude_slot_names": exclude_slot_name_terms,
            },
        }
        out_path.write_text(json.dumps(out_data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print()
        print(f"Wrote analysis JSON to {out_path}")


if __name__ == "__main__":
    main()
