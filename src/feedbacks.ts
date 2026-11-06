import { inputChoices, outputChoices, portChoices, portNumber, presetChoices } from './choices.js'
import type ModuleInstance from './main.js'
import type { PortId } from './protocol.js'

export type FeedbacksSchema = {
	route: { type: 'boolean'; options: { input: number; output: number } }
	sourceSelected: { type: 'boolean'; options: { port: number } }
	destinationSelected: { type: 'boolean'; options: { port: number } }
	routedInput: { type: 'boolean'; options: { input: string } }
	routedOutput: { type: 'boolean'; options: { output: string } }
	autoRouteMode: { type: 'boolean'; options: { mode: string } }
	outputLocked: { type: 'boolean'; options: { output: string } }
	outputStaged: { type: 'boolean'; options: { output: string } }
	outputNext: { type: 'boolean'; options: { output: string } }
	stagedWaiting: { type: 'boolean'; options: Record<string, never> }
	stagedRoutes: { type: 'boolean'; options: Record<string, never> }
	portSignal: { type: 'boolean'; options: { port: string } }
	portConnected: { type: 'boolean'; options: { port: string } }
	portLegend: { type: 'boolean'; options: { port: string; level: string } }
	presetLive: { type: 'boolean'; options: { preset: string } }
	presetStaged: { type: 'boolean'; options: { preset: string } }
	portMuted: { type: 'boolean'; options: { port: string } }
	saveArmed: { type: 'boolean'; options: Record<string, never> }
	saveSlotArmed: { type: 'boolean'; options: { slot: number } }
	slotLive: { type: 'boolean'; options: { slot: number } }
	slotStaged: { type: 'boolean'; options: { slot: number } }
	slotEmpty: { type: 'boolean'; options: { slot: number } }
	hotplugging: { type: 'boolean'; options: { port: string } }
}

export function UpdateFeedbacks(self: ModuleInstance): void {
	const { state } = self
	const inputs = inputChoices(state)
	const outputs = outputChoices(state)
	const ports = portChoices(state)
	const presets = presetChoices(state)
	const slotOption = {
		type: 'number' as const,
		id: 'slot' as const,
		label: 'Front-panel preset',
		default: 1,
		min: 1,
		max: 64,
	}

	const portStatus = (port: unknown) => {
		const input = portNumber(port, 'I')
		if (input !== undefined) return state.sourceStatus.get(input)
		const output = portNumber(port, 'O')
		return output === undefined ? undefined : state.destinationStatus.get(output)
	}

	self.setFeedbackDefinitions({
		route: {
			type: 'boolean',
			name: 'Route',
			description: 'True if the input is routed to the output. 0 means the selected one.',
			defaultStyle: { bgcolor: 0xff0000, color: 0x000000 },
			options: [
				{ type: 'number', id: 'input', label: 'Input (0 = selected)', default: 1, min: 0, max: 512 },
				{ type: 'number', id: 'output', label: 'Output (0 = selected)', default: 1, min: 0, max: 512 },
			],
			callback: (feedback) => {
				const input = Number(feedback.options.input) || state.selectedInput
				const output = Number(feedback.options.output) || state.selectedOutput
				return input !== undefined && output !== undefined && state.routes.get(output) === input
			},
		},
		sourceSelected: {
			type: 'boolean',
			name: 'Selected input',
			description: 'True if this input is selected. It flashes while taking it would change the selected output.',
			defaultStyle: { bgcolor: 0x00ff00, color: 0x000000 },
			options: [{ type: 'number', id: 'port', label: 'Input', default: 1, min: 1, max: 512 }],
			callback: (feedback) => {
				const input = Number(feedback.options.port)
				if (state.selectedInput !== input) return false
				return state.nextInput !== input || state.flashOn
			},
		},
		destinationSelected: {
			type: 'boolean',
			name: 'Selected output',
			description: 'True if this output is selected',
			defaultStyle: { bgcolor: 0xffff00, color: 0x000000 },
			options: [{ type: 'number', id: 'port', label: 'Output', default: 1, min: 1, max: 512 }],
			callback: (feedback) => state.selectedOutput === Number(feedback.options.port),
		},
		routedInput: {
			type: 'boolean',
			name: 'Routed input',
			description: 'True for the input on the selected output, right after an output was pressed',
			defaultStyle: { bgcolor: 0x00ff00, color: 0x000000 },
			options: [{ type: 'dropdown', id: 'input', label: 'Input', default: 'I1', choices: inputs }],
			callback: (feedback) => {
				const input = portNumber(feedback.options.input, 'I')
				return input !== undefined && state.isRoutedInput(input)
			},
		},
		routedOutput: {
			type: 'boolean',
			name: 'Routed output',
			description: 'True for each output carrying the selected input, right after an input was pressed',
			defaultStyle: { bgcolor: 0xffff00, color: 0x000000 },
			options: [{ type: 'dropdown', id: 'output', label: 'Output', default: 'O1', choices: outputs }],
			callback: (feedback) => {
				const output = portNumber(feedback.options.output, 'O')
				return output !== undefined && state.isRoutedOutput(output)
			},
		},
		autoRouteMode: {
			type: 'boolean',
			name: 'Auto-route mode',
			description: 'True if the auto-route mode is this one',
			defaultStyle: { bgcolor: 0xff0000, color: 0x000000 },
			options: [
				{
					type: 'dropdown',
					id: 'mode',
					label: 'Mode',
					default: 'cut',
					choices: [
						{ id: 'off', label: 'Off' },
						{ id: 'stage', label: 'Stage' },
						{ id: 'cut', label: 'Cut' },
					],
				},
			],
			callback: (feedback) => feedback.options.mode === self.autoRouteMode,
		},
		outputLocked: {
			type: 'boolean',
			name: 'Locked output',
			description: 'True if this output is locked',
			defaultStyle: { bgcolor: 0xff0000, color: 0x000000 },
			options: [{ type: 'dropdown', id: 'output', label: 'Output', default: 'O1', choices: outputs }],
			callback: (feedback) => {
				const output = portNumber(feedback.options.output, 'O')
				return output !== undefined && state.isLocked(output)
			},
		},
		outputStaged: {
			type: 'boolean',
			name: 'Staged output',
			description: 'True if a route is staged for this output',
			defaultStyle: { bgcolor: 0xff8000, color: 0x000000 },
			options: [{ type: 'dropdown', id: 'output', label: 'Output', default: 'O1', choices: outputs }],
			callback: (feedback) => {
				const output = portNumber(feedback.options.output, 'O')
				return output !== undefined && state.pendingInput(output) !== undefined
			},
		},
		outputNext: {
			type: 'boolean',
			name: 'Selected output has a new input waiting',
			description: 'True while the selected input is not yet on this selected output and is not staged',
			defaultStyle: { bgcolor: 0xffff00, color: 0x000000 },
			options: [{ type: 'dropdown', id: 'output', label: 'Output', default: 'O1', choices: outputs }],
			callback: (feedback) =>
				portNumber(feedback.options.output, 'O') === state.selectedOutput && state.nextInput !== undefined,
		},
		stagedWaiting: {
			type: 'boolean',
			name: 'Staged routes waiting',
			description: 'Flashes while routes are staged and have not been taken',
			defaultStyle: { bgcolor: 0xff8000, color: 0x000000 },
			options: [],
			callback: () => state.hasStagedRoutes && state.flashOn,
		},
		stagedRoutes: {
			type: 'boolean',
			name: 'Staged routes waiting (steady)',
			description: 'True while routes are staged and have not been taken, without flashing',
			defaultStyle: { bgcolor: 0xff8000, color: 0x000000 },
			options: [],
			callback: () => state.hasStagedRoutes,
		},
		portLegend: {
			type: 'boolean',
			name: 'Port status, as in the router web interface',
			description: 'True while the port is in this state. The presets show it as a coloured border.',
			defaultStyle: { bgcolor: 0x007ee6, color: 0xffffff },
			options: [
				{ type: 'dropdown', id: 'port', label: 'Port', default: 'I1', choices: ports },
				{
					type: 'dropdown',
					id: 'level',
					label: 'State',
					default: 'hdmi18',
					choices: [
						{ id: 'none', label: 'Not connected' },
						{ id: 'connected', label: 'Connected, no signal' },
						{ id: 'dvi', label: 'DVI signal' },
						{ id: 'hdmi', label: 'HDMI signal (max 9G)' },
						{ id: 'hdmi18', label: 'HDMI signal (max 18G)' },
					],
				},
			],
			callback: (feedback) => {
				const input = portNumber(feedback.options.port, 'I')
				if (input !== undefined) return state.inputLegend(input) === feedback.options.level
				const output = portNumber(feedback.options.port, 'O')
				return output !== undefined && state.outputLegend(output) === feedback.options.level
			},
		},
		portSignal: {
			type: 'boolean',
			name: 'Signal on a port',
			description: 'True if the port has a valid signal. An output has one when a live input is routed to it.',
			defaultStyle: { bgcolor: 0x008000, color: 0xffffff },
			options: [{ type: 'dropdown', id: 'port', label: 'Port', default: 'I1', choices: ports }],
			callback: (feedback) => portStatus(feedback.options.port)?.signal === true,
		},
		portConnected: {
			type: 'boolean',
			name: 'Cable connected to a port',
			description: 'True if the router sees a source on this input, or a display on this output',
			defaultStyle: { bgcolor: 0x008000, color: 0xffffff },
			options: [{ type: 'dropdown', id: 'port', label: 'Port', default: 'O1', choices: ports }],
			callback: (feedback) => portStatus(feedback.options.port)?.connected === true,
		},
		slotLive: {
			type: 'boolean',
			name: 'Front-panel preset is live',
			description: "True if the router's routes are the same as the preset on this front-panel preset button",
			defaultStyle: { bgcolor: 0x00ff00, color: 0x000000 },
			options: [slotOption],
			callback: (feedback) => {
				const name = state.slotPreset(Number(feedback.options.slot))
				return name !== undefined && state.isPresetLive(name)
			},
		},
		slotStaged: {
			type: 'boolean',
			name: 'Front-panel preset is staged',
			description: "True while this front-panel preset's routes are staged and a take would change something",
			defaultStyle: { bgcolor: 0xff8000, color: 0x000000 },
			options: [slotOption],
			callback: (feedback) => {
				const name = state.slotPreset(Number(feedback.options.slot))
				return name !== undefined && state.isPresetStaged(name)
			},
		},
		slotEmpty: {
			type: 'boolean',
			name: 'Front-panel preset is empty',
			description: 'True while this front-panel preset button holds no preset',
			defaultStyle: { color: 0x808080 },
			options: [slotOption],
			callback: (feedback) => state.slotPreset(Number(feedback.options.slot)) === undefined,
		},
		saveSlotArmed: {
			type: 'boolean',
			name: 'Save waiting, and this front-panel preset can take it',
			description: 'Flashes after SAVE is pressed, on inputs the router has a front-panel preset for',
			defaultStyle: { bgcolor: 0xff0000, color: 0x000000 },
			options: [slotOption],
			callback: (feedback) => state.saveArmed && state.flashOn && state.slots.has(Number(feedback.options.slot)),
		},
		saveArmed: {
			type: 'boolean',
			name: 'Save waiting for a router preset',
			description: 'Flashes after SAVE is pressed, until a router preset is pressed or it is cancelled',
			defaultStyle: { bgcolor: 0xff0000, color: 0x000000 },
			options: [],
			callback: () => state.saveArmed && state.flashOn,
		},
		portMuted: {
			type: 'boolean',
			name: 'Muted port',
			description: 'True if this input or output is muted, sending black',
			defaultStyle: { bgcolor: 0x0000ff, color: 0xffffff },
			options: [
				{
					type: 'dropdown',
					id: 'port',
					label: 'Port',
					default: 'selected',
					choices: [{ id: 'selected', label: 'The input or output pressed last' }, ...ports],
				},
			],
			callback: (feedback) => {
				const port = feedback.options.port === 'selected' ? state.lastSelectedPort : feedback.options.port
				return typeof port === 'string' && /^[IO]\d+$/.test(port) && state.isMuted(port as PortId)
			},
		},
		hotplugging: {
			type: 'boolean',
			name: 'Hotplug in progress',
			description: "True while this port's 5V or HPD is off for a hotplug",
			defaultStyle: { bgcolor: 0xff8000, color: 0x000000 },
			options: [
				{
					type: 'dropdown',
					id: 'port',
					label: 'Port',
					default: 'selected',
					choices: [{ id: 'selected', label: 'The selected output' }, ...ports],
				},
			],
			callback: (feedback) => {
				const port =
					feedback.options.port === 'selected'
						? state.selectedOutput === undefined
							? undefined
							: `O${state.selectedOutput}`
						: feedback.options.port
				return typeof port === 'string' && state.hotplugging.has(port as PortId)
			},
		},
		presetLive: {
			type: 'boolean',
			name: 'Router preset is live',
			description: "True if the router's routes are the same as this preset's",
			defaultStyle: { bgcolor: 0x00ff00, color: 0x000000 },
			options: [
				{
					type: 'dropdown',
					id: 'preset',
					label: 'Router preset',
					default: presets[0]?.id ?? '',
					choices: presets,
					allowCustom: true,
				},
			],
			callback: (feedback) => state.isPresetLive(String(feedback.options.preset)),
		},
		presetStaged: {
			type: 'boolean',
			name: 'Router preset is staged',
			description: "True while this preset's routes are staged and a take would change something",
			defaultStyle: { bgcolor: 0xff8000, color: 0x000000 },
			options: [
				{
					type: 'dropdown',
					id: 'preset',
					label: 'Router preset',
					default: presets[0]?.id ?? '',
					choices: presets,
					allowCustom: true,
				},
			],
			callback: (feedback) => state.isPresetStaged(String(feedback.options.preset)),
		},
	})
}
