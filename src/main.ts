import {
	InstanceBase,
	InstanceStatus,
	TCPHelper,
	createModuleLogger,
	type CompanionHTTPRequest,
	type CompanionHTTPResponse,
	type LogLevel,
	type SomeCompanionConfigField,
} from '@companion-module/base'
import { UpdateActions, type ActionsSchema, type LockCommand, type MuteCommand } from './actions.js'
import { Lw3Client } from './client.js'
import {
	AUTO_ROUTE_LABELS,
	AUTO_ROUTE_ORDER,
	GetConfigFields,
	type AutoRouteMode,
	type ModuleConfig,
} from './config.js'
import { UpdateFeedbacks, type FeedbacksSchema } from './feedbacks.js'
import {
	handlePortsRequest,
	type ChangeErrors,
	type EdidSlot,
	type PortChanges,
	type PortsSnapshot,
} from './ports-page.js'
import { UpdatePresets } from './presets.js'
import {
	Cmd,
	DEFAULT_PORT,
	HOTPLUG_DEFAULT_SECONDS,
	HOTPLUG_MAX_SECONDS,
	EDID_BANKS,
	ErrorCode,
	MAX_NAME_LENGTH,
	cleanName,
	isSafePresetName,
	plainName,
	unescapeValue,
	parseEdidProperty,
	parseEdidStatus,
	parseList,
	parsePortName,
	parsePortStatus,
	parsePresetNames,
	parsePresetSource,
	parseProperty,
	parseSource,
	replyError,
	type PortId,
	type PortStatus,
	type Property,
	type Route,
} from './protocol.js'
import { RouterState } from './state.js'
import { UpgradeScripts } from './upgrades.js'
import {
	UpdateVariableDefinitions,
	nameVar,
	portNameValues,
	routeValues,
	selectionValues,
	type VariablesSchema,
} from './variables.js'

export type ModuleSchema = {
	config: ModuleConfig
	secrets: undefined
	actions: ActionsSchema
	feedbacks: FeedbacksSchema
	variables: VariablesSchema
}

export { UpgradeScripts }

const XP_PATH = '/MEDIA/XP/VIDEO'
const NAMES_PATH = '/MEDIA/NAMES/VIDEO'
const UID_PATH = '/MANAGEMENT/UID'
const PRESET_PATH_PREFIX = '/MEDIA/PRESET/'
const DEFINITIONS_DEBOUNCE_MS = 100
/** Saving a preset could announce several changes, which only need reading once */
const PRESET_READ_DEBOUNCE_MS = 200
const FLASH_MS = 500
/** A fresh attempt gets through as soon as the network returns; one left running backs off for over a minute */
const CONNECT_TIMEOUT_MS = 5000
/** The router has nothing to say while nothing changes, so a quiet connection has to be tested */
const HEARTBEAT_MS = 3000

export default class ModuleInstance extends InstanceBase<ModuleSchema> {
	config!: ModuleConfig // Setup in init()
	readonly state = new RouterState()

	#socket: TCPHelper | undefined
	readonly #client = new Lw3Client(
		(data) => this.#write(data),
		(line) => this.#handleLine(line),
		(command) => this.#replyTimedOut(command),
	)
	/** Still on the first read after connecting, when everything is new and not worth logging */
	#reading = false
	#lostAt: number | undefined
	/** Routes this module asked for, so that only changes from elsewhere are logged */
	readonly #ownRoutes = new Map<number, number>()
	/** Ports this module is renaming right now, for the same reason */
	readonly #ownRenames = new Set<string>()
	#heartbeatTimer: ReturnType<typeof setInterval> | undefined
	/** Hotplugs whose port couldn't be turned back on, to finish when the router is back */
	readonly #unfinishedHotplugs = new Set<PortId>()
	#connectTimer: ReturnType<typeof setTimeout> | undefined
	#presetReadTimer: ReturnType<typeof setTimeout> | undefined
	#flashTimer: ReturnType<typeof setInterval> | undefined
	#definitionsTimer: ReturnType<typeof setTimeout> | undefined
	#choicesDirty = false
	#portsDirty = false
	#presetsDirty = false

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig): Promise<void> {
		this.config = config
		this.#publishDefinitions(true)
		this.setVariableValues({ ...portNameValues(this.state), ...selectionValues(this.state) })
		this.#publishAutoRouteMode()
		this.#connect()
	}

	/** Companion's debug log never names the connection, so lines carry its label as their source. */
	override log(level: LogLevel, message: string): void {
		createModuleLogger(this.label)[level](message)
	}

	async destroy(): Promise<void> {
		this.#disconnect()
		this.#stopFlash()
		if (this.#definitionsTimer) clearTimeout(this.#definitionsTimer)
		this.#definitionsTimer = undefined
		this.log('debug', 'destroy')
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		const previous = this.config
		const previousMode = this.autoRouteMode
		this.config = config
		this.#autoRouteModeChanged(previousMode)
		if (config.host === previous.host && config.port === previous.port) return
		this.#connect()
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields(this.label)
	}

	async handleHttpRequest(request: CompanionHTTPRequest): Promise<CompanionHTTPResponse> {
		const host = {
			connected: !!this.#socket?.isConnected,
			routerAddress: `${this.config.host}:${this.config.port ?? DEFAULT_PORT}`,
			readPorts: async () => this.#readPorts(),
			readEdids: async () => this.#readEdidSlots(),
			applyPorts: async (changes: PortChanges) => this.#applyPorts(changes),
			storeEdid: async (from: string, to: string) =>
				this.#edidCommand(Cmd.copyEdid(from, to), `Stored ${from} in ${to}`),
			deleteEdid: async (slot: string) => this.#edidCommand(Cmd.deleteEdid(slot), `Deleted the EDID in ${slot}`),
			hotplug: async (port: string) => this.hotplug(port as PortId),
			outputsFedBy: (input: number) => this.outputsFedBy(input),
		}
		return handlePortsRequest(host, request)
	}

	/** Read fresh for the ports page, which is the only thing that uses these */
	async #readPorts(): Promise<PortsSnapshot | undefined> {
		const { state } = this
		if (!this.#socket?.isConnected || state.inputCount === 0) return undefined
		const valueOf = async (command: string): Promise<string | undefined> => {
			const lines = await this.#client.request(command)
			return lines === undefined ? undefined : (parseProperty(lines[0] ?? '')?.value ?? '')
		}
		const status = await valueOf(Cmd.edidStatus)
		if (status === undefined) return undefined
		const emulated = parseEdidStatus(status)

		const inputs: PortsSnapshot['inputs'] = []
		for (let port = 1; port <= state.inputCount; port++) {
			const hdcp = await valueOf(Cmd.inputHdcp(port))
			if (hdcp === undefined) return undefined
			inputs.push({
				port,
				name: state.inputName(port),
				edid: emulated[port - 1] ?? '',
				hdcp,
				signal: state.sourceStatus.get(port)?.signal === true,
			})
		}
		const outputs: PortsSnapshot['outputs'] = []
		for (let port = 1; port <= state.outputCount; port++) {
			const hdcp = await valueOf(Cmd.outputHdcp(port))
			if (hdcp === undefined) return undefined
			outputs.push({ port, name: state.outputName(port), hdcp })
		}
		const edids = await this.#readEdidSlots()
		return edids && { routerName: state.routerName, inputs, outputs, edids }
	}

	async #readEdidSlots(): Promise<EdidSlot[] | undefined> {
		const slots: EdidSlot[] = []
		for (const bank of EDID_BANKS) {
			const found = new Map<string, EdidSlot>()
			const slot = (id: string): EdidSlot => {
				let existing = found.get(id)
				if (!existing) {
					existing = { id, name: '', resolution: '', valid: false }
					found.set(id, existing)
				}
				return existing
			}
			const read = async (
				property: 'Validity' | 'MonitorName' | 'PreferredResolution',
				apply: (target: EdidSlot, value: string) => void,
			): Promise<boolean> => {
				const lines = await this.#client.request(Cmd.edidBank(bank, property))
				if (lines === undefined) return false
				for (const line of lines) {
					const parsed = parseEdidProperty(line)
					if (parsed) apply(slot(parsed.slot), parsed.value)
				}
				return true
			}
			const complete =
				(await read('Validity', (target, value) => (target.valid = value === 'true'))) &&
				(await read('MonitorName', (target, value) => (target.name = value))) &&
				(await read('PreferredResolution', (target, value) => (target.resolution = value)))
			if (!complete) return undefined
			// the router lists them in text order: F1, F10, F100
			slots.push(...[...found.values()].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))))
		}
		return slots
	}

	/** Everything is tried, so one refusal doesn't leave the rest unsent. Names first, as they can't disturb a picture. */
	async #applyPorts(changes: PortChanges): Promise<ChangeErrors> {
		const errors: ChangeErrors = {}
		if (changes.routerName !== undefined) {
			const lines = await this.#client.request(Cmd.setRouterName(changes.routerName), true)
			const error = lines === undefined ? 'Not connected' : replyError(lines)?.message
			if (error) errors['Router name'] = error
			else for (const line of lines ?? []) this.#applyProperty(parseProperty(line))
		}
		for (const { port, name } of changes.names) {
			const error = await this.#rename(port as PortId, name)
			if (error) errors[`${port} name`] = error
		}
		const send = async (command: string, key: string): Promise<void> => {
			const lines = await this.#client.request(command, true)
			if (lines === undefined) errors[key] = 'Not connected'
			else {
				const error = replyError(lines)
				if (error) errors[key] = `${error.code} ${error.message}`
			}
		}
		for (const { port, value } of changes.inputHdcp) await send(Cmd.setInputHdcp(port, value), `I${port} hdcp`)
		for (const { port, value } of changes.outputHdcp) await send(Cmd.setOutputHdcp(port, value), `O${port} hdcp`)
		if (changes.edids.length > 0) {
			const lines = await this.#client.request(
				Cmd.switchEdid(changes.edids.map(({ port, slot }) => ({ input: port, slot }))),
				true,
			)
			const error = lines === undefined ? 'Not connected' : replyError(lines)?.message
			if (error) for (const { port } of changes.edids) errors[`I${port} edid`] = error
		}
		const sent =
			(changes.routerName === undefined ? 0 : 1) +
			changes.names.length +
			changes.inputHdcp.length +
			changes.outputHdcp.length +
			changes.edids.length
		const failed = Object.keys(errors).length
		this.log(failed ? 'warn' : 'info', `Ports page: ${sent} changes sent, ${failed} refused`)
		return errors
	}

	async #edidCommand(command: string, done: string): Promise<string | undefined> {
		const lines = await this.#client.request(command, true)
		if (lines === undefined) return 'Not connected'
		const error = replyError(lines)
		if (error) {
			this.log('warn', `The router refused: ${command}: ${error.message}`)
			return error.message
		}
		this.log('info', `Ports page: ${done}`)
		return undefined
	}

	// ---- actions ----------------------------------------------------------------------------

	selectInput(input: number | undefined): void {
		if (input === undefined) return
		this.state.selectInput(input)
		this.#selectionChanged()
		void this.#autoRoute()
	}

	selectOutput(output: number | undefined): void {
		if (output === undefined) return
		this.state.selectOutput(output)
		this.#selectionChanged()
		void this.#autoRoute()
	}

	async #autoRoute(): Promise<void> {
		const mode = this.autoRouteMode
		if (mode === 'off') return
		if (this.state.selectedInput === undefined || this.state.selectedOutput === undefined) return
		if (mode === 'cut') await this.takeSelection()
		else this.stageSelection()
	}

	get autoRouteMode(): AutoRouteMode {
		return this.config.autoRoute ?? 'off'
	}

	/**
	 * Saved in the connection settings. It applies from the next selection, so changing it never routes
	 * anything. Leaving Stage discards what was staged, so that a later take can't send forgotten routes.
	 */
	setAutoRouteMode(value: string): void {
		const current = AUTO_ROUTE_ORDER.indexOf(this.autoRouteMode)
		const mode =
			value === 'next'
				? AUTO_ROUTE_ORDER[(current + 1) % AUTO_ROUTE_ORDER.length]
				: AUTO_ROUTE_ORDER.find((candidate) => candidate === value)
		if (mode === undefined || mode === this.autoRouteMode) return
		const previous = this.autoRouteMode
		this.config = { ...this.config, autoRoute: mode }
		this.saveConfig(this.config, undefined)
		this.log('info', `Auto-route mode: ${AUTO_ROUTE_LABELS[mode]}`)
		this.#autoRouteModeChanged(previous)
	}

	#autoRouteModeChanged(previous: AutoRouteMode): void {
		this.#publishAutoRouteMode()
		if (previous !== 'stage' || this.autoRouteMode === 'stage') return
		const { state } = this
		const waiting = state.stagedRoutes()
		if (waiting.length > 0) {
			const list = waiting
				.map(
					({ input, output }) => `${input === 0 ? 'nothing' : state.inputName(input)} to ${state.outputName(output)}`,
				)
				.join(', ')
			this.log('info', `Left Stage, so the staged routes were discarded: ${list}`)
		}
		this.clearStaged()
	}

	#publishAutoRouteMode(): void {
		this.setVariableValues({ auto_route_mode: AUTO_ROUTE_LABELS[this.autoRouteMode] })
		this.checkFeedbacks('autoRouteMode')
	}

	async routeNow(input: number | undefined, output: number | undefined): Promise<void> {
		if (input === undefined || output === undefined) return
		await this.#switch([{ input, output }])
	}

	/** In the Stage mode this goes in with the other staged routes */
	async clearRoute(output: number | undefined): Promise<void> {
		if (output === undefined) {
			this.log('warn', 'Select an output before clearing its route')
			return
		}
		if (this.autoRouteMode !== 'stage') {
			await this.#switch([{ input: 0, output }])
			return
		}
		this.stage(0, output)
		if (output === this.state.selectedOutput) {
			// as with any staged pair, the next input starts afresh instead of replacing this
			this.state.pairStaged = true
			this.#selectionChanged()
		}
	}

	/** A route the router refuses keeps its selection, so nothing looks as if it happened */
	async takeSelection(): Promise<void> {
		const { selectedInput: input, selectedOutput: output } = this.state
		if (input === undefined || output === undefined) {
			this.log('warn', 'Select an input and an output before taking')
			return
		}
		if (!(await this.#switch([{ input, output }]))) return
		// a take would otherwise undo this route later
		this.state.staged.delete(output)
		this.state.stagedPreset = undefined
		this.#stagedChanged()
		// something else may have been pressed while the router answered
		if (this.state.selectedInput === input && this.state.selectedOutput === output) {
			this.state.clearSelection()
			this.#selectionChanged()
		}
	}

	stageSelection(): void {
		const { selectedInput, selectedOutput } = this.state
		if (selectedInput === undefined || selectedOutput === undefined) {
			this.log('warn', 'Select an input and an output before staging')
			return
		}
		this.stage(selectedInput, selectedOutput)
		// the pair stays on show, and the next output reuses the input to add to the salvo
		this.state.pairStaged = true
		this.#selectionChanged()
	}

	stage(input: number | undefined, output: number | undefined): void {
		if (input === undefined || output === undefined) return
		this.state.staged.set(output, input)
		this.state.stagedPreset = undefined
		this.#stagedChanged()
	}

	/** One press for everything lined up: what is staged, and a selected pair that isn't yet */
	async take(): Promise<void> {
		const { selectedInput: input, selectedOutput: output, pairStaged, staged } = this.state
		const pair = input !== undefined && output !== undefined && !pairStaged ? { input, output } : undefined
		if (staged.size > 0) {
			await this.#sendStaged(pair)
		} else if (pairStaged) {
			// its staged route is already live, so what is still on show has nothing to send
			this.log('info', 'Nothing is staged to take')
		} else {
			await this.takeSelection()
		}
	}

	async takeStaged(): Promise<void> {
		await this.#sendStaged()
	}

	/** A selected pair replaces anything staged for the same output, being the more recent */
	async #sendStaged(pair?: Route): Promise<void> {
		const staged = this.state.stagedRoutes()
		const routes = pair ? [...staged.filter(({ output }) => output !== pair.output), pair] : staged
		if (routes.length === 0) {
			// everything staged is already live, so there is nothing to send or to keep waiting
			this.state.staged.clear()
			this.state.stagedPreset = undefined
			this.#stagedChanged()
			return
		}
		const free = routes.filter((route) => {
			if (!this.state.isLocked(route.output)) return true
			const left = route === pair ? 'its route stays selected' : 'its staged route stays staged'
			this.log('warn', `${this.state.outputName(route.output)} is locked, so ${left}`)
			return false
		})
		if (free.length === 0) return
		const pairStaysSelected = pair !== undefined && !free.includes(pair)
		if (await this.#switch(free)) {
			for (const { output } of free) this.state.staged.delete(output)
			// what stayed behind and is already live has nothing left to wait for
			for (const output of [...this.state.staged.keys()]) {
				if (this.state.pendingInput(output) === undefined) this.state.staged.delete(output)
			}
			this.state.stagedPreset = undefined
			this.#stagedChanged()
			if (pairStaysSelected) return
			this.state.clearSelection()
			this.#selectionChanged()
		}
	}

	/** A pair that was staged goes too, and in Stage so does anything half selected, for a clean start */
	clearStaged(): void {
		const { state } = this
		state.staged.clear()
		state.stagedPreset = undefined
		this.#stagedChanged()
		if (state.pairStaged || this.autoRouteMode === 'stage') {
			state.clearSelection()
			this.#selectionChanged()
		}
	}

	/** Follows the auto-route mode: in Stage the preset's routes wait for a take */
	async recallPreset(name: string): Promise<void> {
		if (this.autoRouteMode === 'stage') await this.stagePreset(name)
		else await this.loadPreset(name)
	}

	/**
	 * Replaces whatever is staged with the preset's routes, read fresh so an edited preset can't catch anyone
	 * out. Only the routes are staged. Anything else the preset holds only applies to a real recall.
	 */
	async stagePreset(name: string): Promise<void> {
		if (!isSafePresetName(name)) {
			this.log('warn', `"${name}" can't be a router preset name`)
			return
		}
		const lines = await this.#client.request(Cmd.presetRoutes(name), true)
		if (lines === undefined) {
			this.log('warn', `Not connected, so router preset ${name} wasn't staged`)
			return
		}
		const error = replyError(lines)
		const value = parseProperty(lines[0] ?? '')?.value
		if (error || value === undefined) {
			this.log('warn', `Couldn't read router preset ${name}: ${error?.message ?? 'no routes in the reply'}`)
			return
		}
		const routes = parseList(value).map(parsePresetSource)
		const { state } = this
		state.staged.clear()
		routes.forEach((input, index) => {
			if (input === undefined) this.log('warn', `Router preset ${name} has an unexpected route on output ${index + 1}`)
			else state.staged.set(index + 1, input)
		})
		state.stagedPreset = name
		// the live feedback should compare against this fresh copy too
		if (state.presets.has(name)) {
			state.presets.set(name, routes)
			this.#presetContentsChanged()
		}
		state.clearSelection()
		this.#selectionChanged()
		this.#stagedChanged()
		this.log('info', `Router preset ${name} staged: ${state.stagedRoutes().length} outputs would change`)
	}

	async loadPreset(name: string): Promise<void> {
		if (!isSafePresetName(name)) {
			this.log('warn', `"${name}" can't be a router preset name`)
			return
		}
		const lines = await this.#client.request(Cmd.loadPreset(name), true)
		if (lines === undefined) {
			this.log('warn', `Not connected, so router preset ${name} wasn't recalled`)
			return
		}
		const error = replyError(lines)
		if (error) {
			this.log('warn', `The router refused preset ${name}: ${error.code} ${error.message}`)
		} else {
			this.log('info', `Router preset ${name} recalled`)
		}
	}

	async lockOutput(output: number | undefined, command: LockCommand): Promise<void> {
		if (output === undefined) {
			this.log('warn', 'Select an output before locking')
			return
		}
		const lock = command === 'toggle' ? !this.state.isLocked(output) : command === 'lockDestination'
		const lines = await this.#client.request(lock ? Cmd.lock(output) : Cmd.unlock(output), true)
		if (lines === undefined) {
			this.log('warn', `Not connected, so output ${output} wasn't ${lock ? 'locked' : 'unlocked'}`)
			return
		}
		const error = replyError(lines)
		// the router says "Not exists" when an output is already how it was asked to be
		if (error && error.code !== ErrorCode.notExists) {
			this.log('warn', `The router refused to ${lock ? 'lock' : 'unlock'} output ${output}: ${error.message}`)
		}
	}

	/** `selected` is the input or output pressed last */
	async mutePort(target: string, command: MuteCommand): Promise<void> {
		const port =
			target === 'selected' ? this.state.lastSelectedPort : /^[IO]\d+$/.test(target) ? (target as PortId) : undefined
		if (port === undefined) {
			this.log('warn', 'Select an input or an output before muting')
			return
		}
		const name = this.state.portName(port)
		const mute = command === 'toggle' ? !this.state.isMuted(port) : command === 'mute'
		const doing = mute ? 'mute' : 'unmute'
		// measured: the router refuses a locked output with "Not exists", which says nothing useful
		if (port.startsWith('O') && this.state.isLocked(Number(port.slice(1)))) {
			this.log('warn', `${name} is locked, so it can't be ${doing}d`)
			return
		}
		const lines = await this.#client.request(mute ? Cmd.mute(port) : Cmd.unmute(port), true)
		if (lines === undefined) {
			this.log('warn', `Not connected, so ${name} wasn't ${doing}d`)
			return
		}
		const error = replyError(lines)
		// the router says "Not exists" when a port is already how it was asked to be
		if (error && error.code !== ErrorCode.notExists) {
			this.log('warn', `The router refused to ${doing} ${name}: ${error.message}`)
		}
	}

	/**
	 * Turns an output's 5V, or an input's hotplug, off and back on, as if its cable was pulled and put
	 * back. An input's affects every output it feeds. Returns why it didn't happen, if it didn't.
	 */
	async hotplug(port: PortId | undefined, seconds = HOTPLUG_DEFAULT_SECONDS): Promise<string | undefined> {
		if (port === undefined) {
			this.log('warn', 'Select an output before hotplugging')
			return 'No port selected'
		}
		const number = Number(port.slice(1))
		const isInput = port.startsWith('I')
		const name = this.state.portName(port)
		if (this.state.hotplugging.has(port)) return `${name} is already being hotplugged`
		const hold = Math.min(Math.max(Number(seconds) || HOTPLUG_DEFAULT_SECONDS, 0.5), HOTPLUG_MAX_SECONDS)
		const read = await this.#client.request(isInput ? Cmd.inputHotplug(number) : Cmd.output5v(number), true)
		if (read === undefined) {
			this.log('warn', `Not connected, so ${name} wasn't hotplugged`)
			return 'Not connected'
		}
		const value = parseProperty(read.find((line) => line.startsWith('pw ')) ?? '')?.value
		const normal = isInput ? 'AUTO' : 'true'
		if (value !== normal) {
			// someone turned it off on purpose, and a hotplug would leave it on
			const why = value === undefined ? `the router didn't say how ${name} is set` : `${name} is already off`
			this.log('warn', `Hotplug not sent: ${why}`)
			return why
		}
		const fed = isInput ? this.outputsFedBy(number) : []
		const feeds = fed.length > 0 ? `, which drops ${fed.join(', ')}` : ''
		this.log('info', `Hotplug: ${name} off for ${hold} s${feeds}`)
		this.state.hotplugging.add(port)
		this.checkFeedbacks('hotplugging')
		const off = await this.#client.request(
			isInput ? Cmd.setInputHotplug(number, false) : Cmd.setOutput5v(number, false),
			true,
		)
		const offError = off === undefined ? 'Not connected' : replyError(off)?.message
		if (offError) {
			this.state.hotplugging.delete(port)
			this.checkFeedbacks('hotplugging')
			this.log('warn', `The router refused to hotplug ${name}: ${offError}`)
			return offError
		}
		await new Promise((resolve) => setTimeout(resolve, hold * 1000))
		await this.#finishHotplug(port)
		return undefined
	}

	/** If the router can't be told, it is told on reconnecting, so a port is never left off */
	async #finishHotplug(port: PortId): Promise<void> {
		const number = Number(port.slice(1))
		const name = this.state.portName(port)
		const on = await this.#client.request(
			port.startsWith('I') ? Cmd.setInputHotplug(number, true) : Cmd.setOutput5v(number, true),
			true,
		)
		const error = on === undefined ? 'Not connected' : replyError(on)?.message
		if (error) {
			this.#unfinishedHotplugs.add(port)
			this.log(
				'warn',
				`${name} is still off after its hotplug (${error}). It is turned back on when the router is back.`,
			)
			return
		}
		this.#unfinishedHotplugs.delete(port)
		this.state.hotplugging.delete(port)
		this.checkFeedbacks('hotplugging')
		this.log('info', `Hotplug: ${name} back on`)
	}

	/** For the log, and the warning on the ports page */
	outputsFedBy(input: number): string[] {
		return [...this.state.routes]
			.filter(([, routed]) => routed === input)
			.sort(([a], [b]) => a - b)
			.map(([output]) => this.state.outputName(output))
	}

	async renamePort(port: string, name: string): Promise<void> {
		const typed = cleanName(name)
		const clean = plainName(typed)
		if (!/^[IO]\d+$/.test(port) || clean === '') {
			this.log('warn', `Can't rename ${port} to "${name}"`)
			return
		}
		if (clean !== typed)
			this.log('info', `The router only stores plain characters, so "${typed}" is sent as "${clean}"`)
		if (clean.length > MAX_NAME_LENGTH) {
			this.log('warn', `The router only keeps the first ${MAX_NAME_LENGTH} characters of "${clean}"`)
		}
		const error = await this.#rename(port as PortId, clean)
		if (error) this.log('warn', `The router refused the name "${clean}": ${error}`)
	}

	/** Returns why it failed, if it did */
	async #rename(id: PortId, name: string): Promise<string | undefined> {
		// the router requires a number before the name. Keep the one the port has.
		const prefix = this.state.names.get(id)?.prefix ?? '2'
		// the change message arrives ahead of the reply, so this has to be known before sending
		this.#ownRenames.add(id)
		const lines = await this.#client.request(Cmd.rename(id, prefix, name), true)
		this.#ownRenames.delete(id)
		if (lines === undefined) return 'Not connected'
		const error = replyError(lines)
		if (error) return error.message
		// the reply has what the router stored, which may be shorter than what was sent
		for (const line of lines) this.#applyProperty(parseProperty(line))
		return undefined
	}

	async softReset(): Promise<void> {
		this.log('warn', 'Soft resetting the router')
		await this.#client.request(Cmd.softReset, true)
	}

	/** Returns whether the router accepted it. What is routed now is learned from its change message. */
	async #switch(routes: Route[]): Promise<boolean> {
		for (const { input, output } of routes) this.#ownRoutes.set(output, input)
		const lines = await this.#client.request(Cmd.switch(routes), true)
		const forget = (): void => {
			for (const { output } of routes) this.#ownRoutes.delete(output)
		}
		if (lines === undefined) {
			forget()
			this.log('warn', 'Not connected, so the route was not made')
			return false
		}
		const error = replyError(lines)
		if (error) {
			forget()
			const outputs = routes.map(({ output }) => this.state.outputName(output)).join(', ')
			if (error.code === ErrorCode.accessDenied) this.log('warn', `Refused: ${outputs} is locked`)
			else this.log('warn', `The router refused the route to ${outputs}: ${error.code} ${error.message}`)
			return false
		}
		return true
	}

	// ---- connection -------------------------------------------------------------------------

	#connect(retrying = false): void {
		this.#disconnect()
		if (!retrying) this.#lostAt = undefined

		const { host } = this.config
		if (!host) {
			this.updateStatus(InstanceStatus.BadConfig, 'No Lightware router IP set')
			return
		}
		if (!retrying) this.updateStatus(InstanceStatus.Connecting)

		const socket = new TCPHelper(host, this.config.port || DEFAULT_PORT)
		this.#socket = socket
		this.#armConnectTimer()

		socket.on('status_change', (status, message) => {
			if (socket !== this.#socket) return
			this.updateStatus(status, message)
			if (status !== InstanceStatus.Ok) {
				this.#lostAt ??= Date.now()
				this.#stopHeartbeat()
				this.#client.reset()
				this.#armConnectTimer()
			}
		})
		socket.on('error', (error) => this.log('debug', `Network error: ${error.message}`))
		socket.on('connect', () => {
			if (socket !== this.#socket) return
			this.#stopConnectTimer()
			if (this.#lostAt !== undefined) {
				this.log('info', `Reconnected after ${Math.round((Date.now() - this.#lostAt) / 1000)} s`)
				this.#lostAt = undefined
			}
			this.#client.reset()
			void this.#readRouter()
		})
		socket.on('data', (data) => {
			if (socket === this.#socket) this.#client.push(data)
		})
	}

	#disconnect(): void {
		this.#stopHeartbeat()
		this.#stopConnectTimer()
		if (this.#presetReadTimer) clearTimeout(this.#presetReadTimer)
		this.#presetReadTimer = undefined
		this.#ownRoutes.clear()
		this.#reading = false
		this.#socket?.destroy()
		this.#socket = undefined
		this.#client.reset()
	}

	#write(data: string): boolean {
		if (!this.#socket?.isConnected) return false
		void this.#socket.send(data)
		return true
	}

	#replyTimedOut(command: string): void {
		this.#lostAt ??= Date.now()
		this.log('warn', `No reply from the router to ${command}, reconnecting`)
		this.updateStatus(InstanceStatus.ConnectionFailure, 'No reply from the Lightware router')
		this.#connect(true)
	}

	#armConnectTimer(): void {
		this.#connectTimer ??= setTimeout(() => {
			this.#connectTimer = undefined
			this.updateStatus(InstanceStatus.ConnectionFailure, 'Cannot reach the Lightware router, retrying')
			this.#connect(true)
		}, CONNECT_TIMEOUT_MS)
	}

	#stopConnectTimer(): void {
		if (this.#connectTimer) clearTimeout(this.#connectTimer)
		this.#connectTimer = undefined
	}

	#startHeartbeat(): void {
		this.#stopHeartbeat()
		this.#heartbeatTimer = setInterval(() => {
			if (this.#client.idle) void this.#client.request(Cmd.productName)
		}, HEARTBEAT_MS)
	}

	#stopHeartbeat(): void {
		if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer)
		this.#heartbeatTimer = undefined
	}

	// ---- reading the router -----------------------------------------------------------------

	/** Subscribe first, so nothing that changes during the read is missed */
	async #readRouter(): Promise<void> {
		this.#reading = true
		const socket = this.#socket
		const product = await this.#client.request(Cmd.productName)
		const firmware = await this.#client.request(Cmd.firmware)
		await this.#client.request(Cmd.subscribeRouting)
		await this.#client.request(Cmd.subscribeNames)
		await this.#client.request(Cmd.subscribeRouterName)
		await this.#client.request(Cmd.subscribePresets)
		const supported = await this.#readState()
		if (socket !== this.#socket || product === undefined) return

		this.state.model = parseProperty(product[0] ?? '')?.value ?? ''
		this.state.firmware = parseProperty(firmware?.[0] ?? '')?.value ?? ''
		this.setVariableValues({
			model: this.state.model,
			firmware: this.state.firmware,
			inputs: this.state.inputCount,
			outputs: this.state.outputCount,
		})
		this.#reading = false

		const { model, firmware: version, inputCount, outputCount, presets } = this.state
		const unit = `${model || 'Unknown model'}, firmware ${version || 'unknown'}`
		if (!supported) {
			this.log('warn', `Connected to ${unit}, but it doesn't have the routing this module knows. Please report it.`)
			this.updateStatus(InstanceStatus.UnknownWarning, 'Lightware router model not supported yet')
		} else {
			this.log(
				'info',
				`Router found: ${unit}, ${inputCount} inputs, ${outputCount} outputs, ${presets.size} router presets`,
			)
		}
		this.#startHeartbeat()
		for (const port of [...this.#unfinishedHotplugs]) await this.#finishHotplug(port)
	}

	/** Returns false if the router has no routing where this module looks for it */
	async #readState(): Promise<boolean> {
		let routes = await this.#client.request(Cmd.routes)
		if (routes && replyError(routes)) routes = await this.#client.request(Cmd.routesOlder)
		if (routes === undefined) return false
		if (replyError(routes)) return false
		for (const line of routes) this.#applyProperty(parseProperty(line))

		for (const command of [
			Cmd.destinationStatus,
			Cmd.sourceStatus,
			Cmd.destinationDetail,
			Cmd.sourceDetail,
			Cmd.routerName,
			Cmd.names,
		]) {
			const lines = await this.#client.request(command)
			if (lines === undefined) return false
			for (const line of lines) this.#applyProperty(parseProperty(line))
		}
		await this.#readPresets()
		return true
	}

	async #readPresets(): Promise<void> {
		const listing = await this.#client.request(Cmd.presets)
		if (listing === undefined) return
		const presets = new Map<string, (number | undefined)[]>()
		for (const name of parsePresetNames(listing)) {
			if (!isSafePresetName(name)) {
				this.log('debug', `Skipped a router preset with an unexpected name: ${name}`)
				continue
			}
			const lines = await this.#client.request(Cmd.presetRoutes(name))
			if (lines === undefined) return
			const value = parseProperty(lines[0] ?? '')?.value
			presets.set(name, value === undefined ? [] : parseList(value).map(parsePresetSource))
		}
		const before = this.state.presets
		const sameNames = before.size === presets.size && [...presets.keys()].every((name) => before.has(name))
		const sameContents = JSON.stringify([...before]) === JSON.stringify([...presets])
		this.state.presets = presets
		if (!sameNames) {
			this.#choicesDirty = true
			this.#presetsDirty = true
			this.#scheduleDefinitions()
			if (!this.#reading) this.log('info', `Router presets now: ${[...presets.keys()].join(', ') || 'none'}`)
		}
		// a read that finds nothing new must not touch the buttons
		if (!sameContents) this.#presetContentsChanged()
	}

	// ---- incoming ---------------------------------------------------------------------------

	#handleLine(line: string): void {
		const property = parseProperty(line)
		if (property) this.#applyProperty(property)
		else this.log('debug', `Ignored from router: ${line}`)
	}

	#applyProperty(property: Property | undefined): void {
		if (!property) return
		if (property.path === XP_PATH) {
			if (property.property === 'DestinationConnectionStatus' || property.property === 'DestinationConnectionList') {
				this.#applyRoutes(property.value)
			} else if (property.property === 'DestinationPortStatus') {
				this.#applyDestinationStatus(property.value)
			} else if (property.property === 'SourcePortStatus') {
				this.#applySourceStatus(property.value)
			} else if (property.property === 'DestinationPortGuiStatus') {
				this.state.destinationDetail = parseList(property.value)
				this.checkFeedbacks('portLegend')
			} else if (property.property === 'SourcePortGuiStatus') {
				this.state.sourceDetail = parseList(property.value)
				this.checkFeedbacks('portLegend')
			}
		} else if (property.path === UID_PATH && property.property === 'DeviceLabel') {
			this.#applyRouterName(unescapeValue(property.value))
		} else if (property.path === NAMES_PATH) {
			this.#applyName(property.property, property.value)
		} else if (property.path.startsWith(PRESET_PATH_PREFIX)) {
			this.#presetReadTimer ??= setTimeout(() => {
				this.#presetReadTimer = undefined
				void this.#readPresets()
			}, PRESET_READ_DEBOUNCE_MS)
		}
	}

	#applyRouterName(name: string): void {
		const { state } = this
		if (name === state.routerName) return
		state.routerName = name
		this.setVariableValues({ router_name: name })
		if (!this.#reading) this.log('info', `Router name is now "${name}"`)
	}

	#applyRoutes(value: string): void {
		const { state } = this
		const entries = parseList(value)
		if (entries.length !== state.outputCount) {
			state.outputCount = entries.length
			this.#portsDirty = true
			this.#publishVariableDefinitions()
			this.#scheduleDefinitions()
			this.setVariableValues({ outputs: state.outputCount, ...portNameValues(state) })
		}
		let changed = false
		entries.forEach((entry, index) => {
			const output = index + 1
			const input = parseSource(entry)
			if (input === undefined) {
				this.log('debug', `Unexpected route on output ${output}: ${entry}`)
				return
			}
			if (state.routes.get(output) === input) {
				// asking for what is already routed gets no change message
				if (this.#ownRoutes.get(output) === input) this.#ownRoutes.delete(output)
				return
			}
			state.routes.set(output, input)
			changed = true
			if (this.#ownRoutes.get(output) === input) {
				this.#ownRoutes.delete(output)
			} else if (!this.#reading) {
				this.log('info', `${state.outputName(output)} now on ${input === 0 ? 'nothing' : state.inputName(input)}`)
			}
		})
		if (!changed) return
		this.setVariableValues({ ...routeValues(state), ...selectionValues(state) })
		this.#syncFlash()
		this.checkFeedbacks(
			'route',
			'routedInput',
			'routedOutput',
			'sourceSelected',
			'outputNext',
			'outputStaged',
			'stagedWaiting',
			'presetLive',
			'presetStaged',
		)
	}

	#applyDestinationStatus(value: string): void {
		const locks = this.#applyStatus(value, this.state.destinationStatus, 'O')
		if (locks.changed) this.checkFeedbacks('portSignal', 'portConnected', 'portLegend')
		if (locks.lockChanged || locks.muteChanged) this.setVariableValues(selectionValues(this.state))
		if (locks.lockChanged) this.checkFeedbacks('outputLocked')
		if (locks.muteChanged) this.checkFeedbacks('portMuted')
	}

	#applySourceStatus(value: string): void {
		const entries = parseList(value)
		if (entries.length !== this.state.inputCount) {
			this.state.inputCount = entries.length
			this.#portsDirty = true
			this.#publishVariableDefinitions()
			this.#scheduleDefinitions()
			this.setVariableValues({ inputs: this.state.inputCount, ...portNameValues(this.state) })
		}
		const status = this.#applyStatus(value, this.state.sourceStatus, 'I')
		if (status.muteChanged) {
			this.setVariableValues(selectionValues(this.state))
			this.checkFeedbacks('portMuted')
		}
		if (status.changed) {
			this.checkFeedbacks('portSignal', 'portConnected', 'portLegend')
		}
	}

	#applyStatus(
		value: string,
		statuses: Map<number, PortStatus>,
		kind: 'I' | 'O',
	): { changed: boolean; lockChanged: boolean; muteChanged: boolean } {
		let changed = false
		let lockChanged = false
		let muteChanged = false
		parseList(value).forEach((entry, index) => {
			const port = index + 1
			const status = parsePortStatus(entry)
			if (!status) {
				this.log('debug', `Unexpected status on ${kind}${port}: ${entry}`)
				return
			}
			const before = statuses.get(port)
			if (
				before?.locked === status.locked &&
				before.muted === status.muted &&
				before.connected === status.connected &&
				before.signal === status.signal
			) {
				return
			}
			statuses.set(port, status)
			changed = true
			if (before?.locked !== status.locked) lockChanged = true
			if (before?.muted !== status.muted) muteChanged = true
			if (before && !this.#reading) {
				if (before.signal !== status.signal) {
					this.log('debug', `${kind}${port} signal ${status.signal ? 'present' : 'lost'}`)
				}
				if (before.connected !== status.connected) {
					this.log('debug', `${kind}${port} ${status.connected ? 'connected' : 'disconnected'}`)
				}
				if (before.locked !== status.locked) {
					this.log('info', `${kind}${port} ${status.locked ? 'locked' : 'unlocked'}`)
				}
				if (before.muted !== status.muted) {
					this.log('info', `${kind}${port} ${status.muted ? 'muted' : 'unmuted'}`)
				}
			}
		})
		return { changed, lockChanged, muteChanged }
	}

	#applyName(port: string, value: string): void {
		const name = parsePortName(port, value)
		if (!name) return
		const before = this.state.names.get(name.port)
		if (before?.name === name.name && before.prefix === name.prefix) return
		this.state.names.set(name.port, name)
		if (before && before.name !== name.name && !this.#ownRenames.has(port) && !this.#reading) {
			this.log('info', `${port} renamed: "${before.name}" to "${name.name}"`)
		}
		if (before?.name === name.name) return
		this.setVariableValues({
			[nameVar(port)]: name.name,
			...routeValues(this.state),
			...selectionValues(this.state),
		})
		this.#choicesDirty = true
		this.#scheduleDefinitions()
	}

	// ---- derived updates --------------------------------------------------------------------

	#selectionChanged(): void {
		this.setVariableValues(selectionValues(this.state))
		// start from the bright half, so a press shows straight away
		this.#stopFlash()
		this.#syncFlash()
		this.checkFeedbacks(
			'route',
			'routedInput',
			'routedOutput',
			'sourceSelected',
			'destinationSelected',
			'outputNext',
			'portMuted',
			'hotplugging',
		)
	}

	#stagedChanged(): void {
		this.setVariableValues(routeValues(this.state))
		this.#syncFlash()
		this.checkFeedbacks('outputStaged', 'stagedWaiting', 'stagedRoutes', 'presetStaged')
	}

	#presetContentsChanged(): void {
		this.setVariableValues({ live_preset: this.state.livePreset ?? 'None' })
		this.checkFeedbacks('presetLive')
	}

	/** The flash only runs while there is something to flash */
	#syncFlash(): void {
		const { state } = this
		if (state.nextInput === undefined && !state.hasStagedRoutes) {
			if (!this.#flashTimer) return
			this.#stopFlash()
			this.checkFeedbacks('sourceSelected', 'stagedWaiting')
			return
		}
		this.#flashTimer ??= setInterval(() => {
			state.flashOn = !state.flashOn
			this.checkFeedbacks('sourceSelected', 'stagedWaiting')
		}, FLASH_MS)
	}

	#stopFlash(): void {
		if (this.#flashTimer) clearInterval(this.#flashTimer)
		this.#flashTimer = undefined
		this.state.flashOn = true
	}

	// ---- definitions ------------------------------------------------------------------------

	#publishVariableDefinitions(): void {
		UpdateVariableDefinitions((definitions) => this.setVariableDefinitions(definitions), this.state)
	}

	/** Names arrive in a batch, and rebuilding dropdowns and presets for each would be wasteful */
	#scheduleDefinitions(): void {
		this.#definitionsTimer ??= setTimeout(() => {
			this.#definitionsTimer = undefined
			this.#publishDefinitions(false)
		}, DEFINITIONS_DEBOUNCE_MS)
	}

	#publishDefinitions(all: boolean): void {
		if (all) this.#publishVariableDefinitions()
		// presets are validated against the action and feedback definitions, so those go first
		if (all || this.#portsDirty || this.#choicesDirty) {
			UpdateActions(this)
			UpdateFeedbacks(this)
		}
		if (all || this.#portsDirty || this.#presetsDirty) UpdatePresets(this)
		this.#portsDirty = false
		this.#choicesDirty = false
		this.#presetsDirty = false
		this.checkAllFeedbacks()
	}
}
