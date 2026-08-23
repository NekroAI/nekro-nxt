# Server 部署

NekroNXT Server 面向长期运行，目标形态是一个容器、一个主要 `/data` 和少量必要环境变量。

![Server 容器、数据卷与 Desktop 连接](../../assets/brand/raster/install-server.webp)

## 准备

- Docker Engine 与 Docker Compose；
- 至少 32 个字符的随机管理密钥；
- 一个持久化 `/data`；
- 需要远程访问时，明确的网络和备份方案。

## 启动

```bash
git clone https://github.com/NekroAI/nekro-nxt.git
cd nekro-nxt
NEKRO_MANAGEMENT_KEY='请替换为至少32个字符的随机字符串' docker compose up --build -d
```

默认映射到 `127.0.0.1:4960`。`compose.yaml` 使用命名卷保存 `/data`，并设置 `restart: unless-stopped`。

查看状态：

```bash
docker compose ps
docker compose logs -f nekro-nxt
```

## 远程访问与设备配对

服务暴露到非 loopback 地址时必须设置管理密钥。Server 在 `/data/host/tls/` 保存自动 TLS 证书，管理密钥只用于设备配对证明；产品页面、API、SSE、资源和扩展界面要求设备会话。

在 Desktop 的实例浮层中添加 Server 地址，核对证书指纹并完成配对。轮换管理密钥会撤销旧设备，需要重新配对。

## 数据

所有生产数据归入 `/data`。智能体开发工作区位于 `/data/workspaces/<agentId>/`；DSH、扩展、资源、Host 证书和 Core 数据各有自己的所有者目录。不要在运行容器中执行 `git pull`，升级使用新镜像替换容器。

备份与恢复见[升级、备份与恢复](upgrade-backup.md)。
