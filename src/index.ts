import { Env, SiteConfig } from './types';
import { renderTemplFull, renderSearchResults, renderAuthPrompt } from './render';
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

function shouldReturnOriginResponse(originResponse: Response, siteConfig: SiteConfig): boolean {
    const isNotEndWithSlash = new URL(originResponse.url).pathname.slice(-1) !== '/';
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
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

// Keyed on the credentials, so changing AUTH_PASSWORD invalidates every session.
function sessionKey(env: Env) {
    return crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(`${env.AUTH_USERNAME}:${env.AUTH_PASSWORD}`),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify'],
    );
}

async function createSessionCookie(env: Env): Promise<string> {
    const exp = String(Date.now() + SESSION_MAX_AGE * 1000);
    const sig = await crypto.subtle.sign('HMAC', await sessionKey(env), new TextEncoder().encode(exp));
    const value = `${exp}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`;
    return `session=${value}; Path=/; Max-Age=${SESSION_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}

async function hasValidSession(request: Request, env: Env): Promise<boolean> {
    const match = (request.headers.get('cookie') ?? '').match(/(?:^|;\s*)session=([^;]+)/);
    if (!match) return false;
    const [exp, sig] = match[1].split('.');
    if (!sig || !(Number(exp) > Date.now())) return false;
    try {
        const sigBytes = Uint8Array.from(atob(sig), (c) => c.charCodeAt(0));
        return await crypto.subtle.verify('HMAC', await sessionKey(env), sigBytes, new TextEncoder().encode(exp));
    } catch {
        return false;
    }
}

  /**
   * Helper funtion to generate Response object
   * @param {string} message
   * @returns {Response}
   */
  function getUnauthorizedResponse(message: string) {
    // No WWW-Authenticate header: file downloads are guarded by the custom
    // login dialog (renderAuthPrompt) instead of the browser's native Basic
    // Auth prompt, so we never want the browser popping up its own dialog.
    return new Response(message, {
      status: 401,
    })
  }


export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        const domain = url.hostname;

        // Serve robots.txt — browsing/search is public and should be
        // indexable; file downloads are separately gated by Basic Auth
        // below, so crawlers requesting a file simply get a 401.
        if (url.pathname === '/robots.txt') {
            return new Response('User-agent: *\nAllow: /\n', {
                headers: {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Cache-Control': 'public, max-age=86400',
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
            // Login form submission: set a session cookie and redirect back to the file's folder listing.
            if (request.method === 'POST') {
                const form = await request.formData().catch(() => new FormData());
                if (form.get('username') !== env.AUTH_USERNAME || form.get('password') !== env.AUTH_PASSWORD) {
                    return new Response(renderAuthPrompt(path, siteConfig, 'Felaktigt användarnamn eller lösenord.'), {
                        headers: { 'Content-Type': 'text/html; charset=utf-8' },
                        status: 401,
                    });
                }
                return new Response(null, {
                    status: 303,
                    headers: {
                        Location: path.slice(0, path.lastIndexOf('/') + 1) + '?download=' + encodeURIComponent(path.slice(path.lastIndexOf('/') + 1)),
                        'Set-Cookie': await createSessionCookie(env),
                    },
                });
            }

            const authorization = request.headers.get('authorization');
            if (authorization) {
                const credentials = parseCredentials(authorization);
                if (credentials[0] !== env.AUTH_USERNAME || credentials[1] !== env.AUTH_PASSWORD) {
                    return getUnauthorizedResponse(
                    'Felaktigt användarnamn eller lösenord.',
                    );
                }
            } else if (!(await hasValidSession(request, env))) {
                if ((request.headers.get('accept') ?? '').includes('text/html')) {
                    return new Response(renderAuthPrompt(path, siteConfig), {
                        headers: { 'Content-Type': 'text/html; charset=utf-8' },
                        status: 401,
                    });
                }
                return getUnauthorizedResponse(
                'Ange användarnamn och lösenord för att ladda ner filer.',
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
        return new Response(renderTemplFull(files, folders, '/' + objectKey, siteConfig, searchQuery ?? undefined, url.searchParams.get('download') ?? undefined), {
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
            },
            status: 200,
        });
    },
};
