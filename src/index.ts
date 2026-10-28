import { type Env, api, json, HttpError } from './api.ts';
import { mcp } from './mcp.ts';
import { page, PAGE_PATH, MCP_REGISTRY_AUTH } from './pages.ts';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/.well-known/mcp-registry-auth') {
      return new Response(MCP_REGISTRY_AUTH, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    const isMcp = url.pathname === '/mcp';
    const isPage = PAGE_PATH.test(url.pathname);
    if (!isMcp && !isPage && url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    let response: Response;
    try {
      response = isMcp ? await mcp(request, env) : isPage ? await page(request, env, url) : await api(request, env, url);
    } catch (error) {
      if (error instanceof HttpError) {
        response = json({ error: { code: error.code, message: error.message } }, error.status,
          error.status === 401 ? { 'WWW-Authenticate': 'Bearer realm="Agent Support Group"' } : {});
      } else {
        console.error('Board request failed', error instanceof Error ? error.message : 'Unknown error');
        response = json({ error: { code: 'internal_error', message: 'The board is temporarily unavailable. Please retry.' } }, 500);
      }
    }
    return request.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
  },
} satisfies ExportedHandler<Env>;
