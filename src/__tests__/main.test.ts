/**
 * Drives the module against the fake router over a real TCP connection on localhost. Companion's
 * `InstanceBase` is stubbed, and the socket is the real `TCPHelper`.
 */
import { Script } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { InstanceStatus } from '@companion-module/base'
import { portNumber, portOf } from '../choices.js'
import { plainName } from '../protocol.js'
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

describe('log lines', () => {
	it('carry the connection label as their source', () => {
		const sink = vi.fn()
		vi.stubGlobal('COMPANION_LOGGER', sink)
		ModuleInstance.prototype.log.call({ label: 'lightwareLW3' }, 'warn', 'hello')
		vi.unstubAllGlobals()
		expect(sink).toHaveBeenCalledWith('lightwareLW3', 'warn', 'hello')
	})
})

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

	it("draws every preset without Companion's top bar or status icons", async () => {
		await module.init({ host: '' })
		for (const preset of Object.values(lastPresets(module))) {
			expect(preset.variants[0].canvas).toEqual({ decoration: 'none', showStatusIcons: 'none' })
			expect(preset.variants[1].style.show_topbar).toBe(false)
		}
	})

	it('shows a mute over being selected, and pressing over a mute, on port buttons', async () => {
		await module.init({ host: '' })
		const presets = lastPresets(module)
		// the layered button and its plain fallback list them in the same order
		const order = (id: string): string[] =>
			(presets[id].variants[1].feedbacks as { feedbackId: string }[]).map(({ feedbackId }) => feedbackId)
		for (const [id, selected] of [
			['input_1', 'sourceSelected'],
			['output_1', 'destinationSelected'],
			['routed_1', 'destinationSelected'],
		]) {
			const feedbacks = order(id)
			expect(feedbacks.indexOf('portMuted')).toBeGreaterThan(feedbacks.indexOf(selected))
			expect(feedbacks.indexOf('portMuted')).toBeLessThan(feedbacks.indexOf('internal:buttonPushed'))
		}
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

	it('lights LOCK red while the selected output is locked', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		const locked = lastCall(module.setFeedbackDefinitions).portLocked
		module.selectOutput(7)
		expect(locked.callback({ options: { port: 'selected' } })).toBe(false)
		await module.lockOutput(7, 'lockDestination')
		await until(() => module.state.isLocked(7))
		expect(locked.callback({ options: { port: 'selected' } })).toBe(true)
		const lock = lastPresets(module).lock.variants[0].feedbacks.map((f: { feedbackId: string }) => f.feedbackId)
		expect(lock).toEqual(['portLocked', 'internal:buttonPushed'])
	})

	describe('default names', () => {
		it('only sends names that are not already the default, and the model as the router name', async () => {
			fake.outputs[1].name = 'Projector L'
			fake.inputs[2].name = 'Laptop'
			fake.routerName = 'Show rack'
			await module.init({ host: '127.0.0.1', port })
			await connected()
			await module.setDefaultNames('all')
			expect(writes()).toEqual([
				'SET /MEDIA/NAMES/VIDEO.I3=2;Input 3',
				'SET /MEDIA/NAMES/VIDEO.O2=2;Output 2',
				'SET /MANAGEMENT/UID.DeviceLabel=MX2-8x8-HDMI20-L',
			])
			expect(logged(module, 'info')).toContain('Default names: 3 changed, 0 refused')
		})

		it('can do just the inputs, and does nothing when run again', async () => {
			fake.inputs[0].name = 'Camera'
			fake.outputs[0].name = 'Screen'
			await module.init({ host: '127.0.0.1', port })
			await connected()
			await module.setDefaultNames('inputs')
			await module.setDefaultNames('inputs')
			expect(writes()).toEqual(['SET /MEDIA/NAMES/VIDEO.I1=2;Input 1'])
		})

		it('gives the page the model, for its Default names button', async () => {
			await module.init({ host: '127.0.0.1', port })
			await connected()
			const reply = await module.handleHttpRequest({
				method: 'GET',
				path: '/ports',
				baseUrl: '',
				originalUrl: '/ports',
				hostname: 'companion.local',
				ip: '127.0.0.1',
				query: {},
				headers: { host: 'companion.local:8000' },
			})
			expect(JSON.parse(reply.body ?? '{}').model).toBe('MX2-8x8-HDMI20-L')
		})
	})

	describe('input locks', () => {
		it('locks the input pressed last, and shows it and the outputs it holds as locked', async () => {
			await module.init({ host: '127.0.0.1', port })
			await connected()
			const locked = lastCall(module.setFeedbackDefinitions).portLocked
			module.selectInput(2)
			expect(variable(module, 'selected_lock_text')).toBe('LOCK\nInput 2')
			await module.lockPort('selected', 'toggle')
			await until(() => module.state.isInputLocked(2))
			expect(writes()).toEqual(['CALL /MEDIA/XP/VIDEO:lockSource(I2)'])
			expect(variable(module, 'selected_lock_text')).toBe('UNLOCK\nInput 2')
			expect(locked.callback({ options: { port: 'I2' } })).toBe(true)
			// Input 2 is on outputs 2, 3, 6 and 8, which the router freezes without marking them
			expect(locked.callback({ options: { port: 'O3' } })).toBe(true)
			expect(locked.callback({ options: { port: 'O1' } })).toBe(false)
			expect(logged(module, 'info')).toContain('I2 locked')
		})

		it('says an input lock is why a route was refused, and leaves those routes out of a take', async () => {
			await module.init({ host: '127.0.0.1', port })
			await connected()
			await module.lockPort('I2', 'lock')
			await until(() => module.state.isInputLocked(2))
			await module.routeNow(2, 1)
			expect(logged(module, 'warn')).toContain('Refused: Input 2 is locked')
			module.stage(1, 3)
			module.stage(1, 5)
			await module.takeStaged()
			expect(logged(module, 'warn')).toContain(
				'Input 2 is locked, which holds Output 3, so its staged route stays staged',
			)
			expect(writes()).toContain('CALL /MEDIA/XP/VIDEO:switch(I1:O5)')
			await module.mutePort('I2', 'mute')
			expect(logged(module, 'warn')).toContain("Input 2 is locked, so it can't be muted")
		})
	})

	describe('what the reviewers check', () => {
		it('sends only the variables that changed when a route changes', async () => {
			await module.init({ host: '127.0.0.1', port })
			await connected()
			await new Promise((resolve) => setTimeout(resolve, 200))
			const before = mock(module.setVariableValues).mock.calls.length
			await module.routeNow(3, 7)
			await until(() => module.state.routes.get(7) === 3)
			const sent = mock(module.setVariableValues).mock.calls.slice(before) as [Record<string, unknown>][]
			const ids = new Set(sent.flatMap(([values]) => Object.keys(values)))
			expect(ids.has('source_O7')).toBe(true)
			expect(ids.has('sourcename_O7')).toBe(true)
			expect(ids.has('source_O1')).toBe(false)
			expect(ids.has('sourcename_O8')).toBe(false)
		})

		it('runs one preset read at a time, with one more after it for anything that came in meanwhile', async () => {
			await module.init({ host: '127.0.0.1', port })
			await connected()
			const before = fake.received.length
			const save = async (): Promise<unknown> =>
				module.handleHttpRequest({
					method: 'POST',
					path: '/preset/save',
					baseUrl: '',
					originalUrl: '/preset/save',
					hostname: 'companion.local',
					ip: '127.0.0.1',
					query: {},
					headers: { host: 'companion.local:8000' },
					body: JSON.stringify({ name: 'SHOW-A' }),
				})
			await Promise.all([save(), save(), save()])
			expect(fake.received.slice(before).filter((command) => command === 'GET /MEDIA/PRESET')).toHaveLength(2)
		})

		it('takes a bare number from an expression, and says so when a port makes no sense', async () => {
			expect(portNumber(1, 'I')).toBe(1)
			expect(portNumber('I3', 'I')).toBe(3)
			expect(portNumber('O3', 'I')).toBeUndefined()
			expect(portNumber(1.5, 'O')).toBeUndefined()
			expect(portNumber('i3', 'I')).toBe(3)
			expect(portOf('o2')).toBe('O2')
			expect(portOf('SELECTED')).toBe('selected')
			expect(portOf('2')).toBeUndefined()
			await module.init({ host: '127.0.0.1', port })
			await connected()
			await module.mutePort('1', 'mute')
			expect(logged(module, 'warn')).toContain('"1" isn\'t a port: use I1 or O1')
			await module.mutePort('o3', 'mute')
			expect(writes()).toEqual(['CALL /MEDIA/XP/VIDEO:muteDestination(O3)'])
		})

		it('says what to type for a port dropdown in expression mode, and hides what a tick makes irrelevant', async () => {
			await module.init({ host: '' })
			const actions = lastCall(module.setActionDefinitions)
			const option = (action: string, id: string): Record<string, any> =>
				actions[action].options.find((candidate: { id: string }) => candidate.id === id)
			expect(option('xpt', 'input').expressionDescription).toBe('Input number, such as 1')
			expect(option('xpt', 'input').allowCustom).toBe(true)
			expect(option('mute', 'port').expressionDescription).toContain('selected')
			expect(option('outputLock', 'cmd').expressionDescription).toContain('lockDestination')
			for (const action of ['unroute', 'outputLock', 'hotplugOutput']) {
				expect(option(action, 'useSelected').disableAutoExpression).toBe(true)
				expect(option(action, 'output').isVisibleExpression).toBe('!$(options:useSelected)')
			}
			expect(option('outputLock', 'output')).toMatchObject({ step: 1, asInteger: true })
			expect(option('recallSlot', 'slot')).toMatchObject({ step: 1, asInteger: true })
		})
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

	describe('mute', () => {
		it('mutes and unmutes whichever was pressed last, input or output', async () => {
			await module.init({ host: '127.0.0.1', port })
			await connected()
			module.selectOutput(7)
			module.selectInput(3)
			expect(variable(module, 'selected_mute_text')).toBe('MUTE\nInput 3')
			await module.mutePort('selected', 'toggle')
			await until(() => module.state.isMuted('I3'))
			expect(variable(module, 'selected_mute_text')).toBe('UNMUTE\nInput 3')
			module.selectOutput(8)
			await module.mutePort('selected', 'toggle')
			await until(() => module.state.isMuted('O8'))
			await module.mutePort('O8', 'unmute')
			await until(() => !module.state.isMuted('O8'))
			expect(writes()).toEqual([
				'CALL /MEDIA/XP/VIDEO:muteSource(I3)',
				'CALL /MEDIA/XP/VIDEO:muteDestination(O8)',
				'CALL /MEDIA/XP/VIDEO:unmuteDestination(O8)',
			])
			// the route stays, which is what makes a mute different from clearing it
			expect(module.state.routes.get(8)).toBe(2)
			expect(logged(module, 'warn')).toEqual([])
		})

		it('does nothing with nothing selected, and says why', async () => {
			await module.init({ host: '127.0.0.1', port })
			await connected()
			expect(variable(module, 'selected_mute_text')).toBe('[UN]MUTE\nIN/OUT')
			await module.mutePort('selected', 'toggle')
			expect(writes()).toEqual([])
			expect(logged(module, 'warn')).toContain('Select an input or an output before muting')
		})

		it('says a locked output is locked, rather than passing on the router\'s "Not exists"', async () => {
			await module.init({ host: '127.0.0.1', port })
			await connected()
			await module.lockOutput(7, 'lockDestination')
			await until(() => module.state.isLocked(7))
			await module.mutePort('O7', 'mute')
			expect(writes()).toEqual(['CALL /MEDIA/XP/VIDEO:lockDestination(O7)'])
			expect(logged(module, 'warn')).toContain("Output 7 is locked, so it can't be muted")
		})

		it('logs a mute made elsewhere', async () => {
			await module.init({ host: '127.0.0.1', port })
			await connected()
			fake.outputs[1].muted = true
			fake.announceStatus()
			await until(() => module.state.isMuted('O2'))
			expect(logged(module, 'info')).toContain('O2 muted')
		})
	})

	describe('hotplug', () => {
		it("turns an output's 5V off and back on, and shows it meanwhile", async () => {
			await module.init({ host: '127.0.0.1', port })
			await connected()
			const done = module.hotplug('O8', 0.5)
			await until(() => fake.output5v[7] === 'false')
			expect(module.state.hotplugging.has('O8')).toBe(true)
			expect(await done).toBeUndefined()
			expect(fake.output5v[7]).toBe('true')
			expect(module.state.hotplugging.has('O8')).toBe(false)
			expect(writes()).toEqual([
				'SET /MEDIA/PORTS/VIDEO/O8/SETTINGS.Enable5V=false',
				'SET /MEDIA/PORTS/VIDEO/O8/SETTINGS.Enable5V=true',
			])
			expect(logged(module, 'info')).toContain('Hotplug: Output 8 off for 0.5 s')
		})

		it('says which outputs an input hotplug drops', async () => {
			await module.init({ host: '127.0.0.1', port })
			await connected()
			expect(await module.hotplug('I2', 0.5)).toBeUndefined()
			expect(writes()).toEqual([
				'SET /MEDIA/PORTS/VIDEO/I2/SETTINGS.EnableHPD=OFF',
				'SET /MEDIA/PORTS/VIDEO/I2/SETTINGS.EnableHPD=AUTO',
			])
			expect(logged(module, 'info')).toContain(
				'Hotplug: Input 2 off for 0.5 s, which drops Output 2, Output 3, Output 6, Output 8',
			)
		})

		it('leaves alone a port someone turned off on purpose', async () => {
			await module.init({ host: '127.0.0.1', port })
			await connected()
			fake.output5v[2] = 'false'
			expect(await module.hotplug('O3', 0.5)).toBe('Output 3 is already off')
			expect(writes()).toEqual([])
			expect(fake.output5v[2]).toBe('false')
		})

		it('link trains a DisplayPort output, and shows it meanwhile, on a router that mixes port types', async () => {
			await module.init({ host: '127.0.0.1', port })
			await connected()
			fake.displayPort.add('O8')
			const done = module.hotplug('O8', 0.5)
			await until(() => writes().length > 0)
			expect(module.state.hotplugging.has('O8')).toBe(true)
			expect(await done).toBeUndefined()
			expect(module.state.hotplugging.has('O8')).toBe(false)
			expect(writes()).toEqual(['CALL /MEDIA/PORTS/VIDEO/O8/SETTINGS:dpLinkTrain()'])
			expect(fake.output5v[7]).toBe('true')
			expect(logged(module, 'info')).toContain('Hotplug: Output 8 link train')
			expect(await module.hotplug('O7', 0.5)).toBeUndefined()
			expect(writes()).toContain('SET /MEDIA/PORTS/VIDEO/O7/SETTINGS.Enable5V=false')
		})

		it('says which outputs a DisplayPort input drops', async () => {
			await module.init({ host: '127.0.0.1', port })
			await connected()
			fake.displayPort.add('I2')
			expect(await module.hotplug('I2')).toBeUndefined()
			expect(writes()).toEqual(['CALL /MEDIA/PORTS/VIDEO/I2/SETTINGS:dpLinkTrain()'])
			expect(logged(module, 'info')).toContain(
				'Hotplug: Input 2 link train, which drops Output 2, Output 3, Output 6, Output 8',
			)
		})

		it('sends nothing to a port with no way to hotplug', async () => {
			await module.init({ host: '127.0.0.1', port })
			await connected()
			fake.noHotplug.add('O3')
			expect(await module.hotplug('O3', 0.5)).toBe("Output 3 can't be hotplugged")
			expect(writes()).toEqual([])
			expect(module.state.hotplugging.has('O3')).toBe(false)
		})

		it('turns a port back on after reconnecting, if the router stopped answering part way', async () => {
			await module.init({ host: '127.0.0.1', port })
			await connected()
			const done = module.hotplug('O8', 0.5)
			await until(() => fake.output5v[7] === 'false')
			fake.silent = true
			await done
			expect(logged(module, 'warn').join()).toContain('Output 8 is still off after its hotplug')
			fake.silent = false
			await until(() => fake.output5v[7] === 'true', 15_000)
			// the router turns it on a moment before the module hears that it did
			await until(() => logged(module, 'info').includes('Hotplug: Output 8 back on'))
		}, 30_000)
	})

	describe('an input to every output', () => {
		it('routes it now with Cut, in one command, leaving locked outputs and those already on it', async () => {
			await module.init({ host: '127.0.0.1', port, autoRoute: 'cut' })
			await connected()
			await module.lockOutput(8, 'lockDestination')
			await until(() => module.state.isLocked(8))
			await module.routeToAll(2)
			expect(writes()).toEqual([
				'CALL /MEDIA/XP/VIDEO:lockDestination(O8)',
				'CALL /MEDIA/XP/VIDEO:switch(I2:O1;I2:O4;I2:O5;I2:O7)',
			])
			expect(logged(module, 'warn')).toContain('Left as they are: Output 8 is locked')
		})

		it('stages it for TAKE with Off or Stage', async () => {
			await module.init({ host: '127.0.0.1', port })
			await connected()
			await module.routeToAll(3)
			expect(writes()).toEqual([])
			expect(module.state.stagedRoutes()).toHaveLength(8)
			await module.take()
			expect(writes()).toEqual(['CALL /MEDIA/XP/VIDEO:switch(I3:O1;I3:O2;I3:O3;I3:O4;I3:O5;I3:O6;I3:O7;I3:O8)'])
		})

		it('selects an input on a short press and sends it to every output on a hold', async () => {
			await module.init({ host: '' })
			const [step] = lastPresets(module).input_2.variants[0].steps
			expect(step.down).toEqual([])
			expect(step.up).toEqual([{ actionId: 'selectSource', options: { port: 'I2' } }])
			expect(step[1000]).toEqual({
				options: { runWhileHeld: true },
				actions: [{ actionId: 'routeToAll', options: { input: 'I2' } }],
			})
		})
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

	describe('the one TAKE', () => {
		const ready = async (autoRoute: 'off' | 'stage' = 'off'): Promise<void> => {
			await module.init({ host: '127.0.0.1', port, autoRoute })
			await connected()
		}

		it('takes a selected pair when nothing is staged', async () => {
			await ready()
			module.selectOutput(7)
			module.selectInput(3)
			await module.take()
			expect(writes()).toEqual(['CALL /MEDIA/XP/VIDEO:switch(I3:O7)'])
			expect(module.state.selectedInput).toBeUndefined()
		})

		it('takes what is staged', async () => {
			await ready('stage')
			module.selectInput(3)
			module.selectOutput(7)
			module.selectOutput(8)
			await module.take()
			expect(writes()).toEqual(['CALL /MEDIA/XP/VIDEO:switch(I3:O7;I3:O8)'])
			expect(module.state.staged.size).toBe(0)
			expect(module.state.selectedInput).toBeUndefined()
		})

		it('sends staged routes and a selected pair in one command', async () => {
			await ready()
			module.stage(3, 7)
			module.selectOutput(8)
			module.selectInput(4)
			await module.take()
			expect(writes()).toEqual(['CALL /MEDIA/XP/VIDEO:switch(I3:O7;I4:O8)'])
			expect(module.state.staged.size).toBe(0)
			expect(module.state.selectedInput).toBeUndefined()
		})

		it('lets the selected pair win over a route staged for the same output', async () => {
			await ready()
			module.stage(3, 7)
			module.selectOutput(7)
			module.selectInput(4)
			await module.take()
			expect(writes()).toEqual(['CALL /MEDIA/XP/VIDEO:switch(I4:O7)'])
			expect(module.state.staged.size).toBe(0)
		})

		it('keeps a selected pair whose output is locked, and sends the rest', async () => {
			await ready()
			await module.lockOutput(8, 'lockDestination')
			await until(() => module.state.isLocked(8))
			module.stage(3, 7)
			module.selectOutput(8)
			module.selectInput(4)
			await module.take()
			expect(writes().filter((line) => line.includes('switch'))).toEqual(['CALL /MEDIA/XP/VIDEO:switch(I3:O7)'])
			expect(module.state.selectedInput).toBe(4)
			expect(logged(module, 'warn').join()).toContain('stays selected')
		})

		it('sends nothing after the staged routes are cleared, even with the pair on show', async () => {
			await ready('stage')
			module.selectInput(3)
			module.selectOutput(7)
			module.clearStaged()
			expect(module.state.selectedInput).toBeUndefined()
			expect(module.state.selectedOutput).toBeUndefined()
			expect(variable(module, 'selected_input_label')).toBe('IN')
			await module.take()
			expect(writes()).toEqual([])
		})

		it('keeps a pair that was never staged when clearing in Off', async () => {
			await ready()
			module.stage(3, 7)
			module.selectOutput(8)
			module.selectInput(4)
			module.clearStaged()
			expect(module.state.staged.size).toBe(0)
			expect(module.state.selectedInput).toBe(4)
			await module.take()
			expect(writes()).toEqual(['CALL /MEDIA/XP/VIDEO:switch(I4:O8)'])
		})

		it('clears a half selection when clearing in Stage', async () => {
			await ready('stage')
			module.selectInput(3)
			module.clearStaged()
			expect(module.state.selectedInput).toBeUndefined()
		})

		it('shows the next input only on the selected output, while it would change the route', async () => {
			await ready()
			const next = (output: string): boolean => {
				const { outputNext } = lastCall(module.setFeedbackDefinitions)
				return outputNext.callback({ options: { output } })
			}
			module.selectOutput(7)
			expect(next('O7')).toBe(false)
			module.selectInput(3)
			expect(next('O7')).toBe(true)
			expect(next('O8')).toBe(false)
			await module.take()
			expect(next('O7')).toBe(false)
			await until(() => variable(module, 'source_O7') === 'I3')
			module.selectOutput(7)
			module.selectInput(3)
			expect(next('O7')).toBe(false)
		})

		it('asks for a selection when there is nothing to take', async () => {
			await ready()
			await module.take()
			expect(writes()).toEqual([])
			expect(logged(module, 'warn').join()).toContain('Select an input and an output')
		})
	})

	describe('leaving Stage', () => {
		it.each(['off', 'cut'] as const)('discards what is staged on moving to %s, and logs it', async (mode) => {
			await module.init({ host: '127.0.0.1', port, autoRoute: 'stage' })
			await connected()
			module.selectInput(3)
			module.selectOutput(7)
			module.setAutoRouteMode(mode)
			expect(module.state.staged.size).toBe(0)
			expect(module.state.selectedInput).toBeUndefined()
			expect(writes()).toEqual([])
			expect(logged(module, 'info').join()).toContain('Input 3 to Output 7')
			await module.take()
			expect(writes()).toEqual([])
		})

		it('does the same when the connection settings change it', async () => {
			await module.init({ host: '127.0.0.1', port, autoRoute: 'stage' })
			await connected()
			module.stage(3, 7)
			await module.configUpdated({ host: '127.0.0.1', port, autoRoute: 'off' })
			expect(module.state.staged.size).toBe(0)
		})

		it('keeps routes staged by an action while moving between the other modes', async () => {
			await module.init({ host: '127.0.0.1', port })
			await connected()
			module.stage(3, 7)
			module.setAutoRouteMode('cut')
			expect(module.state.staged.size).toBe(1)
		})
	})

	it('follows a router name changed elsewhere, and the port legend', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		const legend = (port: string, level: string): boolean =>
			lastCall(module.setFeedbackDefinitions).portLegend.callback({ options: { port, level } })
		expect(variable(module, 'router_name')).toBe('MX2-8x8-HDMI20-L')
		fake.setSignal('I1', true, true)
		await until(() => legend('I1', 'hdmi18'))
		fake.setDetail('Source', 'A;0;0;0;0;0;0;0;')
		await until(() => legend('I1', 'dvi'))
		fake.setSignal('I1', true, false)
		await until(() => legend('I1', 'connected'))
		fake.setSignal('I1', false, false)
		await until(() => legend('I1', 'none'))
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
		// the heartbeat asks for the firmware, which also notices an upgrade
		expect(new Set(fake.received.slice(before))).toEqual(new Set(['GET /MANAGEMENT/UID.FirmwareVersion']))
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

	describe('saving router presets', () => {
		it('overwrites the preset pressed after SAVE, instead of recalling it', async () => {
			await module.init({ host: '127.0.0.1', port })
			await connected()
			module.armSave()
			expect(module.state.saveArmed).toBe(true)
			await module.recallPreset('SHOW-B')
			expect(module.state.saveArmed).toBe(false)
			expect(writes()).toEqual(['CALL /MEDIA/PRESET/SHOW-B:save()'])
			expect(fake.presets.get('SHOW-B')).toEqual(['uI1', 'uI2', 'uI2', 'uI1', 'u0', 'uI2', 'u0', 'uI2'])
			await until(() => module.state.isPresetLive('SHOW-B'))
			expect(logged(module, 'info')).toContain('Router preset SHOW-B overwritten with the current routes')
		})

		it('cancels SAVE on a second press or any other button, and on its own after 5 s', async () => {
			await module.init({ host: '127.0.0.1', port })
			await connected()
			module.armSave()
			module.armSave()
			expect(module.state.saveArmed).toBe(false)
			module.armSave()
			module.selectOutput(3)
			expect(module.state.saveArmed).toBe(false)
			vi.useFakeTimers()
			try {
				module.armSave()
				vi.advanceTimersByTime(5000)
				expect(module.state.saveArmed).toBe(false)
			} finally {
				vi.useRealTimers()
			}
			await module.recallPreset('SHOW-B')
			expect(writes()).toEqual(['CALL /MEDIA/PRESET/SHOW-B:load()'])
		})

		it('saves to a front-panel preset after SAVE then an input, making ButtonN when it is empty', async () => {
			await module.init({ host: '127.0.0.1', port })
			await connected()
			await until(() => variable(module, 'preset_slot_3') === 'EMPTY\nButton3')
			module.armSave()
			module.selectInput(3)
			await until(() => variable(module, 'preset_slot_3') === 'Button3')
			expect(module.state.selectedInput).toBeUndefined()
			expect(writes()).toEqual(['CALL /MEDIA/PRESET:createButtonAssignedPreset(3,VIDEO)'])
			// a second time, the preset it holds is overwritten
			module.armSave()
			await module.recallSlot(3)
			expect(writes()).toContain('CALL /MEDIA/PRESET/Button3:save()')
		})

		it('follows a front-panel preset changed elsewhere, and recalls whatever it holds', async () => {
			await module.init({ host: '127.0.0.1', port })
			await connected()
			fake.slots[0] = 'SHOW-B'
			fake.announceSlot(1)
			await until(() => variable(module, 'preset_slot_1') === 'SHOW-B')
			expect(logged(module, 'info')).toContain('Front-panel preset 1 is now SHOW-B')
			await module.recallSlot(1)
			expect(writes()).toEqual(['CALL /MEDIA/PRESET/SHOW-B:load()'])
			await module.recallSlot(2)
			expect(logged(module, 'warn')).toContain('Front-panel preset 2 is empty')
		})

		it('saves what a take would leave when routes are staged, without routing anything', async () => {
			await module.init({ host: '127.0.0.1', port })
			await connected()
			module.stage(3, 5)
			module.armSave()
			await module.recallPreset('SHOW-B')
			expect(writes()).toEqual(['SET /MEDIA/PRESET/SHOW-B.VideoDestination=uI1;uI2;uI2;uI1;uI3;uI2;u0;uI2;'])
			expect(module.state.routes.get(5)).toBe(0)
			expect(logged(module, 'info')).toContain(
				'Router preset SHOW-B overwritten with what a take would leave, including 1 staged route',
			)
		})

		it('says in the settings which router it is connected to', async () => {
			expect((module.getConfigFields()[0] as { value: string }).value).toBe('No router IP set.')
			await module.init({ host: '127.0.0.1', port })
			await connected()
			expect((module.getConfigFields()[0] as { value: string }).value).toBe(
				'Model: MX2-8x8-HDMI20-L\\\nName: MX2-8x8-HDMI20-L\\\nFirmware: 1.10.1b4\\\nInputs: 8\\\nOutputs: 8',
			)
		})

		it('creates a preset from the current routes, refusing a name in use or one unsafe in a command', async () => {
			await module.init({ host: '127.0.0.1', port })
			await connected()
			expect(await module.createPreset('SHOW-A')).toBe('SHOW-A already exists')
			expect(await module.createPreset('a b')).toBe('Use up to 46 letters, digits, - and _')
			expect(await module.createPreset(' SHOW-C ')).toBeUndefined()
			expect(writes()).toEqual(['CALL /MEDIA/PRESET:create(SHOW-C,VIDEO)'])
			await until(() => module.state.presets.has('SHOW-C'))
		})

		it('saves, renames, copies and deletes from the page, answering with the presets as they are', async () => {
			await module.init({ host: '127.0.0.1', port })
			await connected()
			const post = async (path: string, body: unknown) => {
				const response = await module.handleHttpRequest({
					method: 'POST',
					path,
					baseUrl: '',
					originalUrl: path,
					hostname: 'companion.local',
					ip: '127.0.0.1',
					query: {},
					headers: { host: 'companion.local:8000' },
					body: JSON.stringify(body),
				})
				return { status: response.status, json: JSON.parse(response.body ?? '{}') as Record<string, any> }
			}
			const names = (reply: { json: Record<string, any> }) =>
				(reply.json.presets as { name: string }[]).map(({ name }) => name)
			expect(names(await post('/preset/rename', { name: 'SHOW-B', to: 'SHOW-X' }))).toEqual(['SHOW-A', 'SHOW-X'])
			expect(names(await post('/preset/copy', { name: 'SHOW-A', to: 'SHOW-Y' }))).toEqual([
				'SHOW-A',
				'SHOW-X',
				'SHOW-Y',
			])
			expect(names(await post('/preset/delete', { name: 'SHOW-Y' }))).toEqual(['SHOW-A', 'SHOW-X'])
			expect((await post('/preset/save', { name: 'SHOW-A' })).status).toBe(200)
			expect(await post('/preset/delete', { name: 'NOPE' })).toEqual({
				status: 502,
				json: { error: 'No router preset called NOPE' },
			})
			expect(writes()).toEqual([
				'CALL /MEDIA/PRESET:rename(SHOW-B,SHOW-X)',
				'CALL /MEDIA/PRESET:copy(SHOW-A,SHOW-Y)',
				'CALL /MEDIA/PRESET:delete(SHOW-Y)',
				'CALL /MEDIA/PRESET/SHOW-A:save()',
			])
		})
	})

	it('drops a preset deleted elsewhere, and its button', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		expect(fake.received).toContain('OPEN /MEDIA/PRESET')
		fake.deletePresetFromPanel('SHOW-B')
		await until(() => !module.state.presets.has('SHOW-B'))
		await until(() => !Object.keys(lastPresets(module)).includes('preset_SHOW-B'))
		expect(logged(module, 'info')).toContain('Router presets now: SHOW-A')
	})

	it('says in the settings it is still connecting, and where the details are live', async () => {
		await module.init({ host: '127.0.0.1', port: 1 })
		const text = (module.getConfigFields()[0] as { value: string }).value
		expect(text).toContain('Connecting to 127.0.0.1.')
		expect(text).toContain('/variables/connection/')
	})

	it('notices new firmware without the connection dropping, and reads the router again', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		fake.firmware = '1.11.3b5'
		await until(() => variable(module, 'firmware') === '1.11.3b5', 8000)
		expect(logged(module, 'info')).toContain('Router firmware is now 1.11.3b5, was 1.10.1b4. Reading the router again.')
		await until(() => logged(module, 'info').filter((line) => line.startsWith('Router found')).length === 2)
	}, 15_000)

	describe('standby', () => {
		it('puts the router in standby and wakes it, showing it meanwhile', async () => {
			await module.init({ host: '127.0.0.1', port })
			await connected()
			expect(variable(module, 'power')).toBe('NORMAL')
			await module.setPower('toggle')
			await until(() => module.state.standby)
			expect(variable(module, 'power')).toBe('STANDBY')
			expect(mock(module.updateStatus)).toHaveBeenCalledWith(
				InstanceStatus.UnknownWarning,
				'Lightware router in standby',
			)
			expect(logged(module, 'warn')).toContain(
				'The router is in standby: its outputs are off and it refuses any change',
			)
			await module.routeNow(3, 5)
			expect(logged(module, 'warn').join()).toContain('Node disabled or standby mode active')
			await module.setPower('wake')
			await until(() => !module.state.standby)
			expect(mock(module.updateStatus)).toHaveBeenLastCalledWith(InstanceStatus.Ok)
			expect(writes()).toEqual([
				'CALL /MANAGEMENT/POWER:standby()',
				'CALL /MEDIA/XP/VIDEO:switch(I3:O5)',
				'CALL /MANAGEMENT/POWER:wakeUp()',
			])
		})

		it('finds a router already in standby on connecting, and says so', async () => {
			fake.power = 'STANDBY'
			await module.init({ host: '127.0.0.1', port })
			await connected()
			expect(module.state.standby).toBe(true)
			expect(mock(module.updateStatus)).toHaveBeenLastCalledWith(
				InstanceStatus.UnknownWarning,
				'Lightware router in standby',
			)
			// waking an awake router, or the other way round, isn't worth a warning
			await module.setPower('standby')
			expect(logged(module, 'warn').filter((line) => line.startsWith('The router refused'))).toEqual([])
		})
	})

	it('says once that a router closing every new connection may be full, and recovers when it has room', async () => {
		fake.full = true
		await module.init({ host: '127.0.0.1', port })
		const refused = (): string[] => logged(module, 'warn').filter((line) => line.includes('closed the connection'))
		await until(() => refused().length === 1)
		expect(mock(module.updateStatus)).toHaveBeenCalledWith(
			InstanceStatus.ConnectionFailure,
			'Lightware router may be full, retrying',
		)
		await new Promise((resolve) => setTimeout(resolve, 3000))
		expect(refused()).toHaveLength(1)
		fake.full = false
		await connected()
		expect(logged(module, 'info').some((line) => line.startsWith('Reconnected'))).toBe(true)
	}, 20_000)

	it('tests a quiet connection, and reconnects when the router stops answering', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		fake.silent = true
		await until(() => logged(module, 'warn').some((line) => line.startsWith('No reply from the router')), 8000)
		expect(mock(module.updateStatus)).toHaveBeenCalledWith(
			InstanceStatus.ConnectionFailure,
			'No reply from the Lightware router',
		)
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
			'Lightware router model not supported yet',
		)
	})

	it('builds a preset for every port and router preset, each lit while held', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		await until(() => Object.keys(lastPresets(module)).includes('preset_SHOW-A'))
		const presets = lastPresets(module)
		const feedbackIds = Object.keys(lastCall(module.setFeedbackDefinitions))
		const actionIds = Object.keys(lastCall(module.setActionDefinitions))
		expect(Object.keys(presets)).toHaveLength(9 + 2 + 8 * 2 + 8 + 8)
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

	describe('the ports page', () => {
		const request = (method: string, path: string, body?: unknown, headers = {}) => ({
			method,
			path,
			baseUrl: '',
			originalUrl: path,
			hostname: 'companion.local',
			ip: '127.0.0.1',
			query: {},
			headers: { host: 'companion.local:8000', ...headers },
			body: body === undefined ? undefined : JSON.stringify(body),
		})
		const send = async (method: string, path: string, body?: unknown, headers = {}) => {
			const response = await module.handleHttpRequest(request(method, path, body, headers))
			return { status: response.status, json: JSON.parse(response.body ?? '{}') as Record<string, any> }
		}
		const none = { names: [], inputHdcp: [], outputHdcp: [], edids: [] }
		const ready = async (): Promise<void> => {
			await module.init({ host: '127.0.0.1', port })
			await connected()
		}

		it('hotplugs from the page, and tells it which outputs an input feeds', async () => {
			await ready()
			const feeds = await module.handleHttpRequest({ ...request('GET', '/feeds'), query: { input: '2' } })
			expect(JSON.parse(feeds.body ?? '{}')).toEqual({ outputs: ['Output 2', 'Output 3', 'Output 6', 'Output 8'] })
			expect(await send('POST', '/hotplug', { port: 'X1' })).toEqual({
				status: 400,
				json: { error: 'The request needs a port' },
			})
			fake.output5v[0] = 'false'
			expect(await send('POST', '/hotplug', { port: 'O1' })).toEqual({
				status: 502,
				json: { error: 'Output 1 is already off' },
			})
		})

		it('serves a page whose script parses and never writes names as markup', async () => {
			await ready()
			const response = await module.handleHttpRequest(request('GET', '/'))
			expect(response.status).toBe(200)
			expect(response.headers?.['Content-Type']).toContain('text/html')
			const body = response.body ?? ''
			expect(body).not.toContain('innerHTML')
			const script = /<script>([\s\S]*)<\/script>/.exec(body)?.[1] ?? ''
			expect(script.length).toBeGreaterThan(1000)
			expect(() => new Script(script)).not.toThrow()
		})

		it("shows the router's clock and sets it to Companion's time", async () => {
			await ready()
			const before = (await module.handleHttpRequest(request('GET', '/clock'))).body ?? ''
			expect(JSON.parse(before)).toMatchObject({ router: '2026-11-10T08:45:28' })
			expect(await send('POST', '/clock', {})).toEqual({ status: 200, json: {} })
			expect(fake.clock).not.toBe('2026-11-10T08:45:28')
			expect(logged(module, 'info').join()).toContain('Router clock set to')
		})

		it('works out a plain name in the page just as the module does', async () => {
			await ready()
			const body = (await module.handleHttpRequest(request('GET', '/'))).body ?? ''
			const code = /const SUBSTITUTES = [\s\S]*?\n}\n/.exec(body)?.[0] ?? ''
			const pagePlainName = new Script(`${code}; plainName`).runInNewContext() as (name: string) => string
			for (const name of ['Café', 'Müller Straße', 'Søren Æ', '1920×1080', 'Cam – 1', '🎥 Cam 🎥 1', '🎥', ' plain ']) {
				expect(pagePlainName(name)).toBe(plainName(name))
			}
		})

		it('renames the router, and refuses what it would mangle', async () => {
			await ready()
			const reply = await send('POST', '/ports', {
				routerName: 'Rack 3',
				names: [],
				inputHdcp: [],
				outputHdcp: [],
				edids: [],
			})
			expect(reply.json.snapshot.routerName).toBe('Rack 3')
			expect(variable(module, 'router_name')).toBe('Rack 3')
			expect(writes()).toContain('SET /MANAGEMENT/UID.DeviceLabel=Rack 3')
			for (const routerName of ['', 'x'.repeat(40), 'Café']) {
				const refused = await send('POST', '/ports', {
					routerName,
					names: [],
					inputHdcp: [],
					outputHdcp: [],
					edids: [],
				})
				expect(refused.status).toBe(400)
			}
		})

		it('reads just the stored EDIDs', async () => {
			await ready()
			const { status, json } = await send('GET', '/edids')
			expect(status).toBe(200)
			expect(json.edids.length).toBeGreaterThan(0)
			expect(json.inputs).toBeUndefined()
		})

		it('tells the page where the router is, for its own WebSocket', async () => {
			await ready()
			const { json } = await send('GET', '/ports')
			expect(json.router).toBe(`127.0.0.1:${port}`)
		})

		it('reads every port and EDID slot, in number order', async () => {
			await ready()
			fake.inputHdcp[7] = '0'
			fake.emulated[1] = 'U1'
			const { status, json } = await send('GET', '/ports')
			expect(status).toBe(200)
			expect(json.inputs).toHaveLength(8)
			expect(json.inputs[7]).toMatchObject({ port: 8, name: 'Input 8', edid: 'F137', hdcp: '0' })
			expect(json.inputs[1].edid).toBe('U1')
			expect(json.outputs[0]).toEqual({ port: 1, name: 'Output 1', hdcp: 'AUTO' })
			const ids = json.edids.map((slot: { id: string }) => slot.id)
			expect(ids.slice(0, 2)).toEqual(['F1', 'F137'])
			expect(ids.filter((id: string) => id.startsWith('U')).slice(0, 3)).toEqual(['U1', 'U2', 'U3'])
			expect(json.edids.find((slot: { id: string }) => slot.id === 'U2').valid).toBe(false)
		})

		it('applies names, HDCP and EDIDs, sending the EDIDs as one command', async () => {
			await ready()
			const { status, json } = await send('POST', '/ports', {
				names: [{ port: 'I2', name: 'Cam (2) #1' }],
				inputHdcp: [{ port: 8, value: '0' }],
				outputHdcp: [{ port: 8, value: 'ALWAYS' }],
				edids: [
					{ port: 7, slot: 'F1' },
					{ port: 8, slot: 'U1' },
				],
			})
			expect(status).toBe(200)
			expect(json.errors).toEqual({})
			expect(writes()).toEqual([
				'SET /MEDIA/NAMES/VIDEO.I2=2;Cam (2) #1',
				'SET /MEDIA/PORTS/VIDEO/I8/SETTINGS.HdcpVersion=0',
				'SET /MEDIA/PORTS/VIDEO/O8/SETTINGS.HdcpMode=ALWAYS',
				'CALL /EDID:switch(F1:E7;U1:E8)',
			])
			expect(json.snapshot.inputs[1].name).toBe('Cam (2) #1')
			expect(json.snapshot.inputs[7]).toMatchObject({ edid: 'U1', hdcp: '0' })
			expect(variable(module, 'name_I2')).toBe('Cam (2) #1')
		})

		it.each([
			[{ names: [{ port: 'I2', name: 'Café' }] }, 'plain characters'],
			[{ names: [{ port: 'I2', name: 'X'.repeat(63) }] }, 'at most'],
			[{ names: [{ port: 'I2', name: '   ' }] }, 'needs a name'],
			[{ names: [{ port: 'I99', name: 'Nope' }] }, 'No such port'],
			[{ edids: [{ port: 1, slot: 'U50' }] }, 'holds no EDID'],
			[{ inputHdcp: [{ port: 1, value: '1' }] }, 'unknown HDCP'],
			[{ outputHdcp: [{ port: 99, value: 'AUTO' }] }, 'No such port'],
		])('sends nothing at all when one change is bad: %j', async (bad, message) => {
			await ready()
			const { status, json } = await send('POST', '/ports', {
				...none,
				names: [{ port: 'I1', name: 'Good' }],
				...bad,
			})
			expect(status).toBe(400)
			expect(json.error).toContain(message)
			expect(writes()).toEqual([])
		})

		it('stores and deletes an EDID, and only in a U slot', async () => {
			await ready()
			const stored = await send('POST', '/edid/store', { from: 'D1', to: 'U100' })
			expect(stored.status).toBe(200)
			expect(stored.json.snapshot.edids.find((slot: { id: string }) => slot.id === 'U100').valid).toBe(true)
			const gone = await send('POST', '/edid/delete', { slot: 'U100' })
			expect(gone.json.snapshot.edids.find((slot: { id: string }) => slot.id === 'U100').valid).toBe(false)
			expect((await send('POST', '/edid/store', { from: 'D1', to: 'F1' })).status).toBe(400)
			expect((await send('POST', '/edid/store', { from: 'U50', to: 'U51' })).status).toBe(400)
			expect((await send('POST', '/edid/delete', { slot: 'F1' })).status).toBe(400)
			expect(writes()).toEqual(['CALL /EDID:copy(D1:U100)', 'CALL /EDID:delete(U100)'])
		})

		it('refuses changes from another website', async () => {
			await ready()
			const { status } = await send('POST', '/ports', none, { origin: 'http://evil.example' })
			expect(status).toBe(403)
		})

		it('says when the router is not connected', async () => {
			await module.init({ host: '' })
			expect((await send('GET', '/ports')).status).toBe(503)
			expect((await send('POST', '/ports', none)).status).toBe(503)
		})
	})

	it('sends the nearest plain name, and says so', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		await module.renamePort('I2', 'Café')
		expect(writes()).toEqual(['SET /MEDIA/NAMES/VIDEO.I2=2;Cafe'])
		expect(logged(module, 'info').join()).toContain('"Café" is sent as "Cafe"')
	})

	it('refuses a name with nothing plain in it', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		await module.renamePort('I2', '🎥')
		expect(writes()).toEqual([])
	})

	it('shows names with the characters the router reports escaped', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		fake.renameFromPanel('O3', 'Mon (3) #1')
		await until(() => variable(module, 'name_O3') === 'Mon (3) #1')
	})

	it('has no one-press preset that restarts the router', async () => {
		await module.init({ host: '127.0.0.1', port })
		await connected()
		expect(JSON.stringify(lastPresets(module))).not.toContain('softreset')
	})
})
