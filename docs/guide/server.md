# 服务端部署

NekroNXT 服务端（Server）适合长期在线运行。一个容器保存全部程序，`/data` 保存需要持久化的数据。

## 一行启动

准备 Docker，把 `<管理密钥>` 替换为至少 32 个字符的随机字符串，把 `<持久化目录>` 替换为宿主机上的数据目录：

```bash
docker run -d --name nekro-nxt --restart unless-stopped -p 127.0.0.1:4960:4960 -e NEKRO_MANAGEMENT_KEY='<管理密钥>' -v '<持久化目录>:/data' ghcr.io/nekroai/nekro-nxt:preview
```

启动后访问 `https://127.0.0.1:4960`。首次连接需要核对自动生成的证书指纹，并使用管理密钥完成设备配对。

## Docker Compose

仓库中的 [`docker-compose.yml`](../../docker-compose.yml) 使用相同的预览镜像、命名数据卷和自动重启策略：

```bash
git clone https://github.com/NekroAI/nekro-nxt.git
cd nekro-nxt
NEKRO_MANAGEMENT_KEY='<至少32个字符的管理密钥>' docker compose up -d
```

查看状态与日志：

```bash
docker compose ps
docker compose logs -f nekro-nxt
```

## 从源码构建镜像

需要验证当前检出或修改服务端代码时，可以构建本地镜像：

```bash
NEKRO_IMAGE='nekro-nxt:local' pnpm dist:server
```

然后把上方 `docker run` 命令末尾的镜像名替换为 `nekro-nxt:local`。

## 远程访问与设备配对

首页命令默认只允许本机访问。需要从其他设备连接时，可以把端口映射改为 `-p 4960:4960`，并在防火墙或反向代理中限制访问范围。

服务端在 `/data/host/tls/` 保存自动 TLS 证书。管理密钥只用于设备配对证明；产品页面、API、事件流、资源和扩展界面都要求设备会话。在桌面版的实例菜单中添加服务端地址，核对证书指纹后完成配对。轮换管理密钥会撤销旧设备，需要重新配对。

## 数据、升级与备份

智能体、会话、扩展、资源、证书和工作区都位于 `/data`。升级时拉取新镜像并替换容器，不要在运行容器内执行 `git pull`：

```bash
docker pull ghcr.io/nekroai/nekro-nxt:preview
docker stop nekro-nxt
docker rm nekro-nxt
```

随后重新执行“一行启动”中的命令，继续挂载原持久化目录。升级前先备份完整 `/data`；详细恢复原则见[升级、备份与恢复](upgrade-backup.md)。
