import { describe, expect, it } from 'vitest'
import { FakeLw3 } from './fake-lw3.js'

const XP = '/MEDIA/XP/VIDEO'

/** Sets up the routes the real router had during the measurements */
function measuredRouter(): FakeLw3 {
	const fake = new FakeLw3()
	fake.routes.splice(0, 8, 1, 2, 2, 1, 0, 2, 2, 2)
	return fake
}

/**
 * Commands and replies copied from a real MX2-8x8-HDMI20-L on firmware 1.10.1b4. These keep the fake honest:
 * if it drifts from what the router did, the module's other tests would be proving nothing.
 */
describe('the fake matches the measured router', () => {
	it('rejects the comma form the manual gives', () => {
		expect(measuredRouter().respond(`CALL ${XP}:switch(I2,O7)`).reply).toEqual([`mE ${XP}:switch %E001: Syntax error`])
	})

	it('rejects I0 as a way to unroute', () => {
		expect(measuredRouter().respond(`CALL ${XP}:switch(I0:O7)`).reply).toEqual([`mE ${XP}:switch %E002: Not exists`])
	})

	it('unroutes with 0', () => {
		const { reply, changes } = measuredRouter().respond(`CALL ${XP}:switch(0:O7)`)
		expect(reply).toEqual([`mO ${XP}:switch=OK`])
		expect(changes).toEqual([[XP, 'DestinationConnectionStatus=I1;I2;I2;I1;0;I2;0;I2;']])
	})

	it('sends no change message for a route that is already there', () => {
		const { reply, changes } = measuredRouter().respond(`CALL ${XP}:switch(I2:O7)`)
		expect(reply).toEqual([`mO ${XP}:switch=OK`])
		expect(changes).toEqual([])
	})

	it('changes several routes in one change message', () => {
		const { changes } = measuredRouter().respond(`CALL ${XP}:switch(I3:O7;I3:O8)`)
		expect(changes).toEqual([[XP, 'DestinationConnectionStatus=I1;I2;I2;I1;0;I2;I3;I3;']])
	})

	it('refuses to switch a locked output', () => {
		const fake = measuredRouter()
		expect(fake.respond(`CALL ${XP}:lockDestination(O7)`).reply).toEqual([`mO ${XP}:lockDestination=OK`])
		expect(fake.respond(`CALL ${XP}:switch(I3:O7)`).reply).toEqual([`mE ${XP}:switch %E007: Access denied`])
		expect(fake.routes[6]).toBe(2)
	})

	it('says Not exists when unlocking an unlocked output', () => {
		expect(measuredRouter().respond(`CALL ${XP}:unlockDestination(O7)`).reply).toEqual([
			`mE ${XP}:unlockDestination %E002: Not exists`,
		])
	})

	it('has no switchMulti that works', () => {
		expect(measuredRouter().respond(`CALL ${XP}:switchMulti(I3:O7;I3:O8;)`).reply).toEqual([
			`mE ${XP}:switchMulti %E002: Not exists`,
		])
	})

	it('needs the number before a name', () => {
		const fake = measuredRouter()
		expect(fake.respond('SET /MEDIA/NAMES/VIDEO.O7=Companion plain').reply).toEqual([
			'pE /MEDIA/NAMES/VIDEO.O7 %E004: Invalid value',
		])
		expect(fake.respond('SET /MEDIA/NAMES/VIDEO.O7=3;Companion test').reply).toEqual([
			'pw /MEDIA/NAMES/VIDEO.O7=3;Companion test',
		])
	})

	it('keeps the first 62 characters of a name', () => {
		const { reply } = measuredRouter().respond(`SET /MEDIA/NAMES/VIDEO.O7=2;${'X'.repeat(64)}`)
		expect(reply).toEqual([`pw /MEDIA/NAMES/VIDEO.O7=2;${'X'.repeat(62)}`])
	})

	it('reports some characters in names with a backslash', () => {
		const fake = measuredRouter()
		expect(fake.respond('SET /MEDIA/NAMES/VIDEO.O7=2;Paren(s) & amp').reply).toEqual([
			'pw /MEDIA/NAMES/VIDEO.O7=2;Paren\\(s\\) & amp',
		])
		expect(fake.respond('SET /MEDIA/NAMES/VIDEO.O7=2;#hash %pc').reply).toEqual([
			'pw /MEDIA/NAMES/VIDEO.O7=2;\\#hash \\%pc',
		])
	})

	it('accepts only some numbers before a name, and needs a name', () => {
		const fake = measuredRouter()
		for (const value of ['0;Zero', 'x;Letter']) {
			expect(fake.respond(`SET /MEDIA/NAMES/VIDEO.O7=${value}`).reply).toEqual([`pw /MEDIA/NAMES/VIDEO.O7=${value}`])
		}
		for (const value of ['9;Nine', '12;Twelve', ';None', '2;']) {
			expect(fake.respond(`SET /MEDIA/NAMES/VIDEO.O7=${value}`).reply).toEqual([
				'pE /MEDIA/NAMES/VIDEO.O7 %E004: Invalid value',
			])
		}
	})

	it('switches an EDID with a colon, one or several, and refuses the rest', () => {
		const fake = measuredRouter()
		expect(fake.respond('CALL /EDID:switch(F137,E8)').reply).toEqual(['mE /EDID:switch %E004: Invalid value'])
		expect(fake.respond('CALL /EDID:switch(E8:F1)').reply).toEqual(['mE /EDID:switch %E004: Invalid value'])
		expect(fake.respond('CALL /EDID:switch(F1:E7;F1:E8)').reply).toEqual(['mO /EDID:switch='])
		expect(fake.respond('GET /EDID.EdidStatus').reply).toEqual([
			'pr /EDID.EdidStatus=F137;F137;F137;F137;F137;F137;F1;F1',
		])
		expect(fake.respond('CALL /EDID:switch(F999:E8)').reply).toEqual(['mE /EDID:switch %E004: Invalid value'])
	})

	it('will emulate an empty slot', () => {
		expect(measuredRouter().respond('CALL /EDID:switch(U50:E8)').reply).toEqual(['mO /EDID:switch='])
	})

	it('only stores and deletes in U slots', () => {
		const fake = measuredRouter()
		expect(fake.respond('CALL /EDID:copy(D1,U100)').reply).toEqual(['mE /EDID:copy %E004: Invalid value'])
		expect(fake.respond('CALL /EDID:copy(F1:F2)').reply).toEqual(['mE /EDID:copy %E004: Invalid value'])
		expect(fake.respond('CALL /EDID:delete(F1)').reply).toEqual(['mE /EDID:delete %E004: Invalid value'])
		expect(fake.respond('CALL /EDID:copy(D1:U100)').reply).toEqual(['mO /EDID:copy='])
		expect(fake.edidSlots.get('U100')?.valid).toBe(true)
		expect(fake.respond('CALL /EDID:delete(U100)').reply).toEqual(['mO /EDID:delete='])
		expect(fake.edidSlots.get('U100')?.valid).toBe(false)
	})

	it('has wildcards for EDID banks but not for port settings', () => {
		const fake = measuredRouter()
		expect(fake.respond('GET /EDID/F/*.MonitorName').reply[0]).toBe('pr /EDID/F/F1.MonitorName=D640x480p60')
		expect(fake.respond('GET /MEDIA/PORTS/VIDEO/*/SETTINGS.HdcpVersion').reply).toEqual([
			'pE /MEDIA/PORTS/VIDEO/*/SETTINGS.HdcpVersion %E002: Not exists',
		])
	})

	it('takes HDCP settings the router has, and refuses the rest', () => {
		const fake = measuredRouter()
		const path = '/MEDIA/PORTS/VIDEO/I8/SETTINGS.HdcpVersion'
		expect(fake.respond(`SET ${path}=3`).reply).toEqual([`pw ${path}=3`])
		expect(fake.respond(`SET ${path}=1`).reply).toEqual([`pE ${path} %E004: Invalid value`])
	})

	it('reports port status the way the router does', () => {
		const fake = measuredRouter()
		fake.setSignal('O1', true, true)
		fake.setSignal('O4', false, true)
		fake.setSignal('O2', true, false)
		expect(fake.respond(`GET ${XP}.DestinationPortStatus`).reply).toEqual([
			`pr ${XP}.DestinationPortStatus=TAF;TAB;TAA;TAE;TAA;TAA;TAA;TAA;`,
		])
	})
})
