# Data Pipeline (uv)

This folder is set up to run with **uv**.

## Quick start

1. Sync the environment (from this folder):

   uv sync

2. Run the scripts:

   uv run python download_icons.py
   uv run python fetch_recipes_from_ids.py
   uv run python normalize_recipes.py

## Notes

- Environment variables are read from `.env` in this folder.
- The environment is pinned by `uv.lock`.
