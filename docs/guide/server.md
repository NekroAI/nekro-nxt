# 服务端部署

NekroNXT 服务端（Server）适合长期在线运行。一个容器保存全部程序，`/data` 保存需要持久化的数据。

## 启动容器

准备 Docker，把 `<管理密钥>` 替换为至少 32 个字符的随机字符串，把 `<持久化目录>` 替换为宿主机上的数据目录：

```bash
docker run -d \
  --name nekro-nxt \
  --restart unless-stopped \
  -p 127.0.0.1:4960:4960 \
  -e NEKRO_MANAGEMENT_KEY='<管理密钥>' \
  -e TZ='Asia/Shanghai' \
  -v '<持久化目录>:/data' \
  ghcr.io/nekroai/nekro-nxt:latest
```

镜像同时提供 x86_64（amd64）和 ARM64 两种架构，适用于常见的 x86 服务器，也适用于树莓派 4/5、ARM 云服务器和 ARM 架构的 NAS；Docker 会自动拉取与宿主机匹配的版本。

在国内网络下拉取 `ghcr.io` 较慢或失败时，可以把镜像地址换成 Docker Hub 上的同一镜像 `kromiose/nekro-nxt:latest`（正式版同时发布到两处，内容一致，版本说明里列出了镜像摘要可以核对）。

`TZ` 是服务端所在的时区（IANA 名称），决定智能体看到的消息时间和定时任务的默认时区；不设置时容器使用 UTC。请设为频道成员实际所在的时区，否则成员说「下午三点」时，智能体会按 UTC 理解。

启动后用浏览器打开 `http://127.0.0.1:4960`，输入管理密钥登录即可使用网页界面；这台浏览器会保持登录 30 天。也可以在桌面版的实例菜单中添加这台服务端。

## Docker Compose

仓库中的 [`docker-compose.yml`](../../docker-compose.yml) 使用正式版镜像、命名数据卷和自动重启策略：

```bash
git clone https://github.com/NekroAI/nekro-nxt.git
cd nekro-nxt
NEKRO_MANAGEMENT_KEY='<至少32个字符的管理密钥>' TZ='Asia/Shanghai' docker compose up -d
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

## 网页访问与登录

首页命令默认只允许本机访问。需要从其他设备访问时，把端口映射改为 `-p 4960:4960`，并在防火墙或反向代理中限制访问范围。

同一个端口同时接受 HTTPS 和 HTTP：

- `https://服务器地址:4960`：使用服务端自动生成的自签名证书（保存在 `/data/host/tls/`），浏览器首次访问需要手动信任；
- `http://服务器地址:4960`：不加密。登录页会先提示风险，确认后才能输入管理密钥；登录后界面底部显示「未加密连接」。只建议在可信的内网使用。

没有登录的浏览器打开任何页面都会先到登录页。登录后的浏览器出现在「设置 → 登录设备」中，可以看到每台设备的登录时间和最后活跃时间，并撤销任意设备；「退出登录」会让这台浏览器下次重新输入管理密钥。轮换管理密钥会撤销全部已登录设备。

### 通过反向代理使用 HTTPS

公网访问建议在前面放一层反向代理（如 Caddy、nginx），由它提供域名证书，再转发到容器的 HTTP 端口。此时设置 `NEKRO_TRUST_PROXY=1`，服务端才会信任代理传来的 `X-Forwarded-Proto` 与 `X-Forwarded-Host`，把登录状态标记为安全连接：

```bash
docker run -d \
  --name nekro-nxt \
  --restart unless-stopped \
  -p 127.0.0.1:4960:4960 \
  -e NEKRO_MANAGEMENT_KEY='<管理密钥>' \
  -e NEKRO_TRUST_PROXY=1 \
  -v '<持久化目录>:/data' \
  ghcr.io/nekroai/nekro-nxt:latest
```

代理需要转发 `Host`（或设置 `X-Forwarded-Host`）与 `X-Forwarded-Proto`。只有容器端口不直接暴露给其他机器时才开启这个选项，否则任何人都能伪造这两个请求头。

### 桌面版连接

在桌面版的实例菜单中添加服务端地址，核对证书指纹后用管理密钥完成配对。桌面版设备同样出现在「登录设备」中。

## 数据、升级与备份

智能体、会话、扩展、资源、证书和工作区都位于 `/data`。升级时拉取新镜像并替换容器，不要在运行容器内执行 `git pull`：

```bash
docker pull ghcr.io/nekroai/nekro-nxt:latest   # 或 docker pull kromiose/nekro-nxt:latest
docker stop nekro-nxt
docker rm nekro-nxt
```

随后重新执行“启动容器”中的命令，继续挂载原持久化目录。升级前先备份完整 `/data`；详细恢复原则见[升级、备份与恢复](upgrade-backup.md)。
