import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
	BUILTIN_REDACTION_KINDS,
	MAX_REDACTION_RULE_INPUT,
	MAX_REDACTION_RULE_PATTERN,
	RedactionRuleError,
	createRedactor,
	createSecretFingerprints,
	isHighEntropySecret,
	redactionRuleError,
	secretVariants,
} from './log-redaction.ts';

const redactor = createRedactor();
const R = (kind: string) => `[REDACTED:${kind}]`;

/** A Yoal-style random token: `randomToken(32)` is 43 base64url characters. */
const token43 = () => randomBytes(32).toString('base64url');
/** A fixed 43-character base64url value with both cases and digits (deterministic tests). */
const FIXED_TOKEN = 'q8ZfK2mNvX4rT7wLpB9cJ1sHdG6yA3eU5oRiW0kVnQx';

function expectRedacted(input: string, kind: string, mustNotContain: string) {
	const result = redactor.redact(input);
	expect(result.text).not.toContain(mustNotContain);
	expect(result.text).toContain(R(kind));
	expect(result.hits).toContain(kind as never);
	return result;
}

function expectUntouched(input: string) {
	const result = redactor.redact(input);
	expect(result.text).toBe(input);
	expect(result.hits).toEqual([]);
}

describe('built-in detectors (LOGS.md §10.4)', () => {
	test('JWT', () => {
		const jwt =
			'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
		const { text } = expectRedacted(`session token=${jwt} accepted`, 'jwt', jwt);
		expect(text).toBe(`session token=${R('jwt')} accepted`);
	});

	test('Authorization header keeps the scheme', () => {
		const r = expectRedacted(`> Authorization: Bearer ${FIXED_TOKEN}`, 'authorization', FIXED_TOKEN);
		expect(r.text).toBe(`> Authorization: Bearer ${R('authorization')}`);
		expect(redactor.redact('authorization=Basic dXNlcjpwYXNzd29yZA==').text).toBe(`authorization=Basic ${R('authorization')}`);
		expect(redactor.redact('{"authorization":"Token abcdefgh12345678"}').text).toBe(`{"authorization":"Token ${R('authorization')}"}`);
		expect(redactor.redact(`Proxy-Authorization: ${FIXED_TOKEN}`).text).toBe(`Proxy-Authorization: ${R('authorization')}`);
	});

	test('Bearer credentials outside a header', () => {
		const r = expectRedacted(`calling api with bearer ${FIXED_TOKEN}`, 'bearer', FIXED_TOKEN);
		expect(r.text).toBe(`calling api with bearer ${R('bearer')}`);
	});

	test('Cookie and Set-Cookie values', () => {
		expect(redactor.redact('Cookie: session=abc123; theme=dark').text).toBe(`Cookie: ${R('cookie')}`);
		expect(redactor.redact('set-cookie: sid=s%3Aabc.def; Path=/; HttpOnly').text).toBe(`set-cookie: ${R('cookie')}`);
		expect(redactor.redact('{"cookie":"a=b; c=d","ok":true}').text).toBe(`{"cookie":"${R('cookie')}","ok":true}`);
	});

	test('AWS access key id and secret', () => {
		expectRedacted('using key AKIAIOSFODNN7EXAMPLE for s3', 'aws_access_key', 'AKIAIOSFODNN7EXAMPLE');
		expectRedacted('ASIAY34FZKBOKMUTVV7A temp creds', 'aws_access_key', 'ASIAY34FZKBOKMUTVV7A');
		const r = expectRedacted('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'aws_secret_key', 'wJalrXUtnFEMI');
		expect(r.text).toBe(`AWS_SECRET_ACCESS_KEY=${R('aws_secret_key')}`);
		expectRedacted('{"SecretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}', 'aws_secret_key', 'wJalrXUtnFEMI');
	});

	test('GCP API keys and service-account JSON', () => {
		expectRedacted('maps key=AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI', 'gcp_api_key', 'AIzaSyDdI0hCZtE6vySjMm');
		const sa =
			'{"type":"service_account","project_id":"demo","private_key_id":"8f2c1e0b9a7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b","private_key":"-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\n-----END PRIVATE KEY-----\\n","client_email":"x@demo.iam.gserviceaccount.com"}';
		const r = redactor.redact(sa);
		expect(r.text).not.toContain('MIIEvQ');
		expect(r.text).not.toContain('8f2c1e0b9a7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b');
		expect(r.hits).toEqual(expect.arrayContaining(['private_key', 'gcp_service_account']));
		expect(r.text).toContain('"project_id":"demo"');
	});

	test('private key blocks, including unterminated ones', () => {
		const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1\nabcdef\n-----END RSA PRIVATE KEY-----';
		expect(redactor.redact(`key:\n${pem}\ndone`).text).toBe(`key:\n${R('private_key')}\ndone`);
		expect(redactor.redact('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA').text).toBe(R('private_key'));
		expect(redactor.redact('-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZI\n-----END PUBLIC KEY-----').hits).toEqual([]);
	});

	test('GitHub, GitLab, Slack and Stripe tokens', () => {
		expectRedacted('token ghp_16C7e42F292c6912E7710c838347Ae178B4a used', 'github_token', 'ghp_16C7e42F');
		expectRedacted('github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012345', 'github_token', 'github_pat_11');
		expectRedacted('remote https://oauth2:glpat' + '-xxxxXXXXxxxxXXXX1234@gitlab.com/x.git', 'gitlab_token', 'glpat-xxxx');
		expectRedacted('slack xoxb' + '-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx', 'slack_token', 'xoxb-1234');
		expectRedacted('stripe sk_' + 'live_51H8abcdefGHIJKLmnopQRSTuv', 'stripe_key', 'sk_live_51H8');
	});

	test('URL userinfo passwords keep the user', () => {
		const r = expectRedacted('connecting to postgres://app:s3cretPass@db.internal:5432/app', 'url_password', 's3cretPass');
		expect(r.text).toBe(`connecting to postgres://app:${R('url_password')}@db.internal:5432/app`);
		expect(redactor.redact('redis://default:hunter2@cache:6379').text).toBe(`redis://default:${R('url_password')}@cache:6379`);
		expectUntouched('fetch https://example.com/a/b?c=d failed');
		expectUntouched('git clone git@github.com:org/repo.git');
	});

	test('credential-named keys, in every common shape', () => {
		expect(redactor.redact('login failed password=hunter2 user=bob').text).toBe(`login failed password=${R('credential')} user=bob`);
		expect(redactor.redact('{"password":"correct horse battery","user":"bob"}').text).toBe(`{"password":"${R('credential')}","user":"bob"}`);
		expect(redactor.redact("DB_PASSWORD='x y z'").text).toBe(`DB_PASSWORD='${R('credential')}'`);
		expect(redactor.redact('client_secret: abcdefgh12345678').text).toBe(`client_secret: ${R('credential')}`);
		expect(redactor.redact('config apiKey="sk-proj-abcdefgh1234"').text).toBe(`config apiKey="${R('credential')}"`);
		expect(redactor.redact('GET /cb?code=x&access_token=abcdefgh12345678&state=1').text).toBe(
			`GET /cb?code=x&access_token=${R('credential')}&state=1`,
		);
		expect(redactor.redact('secret=topsecretvalue').text).toBe(`secret=${R('credential')}`);
	});

	test('high-entropy values in key positions', () => {
		const r = expectRedacted(`session=${FIXED_TOKEN} user=bob`, 'high_entropy', FIXED_TOKEN);
		expect(r.text).toBe(`session=${R('high_entropy')} user=bob`);
		expectRedacted(`"x-signing": "${FIXED_TOKEN}"`, 'high_entropy', FIXED_TOKEN);
	});

	test('every built-in kind is a valid marker name', () => {
		for (const kind of BUILTIN_REDACTION_KINDS) expect(kind).toMatch(/^[a-z_]+$/);
	});
});

describe("Yoal's own credentials", () => {
	test('API keys and CLI tokens (yoal_ + randomToken(32))', () => {
		for (let i = 0; i < 50; i++) {
			const key = `yoal_${token43()}`;
			const r = redactor.redact(`yoal deploy --token ${key} ok`);
			expect(r.text).toBe(`yoal deploy --token ${R('yoal_api_key')} ok`);
		}
	});

	test("Better Auth's 64-letter keys and service-policy secrets", () => {
		const letters = 'aBcDeFgHiJkLmNoPqRsTuVwXyZaBcDeFgHiJkLmNoPqRsTuVwXyZaBcDeFgHiJkL';
		expect(redactor.redact(`key yoal_${letters}`).text).toBe(`key ${R('yoal_api_key')}`);
		expect(redactor.redact(`secret yoal_svc_${FIXED_TOKEN}`).text).toBe(`secret ${R('yoal_api_key')}`);
	});

	test('prober and SCIM tokens', () => {
		expect(redactor.redact(`probe yoalp_${FIXED_TOKEN} registered`).text).toBe(`probe ${R('yoal_token')} registered`);
		expect(redactor.redact(`scim bearer scim_${FIXED_TOKEN}`).hits).toContain('yoal_token');
	});

	test('node and join tokens (unprefixed) by context', () => {
		const t = token43();
		expect(redactor.redact(`YOAL_NODE_TOKEN=${t}`).text).toBe(`YOAL_NODE_TOKEN=${R('yoal_node_token')}`);
		expect(redactor.redact(`{"nodeToken":"${t}"}`).text).toBe(`{"nodeToken":"${R('yoal_node_token')}"}`);
		expect(redactor.redact(`join_token: ${t}`).text).toBe(`join_token: ${R('yoal_node_token')}`);
		// The agent sends its node token as a bearer credential.
		expect(redactor.redact(`authorization: Bearer ${t}`).text).toBe(`authorization: Bearer ${R('authorization')}`);
		expect(redactor.redact(`x-yoal-token: ${t}`).text).toBe(`x-yoal-token: ${R('yoal_token')}`);
		expect(redactor.redact(`X-Yoal-Access-Token=${t}`).text).toBe(`X-Yoal-Access-Token=${R('yoal_token')}`);
		expect(redactor.redact(`YOAL_REGISTRY_TOKEN=${t}`).text).toBe(`YOAL_REGISTRY_TOKEN=${R('yoal_token')}`);
	});

	test('storage access key ids', () => {
		expect(redactor.redact('created key SKFABCDEFGHIJ234567Q for bucket').text).toBe(`created key ${R('yoal_storage_key')} for bucket`);
		expect(redactor.redact('root SKRABCDEFGHIJ234567Q').hits).toEqual(['yoal_storage_key']);
	});

	test('Yoal names that are not credentials pass through', () => {
		expectUntouched('metric yoal_storage_used_bytes=1024 yoal_database_pooler_connections_waiting_total=3');
		expectUntouched('role yoal_studio_ro granted; yoal_monitor connected; yoal_ha_effective_below_target 0');
		expectUntouched('ACCESS_KEY_PREFIX is yoal_ and scim_ prefixes are documented');
	});
});

describe('false positives (must NOT be redacted)', () => {
	const lines = [
		// UUIDs
		'request_id=550e8400-e29b-41d4-a716-446655440000 completed',
		'user 6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b updated',
		'{"id":"550e8400-e29b-41d4-a716-446655440000","status":"ok"}',
		// git SHAs (full and short)
		'deployed commit 3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39 to production',
		'commit=3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39 ref=main',
		'HEAD is now at abc1234 fix tests',
		'sha: 9fceb02d0ae598e95dc970b74767f19372d61af8',
		// content hashes
		'Pulled registry.example.com/org/app@sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		'digest=sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		'integrity=sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==',
		'hash=Kx7QbN3mZp9sV2wR8tY4uI6oP1aS5dF0gH3jK7lL2zX',
		'etag: "33a64df551425fcc55e4d42a148795d9f25f89d4"',
		'checksum=d41d8cd98f00b204e9800998ecf8427e',
		'contentHash=Kx7QbN3mZp9sV2wR8tY4uI6oP1aS5dF0gH3jK7lL2zX',
		// trace and request ids
		'trace_id=4bf92f3577b34da6a3ce929d0e0e4736 span_id=00f067aa0ba902b7',
		'traceparent=00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
		'requestId=V1StGXR8Z5jdHi6BmyT2kQ9pLx4Wc7Ns',
		'cursor=eyJvZmZzZXQiOjEwMH0',
		'ulid 01ARZ3NDEKTSV4RRFFQ69G5FAV created',
		// prose and near-misses
		'max_tokens=1024 token_count=5 tokens: 512',
		'PWD=/home/kieran/projects/app',
		"SyntaxError: Unexpected token: '<'",
		'auth: failed for user bob',
		'missing Bearer token in request',
		'Authorization failed for user bob',
		'cookie: none',
		'password=*** user=bob',
		'password=${DB_PASSWORD}',
		'secretName=db-creds secret_ref=prod/db',
		'path=/var/lib/yoal/agent/state/ABCdef123456789012345678',
		'image=registry.example.com/org/app:v1.2.3',
		'GET /api/v1/orders/123 200 12ms 4321B 10.0.0.1',
		'{"level":"info","msg":"order created","order_id":42,"user":"alice"}',
		'2026-11-25T10:00:00Z INFO user alice@example.com logged in from 10.1.2.3',
		'className=OrderServiceImplementationFactory',
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0',
	];
	for (const line of lines) test(line, () => expectUntouched(line));
});

describe('isHighEntropySecret', () => {
	test('random base64 is secret; ids, hashes and words are not', () => {
		expect(isHighEntropySecret(FIXED_TOKEN)).toBe(true);
		let caught = 0;
		// Seeded, so the share is the same on every run (random bytes made this flaky).
		let seed = 0x2545f491;
		const nextByte = () => {
			seed ^= seed << 13;
			seed ^= seed >>> 17;
			seed ^= seed << 5;
			return (seed >>> 0) & 0xff;
		};
		const seededToken = () => Buffer.from(Array.from({ length: 32 }, nextByte)).toString('base64url');
		for (let i = 0; i < 200; i++) if (isHighEntropySecret(seededToken())) caught++;
		expect(caught).toBeGreaterThan(190);
		expect(isHighEntropySecret('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
		expect(isHighEntropySecret('3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39')).toBe(false);
		expect(isHighEntropySecret('sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg')).toBe(false);
		expect(isHighEntropySecret('OrderServiceImplementationFactory')).toBe(false);
		expect(isHighEntropySecret('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(false);
		expect(isHighEntropySecret('short1A')).toBe(false);
	});
});

describe('known secret values (S5)', () => {
	test('raw, base64 and URL-encoded forms, anywhere in a line', () => {
		const secret = 'pa$$w0rd/With+Symbols&=';
		const r = createRedactor({ secrets: [secret] });
		expect(r.redact(`x ${secret} y`).text).toBe(`x ${R('known_secret')} y`);
		expect(r.redact(secret).text).toBe(R('known_secret'));
		expect(r.redact(`${secret}${secret}`).text).toBe(R('known_secret') + R('known_secret'));
		const b64 = Buffer.from(secret).toString('base64');
		expect(r.redact(`blob:${b64}`).text).toBe(`blob:${R('known_secret')}`);
		expect(r.redact(`q=${encodeURIComponent(secret)}&x=1`).text).toBe(`q=${R('known_secret')}&x=1`);
		expect(r.redact(`x ${secret} y`).hits).toEqual(['known_secret']);
	});

	test('a near miss is not redacted', () => {
		const r = createRedactor({ secrets: ['correct-horse-battery'] });
		expect(r.redact('correct-horse-batter!').text).toBe('correct-horse-batter!');
		expect(r.redact('correct-horse').hits).toEqual([]);
		expect(r.redact('').text).toBe('');
	});

	test('values shorter than 8 characters are ignored', () => {
		const r = createRedactor({ secrets: ['short', '1234567'] });
		expect(r.secretCount).toBe(0);
		expect(r.redact('short 1234567').text).toBe('short 1234567');
	});

	test('multi-line values are matched line by line', () => {
		const r = createRedactor({ secrets: ['first-line-abc\nsecond-line-def'] });
		expect(r.redact('got second-line-def here').text).toBe(`got ${R('known_secret')} here`);
	});

	test('the longest of two secrets sharing a prefix wins', () => {
		const r = createRedactor({ secrets: ['abcdefgh', 'abcdefgh-longer-one'] });
		expect(r.redact('v=abcdefgh-longer-one!').text).toBe(`v=${R('known_secret')}!`);
		expect(r.redact('v=abcdefgh!').text).toBe(`v=${R('known_secret')}!`);
	});

	test('500 secrets: each one is found, unrelated lines are untouched', () => {
		const secrets = Array.from({ length: 500 }, () => token43());
		const r = createRedactor({ secrets, disable: ['high_entropy'] });
		for (const s of secrets) expect(r.redact(`value ${s} end`).text).toBe(`value ${R('known_secret')} end`);
		expect(r.redact('GET /api/v1/orders 200 12ms').text).toBe('GET /api/v1/orders 200 12ms');
	});

	test('unicode secrets', () => {
		const r = createRedactor({ secrets: ['pässwörd-🔑-geheim'] });
		expect(r.redact('x pässwörd-🔑-geheim y').text).toBe(`x ${R('known_secret')} y`);
	});

	test('fingerprints work without the plaintext, and need the same key', () => {
		const key = randomBytes(32);
		const fingerprints = createSecretFingerprints(['db-password-123456'], key);
		expect(JSON.stringify(fingerprints)).not.toContain('db-password');
		// Round-trips through JSON (it is stored).
		const restored = JSON.parse(JSON.stringify(fingerprints));
		const r = createRedactor({ fingerprints: restored, fingerprintKey: key });
		expect(r.redact('pw db-password-123456').text).toBe(`pw ${R('known_secret')}`);
		const wrongKey = createRedactor({ fingerprints: restored, fingerprintKey: randomBytes(32) });
		expect(wrongKey.redact('pw db-password-123456').text).toBe('pw db-password-123456');
		expect(() => createRedactor({ fingerprints })).toThrow();
	});

	test('secretVariants covers the pipeline masker set', () => {
		const v = secretVariants('ab cd/ef?gh');
		expect(v).toContain('ab cd/ef?gh');
		expect(v).toContain(Buffer.from('ab cd/ef?gh').toString('base64'));
		expect(v).toContain(encodeURIComponent('ab cd/ef?gh'));
	});
});

describe('org regex rules', () => {
	test('a rule redacts its matches with its own kind', () => {
		const r = createRedactor({ rules: [{ name: 'customer-id', pattern: 'CUST-\\d{6}' }] });
		const result = r.redact('order for CUST-123456 and CUST-654321');
		expect(result.text).toBe(`order for ${R('rule:customer-id')} and ${R('rule:customer-id')}`);
		expect(result.hits).toEqual(['rule:customer-id']);
	});

	test('flags are honoured and g is implied', () => {
		const r = createRedactor({ rules: [{ name: 'ssn', pattern: 'ssn:\\s*\\d{3}-\\d{2}-\\d{4}', flags: 'i' }] });
		expect(r.redact('SSN: 123-45-6789').text).toBe(R('rule:ssn'));
	});

	test('invalid rules are rejected with a reason', () => {
		expect(redactionRuleError({ name: 'ok', pattern: 'abc' })).toBeNull();
		expect(redactionRuleError({ name: 'Bad Name', pattern: 'abc' })).toContain('name');
		expect(redactionRuleError({ name: 'x', pattern: '(' })).toContain('Invalid');
		expect(redactionRuleError({ name: 'x', pattern: '(a+)+$' })).toContain('Nested');
		expect(redactionRuleError({ name: 'x', pattern: '(.*)*' })).toContain('Nested');
		expect(redactionRuleError({ name: 'x', pattern: 'a*' })).toContain('empty');
		expect(redactionRuleError({ name: 'x', pattern: 'a', flags: 'y' })).toContain('flags');
		expect(redactionRuleError({ name: 'x', pattern: 'a'.repeat(MAX_REDACTION_RULE_PATTERN + 1) })).toContain('at most');
		expect(() => createRedactor({ rules: [{ name: 'x', pattern: '(a+)+' }] })).toThrow(RedactionRuleError);
	});

	test('rules must be in the safe regex subset shared with the query parser', () => {
		for (const pattern of ['(a|a)*$', '(a|aa)*c', 'a*a*a*a*c', '.*x.*y', '\\w+\\w+c', 'a(?=b)', '(a)\\1']) {
			expect(redactionRuleError({ name: 'x', pattern })).not.toBeNull();
		}
		expect(redactionRuleError({ name: 'x', pattern: 'a*a*c', flags: 'i' })).toContain('backtrack');
		for (const pattern of ['acct_[0-9]{8}', 'sess-[a-f0-9]{32}', 'token=\\w+', '"secret":"[^"]*"']) {
			expect(redactionRuleError({ name: 'x', pattern })).toBeNull();
		}
	});

	test('rules only see the first 2 KiB of a line', () => {
		expect(MAX_REDACTION_RULE_INPUT).toBe(2048);
		const r = createRedactor({ rules: [{ name: 'marker', pattern: 'NEEDLE' }] });
		const line = `NEEDLE ${'x'.repeat(MAX_REDACTION_RULE_INPUT)} NEEDLE`;
		const out = r.redact(line).text;
		expect(out.startsWith(R('rule:marker'))).toBe(true);
		expect(out.endsWith('NEEDLE')).toBe(true);
	});
});

describe('redactor behaviour', () => {
	test('disabled kinds are left alone', () => {
		const r = createRedactor({ disable: ['jwt', 'credential', 'high_entropy'] });
		const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
		expect(r.redact(`t ${jwt}`).text).toBe(`t ${jwt}`);
		expect(r.redact('password=hunter2').text).toBe('password=hunter2');
		expect(r.redact('key AKIAIOSFODNN7EXAMPLE').text).toBe(`key ${R('aws_access_key')}`);
	});

	test('one redaction is never wrapped by a second detector', () => {
		const secret = 'my-db-password-1234';
		const r = createRedactor({ secrets: [secret] });
		const out = r.redact(`password=${secret} Authorization: Bearer ${secret}`);
		expect(out.text).toBe(`password=${R('known_secret')} Authorization: Bearer ${R('known_secret')}`);
		expect(out.hits).toEqual(['known_secret']);
	});

	test('hits list each kind once, in first-match order', () => {
		const out = redactor.redact('password=a1 AKIAIOSFODNN7EXAMPLE password=b2 AKIAIOSFODNN7EXAMPLF');
		expect(out.hits).toEqual(['aws_access_key', 'credential']);
	});

	test('the redactor is reusable and stateless between lines', () => {
		const r = createRedactor({ rules: [{ name: 'x', pattern: 'zzz\\d' }] });
		for (let i = 0; i < 3; i++) expect(r.redact('a zzz1 b').text).toBe(`a ${R('rule:x')} b`);
		expect(r.redact('nothing here').hits).toEqual([]);
	});
});

describe('adversarial lines (timing guard)', () => {
	test('every detector stays linear-ish on 16 KiB lines built against it', () => {
		const r = createRedactor({ rules: [{ name: 'acct', pattern: 'acct_[0-9]{8}' }] });
		// Absolute budgets flake on loaded CI runners, so check the growth instead: quadrupling the line
		// must not much more than quadruple the time (a quadratic pattern would be ~16x). The generous
		// absolute cap still catches anything catastrophic.
		const fill = (size: number, unit: string, tail = '') =>
			unit.repeat(Math.ceil(size / unit.length)).slice(0, size - tail.length) + tail;
		const shapes: Array<(size: number) => string> = [
			(n) => fill(n, 'a.', 'token'),
			(n) => fill(n, 'a_', 'token'),
			(n) => fill(n, 'a-', 'password'),
			(n) => fill(n, 'api-key'),
			(n) => fill(n, 'token='),
			(n) => fill(n, 'secret'),
			(n) => fill(n, 'authorization: '),
			(n) => fill(n, 'cookie=a; '),
			(n) => fill(n, 'bearer '),
			(n) => fill(n, 'k=' + 'A1b2'.repeat(10) + ' '),
			(n) => `a=${'A1b2'.repeat((n - 8) / 4)}A1b===`,
			(n) => fill(n, 'yoal_'),
			(n) => fill(n, 'eyJaaaaaaaaa.'),
			(n) => fill(n, 'a://b:c'),
			(n) => fill(n, 'pass:"\\'),
			(n) => fill(n, 'acct_1234567'),
		];
		const best = (line: string) => {
			let fastest = Infinity;
			for (let run = 0; run < 3; run++) {
				const started = performance.now();
				r.redact(line);
				fastest = Math.min(fastest, performance.now() - started);
			}
			return fastest;
		};
		const small = 16 * 1024;
		const large = 4 * small;
		for (const shape of shapes) {
			const short = shape(small);
			const long = shape(large);
			expect([short.length, long.length]).toEqual([small, large]);
			const tShort = best(short);
			const tLong = best(long);
			const label = short.slice(0, 24);
			expect({ label, tooSlow: tShort > 100 }).toEqual({ label, tooSlow: false });
			// Floor the baseline so sub-millisecond noise cannot fake a big ratio.
			expect({ label, superlinear: tLong / Math.max(tShort, 0.5) > 8 }).toEqual({ label, superlinear: false });
		}
	});
});
