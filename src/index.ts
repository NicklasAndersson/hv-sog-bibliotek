import { Env, SiteConfig } from './types';
import { renderTemplFull, renderSearchResults } from './render';
import { getSiteConfig } from './config';

async function listBucket(bucket: R2Bucket, options?: R2ListOptions): Promise<R2Objects> {
    // List all objects in the bucket, launch new request if list is truncated
    const objects: R2Object[] = [];
    const delimitedPrefixes: string[] = [];

    // delete limit, cursor in passed options
    const requestOptions = {
        ...options,
        limit: undefined,
        cursor: undefined,
    };

    var cursor = undefined;
    while (true) {
        const index = await bucket.list({
            ...requestOptions,
            cursor,
        });
        objects.push(...index.objects);
        delimitedPrefixes.push(...index.delimitedPrefixes);
        if (!index.truncated) {
            break;
        }
        cursor = index.cursor;
    }
    return {
        objects,
        delimitedPrefixes,
        truncated: false,
    };
}

function generateSitemap(domain: string, objects: R2Object[], decodeURI: boolean): string {
    const urls = objects.map((obj) => {
        const key = decodeURI ? encodeURIComponent(obj.key).replace(/%2F/g, '/') : obj.key;
        const lastmod = obj.uploaded.toISOString().split('T')[0];
        return `  <url>\n    <loc>https://${domain}/${key}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`;
    });
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`;
}

function shouldReturnOriginResponse(originResponse: Response, siteConfig: SiteConfig): boolean {
    const isNotEndWithSlash = originResponse.url.slice(-1) !== '/';
    const is404 = originResponse.status === 404;
    const isZeroByte = originResponse.headers.get('Content-Length') === '0';
    const overwriteZeroByteObject = (siteConfig.dangerousOverwriteZeroByteObject ?? false) && isZeroByte;

    // order matters here
    if (isNotEndWithSlash) return true;
    if (is404) {
        return false;
    } else {
        return !overwriteZeroByteObject;
    }
}

/**
 * Break down base64 encoded authorization string into plain-text username and password
 * @param {string} authorization
 * @returns {string[]}
 */
function parseCredentials(authorization: string) {
    const parts = authorization.split(' ')
    const plainAuth = atob(parts[1])
    const credentials = plainAuth.split(':')
    return credentials
  }
  /**
   * Helper funtion to generate Response object
   * @param {string} message
   * @returns {Response}
   */
  function getUnauthorizedResponse(message: string) {
    let response = new Response(message, {
      status: 401,
    })
    response.headers.set('WWW-Authenticate', 'Basic realm="Secure Area"')
    return response
  }
  

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        const domain = url.hostname;

        // Serve robots.txt
        if (url.pathname === '/robots.txt') {
            return new Response('User-agent: *\nDisallow: /\n', {
                headers: {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Cache-Control': 'public, max-age=86400',
                },
            });
        }

        // Serve sitemap.xml without auth
        if (url.pathname === '/sitemap.xml') {
            const siteConfig = getSiteConfig(env, domain);
            if (!siteConfig) {
                return new Response('Not found', { status: 404 });
            }
            const index = await listBucket(siteConfig.bucket);
            const xml = generateSitemap(domain, index.objects, siteConfig.decodeURI ?? false);
            return new Response(xml, {
                headers: {
                    'Content-Type': 'application/xml; charset=utf-8',
                    'Cache-Control': 'public, max-age=3600',
                },
            });
        }

        const path = url.pathname;

        const siteConfig = getSiteConfig(env, domain);
        if (!siteConfig) {
            return fetch(request);
        }

        // Handle search (public, no auth required)
        const searchQuery = url.searchParams.get('q');
        if (searchQuery !== null) {
            const query = searchQuery.trim();
            if (query === '') {
                // Empty search query — redirect to root
                return Response.redirect(new URL('/', url).toString(), 302);
            }
            const bucket = siteConfig.bucket;
            const index = await listBucket(bucket, {
                include: ['httpMetadata', 'customMetadata'],
            });

            const lowerQuery = query.toLowerCase();
            const files = index.objects.filter((obj) => {
                if (obj.key.toLowerCase().includes(lowerQuery)) return true;
                const desp = siteConfig.desp['/' + obj.key];
                if (desp && desp.toLowerCase().includes(lowerQuery)) return true;
                return false;
            });

            // Extract unique folder paths from matching files and all folders
            const folderSet = new Set<string>();
            for (const obj of index.objects) {
                const parts = obj.key.split('/');
                for (let i = 1; i < parts.length; i++) {
                    folderSet.add(parts.slice(0, i).join('/') + '/');
                }
            }
            const folders = Array.from(folderSet).filter((folder) => {
                if (folder.toLowerCase().includes(lowerQuery)) return true;
                const desp = siteConfig.desp['/' + folder.slice(0, -1)];
                if (desp && desp.toLowerCase().includes(lowerQuery)) return true;
                return false;
            });

            if (siteConfig.sortFn?.files) {
                files.sort(siteConfig.sortFn.files);
            }
            if (siteConfig.sortFn?.folders) {
                folders.sort(siteConfig.sortFn.folders);
            }

            return new Response(renderSearchResults(files, folders, query, siteConfig), {
                headers: { 'Content-Type': 'text/html; charset=utf-8' },
                status: 200,
            });
        }

        // remove the leading '/'
        const objectKey = siteConfig.decodeURI ? decodeURIComponent(path.slice(1)) : path.slice(1);

        // File downloads (non-directory paths) require Basic Auth
        if (path.slice(-1) !== '/') {
            const authorization = request.headers.get('authorization');
            if (!authorization) {
                return getUnauthorizedResponse(
                'Ange användarnamn och lösenord för att ladda ner filer.',
                );
            }
            const credentials = parseCredentials(authorization);
            if (credentials[0] !== env.AUTH_USERNAME || credentials[1] !== env.AUTH_PASSWORD) {
                return getUnauthorizedResponse(
                'Felaktigt användarnamn eller lösenord.',
                );
            }
        }

        const originResponse = await fetch(request);

        // Handle redirect if configured
        if (siteConfig.redirect) {
            const { key: redirectKey, force: forceRedir } = await siteConfig.redirect(siteConfig.bucket, objectKey);
            if (redirectKey !== objectKey) {
                // If force is false, only redirect when the original key does not exist
                if (forceRedir && originResponse.status !== 404) {
                    console.warn(`Force redirect from ${objectKey} to ${redirectKey} while ${objectKey} exist`);
                }
                if (forceRedir || originResponse.status === 404) {
                    const redirectURL = new URL(request.url);
                    redirectURL.pathname = '/' + (siteConfig.decodeURI ? encodeURIComponent(redirectKey) : redirectKey);
                    return Response.redirect(redirectURL.toString(), 302);
                }
            }
        }

        if (shouldReturnOriginResponse(originResponse, siteConfig)) {
            return originResponse;
        }

        const bucket = siteConfig.bucket;
        const index = await listBucket(bucket, {
            prefix: objectKey,
            delimiter: '/',
            include: ['httpMetadata', 'customMetadata'],
        });
        // filter out key===prefix, appears when dangerousOverwriteZeroByteObject===true
        const files = index.objects.filter((obj) => obj.key !== objectKey);
        const folders = index.delimitedPrefixes.filter((prefix) => prefix !== objectKey);
        // Apply custom sorting if provided
        if (siteConfig.sortFn?.files) {
            files.sort(siteConfig.sortFn.files);
        }
        if (siteConfig.sortFn?.folders) {
            folders.sort(siteConfig.sortFn.folders);
        }
        // If no object found, return origin 404 response. Only return 404 because if there is a zero byte object,
        // user may want to show a empty folder.
        if (files.length === 0 && folders.length === 0 && originResponse.status === 404) {
            return originResponse;
        }
        return new Response(renderTemplFull(files, folders, '/' + objectKey, siteConfig, searchQuery ?? undefined), {
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
            },
            status: 200,
        });
    },
};
