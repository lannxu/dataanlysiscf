# Talent Review Tool 4.1 - 人才盘点 / 九宫格评估系统

运行于 Cloudflare Workers + Durable Objects：前端静态资源由 Workers Assets 托管，全部状态保存在单例 Durable Object 的 storage 中，无需数据库，也无需 VPS。

线上地址：<https://anlysis2.19891103.xyz>

## 开发与部署

```bash
npm install
npm run dev       # 本地开发：http://localhost:8787
npm run deploy    # 部署到 Cloudflare（需先 npx wrangler login）
```

## 结构

* `src/worker.mjs` — Worker 入口：路由分发、静态资源、受保护页面的登录门禁、WebSocket 升级

* `src/store.mjs` — 单例 Durable Object：全部 API、WebSocket Hibernation 实时广播、storage 持久化

* `public/` — 前端页面（主持后台 / 手机评估 / 结果总览），无框架，纯原生 HTML/CSS/JS

## 数据备份与迁移

* 备份：登录管理员后 `GET /api/admin/export-store`，可导出全部讨论区、账号与投票数据

* 导入：`POST /api/admin/import-store`，提交旧版 `data/session.json` 内容即可迁移

## 验证

```text
https://anlysis2.19891103.xyz/healthz
https://anlysis2.19891103.xyz/home.html
```

`/healthz` 应返回 `{"ok":true,...}`。主持后台切换员工时，手机页面应实时同步。

> 历史版本（Node/Express + Docker + Nginx 部署）已从仓库移除，如需查看可翻阅 git 历史或 CHANGELOG.md。

