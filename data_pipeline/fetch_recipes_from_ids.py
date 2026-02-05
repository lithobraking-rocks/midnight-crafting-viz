#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path
from typing import Iterable, List, Tuple

import httpx
from dotenv import load_dotenv
from tqdm import tqdm


def parse_csv_ints(text: str) -> List[int]:
    raw = [part.strip() for part in text.replace("\n", ",").split(",")]
    ids: List[int] = []
    for part in raw:
        if not part:
            continue
        try:
            ids.append(int(part))
        except ValueError:
            raise ValueError(f"Invalid id: {part!r}") from None
    return ids


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


def iter_ids(ids: Iterable[int]) -> Iterable[int]:
    for rid in ids:
        if rid <= 0:
            continue
        yield rid


def parse_base_professions(path: Path) -> List[Tuple[int, str | None]]:
    if path.suffix.lower() == ".json":
        data = json.loads(path.read_text(encoding="utf-8"))
        entries: List[Tuple[int, str | None]] = []
        if isinstance(data, list):
            for item in data:
                if isinstance(item, int):
                    entries.append((item, None))
                elif isinstance(item, dict):
                    pid = item.get("profession_id") or item.get("id")
                    name = item.get("profession_name") or item.get("name")
                    if isinstance(pid, int):
                        entries.append((pid, name if isinstance(name, str) else None))
        return entries

    text = path.read_text(encoding="utf-8")
    entries: List[Tuple[int, str | None]] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        parts = [p.strip() for p in line.split(",")]
        if not parts:
            continue
        try:
            pid = int(parts[0])
        except ValueError:
            continue
        name = parts[1] if len(parts) > 1 and parts[1] else None
        entries.append((pid, name))
    if not entries:
        entries = [(pid, None) for pid in parse_csv_ints(text)]
    return entries


def extract_recipe_ids(skill_tier_json: dict) -> List[int]:
    ids: List[int] = []
    for category in skill_tier_json.get("categories", []):
        for recipe in category.get("recipes", []):
            rid = recipe.get("id")
            if isinstance(rid, int):
                ids.append(rid)
    return ids


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fetch Midnight-tier recipes from a base profession list."
    )
    parser.add_argument(
        "--base-professions",
        default=str(Path(__file__).resolve().parent / "base_profession_ids.json"),
        help="Path to CSV or JSON containing base profession ids.",
    )
    parser.add_argument(
        "--tier-name",
        default="Midnight",
        help="Skill tier name filter (default: Midnight).",
    )
    parser.add_argument("--region", default=None)
    parser.add_argument("--namespace", default=None)
    parser.add_argument("--locale", default=None)
    parser.add_argument("--client-id", default=None)
    parser.add_argument("--client-secret", default=None)
    parser.add_argument("--sleep", type=float, default=0.05, help="Seconds to sleep between requests.")
    parser.add_argument(
        "--out-dir",
        default=str(Path(__file__).resolve().parents[1] / "data" / "raw" / "midnight_recipes"),
        help="Output directory for JSON files.",
    )
    args = parser.parse_args()

    cfg = load_config(args)
    base = f"https://{cfg['region']}.api.blizzard.com"

    base_professions = parse_base_professions(Path(args.base_professions))
    if not base_professions:
        raise RuntimeError("No base professions found in base_professions file.")

    with httpx.Client() as client:
        token = get_oauth_token(client, cfg)
        headers = {"Authorization": f"Bearer {token}"}
        params = {"namespace": cfg["namespace"], "locale": cfg["locale"]}

        out_dir = Path(args.out_dir)
        ok: List[int] = []
        failed: List[Tuple[int, str]] = []
        missing_tier: List[Tuple[int, str | None]] = []
        per_profession: List[dict] = []

        for pid, pname in tqdm(base_professions, desc="Professions", unit="profession"):
            try:
                prof_url = f"{base}/data/wow/profession/{pid}"
                prof_json = fetch_json(client, prof_url, params, headers)

                tier_id = None
                tier_name = None
                tiers = prof_json.get("skill_tiers", [])
                exact_match = None
                contains_match = None
                for tier in tiers:
                    name = tier.get("name", "")
                    if not isinstance(name, str):
                        continue
                    if name.lower() == f"{args.tier_name} {pname or ''}".strip().lower():
                        exact_match = tier
                        break
                    if name.lower().startswith(args.tier_name.lower() + " "):
                        exact_match = tier
                        break
                    if args.tier_name.lower() in name.lower():
                        contains_match = contains_match or tier

                chosen = exact_match or contains_match
                if chosen:
                    tier_id = chosen.get("id")
                    tier_name = chosen.get("name")

                if not isinstance(tier_id, int):
                    missing_tier.append((pid, pname))
                    per_profession.append(
                        {
                            "profession_id": pid,
                            "profession_name": pname,
                            "midnight_tier_id": None,
                            "recipe_ids": [],
                            "ok": [],
                            "failed": [],
                        }
                    )
                    continue

                tier_url = f"{base}/data/wow/profession/{pid}/skill-tier/{tier_id}"
                tier_json = fetch_json(client, tier_url, params, headers)
                recipe_ids = extract_recipe_ids(tier_json)

                prof_dir = out_dir / f"profession_{pid}"
                save_json(prof_dir / "profession.json", prof_json)
                save_json(prof_dir / "skill_tier.json", tier_json)

                prof_ok: List[int] = []
                prof_failed: List[Tuple[int, str]] = []

                for rid in tqdm(list(iter_ids(recipe_ids)), desc=f"Recipes {pid}", unit="recipe", leave=False):
                    try:
                        recipe_url = f"{base}/data/wow/recipe/{rid}"
                        media_url = f"{base}/data/wow/media/recipe/{rid}"
                        recipe_json = fetch_json(client, recipe_url, params, headers)
                        media_json = fetch_json(client, media_url, params, headers)
                        save_json(prof_dir / "recipes" / f"{rid}.json", recipe_json)
                        save_json(prof_dir / "recipe_media" / f"{rid}.json", media_json)
                        ok.append(rid)
                        prof_ok.append(rid)
                    except Exception as exc:
                        failed.append((rid, str(exc)))
                        prof_failed.append((rid, str(exc)))
                    if args.sleep > 0:
                        time.sleep(args.sleep)

                per_profession.append(
                    {
                        "profession_id": pid,
                        "profession_name": pname,
                        "midnight_tier_id": tier_id,
                        "midnight_tier_name": tier_name,
                        "recipe_ids": recipe_ids,
                        "ok": prof_ok,
                        "failed": [{"id": rid, "error": err} for rid, err in prof_failed],
                    }
                )
            except Exception as exc:
                failed.append((pid, f"profession_fetch_error: {exc}"))

    summary = {
        "base_professions": [
            {"profession_id": pid, "profession_name": pname} for pid, pname in base_professions
        ],
        "missing_midnight_tier": [
            {"profession_id": pid, "profession_name": pname} for pid, pname in missing_tier
        ],
        "total_recipes_attempted": len(ok) + len([f for f in failed if isinstance(f[0], int)]),
        "ok": ok,
        "failed": [{"id": rid, "error": err} for rid, err in failed],
        "per_profession": per_profession,
        "region": cfg["region"],
        "namespace": cfg["namespace"],
        "locale": cfg["locale"],
        "tier_name_filter": args.tier_name,
    }
    save_json(out_dir / "summary.json", summary)
    print(f"Done. ok={len(ok)} failed={len(failed)} missing_tier={len(missing_tier)}")


if __name__ == "__main__":
    main()
