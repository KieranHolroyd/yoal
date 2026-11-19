import { describe, expect, test } from 'bun:test';
import { mcpCapableOrigin } from './mcp-origin';

describe('mcpCapableOrigin', () => {
	test('HTTPS and loopback HTTP can serve MCP', () => {
		expect(mcpCapableOrigin('https://control.example.com')).toBe(true);
		expect(mcpCapableOrigin('http://localhost:5173')).toBe(true);
		expect(mcpCapableOrigin('http://127.0.0.1:5173')).toBe(true);
		expect(mcpCapableOrigin('http://[::1]:5173')).toBe(true);
	});

	test('an IP-only HTTP install cannot (the plugin would refuse to start)', () => {
		expect(mcpCapableOrigin('http://192.168.5.15')).toBe(false);
		expect(mcpCapableOrigin('http://control.example.com')).toBe(false);
		expect(mcpCapableOrigin('not a url')).toBe(false);
	});
});
