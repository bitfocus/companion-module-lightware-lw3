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
