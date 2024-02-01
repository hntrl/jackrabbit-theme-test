/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
import libCookie, { CookieSerializeOptions } from 'cookie';
import setCookie, { Cookie } from 'set-cookie-parser';

const THEME_EXPERIMENT_ID = 'asdfasdf';

function clearPreviewCookies(headers: Headers) {
	const cookies = libCookie.parse(headers.get('Cookie') || '');
	delete cookies['preview_theme'];
	delete cookies['_secure_session_id'];
	const stringifiedCookies = Object.entries(cookies)
		.map(([key, value]) => `${key}=${value}`)
		.join('; ');
	headers.set('Cookie', stringifiedCookies);
}

async function getPreviewSessionId(request: Request, themeId: string) {
	const url = new URL('https://platter.outsmartly.app/');
	url.searchParams.set('preview_theme_id', themeId);

	const headers = new Headers(request.headers);
	headers.set('Host', 'platter.outsmartly.app');
	clearPreviewCookies(headers);

	const response = await fetch(
		url.toString(),
		new Request(request, {
			method: 'GET',
			body: null,
			headers,
		})
	);
	// @ts-ignore - The implementation of headers in Cloudflare doesn't match MDN
	const responseCookies: string[] = await response.headers.getAll('Set-Cookie');
	const setCookies = setCookie.parse(responseCookies);
	const previewCookie = setCookies.find((cookie) => cookie.name === '_secure_session_id');
	return previewCookie;
}

export default {
	async fetch(request: Request): Promise<Response> {
		request = request.clone();

		const url = new URL(request.url);
		const requestingHostname = url.hostname;
		url.hostname = 'platter.outsmartly.app';
		url.protocol = 'https:';
		const environment = url.searchParams.get('__orly_blue/green') ?? 'green';
		url.searchParams.forEach((_, key) => {
			if (key.startsWith('__orly_')) {
				url.searchParams.delete(key);
			}
		});

		const replaceHostname = (input: string) => {
			return input.replace(requestingHostname, 'platter.outsmartly.app');
		};

		const requestHeaders = new Headers(request.headers);
		requestHeaders.set('Host', 'platter.outsmartly.app');

		const origin = requestHeaders.get('origin');
		if (origin) {
			requestHeaders.set('origin', replaceHostname(origin));
		}
		const referer = requestHeaders.get('referer');
		if (referer) {
			requestHeaders.set('referer', replaceHostname(referer));
		}

		const cookies = libCookie.parse(requestHeaders.get('Cookie') || '');
		const cookiesToSet: Cookie[] = [];

		// TODO: is there some way to modify the session to use a different theme? If we can't, then everytime the experiment is changed then we lose authed state.

		const themeExperimentChanged = cookies['_orly_te'] !== environment;

		if (themeExperimentChanged) {
			if (environment === 'green') {
				cookiesToSet.push({ name: '_orly_te', value: THEME_EXPERIMENT_ID });
				clearPreviewCookies(requestHeaders);
			}
			if (environment === 'blue' && !cookies['_secure_session_id']) {
				const previewCookie = await getPreviewSessionId(request, '133878677664');
				if (previewCookie) {
					cookiesToSet.push({
						...previewCookie,
						name: '_orly_te',
						value: THEME_EXPERIMENT_ID,
					});
					cookiesToSet.push({
						...previewCookie,
						name: 'preview_theme',
						value: '1',
					});
					cookiesToSet.push(previewCookie);
				}
				const cookies = requestHeaders.get('Cookie');
				const previewCookies = cookiesToSet.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
				requestHeaders.set('Cookie', cookies ? `${cookies}; ${previewCookies}` : previewCookies);
			}
		}

		const response = await fetch(
			url.toString(),
			new Request(request, {
				headers: requestHeaders,
			})
		);

		// @ts-ignore
		const modifiedResponse = new Response(response.body, response);
		if (response.status === 302) {
			const location = modifiedResponse.headers.get('Location');
			if (location) {
				const newLocation = location.replace('platter.outsmartly.app', requestingHostname);
				modifiedResponse.headers.set('Location', newLocation);
			}
		}

		cookiesToSet.forEach((cookie) => {
			cookie.domain = requestingHostname;
			const setCookieString = libCookie.serialize(cookie.name, cookie.value, cookie as CookieSerializeOptions);
			modifiedResponse.headers.append('Set-Cookie', setCookieString);
		});

		rewriteCookieDomain('platter.outsmartly.app', requestingHostname, modifiedResponse.headers);

		const contentType = modifiedResponse.headers.get('Content-Type') ?? '';
		if (response.status !== 200 || request.method !== 'GET' || !contentType.includes('text/html')) {
			return modifiedResponse;
		}

		// @ts-ignore
		const rewriter = new HTMLRewriter()
			.on('head', new StyleInjector('<style>#preview-bar-iframe { display: none; }</style>'))
			.transform(modifiedResponse);

		const text = await rewriter.text();

		return new Response(text, {
			status: modifiedResponse.status,
			statusText: modifiedResponse.statusText,
			headers: modifiedResponse.headers,
		});
	},
};

class StyleInjector {
	constructor(protected styles: string) {}
	element(element: any) {
		element.append(this.styles, { html: true });
	}
}

const rewriteCookieDomain = (domain: string, newDomain: string, headers: Headers) => {
	const domainRegex = new RegExp(`domain=${domain}`, 'gi');

	const cookies: string[] = [];
	headers.forEach((value, key) => {
		if (key.toLowerCase() === 'set-cookie') {
			const modifiedValue = value.replace(domainRegex, `domain=${newDomain}`);
			cookies.push(modifiedValue);
		}
	});

	headers.delete('set-cookie');
	cookies.forEach((value) => {
		headers.append('set-cookie', value);
	});
};
