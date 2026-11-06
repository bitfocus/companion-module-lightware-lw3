import { portLegend, type PortLegend } from './protocol.js'
import type { PortId, PortName, PortStatus, Route } from './protocol.js'

/** Dropdowns need something to offer before a router has reported its size, so buttons can be built offline */
export const OFFLINE_PORT_COUNT = 8

/** What the module knows about the router, and the operator's selection. Ports count from 1. */
export class RouterState {
	inputCount = 0
	outputCount = 0
	model = ''
	firmware = ''
	/** The input on each output, with 0 meaning nothing is routed */
	readonly routes = new Map<number, number>()
	readonly names = new Map<PortId, PortName>()
	readonly sourceStatus = new Map<number, PortStatus>()
	readonly destinationStatus = new Map<number, PortStatus>()
	sourceDetail: string[] = []
	destinationDetail: string[] = []
	routerName = ''
	/** Each router preset's input per output, or undefined if they could not be read */
	presets = new Map<string, (number | undefined)[]>()
	selectedInput: number | undefined
	selectedOutput: number | undefined
	/** Routes waiting for a take, by output */
	readonly staged = new Map<number, number>()
	/** The router preset the staged routes came from, until they are added to or taken */
	stagedPreset: string | undefined
	/** The pair on show has been staged: the next input starts a new pair, the next output reuses the input */
	pairStaged = false
	/** Which kind of port was pressed last, which decides what the routed feedbacks show */
	active: 'input' | 'output' | undefined
	flashOn = true
	/** Ports part way through a hotplug, with their 5V or HPD off */
	readonly hotplugging = new Set<PortId>()
	/** SAVE was pressed: the next router preset pressed is overwritten instead of recalled */
	saveArmed = false
	/** The front panel's preset buttons, by number: the preset each holds, or '' */
	readonly slots = new Map<number, string>()
	/** In standby the outputs are off and every change is refused */
	standby = false

	selectInput(input: number): void {
		if (this.pairStaged) this.selectedOutput = undefined
		this.pairStaged = false
		this.selectedInput = input
		this.active = 'input'
	}

	selectOutput(output: number): void {
		this.selectedOutput = output
		this.pairStaged = false
		this.active = 'output'
	}

	clearSelection(): void {
		this.pairStaged = false
		this.selectedInput = undefined
		this.selectedOutput = undefined
		this.active = undefined
	}

	/** How many to offer in dropdowns and presets */
	get shownInputs(): number {
		return this.inputCount || OFFLINE_PORT_COUNT
	}

	get shownOutputs(): number {
		return this.outputCount || OFFLINE_PORT_COUNT
	}

	inputLegend(input: number): PortLegend {
		return portLegend(this.sourceStatus.get(input), this.sourceDetail[input - 1])
	}

	outputLegend(output: number): PortLegend {
		return portLegend(this.destinationStatus.get(output), this.destinationDetail[output - 1])
	}

	inputName(input: number): string {
		return this.names.get(`I${input}`)?.name ?? `Input ${input}`
	}

	outputName(output: number): string {
		return this.names.get(`O${output}`)?.name ?? `Output ${output}`
	}

	/** The name of what is on an output */
	routedName(output: number): string {
		const input = this.routes.get(output)
		return input === undefined || input === 0 ? 'None' : this.inputName(input)
	}

	/** The input staged for an output, if it differs from what is routed now */
	pendingInput(output: number): number | undefined {
		const input = this.staged.get(output)
		return input !== undefined && input !== this.routes.get(output) ? input : undefined
	}

	get hasStagedRoutes(): boolean {
		return [...this.staged.keys()].some((output) => this.pendingInput(output) !== undefined)
	}

	stagedName(output: number): string {
		const input = this.pendingInput(output)
		if (input === undefined) return ''
		return input === 0 ? 'None' : this.inputName(input)
	}

	/** True while this preset's routes are staged and a take would change something */
	/** What a take would leave routed: the staged routes, and the current ones everywhere else */
	takeResult(): number[] {
		return Array.from({ length: this.outputCount }, (_, index) => {
			const output = index + 1
			return this.pendingInput(output) ?? this.routes.get(output) ?? 0
		})
	}

	slotPreset(slot: number): string | undefined {
		const name = this.slots.get(slot)
		return name && this.presets.has(name) ? name : undefined
	}

	isPresetStaged(name: string): boolean {
		return this.stagedPreset === name && this.hasStagedRoutes
	}

	/** True for the input on the selected output, right after an output was pressed */
	isRoutedInput(input: number): boolean {
		const { active, selectedOutput } = this
		return active === 'output' && selectedOutput !== undefined && this.routes.get(selectedOutput) === input
	}

	/** True for each output carrying the selected input, right after an input was pressed */
	isRoutedOutput(output: number): boolean {
		const { active, selectedInput } = this
		return active === 'input' && selectedInput !== undefined && this.routes.get(output) === selectedInput
	}

	isLocked(output: number): boolean {
		return this.destinationStatus.get(output)?.locked === true
	}

	isMuted(port: PortId): boolean {
		const statuses = port.startsWith('I') ? this.sourceStatus : this.destinationStatus
		return statuses.get(Number(port.slice(1)))?.muted === true
	}

	/** The input or output pressed last, which is what the mute button acts on */
	get lastSelectedPort(): PortId | undefined {
		if (this.active === 'input' && this.selectedInput !== undefined) return `I${this.selectedInput}`
		if (this.active === 'output' && this.selectedOutput !== undefined) return `O${this.selectedOutput}`
		return undefined
	}

	portName(port: PortId): string {
		const number = Number(port.slice(1))
		return port.startsWith('I') ? this.inputName(number) : this.outputName(number)
	}

	/** The selected input, while taking it would change the selected output's route. This is what flashes. */
	get nextInput(): number | undefined {
		const { selectedInput, selectedOutput } = this
		if (selectedInput === undefined || selectedOutput === undefined || this.pairStaged) return undefined
		return this.routes.get(selectedOutput) === selectedInput ? undefined : selectedInput
	}

	/** True when the router's routes are the same as the preset's */
	isPresetLive(name: string): boolean {
		const routes = this.presets.get(name)
		if (!routes || routes.length === 0 || routes.length !== this.outputCount) return false
		return routes.every((input, index) => input !== undefined && this.routes.get(index + 1) === input)
	}

	/** The first preset whose routes are live, or undefined */
	get livePreset(): string | undefined {
		for (const name of this.presets.keys()) {
			if (this.isPresetLive(name)) return name
		}
		return undefined
	}

	/** Only what a take would change, which keeps the command short on a big router */
	stagedRoutes(): Route[] {
		return [...this.staged]
			.filter(([output]) => this.pendingInput(output) !== undefined)
			.map(([output, input]) => ({ input, output }))
	}
}
