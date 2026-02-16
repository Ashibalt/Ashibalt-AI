import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

/**
 * Fetch a URL via HTTP/HTTPS GET. Returns status code, headers, and body.
 * Useful for checking if a dev server is running, debugging web apps, etc.
 */
export async function fetchUrlTool(args: any): Promise<any> {
  if (!args || typeof args.url !== 'string') {
    return { error: 'fetch_url requires url (string)' };
  }

  const urlStr = args.url;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlStr);
  } catch {
    return { error: `Invalid URL: ${urlStr}` };
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return { error: `Only HTTP and HTTPS URLs are supported. Got: ${parsedUrl.protocol}` };
  }

  const method = ((args.method as string) || 'GET').toUpperCase();
  const timeoutMs = Math.min(args.timeout_ms || 10000, 30000);
  const maxBodySize = 50000; // 50KB max

  return new Promise<any>((resolve) => {
    const client = parsedUrl.protocol === 'https:' ? https : http;

    const reqOptions: http.RequestOptions = {
      method,
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'Ashibalt-AI/1.0',
        'Accept': 'text/html,application/json,text/plain,*/*'
      }
    };

    // Allow self-signed certs for localhost dev servers
    if (parsedUrl.protocol === 'https:' && (parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '127.0.0.1')) {
      (reqOptions as any).rejectUnauthorized = false;
    }

    const req = client.request(parsedUrl, reqOptions, (res) => {
      let body = '';
      let truncated = false;

      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        if (body.length < maxBodySize) {
          body += chunk;
          if (body.length > maxBodySize) {
            body = body.slice(0, maxBodySize);
            truncated = true;
          }
        }
      });

      res.on('end', () => {
        // Extract important headers
        const headers: Record<string, string> = {};
        const importantHeaders = ['content-type', 'content-length', 'server', 'location', 'x-powered-by'];
        for (const h of importantHeaders) {
          if (res.headers[h]) {
            headers[h] = Array.isArray(res.headers[h]) ? (res.headers[h] as string[]).join('; ') : String(res.headers[h]);
          }
        }

        resolve({
          success: true,
          status_code: res.statusCode,
          status_message: res.statusMessage,
          headers,
          body,
          truncated,
          body_length: body.length,
          url: urlStr
        });
      });
    });

    req.on('error', (err) => {
      resolve({
        success: false,
        error: err.message,
        url: urlStr,
        hint: 'Connection failed. Is the server running? Check the URL and port.'
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        success: false,
        error: `Request timed out after ${timeoutMs}ms`,
        url: urlStr
      });
    });

    req.end();
  });
}
