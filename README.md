# CoBot

Semantic search for co-ops, commons and community organisations worldwide, powered by the [Murmurations protocol](https://murmurations.network) and [OpenStreetMap](https://www.openstreetmap.org/).

**Live:** [cobot.murmurations.network](https://cobot.murmurations.network/)

## What it does

- Searches organisations by topic and location using AI-powered semantic search
- Chat and search modes with an interactive map
- Users can submit their own Murmurations profiles for instant indexing

## Stack

- Vanilla JS frontend with [MapLibre GL](https://maplibre.org/) for maps
- [Transformers.js](https://huggingface.co/docs/transformers.js) (all-MiniLM-L6-v2) for embeddings
- Express server (local dev) / Vercel serverless (production)
- Claude Haiku for query understanding and chat

## Running locally

```bash
npm install
cp .env.example .env  # add your ANTHROPIC_API_KEY
node server/index.js
```

Open [http://localhost:3000](http://localhost:3000).

The `ANTHROPIC_API_KEY` is optional — without it, chat mode is disabled and search still works.

## Data

Profile data comes from the [Murmurations Index API](https://docs.murmurations.network/) and [OpenStreetMap](https://www.openstreetmap.org/) via the Overpass API. Run `node scripts/fetch-profiles.js` and `node scripts/fetch-osm.js` to rebuild the dataset.

## Contributing

Contributions welcome. [Get in touch](https://open.coop/contact/) if you'd like to help or have datasets to contribute.

Built by [The Open Co-op](https://open.coop). [Donate](https://opencollective.com/murmurations) to help keep it running.
