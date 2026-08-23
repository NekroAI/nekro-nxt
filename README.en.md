<p align="center">
  <img src="apps/web/public/brand/mark.svg" width="112" height="112" alt="NekroNXT Logo" />
</p>

<h1 align="center">NekroNXT</h1>

<p align="center"><strong>Bring persistent agents into real group chats—and let them help create their own extensions.</strong></p>

<p align="center"><a href="README.md">简体中文</a> · <a href="docs/README.md">Documentation</a></p>

![Shuiyue Ying at the NekroNXT Moon-Tide Observatory](assets/brand/raster/readme-hero.png)

NekroNXT is an extensible agent chat system by NekroAI. It uses DSH as its core engine, keeps each channel in an isolated fact stream, supports built-in and adapter-provided channels, and provides a local dynamic-extension workflow.

## Highlights

- Persistent agents with independent personas, models, permissions, channels, and extensions;
- Channel-scoped history and runtime context instead of cross-chat context mixing;
- Explicit communication tools and observable delivery results;
- Describe → run → verify → save → enable workflow for local extensions;
- A shared core and Web UI across installable Desktop and long-running Server hosts.

## Try the Preview

Desktop builds include the matching Server runtime and Web UI. Download a platform package and its receipt from the [rolling Preview Release](https://github.com/NekroAI/nekro-nxt/releases/tag/preview). Current builds are unsigned.

For a Server checkout:

```bash
git clone https://github.com/NekroAI/nekro-nxt.git
cd nekro-nxt
NEKRO_MANAGEMENT_KEY='replace-with-at-least-32-random-characters' docker compose up --build -d
```

The complete user documentation is currently maintained in Chinese: [Quick start](docs/guide/getting-started.md), [Desktop](docs/guide/desktop.md), [Server](docs/guide/server.md), [Troubleshooting](docs/guide/troubleshooting.md), and [Contributor guide](docs/guide/contributors.md).

## Project status

NekroNXT is an early preview. The MVP flow is largely in place, while package signing, automatic whole-product replacement, recovery coverage, and more platform adapters are still being validated. Do not use irreplaceable production data yet.

The software license will be added by the project owner before the repository becomes public. Brand and character assets are separately reserved; see [`BRAND.md`](BRAND.md) and [`NOTICE`](NOTICE).

Copyright © 2026 NekroAI contributors.
