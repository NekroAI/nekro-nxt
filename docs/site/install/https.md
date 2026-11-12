---
summary: 让其他设备或公网通过 HTTPS 访问实例：反向代理与信任代理设置。
ui: [设置 → 登录与访问]
routes: [/settings/access]
keywords: [HTTPS, 反向代理, nginx, Caddy, 公网, 证书, NEKRO_TRUST_PROXY]
---

# 通过公网和 HTTPS 访问

[Docker 部署](docker.md)里的启动命令默认只允许本机访问。需要从其他设备访问时，把端口映射改为 `-p 4960:4960`，并在防火墙或反向代理中限制访问范围。

同一个端口同时接受 HTTPS 和 HTTP：

- `https://服务器地址:4960`：使用服务端自动生成的自签名证书（保存在 `/data/host/tls/`），浏览器首次访问需要手动信任；
- `http://服务器地址:4960`：不加密。登录页会先提示风险，确认后才能输入管理密钥；登录后界面底部显示「未加密连接」。只建议在可信的内网使用。

## 通过反向代理使用 HTTPS

公网访问建议在前面放一层反向代理（如 Caddy、nginx），由它提供域名证书，再转发到容器的 HTTP 端口。此时设置 `NEKRO_TRUST_PROXY`，服务端才会信任代理传来的 `X-Forwarded-Proto` 与 `X-Forwarded-Host`，把登录状态标记为安全连接：

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

代理需要转发 `Host`（或设置 `X-Forwarded-Host`）与 `X-Forwarded-Proto`，并用客户端地址覆盖 `X-Forwarded-For`：登录限流按它区分访问者。

`NEKRO_TRUST_PROXY` 的写法：

- `1`：信任所有连接的转发头。只在实例端口只有反向代理能访问时使用，例如上面把端口只发布到本机的 `-p 127.0.0.1:4960:4960`。
- 反向代理连接实例时用的地址，写 IP 地址，可以带 `/24` 这样的前缀表示网段，多个用逗号分隔。只有从这些地址来的连接，转发头才会被采用。实例端口对局域网或其他机器开放时用这种写法，否则能直接连到端口的人都可以伪造这些请求头，绕过登录限流。

`NEKRO_TRUST_PROXY` 需要和 `NEKRO_MANAGEMENT_KEY` 一起设置；没有管理密钥的实例不需要登录，会拒绝经过代理的请求。

Caddy 默认就会正确设置这些请求头，并自动申请证书：

```text
nxt.example.com {
    reverse_proxy 127.0.0.1:4960
}
```

nginx 示例：

```nginx
location / {
    proxy_pass http://127.0.0.1:4960;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    # 事件流和通知等待需要不缓冲、较长的超时
    proxy_buffering off;
    proxy_read_timeout 1h;
}
```

配好后在「设置 → 登录与访问」填写访问地址，例如 `https://nxt.example.com`。Bark、ntfy、企业微信的通知会带上打开对应页面的链接。
