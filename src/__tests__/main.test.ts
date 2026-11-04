/**
 * Drives the module against the fake router over a real TCP connection on localhost. Companion's
 * `InstanceBase` is stubbed, and the socket is the real `TCPHelper`.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { InstanceStatus } from '@companion-module/base'
import { FakeLw3, until } from './fake-lw3.js'

vi.mock('@companion-module/base', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@companion-module/base')>()
	class StubInstanceBase {
		log = vi.fn()
		updateStatus = vi.fn()
		setVariableValues = vi.fn()
		setVariableDefinitions = vi.fn()
		setActionDefinitions = vi.fn()
		setFeedbackDefinitions = vi.fn()
		setPresetDefinitions = vi.fn()
		checkFeedbacks = vi.fn()
		checkAllFeedbacks = vi.fn()
		saveConfig = vi.fn()
	}
	return { ...actual, InstanceBase: StubInstanceBase }
})

const { default: ModuleInstance } = await import('../main.js')
type Module = InstanceType<typeof ModuleInstance>

const mock = (fn: unknown): Mock => fn as Mock
const XP = '/MEDIA/XP/VIDEO'

/** The latest value the module gave a variable */
function variable(module: Module, id: string): unknown {
	const calls = mock(module.setVariableValues).mock.calls as [Record<string, unknown>][]
	for (let i = calls.length - 1; i >= 0; i--) {
		if (id in calls[i][0]) return calls[i][0][id]
	}
	return undefined
}

const logged = (module: Module, level: string): string[] =>
	(mock(module.log).mock.calls as [string, string][]).filter(([l]) => l === level).map(([, text]) => text)

/** The most recent definitions the module published */
const lastCall = (fn: unknown): Record<string, any> => {
	const calls = mock(fn).mock.calls
	return calls[calls.length - 1][0] as Record<string, any>
}

const lastPresets = (module: Module): Record<string, any> => {
	const calls = mock(module.setPresetDefinitions).mock.calls
	return calls[calls.length - 1][1] as Record<string, any>
}

describe('the module against the fake router', () => {
	let fake: FakeLw3
	let module: Module
	let port: number

	const connected = async (): Promise<void> => {
		await until(() => logged(module, 'info').some((line) => line.startsWith('Router found')))
	}
	/** Commands that change something, ignoring reads, subscriptions and heartbeats */
	const writes = (): string[] => fake.received.filter((command) => /^(CALL|SET) /.test(command))

	beforeEach(async () => {
		fake = new FakeLw3()
		fake.routes.splice(0, 8, 1, 2, 2, 1, 0, 2, 0, 2)
		port = await fake.listen()
		module = new ModuleInstance({})
	})

	afterEach(async () => {
		await module.destroy()
		await fake.close()
	})

	it('offers actions and presets before any router has answered, unlike the old module', async () => {
		await module.init({ host: '' })
		const actions = lastCall(module.setActionDefinitions)
		expect(Object.keys(actions)).toEqual(expect.arrayContaining(['xpt', 'preset', 'selectSource', 'takeSalvo']))
		expect(actions.xpt.options[0].choices).toHaveLength(8)
		expect(lastPresets(module).input_1).toBeDefined()
		expect(mock(module.updateStatus)).toHaveBeenCalledWith(InstanceStatus.BadConfig, expect.any(String))
	})

	it('reports what it found, and has no blank names at startup', async () => {
		await module.init({ host: '' })
		expect(variable(module, 'name_I1')).toBe('Input 1')
		expect(variable(module, 'selected_input_label')).toBe('IN')
		await module.configUpdated({ host: '127.0.0.1', port })
		await connected()
		expect(logged(module, 'info')).toContain(
			'Router found: MX2-8x8-HDMI20-L, firmware 1.10.1b4, 8 inputs, 8 outputs, 2 router presets',
		)
		expect(variable(module, 'model')).toBe('MX2-8x8-HDMI20-L')
		expect(variable(module, 'source_O1')).toBe('I1')
		expect(variable(module, 'source_O5')).toBe('0')
		expect(variable(module, 'sourcename_O5')).toBe('None')
		expect(variable(module, 'sourcename_O1')).toBe('Input 1')
	})

	it('subscribes before it reads, so a change during the read is not missed', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		const subscribe = fake.received.indexOf(`OPEN ${XP}`)
		const read = fake.received.indexOf(`GET ${XP}.DestinationConnectionStatus`)
		expect(subscribe).toBeGreaterThan(-1)
		expect(subscribe).toBeLessThan(read)
	})

	it('routes, and learns the result from the change message', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		await module.routeNow(3, 7)
		expect(writes()).toEqual(['CALL /MEDIA/XP/VIDEO:switch(I3:O7)'])
		await until(() => variable(module, 'source_O7') === 'I3')
		expect(variable(module, 'sourcename_O7')).toBe('Input 3')
		expect(logged(module, 'info').filter((line) => line.includes('now on'))).toEqual([])
		expect(logged(module, 'warn')).toEqual([])
	})

	it('clears a route straight away unless the mode is Stage', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		await module.clearRoute(1)
		expect(writes()).toEqual(['CALL /MEDIA/XP/VIDEO:switch(0:O1)'])
		await until(() => variable(module, 'source_O1') === '0')
		expect(variable(module, 'sourcename_O1')).toBe('None')
	})

	it('reports a route changed from elsewhere', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		fake.routeFromPanel(8, 1)
		await until(() => variable(module, 'source_O1') === 'I8')
		expect(logged(module, 'info')).toContain('Output 1 now on Input 8')
	})

	it('warns that a locked output refused a route, without pretending it worked', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		await module.lockOutput(7, 'lockDestination')
		await until(() => module.state.isLocked(7))
		await module.routeNow(3, 7)
		expect(logged(module, 'warn')).toContain('Refused: Output 7 is locked')
		expect(module.state.routes.get(7)).toBe(0)
	})

	it('does not treat unlocking an unlocked output as a failure', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		await module.lockOutput(7, 'unlockDestination')
		expect(logged(module, 'warn')).toEqual([])
	})

	it('toggles a lock', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		await module.lockOutput(2, 'toggle')
		await until(() => module.state.isLocked(2))
		await module.lockOutput(2, 'toggle')
		await until(() => !module.state.isLocked(2))
		expect(writes()).toEqual(['CALL /MEDIA/XP/VIDEO:lockDestination(O2)', 'CALL /MEDIA/XP/VIDEO:unlockDestination(O2)'])
	})

	it('flashes the next input, and clears the selection once the take is accepted', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		module.selectOutput(7)
		module.selectInput(3)
		expect(module.state.nextInput).toBe(3)
		await module.takeSelection()
		expect(module.state.selectedInput).toBeUndefined()
		expect(module.state.selectedOutput).toBeUndefined()
		expect(variable(module, 'selected_input_label')).toBe('IN')
		await until(() => variable(module, 'source_O7') === 'I3')
	})

	it('keeps the selection when a locked output refuses the take', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		await module.lockOutput(7, 'lockDestination')
		await until(() => module.state.isLocked(7))
		module.selectOutput(7)
		module.selectInput(3)
		await module.takeSelection()
		expect(module.state.selectedOutput).toBe(7)
		expect(module.state.selectedInput).toBe(3)
	})

	it('lights the routed input after an output is pressed, and routed outputs after an input is', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		module.selectOutput(1)
		expect(module.state.isRoutedInput(1)).toBe(true)
		expect(module.state.isRoutedOutput(1)).toBe(false)
		module.selectInput(2)
		expect(module.state.isRoutedInput(1)).toBe(false)
		expect([2, 3, 6, 8].every((output) => module.state.isRoutedOutput(output))).toBe(true)
	})

	it('does nothing automatically with auto-route off', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		module.selectOutput(7)
		module.selectInput(3)
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(writes()).toEqual([])
		expect(variable(module, 'auto_route_mode')).toBe('OFF')
	})

	it('takes as soon as both are selected in cut mode, in either order', async () => {
		await module.init({ host: '127.0.0.1', port, autoRoute: 'cut' })
		await connected()
		module.selectOutput(7)
		expect(writes()).toEqual([])
		module.selectInput(3)
		await until(() => variable(module, 'source_O7') === 'I3')
		module.selectInput(4)
		expect(writes()).toHaveLength(1)
		module.selectOutput(8)
		await until(() => variable(module, 'source_O8') === 'I4')
		expect(writes()).toEqual(['CALL /MEDIA/XP/VIDEO:switch(I3:O7)', 'CALL /MEDIA/XP/VIDEO:switch(I4:O8)'])
	})

	it('builds a salvo in stage mode: a source, then outputs, and a new source starts a new pair', async () => {
		await module.init({ host: '127.0.0.1', port, autoRoute: 'stage' })
		await connected()
		module.selectInput(3)
		module.selectOutput(7)
		module.selectOutput(8)
		expect(module.state.nextInput).toBeUndefined()
		module.selectInput(4)
		expect(module.state.selectedOutput).toBeUndefined()
		module.selectOutput(5)
		expect(writes()).toEqual([])
		expect(variable(module, 'stagedname_O7')).toBe('Input 3')
		await module.takeStaged()
		expect(writes()).toEqual(['CALL /MEDIA/XP/VIDEO:switch(I3:O7;I3:O8;I4:O5)'])
		expect(module.state.selectedInput).toBeUndefined()
	})

	it('removes a staged route when its output is taken directly, so a later take cannot undo it', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		module.stage(3, 7)
		module.selectOutput(7)
		module.selectInput(4)
		await module.takeSelection()
		expect(module.state.staged.size).toBe(0)
	})

	it('steps the auto-route mode, saves it, and never routes by changing it', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		module.selectOutput(7)
		module.selectInput(3)
		for (const [mode, label] of [
			['stage', 'STAGE'],
			['cut', 'CUT'],
			['off', 'OFF'],
		]) {
			module.setAutoRouteMode('next')
			expect(module.autoRouteMode).toBe(mode)
			expect(variable(module, 'auto_route_mode')).toBe(label)
			expect(mock(module.saveConfig)).toHaveBeenLastCalledWith(expect.objectContaining({ autoRoute: mode }), undefined)
		}
		expect(writes()).toEqual([])
		expect(logged(module, 'info')).toContain('Auto-route mode: STAGE')
	})

	it('does not reconnect when only the auto-route mode changes', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		const reads = fake.received.length
		await module.configUpdated({ host: '127.0.0.1', port, autoRoute: 'cut' })
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(fake.received.length).toBe(reads)
		expect(variable(module, 'auto_route_mode')).toBe('CUT')
	})

	it('takes staged routes as one command', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		module.stage(3, 7)
		module.stage(3, 8)
		expect(variable(module, 'stagedname_O7')).toBe('Input 3')
		await module.takeStaged()
		expect(writes()).toEqual(['CALL /MEDIA/XP/VIDEO:switch(I3:O7;I3:O8)'])
		expect(module.state.staged.size).toBe(0)
		await until(() => variable(module, 'source_O8') === 'I3')
	})

	it('leaves a locked output staged and takes the rest', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		await module.lockOutput(8, 'lockDestination')
		await until(() => module.state.isLocked(8))
		module.stage(3, 7)
		module.stage(3, 8)
		await module.takeStaged()
		expect(writes()).toContain('CALL /MEDIA/XP/VIDEO:switch(I3:O7)')
		expect([...module.state.staged.keys()]).toEqual([8])
	})

	it('recalls a router preset and shows it is live', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		expect(module.state.isPresetLive('SHOW-A')).toBe(false)
		await module.loadPreset('SHOW-A')
		expect(writes()).toEqual(['CALL /MEDIA/PRESET/SHOW-A:load()'])
		await until(() => module.state.isPresetLive('SHOW-A'))
		expect(variable(module, 'live_preset')).toBe('SHOW-A')
		expect(mock(module.checkFeedbacks).mock.calls.flat()).toContain('presetLive')
	})

	describe('in the Stage mode', () => {
		const stagedPresets = async (): Promise<void> => {
			await module.init({ host: '127.0.0.1', port, autoRoute: 'stage' })
			await connected()
		}

		it('stages a clear with the other routes, and shows it as None', async () => {
			await stagedPresets()
			module.selectInput(3)
			module.selectOutput(7)
			module.selectOutput(1)
			await module.clearRoute(1)
			expect(writes()).toEqual([])
			expect(variable(module, 'stagedname_O1')).toBe('None')
			expect(variable(module, 'stagedname_O7')).toBe('Input 3')
			await module.takeStaged()
			expect(writes()).toEqual(['CALL /MEDIA/XP/VIDEO:switch(I3:O7;0:O1)'])
			await until(() => variable(module, 'source_O1') === '0')
		})

		it('starts a new pair after staging a clear, instead of replacing it', async () => {
			await stagedPresets()
			module.selectOutput(1)
			await module.clearRoute(1)
			module.selectInput(3)
			expect(module.state.selectedOutput).toBeUndefined()
			expect(module.state.staged.get(1)).toBe(0)
		})

		it('stages a preset instead of loading it, reading it fresh', async () => {
			await stagedPresets()
			fake.presets.set('SHOW-A', ['uI1', 'uI3', 'uI2', 'uI1', 'u0', 'uI2', 'uI4', 'uI2'])
			const reads = fake.received.length
			await module.recallPreset('SHOW-A')
			expect(writes()).toEqual([])
			expect(fake.received.slice(reads)).toEqual(['GET /MEDIA/PRESET/SHOW-A.VideoDestination'])
			expect(module.state.isPresetStaged('SHOW-A')).toBe(true)
			expect(module.state.isPresetLive('SHOW-A')).toBe(false)
			expect(logged(module, 'info')).toContain('Router preset SHOW-A staged: 2 outputs would change')
		})

		it('takes only what would change, then shows the preset as live', async () => {
			await stagedPresets()
			fake.presets.set('SHOW-A', ['uI1', 'uI3', 'uI2', 'uI1', 'u0', 'uI2', 'uI4', 'uI2'])
			await module.recallPreset('SHOW-A')
			expect(variable(module, 'stagedname_O1')).toBe('')
			expect(variable(module, 'stagedname_O2')).toBe('Input 3')
			await module.takeStaged()
			expect(writes()).toEqual(['CALL /MEDIA/XP/VIDEO:switch(I3:O2;I4:O7)'])
			await until(() => module.state.routes.get(7) === 4)
			expect(module.state.staged.size).toBe(0)
			expect(module.state.isPresetStaged('SHOW-A')).toBe(false)
			await until(() => module.state.isPresetLive('SHOW-A'))
			expect(variable(module, 'live_preset')).toBe('SHOW-A')
		})

		it('replaces what was staged when another preset is pressed', async () => {
			await stagedPresets()
			module.stage(3, 5)
			await module.recallPreset('SHOW-A')
			expect(module.state.staged.get(5)).toBe(1)
			await module.recallPreset('SHOW-B')
			expect(module.state.staged.get(5)).toBe(2)
			expect(module.state.isPresetStaged('SHOW-A')).toBe(false)
			expect(module.state.isPresetStaged('SHOW-B')).toBe(true)
		})

		it('stops showing a preset as staged once it is added to, or cleared', async () => {
			await stagedPresets()
			await module.recallPreset('SHOW-A')
			module.stage(3, 5)
			expect(module.state.isPresetStaged('SHOW-A')).toBe(false)
			expect(module.state.hasStagedRoutes).toBe(true)
			await module.recallPreset('SHOW-A')
			module.clearStaged()
			expect(module.state.isPresetStaged('SHOW-A')).toBe(false)
			expect(module.state.hasStagedRoutes).toBe(false)
		})

		it('keeps a locked output staged and takes the rest of a preset', async () => {
			await stagedPresets()
			await module.lockOutput(2, 'lockDestination')
			await until(() => module.state.isLocked(2))
			await module.recallPreset('SHOW-A')
			await module.takeStaged()
			expect([...module.state.staged.keys()]).toEqual([2])
			expect(logged(module, 'warn')).toContain('Output 2 is locked, so its staged route stays staged')
		})

		it('warns when a preset is not on the router, and leaves what was staged alone', async () => {
			await stagedPresets()
			module.stage(3, 5)
			await module.recallPreset('SHOW-Z')
			expect(module.state.staged.get(5)).toBe(3)
			expect(logged(module, 'warn').some((line) => line.startsWith("Couldn't read router preset SHOW-Z"))).toBe(true)
		})
	})

	it('recalls a preset straight away in the Cut and Off modes', async () => {
		await module.init({ host: '127.0.0.1', port, autoRoute: 'cut' })
		await connected()
		await module.recallPreset('SHOW-A')
		expect(writes()).toEqual(['CALL /MEDIA/PRESET/SHOW-A:load()'])
	})

	it('never sends a preset name that could change the command', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		await module.loadPreset('X:factoryDefaults')
		await module.loadPreset('X\r\nCALL /SYS:factoryDefaults()')
		await module.stagePreset('X:factoryDefaults')
		expect(writes()).toEqual([])
		expect(logged(module, 'warn')).toHaveLength(3)
	})

	it('renames a port, keeping its number, and says nothing about its own rename', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		await module.renamePort('I2', 'Camera 2')
		expect(writes()).toEqual(['SET /MEDIA/NAMES/VIDEO.I2=2;Camera 2'])
		expect(variable(module, 'name_I2')).toBe('Camera 2')
		expect(variable(module, 'sourcename_O2')).toBe('Camera 2')
		await until(() => (mock(module.setActionDefinitions).mock.calls.length ?? 0) > 1)
		expect(logged(module, 'info').filter((line) => line.includes('renamed'))).toEqual([])
	})

	it('reports a name changed from elsewhere and updates the dropdowns', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		const before = mock(module.setActionDefinitions).mock.calls.length
		fake.renameFromPanel('O3', 'Monitor')
		await until(() => variable(module, 'name_O3') === 'Monitor')
		expect(logged(module, 'info')).toContain('O3 renamed: "Output 3" to "Monitor"')
		await until(() => mock(module.setActionDefinitions).mock.calls.length > before)
		expect(lastCall(module.setActionDefinitions).xpt.options[1].choices[2].label).toBe('3: Monitor')
	})

	it('follows signal and cable changes', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		const feedback = lastCall(module.setFeedbackDefinitions)
		const options = { options: { port: 'I1' } }
		expect(feedback.portSignal.callback(options)).toBe(false)
		fake.setSignal('I1', true, true)
		await until(() => feedback.portSignal.callback(options) === true)
		expect(feedback.portConnected.callback(options)).toBe(true)
		fake.setSignal('I1', true, false)
		await until(() => feedback.portSignal.callback(options) === false)
		expect(feedback.portConnected.callback(options)).toBe(true)
	})

	it('only tests a quiet connection: no reads, and nothing touches the buttons', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		// let the rebuild from the first read finish, so only what comes after gets counted
		await new Promise((resolve) => setTimeout(resolve, 200))
		const checks = mock(module.checkFeedbacks).mock.calls.length
		const definitions = mock(module.setActionDefinitions).mock.calls.length
		const before = fake.received.length
		await until(() => fake.received.length >= before + 2, 8000)
		expect(new Set(fake.received.slice(before))).toEqual(new Set(['GET /.ProductName']))
		expect(mock(module.checkFeedbacks).mock.calls.length).toBe(checks)
		expect(mock(module.setActionDefinitions).mock.calls.length).toBe(definitions)
	}, 10_000)

	it('reads a preset again when the router announces a change to it, which can make it live', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		expect(fake.received).toContain('OPEN /MEDIA/PRESET/*')
		expect(module.state.isPresetLive('SHOW-A')).toBe(false)
		fake.savePresetFromPanel('SHOW-A', ['uI1', 'uI2', 'uI2', 'uI1', 'u0', 'uI2', 'u0', 'uI2'])
		await until(() => module.state.isPresetLive('SHOW-A'))
		expect(variable(module, 'live_preset')).toBe('SHOW-A')
	})

	it('picks up a new preset from an announcement, adding a button for it', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		fake.savePresetFromPanel(
			'SHOW-C',
			Array.from({ length: 8 }, () => 'uI3'),
		)
		await until(() => module.state.presets.has('SHOW-C'))
		await until(() => Object.keys(lastPresets(module)).includes('preset_SHOW-C'))
		expect(logged(module, 'info')).toContain('Router presets now: SHOW-A, SHOW-B, SHOW-C')
	})

	it('tests a quiet connection, and reconnects when the router stops answering', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		fake.silent = true
		await until(() => logged(module, 'warn').some((line) => line.startsWith('No reply from the router')), 8000)
		expect(mock(module.updateStatus)).toHaveBeenCalledWith(InstanceStatus.ConnectionFailure, 'No reply from the router')
		fake.silent = false
		await until(() => logged(module, 'info').some((line) => line.startsWith('Reconnected')), 8000)
	}, 20_000)

	it('reconnects and reads again after the connection drops', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		const found = (): number => logged(module, 'info').filter((line) => line.startsWith('Router found')).length
		fake.routes[0] = 5
		fake.dropClients()
		await until(() => found() === 2, 10_000)
		expect(variable(module, 'source_O1')).toBe('I5')
	}, 15_000)

	it('warns plainly on a router without this routing', async () => {
		await fake.close()
		fake = new FakeLw3({ noRouting: true })
		port = await fake.listen()
		await module.init({ host: '127.0.0.1', port })
		await until(() => logged(module, 'warn').some((line) => line.includes("doesn't have the routing")))
		expect(mock(module.updateStatus)).toHaveBeenCalledWith(
			InstanceStatus.UnknownWarning,
			'Router model not supported yet',
		)
	})

	it('builds a preset for every port and router preset, each lit while held', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		await until(() => Object.keys(lastPresets(module)).includes('preset_SHOW-A'))
		const presets = lastPresets(module)
		const feedbackIds = Object.keys(lastCall(module.setFeedbackDefinitions))
		const actionIds = Object.keys(lastCall(module.setActionDefinitions))
		expect(Object.keys(presets)).toHaveLength(7 + 2 + 8 * 2 + 8)
		for (const [id, preset] of Object.entries(presets)) {
			for (const variant of preset.variants) {
				const used: string[] = variant.feedbacks.map((feedback: { feedbackId: string }) => feedback.feedbackId)
				expect(used, id).toContain('internal:buttonPushed')
				for (const feedback of used.filter((name) => !name.startsWith('internal:'))) {
					expect(feedbackIds).toContain(feedback)
				}
				for (const action of variant.steps[0].down) expect(actionIds).toContain(action.actionId)
			}
		}
	})

	it('has no one-press preset that restarts the router', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		expect(JSON.stringify(lastPresets(module))).not.toContain('softreset')
	})
})
