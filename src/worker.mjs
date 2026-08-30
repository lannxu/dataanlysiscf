import { TalentStore } from './store.mjs';

// Durable Object 类必须从入口模块导出，供 wrangler 迁移注册
export { TalentStore };

// 需要登录态的页面（与原 server.mjs protectedPages 一致）
const protectedPages = new Set([
  '/home.html', '/admin.html', '/summary.html',
  '/initial-results.html', '/accounts.html', '/change-password.html'
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const upgrade = request.headers.get('Upgrade') === 'websocket';

    // WebSocket 升级（手机端实时同步）：全部交给 DO 处理
    if (upgrade) return doFetch(request, env);

    if (url.pathname === '/healthz') {
      return Response.json({ ok: true, version: '4.1.0-cf' });
    }

    // 所有 API 请求进入 DO（无同名静态文件，天然落到 Worker）
    if (url.pathname.startsWith('/api/')) return doFetch(request, env);

    // 根路径：DO 不需要处理非升级请求，直接给手机端首页
    if (url.pathname === '/') {
      return env.ASSETS.fetch(new URL('/index.html', url));
    }

    // 受保护页面：先问 DO 要登录态/房间权限
    if (protectedPages.has(url.pathname)) {
      const guard = await doFetch(new Request(
        'https://do/api/internal/page-guard?path=' + encodeURIComponent(url.pathname + url.search),
        { headers: { cookie: request.headers.get('cookie') || '' }, redirect: 'manual' }
      ), env);
      // 200 = 放行；302/403 = 原样转发（登录跳转或拒绝）
      if (guard.status !== 200) return guard;
      return env.ASSETS.fetch(request);
    }

    // 其余静态资源（login/pre/my-votes/index、css、js、xlsx 模板）直接托管
    return env.ASSETS.fetch(request);
  }
};

function doFetch(request, env) {
  const id = env.STORE.idFromName('global');
  return env.STORE.get(id).fetch(request);
}
