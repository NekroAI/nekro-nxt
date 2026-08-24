<p align="center">
  <img src="apps/web/public/brand/mark.svg" width="112" height="112" alt="NekroNXT Logo" />
</p>

<h1 align="center">NekroNXT</h1>

<p align="center"><strong>Bring intelligent agents into real group chats.</strong></p>

<p align="center">Multi-platform messaging · Multi-person conversations · Powered by DSH</p>

<p align="center"><a href="README.md">简体中文</a> · <a href="docs/README.md">Documentation</a> · <a href="https://github.com/NekroAI/nekro-nxt/releases/tag/preview">Download Preview</a></p>

NekroNXT is a group-chat agent system by NekroAI. It connects agents to messaging platforms through adapters, lets them follow real multi-person conversations, and keeps each channel in its own durable context.

## What makes it different

- **One integration model for messaging platforms.** Adapters provide account login, message delivery, and channel discovery without rebuilding the product flow for every platform.
- **Built for active group conversations.** Mentions and trigger rules can wake an agent; messages arriving during tool use are recorded and folded into the next reasoning step instead of being lost.
- **A real agent runtime powered by DSH.** DSH provides the reasoning loop, tool execution, persistent sessions, context compaction, model providers, and extension runtime. NekroNXT adds messaging integration, channel boundaries, observable delivery, and the product experience.
- **Agents that persist beyond one request.** Each agent has its own persona, model, permissions, channels, and extensions.
- **A verifiable creation loop.** Describe, run, inspect, revise, save, and then enable local extensions for selected agents.

## Product preview

![A multi-person channel conversation and runtime activity in NekroNXT](assets/brand/screenshots/channel-conversation.png)

[Agent workbench](assets/brand/screenshots/agent-workbench.png) · [Messaging connections](assets/brand/screenshots/connections.png) · [Extension creator](assets/brand/screenshots/creator-workbench.png)

All screenshots use fictional people, channels, and messages. Available messaging platforms depend on installed adapters.

## Get started

For a personal computer, download the macOS, Windows, or Linux package from the [rolling Preview release](https://github.com/NekroAI/nekro-nxt/releases/tag/preview). The desktop app includes the complete local runtime.

For a long-running server, replace the two placeholders and run:

```bash
docker run -d --name nekro-nxt --restart unless-stopped -p 127.0.0.1:4960:4960 -e NEKRO_MANAGEMENT_KEY='<management-key-at-least-32-characters>' -v '<persistent-data-directory>:/data' ghcr.io/nekroai/nekro-nxt:preview
```

The complete user documentation is currently maintained in Chinese: [Quick start](docs/guide/getting-started.md), [Desktop installation](docs/guide/desktop.md), [Server deployment](docs/guide/server.md), [Connect messaging channels](docs/guide/connections.md), and [Troubleshooting](docs/guide/troubleshooting.md).

NekroNXT is an early preview. The main user flow works today, while adapters, recovery coverage, and distribution are still being expanded.

The software license will be added by the project owner before public release. Brand and character assets are separately reserved; see [Brand guidelines](docs/BRAND.md) and [`NOTICE`](NOTICE).

Copyright © 2026 NekroAI contributors.
