# Talent Review Tool 4.0 - 人才盘点 / 九宫格评估系统

## Cloudflare Workers 部署（新版，推荐）

应用已迁移到 Cloudflare Workers + Durable Objects，前端静态资源由 Workers Assets 托管，全部状态保存在单例 Durable Object 的 storage 中，无需数据库。

```bash
pnpm install
pnpm dev:cf       # 本地开发：http://localhost:8787
pnpm deploy:cf    # 部署到 Cloudflare（需先 wrangler login）
```

- 结构：`src/worker.mjs` 为入口（路由/静态资源/登录门禁），`src/store.mjs` 为 Durable Object（全部 API + WebSocket 实时同步 + 持久化）。
- 迁移旧数据：登录管理员后，把旧版 `data/session.json` 的内容 POST 到 `/api/admin/import-store`；`GET /api/admin/export-store` 可随时备份。
- 自定义域名/二维码地址：在 Cloudflare Dashboard 设置 `PUBLIC_URL` 环境变量（对应旧版 `.env` 的 `PUBLIC_URL`）。

## 本地运行（旧版 Node 模式）

```powershell
$env:PORT="3100"
$env:PUBLIC_URL="http://192.168.31.227:3100"
node server.mjs
```

讨论区首页：`http://localhost:3100/home.html`

## Docker 部署

```bash
cp .env.example .env
# 编辑 .env，将 PUBLIC_URL 改为正式域名
docker compose up -d --build
```

生产环境中，应用通过 VPS 本机 `127.0.0.1:3001` 提供给 Nginx，域名流量由 Nginx 转发到该端口。Docker Compose 已将端口限制绑定到 `127.0.0.1:3001`，不会直接暴露到公网。现场数据保存在 `data/session.json`，Docker 已将该目录设置为持久化目录。

## Nginx 反向代理与域名

项目支持 Nginx 反向代理、HTTPS 域名和 WebSocket 实时同步。

1. 将 `deploy/nginx-talent-review.conf.example` 复制到 Nginx 配置目录。
2. 把配置中的 `talent.example.com` 替换为正式域名。
3. 如果应用端口不是 `3001`，修改 `upstream talent_review_app` 中的端口。
4. 检查并重载 Nginx：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

5. 使用 Certbot 或公司证书为域名启用 HTTPS，并在 `.env` 中设置：

```dotenv
PUBLIC_URL=https://你的域名
```

Nginx 必须转发 `Host`、`X-Forwarded-Host`、`X-Forwarded-Proto`，并保留 WebSocket 的 `Upgrade` 和 `Connection` 请求头。示例配置已包含这些设置。

## 验证

```text
https://你的域名/healthz
https://你的域名/home.html
```

`/healthz` 应返回 `{"ok":true,...}`。主持后台切换员工时，手机页面应实时同步。