import { describe, expect, it } from 'vitest'
import {
	Cmd,
	LineBuffer,
	cleanName,
	isSafePresetName,
	parseError,
	parseList,
	parsePortName,
	parsePortStatus,
	parsePresetNames,
	parsePresetSource,
	parseProperty,
	parseSource,
} from '../protocol.js'

describe('commands', () => {
	it('uses the colon form the router accepts, not the comma form in its manual', () => {
		expect(Cmd.switch([{ input: 2, output: 7 }])).toBe('CALL /MEDIA/XP/VIDEO:switch(I2:O7)')
	})

	it('unroutes with a bare 0, as I0 is refused', () => {
		expect(Cmd.switch([{ input: 0, output: 7 }])).toBe('CALL /MEDIA/XP/VIDEO:switch(0:O7)')
	})

	it('puts several routes in one command', () => {
		expect(
			Cmd.switch([
				{ input: 3, output: 7 },
				{ input: 3, output: 8 },
			]),
		).toBe('CALL /MEDIA/XP/VIDEO:switch(I3:O7;I3:O8)')
	})

	it('keeps the number before a name', () => {
		expect(Cmd.rename('O7', '2', 'Stage left')).toBe('SET /MEDIA/NAMES/VIDEO.O7=2;Stage left')
	})
})

describe('parsing what the router sent', () => {
	it('reads properties and change messages', () => {
		expect(parseProperty('pr /.ProductName=MX2-8x8-HDMI20-L')).toEqual({
			path: '/',
			property: 'ProductName',
			value: 'MX2-8x8-HDMI20-L',
		})
		expect(parseProperty('CHG /MEDIA/XP/VIDEO.DestinationConnectionStatus=I1;0;')).toEqual({
			path: '/MEDIA/XP/VIDEO',
			property: 'DestinationConnectionStatus',
			value: 'I1;0;',
		})
	})

	it('keeps = and . inside a value', () => {
		expect(parseProperty('pw /MEDIA/NAMES/VIDEO.I1=2;a=b.c')?.value).toBe('2;a=b.c')
	})

	it('reads errors of each kind', () => {
		expect(parseError('mE /MEDIA/XP/VIDEO:switch %E007: Access denied')).toEqual({
			code: 'E007',
			message: 'Access denied',
		})
		expect(parseError('pE /MEDIA/NAMES/VIDEO.O7 %E004: Invalid value')?.code).toBe('E004')
		expect(parseError('mO /MEDIA/XP/VIDEO:switch=OK')).toBeUndefined()
	})

	it('drops only the empty entry after the last semicolon', () => {
		expect(parseList('I1;I2;0;')).toEqual(['I1', 'I2', '0'])
		expect(parseList('U1;U1')).toEqual(['U1', 'U1'])
	})

	it('reads sources', () => {
		expect(parseSource('I12')).toBe(12)
		expect(parseSource('0')).toBe(0)
		expect(parseSource('O1')).toBeUndefined()
		expect(parsePresetSource('uI4')).toBe(4)
		expect(parsePresetSource('u0')).toBe(0)
	})

	// every value here was seen on a real router while pulling cables
	it.each([
		['TAA', false, false, false, false],
		['TAB', false, false, true, false],
		['TEE', false, false, false, true],
		['TAF', false, false, true, true],
		['TEF', false, false, true, true],
		['TFF', false, false, true, true],
		['LAA', true, false, false, false],
		['MAA', false, true, false, false],
	])('reads the port status %s', (entry, locked, muted, connected, signal) => {
		expect(parsePortStatus(entry)).toEqual({ locked, muted, connected, signal })
	})

	it('rejects a status it does not know', () => {
		expect(parsePortStatus('T000F')).toBeUndefined()
	})

	it('splits a name from its number at the first semicolon', () => {
		expect(parsePortName('I1', '2;Input; one')).toEqual({ port: 'I1', prefix: '2', name: 'Input; one' })
		expect(parsePortName('I1', 'no number')).toBeUndefined()
		expect(parsePortName('X1', '2;Input')).toBeUndefined()
	})

	it('lists presets', () => {
		expect(parsePresetNames(['n- /MEDIA/PRESET/DIR-001', 'n- /MEDIA/PRESET/US-001'])).toEqual(['DIR-001', 'US-001'])
	})

	it('joins lines split across packets', () => {
		const lines = new LineBuffer()
		expect(lines.push('{00')).toEqual([])
		expect(lines.push('01\r\nmO /x\r')).toEqual(['{0001'])
		expect(lines.push('\n}\r\n')).toEqual(['mO /x', '}'])
	})
})

describe('what reaches the router', () => {
	it('refuses a preset name that could change the command', () => {
		expect(isSafePresetName('DIR-001')).toBe(true)
		expect(isSafePresetName('x:factoryDefaults')).toBe(false)
		expect(isSafePresetName('a/b')).toBe(false)
		expect(isSafePresetName('a\r\nCALL /SYS:softReset()')).toBe(false)
		expect(isSafePresetName('')).toBe(false)
	})

	it('removes control characters from names', () => {
		expect(cleanName('  Stage\r\nCALL /SYS:softReset() ')).toBe('StageCALL /SYS:softReset()')
	})
})
