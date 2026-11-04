import { InstanceBase, InstanceStatus, TCPHelper, type SomeCompanionConfigField } from '@companion-module/base'
import { UpdateActions, type ActionsSchema, type LockCommand } from './actions.js'
import { Lw3Client } from './client.js'
import {
	AUTO_ROUTE_LABELS,
	AUTO_ROUTE_ORDER,
	GetConfigFields,
	type AutoRouteMode,
	type ModuleConfig,
} from './config.js'
import { UpdateFeedbacks, type FeedbacksSchema } from './feedbacks.js'
import { UpdatePresets } from './presets.js'
import {
	Cmd,
	DEFAULT_PORT,
	ErrorCode,
	MAX_NAME_LENGTH,
	cleanName,
	isSafePresetName,
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

	async destroy(): Promise<void> {
		this.#disconnect()
		this.#stopFlash()
		if (this.#definitionsTimer) clearTimeout(this.#definitionsTimer)
		this.#definitionsTimer = undefined
		this.log('debug', 'destroy')
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		const previous = this.config
		this.config = config
		this.#publishAutoRouteMode()
		if (config.host === previous.host && config.port === previous.port) return
		this.#connect()
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
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

	/** Saved in the connection settings. It applies from the next selection, so changing it never routes anything. */
	setAutoRouteMode(value: string): void {
		const current = AUTO_ROUTE_ORDER.indexOf(this.autoRouteMode)
		const mode =
			value === 'next'
				? AUTO_ROUTE_ORDER[(current + 1) % AUTO_ROUTE_ORDER.length]
				: AUTO_ROUTE_ORDER.find((candidate) => candidate === value)
		if (mode === undefined || mode === this.autoRouteMode) return
		this.config = { ...this.config, autoRoute: mode }
		this.saveConfig(this.config, undefined)
		this.log('info', `Auto-route mode: ${AUTO_ROUTE_LABELS[mode]}`)
		this.#publishAutoRouteMode()
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

	async takeStaged(): Promise<void> {
		const routes = this.state.stagedRoutes()
		if (routes.length === 0) {
			// everything staged is already live, so there is nothing to send or to keep waiting
			this.state.staged.clear()
			this.state.stagedPreset = undefined
			this.#stagedChanged()
			return
		}
		const free = routes.filter(({ output }) => {
			if (!this.state.isLocked(output)) return true
			this.log('warn', `${this.state.outputName(output)} is locked, so its staged route stays staged`)
			return false
		})
		if (free.length === 0) return
		if (await this.#switch(free)) {
			for (const { output } of free) this.state.staged.delete(output)
			// what stayed behind and is already live has nothing left to wait for
			for (const output of [...this.state.staged.keys()]) {
				if (this.state.pendingInput(output) === undefined) this.state.staged.delete(output)
			}
			this.state.stagedPreset = undefined
			this.#stagedChanged()
			this.state.clearSelection()
			this.#selectionChanged()
		}
	}

	clearStaged(): void {
		this.state.staged.clear()
		this.state.stagedPreset = undefined
		this.#stagedChanged()
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

	async renamePort(port: string, name: string): Promise<void> {
		const clean = cleanName(name)
		if (!/^[IO]\d+$/.test(port) || clean === '') {
			this.log('warn', `Can't rename ${port} to "${name}"`)
			return
		}
		const id = port as PortId
		// the router requires a number before the name. Keep the one the port has.
		const prefix = this.state.names.get(id)?.prefix ?? '2'
		if (clean.length > MAX_NAME_LENGTH) {
			this.log('warn', `The router only keeps the first ${MAX_NAME_LENGTH} characters of "${clean}"`)
		}
		// the change message arrives ahead of the reply, so this has to be known before sending
		this.#ownRenames.add(id)
		const lines = await this.#client.request(Cmd.rename(id, prefix, clean), true)
		this.#ownRenames.delete(id)
		if (lines === undefined) {
			this.log('warn', `Not connected, so ${port} wasn't renamed`)
			return
		}
		const error = replyError(lines)
		if (error) {
			this.log('warn', `The router refused the name "${clean}": ${error.message}`)
			return
		}
		// the reply has what the router stored, which may be shorter than what was sent
		for (const line of lines) this.#applyProperty(parseProperty(line))
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
			this.updateStatus(InstanceStatus.BadConfig, 'No router IP set')
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
		this.updateStatus(InstanceStatus.ConnectionFailure, 'No reply from the router')
		this.#connect(true)
	}

	#armConnectTimer(): void {
		this.#connectTimer ??= setTimeout(() => {
			this.#connectTimer = undefined
			this.updateStatus(InstanceStatus.ConnectionFailure, 'Cannot reach the router, retrying')
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
			this.updateStatus(InstanceStatus.UnknownWarning, 'Router model not supported yet')
		} else {
			this.log(
				'info',
				`Router found: ${unit}, ${inputCount} inputs, ${outputCount} outputs, ${presets.size} router presets`,
			)
		}
		this.#startHeartbeat()
	}

	/** Returns false if the router has no routing where this module looks for it */
	async #readState(): Promise<boolean> {
		let routes = await this.#client.request(Cmd.routes)
		if (routes && replyError(routes)) routes = await this.#client.request(Cmd.routesOlder)
		if (routes === undefined) return false
		if (replyError(routes)) return false
		for (const line of routes) this.#applyProperty(parseProperty(line))

		for (const command of [Cmd.destinationStatus, Cmd.sourceStatus, Cmd.names]) {
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
			}
		} else if (property.path === NAMES_PATH) {
			this.#applyName(property.property, property.value)
		} else if (property.path.startsWith(PRESET_PATH_PREFIX)) {
			this.#presetReadTimer ??= setTimeout(() => {
				this.#presetReadTimer = undefined
				void this.#readPresets()
			}, PRESET_READ_DEBOUNCE_MS)
		}
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
			'outputStaged',
			'stagedWaiting',
			'presetLive',
			'presetStaged',
		)
	}

	#applyDestinationStatus(value: string): void {
		const locks = this.#applyStatus(value, this.state.destinationStatus, 'O')
		if (locks.changed) this.checkFeedbacks('portSignal', 'portConnected')
		if (locks.lockChanged) {
			this.setVariableValues(selectionValues(this.state))
			this.checkFeedbacks('outputLocked')
		}
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
		if (this.#applyStatus(value, this.state.sourceStatus, 'I').changed) {
			this.checkFeedbacks('portSignal', 'portConnected')
		}
	}

	#applyStatus(
		value: string,
		statuses: Map<number, PortStatus>,
		kind: 'I' | 'O',
	): { changed: boolean; lockChanged: boolean } {
		let changed = false
		let lockChanged = false
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
			}
		})
		return { changed, lockChanged }
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
		this.checkFeedbacks('route', 'routedInput', 'routedOutput', 'sourceSelected', 'destinationSelected')
	}

	#stagedChanged(): void {
		this.setVariableValues(routeValues(this.state))
		this.#syncFlash()
		this.checkFeedbacks('outputStaged', 'stagedWaiting', 'presetStaged')
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
