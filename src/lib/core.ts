import { encrypt, decrypt } from 'zencrypt';
import { parse, serialize } from './cookie.js';
import type { Session, SessionOptions } from './types';
import { daysToMaxage, maxAgeToDateOfExpiry } from './utils.js';

export default async function initializeSession<SessionType = Record<string, any>>(
	headersOrCookieString: Headers | string,
	userOptions: SessionOptions
) {
	if (userOptions.secret == null) {
		throw new Error('Please provide at least one secret');
	}

	const isSecureCookie =
		typeof process !== 'undefined' ? process.env.NODE_ENV !== 'development' : false;

	let setCookie: string | undefined;

	const options = {
		key: userOptions.key ?? 'kit.session',
		expiresInDays: userOptions.expires ?? 7,
		cookie: {
			maxAge: daysToMaxage(userOptions.expires ?? 7),
			httpOnly: userOptions?.cookie?.httpOnly ?? true,
			sameSite: userOptions?.cookie?.sameSite ?? 'lax',
			path: userOptions?.cookie?.path ?? '/',
			domain: userOptions?.cookie?.domain ?? undefined,
			secure: userOptions?.cookie?.secure ?? isSecureCookie
		},
		rolling: userOptions?.rolling ?? false,
		secrets: Array.isArray(userOptions.secret)
			? userOptions.secret
			: [{ id: 1, secret: userOptions.secret }]
	};

	const cookies = parse(
		typeof headersOrCookieString === 'string'
			? headersOrCookieString
			: headersOrCookieString.get('cookie') || '',
		{}
	);

	let sessionCookie: string = cookies[options.key] || '';

	const sessionState = {
		invalidDate: false,
		shouldReEncrypt: false,
		shouldDestroy: false,
		shouldSendToClient: false
	};

	type SessionDataWithExpires = SessionType & { expires?: Date };

	let sessionData: SessionDataWithExpires | undefined;

	function checkSessionExpiry() {
		if (
			sessionData &&
			sessionData.expires &&
			new Date(sessionData.expires).getTime() < new Date().getTime()
		) {
			sessionState.invalidDate = true;
		}
	}

	async function getSessionData() {
		const [_sessionCookie, secret_id] = sessionCookie.split('&id=');

		// If we have a session cookie we try to get the id from the cookie value and use it to decode the cookie.
		// If the decodeID is not the first secret in the secrets array we should re encrypt to the newest secret.
		if (_sessionCookie.length > 0) {
			// Split the sessionCookie on the &id= field to get the id we used to encrypt the session.
			const decodeID = secret_id ? Number(secret_id) : 1;

			// Use the id from the cookie or the initial one which is always 1.
			let secret = options.secrets.find((sec) => sec.id === decodeID);

			// If there is no secret found try the first in the secrets array.
			if (!secret) secret = options.secrets[0];

			// Set the session cookie without &id=
			sessionCookie = _sessionCookie;

			// Try to decode with the given sessionCookie and secret
			try {
				const decrypted = await decrypt(_sessionCookie, secret.secret);
				sessionData = decrypted;

				checkSessionExpiry();

				// If the decodeID unequals the newest secret id in the array, we should re-encrypt the session with the newest secret.
				if (options.secrets[0].id !== decodeID) {
					await reEncryptSession();
				}

				return sessionData;
			} catch (error) {
				await destroySession();
			}
		}
	}

	await getSessionData();

	async function makeCookie(maxAge: number, destroy: boolean = false) {
		const encode = async () => {
			return `${await encrypt(sessionData, options.secrets[0].secret as string)}&id=${
				options.secrets[0].id
			}`;
		};

		return serialize(options.key, destroy ? '0' : await encode(), {
			httpOnly: options.cookie.httpOnly,
			path: options.cookie.path,
			sameSite: options.cookie.sameSite,
			secure: options.cookie.secure,
			domain: options.cookie?.domain,
			maxAge: destroy ? undefined : maxAge,
			expires: destroy ? new Date(Date.now() - 360000000) : undefined
		});
	}

	const session = {
		get 'set-cookie'(): string | undefined {
			return setCookie;
		},
		update: async function (updateFn: (data?: SessionType) => SessionType | Promise<SessionType>) {
			const _sd = await updateFn(sessionData);

			let maxAge = options.cookie.maxAge;

			if (sessionData?.expires) {
				maxAge = new Date(sessionData.expires).getTime() / 1000 - new Date().getTime() / 1000;
			}

			sessionData = {
				..._sd,
				expires: maxAgeToDateOfExpiry(maxAge)
			};

			sessionState.shouldSendToClient = true;

			setCookie = await makeCookie(maxAge);

			return sessionData;
		},
		set: async function (data?: SessionType) {
			let maxAge = options.cookie.maxAge;

			if (sessionData?.expires) {
				maxAge = new Date(sessionData.expires).getTime() / 1000 - new Date().getTime() / 1000;
			}

			sessionData = {
				...(data as any),
				expires: maxAgeToDateOfExpiry(maxAge)
			};

			sessionState.shouldSendToClient = true;

			setCookie = await makeCookie(maxAge);

			return sessionData;
		},
		get data(): SessionDataWithExpires | {} {
			// The user wants to get the data
			return sessionData && !sessionState.invalidDate && !sessionState.shouldDestroy
				? sessionData
				: {};
		},
		refresh: async function (expiresInDays?: number) {
			if (!sessionData) {
				return false;
			}

			const newMaxAge = daysToMaxage(expiresInDays ? expiresInDays : options.expiresInDays);

			sessionData = {
				...sessionData,
				expires: maxAgeToDateOfExpiry(newMaxAge)
			};

			setCookie = await makeCookie(newMaxAge);

			sessionState.shouldSendToClient = true;

			return true;
		},
		destroy: async function () {
			await destroySession();
			return true;
		}
	};

	// If rolling is activated and the session exists we refresh the session on every request.
	if (options?.rolling) {
		// Fake access session data:
		const _sd = sessionData;

		if (typeof options.rolling === 'number' && _sd?.expires) {
			// refreshes when a percentage of the expiration date is met
			const differenceInSeconds = Math.round(
				new Date(_sd.expires).getTime() / 1000 - new Date().getTime() / 1000
			);

			if (differenceInSeconds < (options.rolling / 100) * options.cookie.maxAge) {
				await session.refresh();
			}
		} else {
			await session.refresh();
		}
	}

	async function destroySession() {
		sessionData = undefined;
		setCookie = await makeCookie(0, true);
		sessionState.shouldSendToClient = true;
	}

	async function reEncryptSession() {
		if (sessionData) {
			let maxAge = options.cookie.maxAge;

			if (sessionData?.expires) {
				maxAge = new Date(sessionData.expires).getTime() / 1000 - new Date().getTime() / 1000;
			}

			sessionData = { ...sessionData };
			sessionState.shouldSendToClient = true;
			setCookie = await makeCookie(maxAge);
		}
	}

	return {
		session,
		cookies
	} as {
		session: Session<SessionDataWithExpires | undefined>;
		cookies: Record<string, string>;
	};
}